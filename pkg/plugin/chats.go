package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/grafana/authlib/authn"
	"github.com/grafana/authlib/types"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/config"

	"github.com/elohmeier/grafana-pi-app/pkg/api"
	"github.com/elohmeier/grafana-pi-app/pkg/chatlog"
)

const (
	chatRequestTimeout = 20 * time.Second
	maxCommitBodyBytes = 32 << 20
	maxSmallBodyBytes  = 64 << 10
)

// sessionScope returns the storage scope of the requesting user:
// [namespace, orgID, pluginID, userUID] as JSON.
//
// The SDK's User contains a mutable login, not the stable user UID. Verify the
// identity token Grafana forwards instead of accepting an owner from the client.
// sessionIdentity is the verified caller of a plugin request.
type sessionIdentity struct {
	// Scope owns the caller's chats: deployment namespace, org, plugin, and user (or service account).
	Scope string
	// ServiceAccount is set for service accounts, such as the assistant host.
	ServiceAccount bool
	UID            string
	Login          string
	OrgID          int64
}

func (a *App) sessionScope(r *http.Request) (string, error) {
	identity, err := a.sessionIdentity(r)
	return identity.Scope, err
}

func (a *App) sessionIdentity(r *http.Request) (sessionIdentity, error) {
	var none sessionIdentity
	p := backend.PluginConfigFromContext(r.Context())
	orgID := p.OrgID //nolint:staticcheck // Grafana ID token audiences use org:<numeric ID>; Namespace is not a substitute.
	if orgID <= 0 || p.User == nil || p.PluginID == "" {
		return none, errors.New("missing user context")
	}
	issuer, err := config.GrafanaConfigFromContext(r.Context()).AppURL()
	if err != nil || issuer == "" {
		return none, errors.New("missing Grafana URL")
	}
	keysURL := strings.TrimRight(issuer, "/") + "/api/signing-keys/keys"
	if base := a.settings.SessionGrafanaURL; base != "" {
		keysURL = strings.TrimRight(base, "/") + "/api/signing-keys/keys"
	}
	if base := os.Getenv("PI_SESSION_GRAFANA_URL"); base != "" {
		keysURL = strings.TrimRight(base, "/") + "/api/signing-keys/keys"
	}
	a.chatMu.Lock()
	if a.idKeys == nil || a.idKeysURL != keysURL {
		a.idKeys = authn.NewKeyRetriever(authn.KeyRetrieverConfig{SigningKeysURL: keysURL}, authn.WithHTTPClientKeyRetrieverOpt(&http.Client{Timeout: 5 * time.Second}))
		a.idKeysURL = keysURL
	}
	keys := a.idKeys
	a.chatMu.Unlock()
	claims, err := authn.NewIDTokenVerifier(authn.VerifierConfig{AllowedAudiences: []string{fmt.Sprintf("org:%d", orgID)}}, keys).Verify(r.Context(), r.Header.Get(grafanaIDHeader))
	if err != nil {
		return none, err
	}
	switch {
	case claims.Expiry == nil:
		return none, errors.New("identity token has no expiry")
	case claims.Issuer != issuer:
		return none, fmt.Errorf("identity token issuer %q does not match the Grafana URL %q", claims.Issuer, issuer)
	case claims.Rest.Type != types.TypeUser && claims.Rest.Type != types.TypeServiceAccount || claims.Rest.Identifier == "":
		return none, fmt.Errorf("identity token is for a %s, not a user or service account", claims.Rest.Type)
	case p.Namespace != "" && p.Namespace != claims.Rest.Namespace:
		return none, fmt.Errorf("identity token namespace %q does not match %q", claims.Rest.Namespace, p.Namespace)
	}
	owner := claims.Rest.Identifier
	if claims.Rest.Type == types.TypeServiceAccount {
		// The assistant host (Mattermost) stores its chats as a service account.
		owner = string(types.TypeServiceAccount) + ":" + owner
	}
	scope, _ := json.Marshal([]any{a.settings.SessionNamespace, orgID, p.PluginID, owner})
	return sessionIdentity{
		Scope:          string(scope),
		ServiceAccount: claims.Rest.Type == types.TypeServiceAccount,
		UID:            claims.Rest.Identifier,
		Login:          claims.Rest.Username,
		OrgID:          orgID,
	}, nil
}

func (a *App) chatBackendName() string {
	if a.settings.SessionPostgresDSN != "" {
		return "PostgreSQL"
	}
	return "SQLite"
}

// getChatStore opens the chat store on first use: PostgreSQL when a DSN is
// configured, otherwise the embedded SQLite database. Failures are retried on
// the next call.
func (a *App) getChatStore(ctx context.Context) (chatlog.Store, error) {
	a.chatMu.Lock()
	defer a.chatMu.Unlock()
	if a.disposed {
		return nil, errors.New("plugin instance disposed")
	}
	if a.chatStore != nil {
		return a.chatStore, nil
	}
	var s chatlog.Store
	var err error
	if a.settings.SessionPostgresDSN != "" {
		s, err = chatlog.OpenPostgres(ctx, a.settings.SessionPostgresDSN, a.settings.SessionSchema)
	} else {
		var path string
		if path, err = chatlog.SQLitePath(a.settings.PluginID); err == nil {
			s, err = chatlog.OpenSQLite(ctx, path)
		}
	}
	if err != nil {
		return nil, err
	}
	a.chatStore = s
	return s, nil
}

type chatHandler func(w http.ResponseWriter, r *http.Request, s chatlog.Store, scope, id string)

func (a *App) registerChatRoutes(mux *http.ServeMux) {
	routes := map[string]chatHandler{
		"GET /chats":               a.handleListChats,
		"POST /chats/{id}/open":    a.handleOpenChat,
		"GET /chats/{id}/log":      a.handleChatLog,
		"POST /chats/{id}/commits": a.handleChatCommit,
		"PATCH /chats/{id}":        a.handleRenameChat,
		"DELETE /chats/{id}":       a.handleDeleteChat,
		"POST /chats/{id}/share":   a.handleShareChat,
		// {id} is the share token here.
		"POST /shares/{id}/copy": a.handleCopySharedChat,
	}
	for pattern, handler := range routes {
		mux.HandleFunc(pattern, a.withAppAccess(a.chatRoute(handler, strings.Contains(pattern, "{id}"))))
	}
}

func (a *App) chatRoute(handler chatHandler, withID bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		ctx, cancel := context.WithTimeout(r.Context(), chatRequestTimeout)
		defer cancel()
		r = r.WithContext(ctx)
		id := r.PathValue("id")
		if withID && !chatlog.ValidID(id) {
			writeJSONError(w, http.StatusBadRequest, "invalid chat ID")
			return
		}
		scope, err := a.sessionScope(r)
		if err != nil {
			backend.Logger.Warn("Cannot verify chat identity", "error", err)
			writeJSONError(w, http.StatusUnauthorized, "Verified Grafana user identity is required for chat storage")
			return
		}
		s, err := a.getChatStore(ctx)
		if err != nil {
			backend.Logger.Error("Chat storage unavailable", "backend", a.chatBackendName(), "error", err)
			writeJSONError(w, http.StatusServiceUnavailable, "Chat storage is unavailable; check its configuration and permissions")
			return
		}
		handler(w, r, s, scope, id)
	}
}

func writeChatError(w http.ResponseWriter, err error) {
	var conflict *chatlog.ConflictError
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &conflict):
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(api.ErrorResponse{Error: conflict.Error(), Reason: conflict.Reason})
	case errors.As(err, &tooLarge):
		writeJSONError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("chat request exceeds %d bytes", tooLarge.Limit))
	case errors.Is(err, chatlog.ErrInvalid):
		writeJSONError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, chatlog.ErrNotFound):
		writeJSONError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, chatlog.ErrDeleted):
		writeJSONError(w, http.StatusGone, err.Error())
	default:
		backend.Logger.Error("Chat storage operation failed", "error", err)
		writeJSONError(w, http.StatusServiceUnavailable, "Chat storage is unavailable; the change has not been confirmed saved")
	}
}

// decodeChatBody decodes one JSON value. An empty body leaves v unchanged
// when optional is set.
func decodeChatBody(w http.ResponseWriter, r *http.Request, limit int64, optional bool, v any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	err := decoder.Decode(v)
	if errors.Is(err, io.EOF) && optional {
		return nil
	}
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return err
	}
	if err != nil {
		return fmt.Errorf("%w: %v", chatlog.ErrInvalid, err)
	}
	var extra json.RawMessage
	if err = decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if errors.As(err, &tooLarge) {
			return err
		}
		return fmt.Errorf("%w: unexpected data after the JSON body", chatlog.ErrInvalid)
	}
	return nil
}

func queryLimit(r *http.Request, fallback, maximum int) (int, error) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return fallback, nil
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 1 {
		return 0, fmt.Errorf("%w: limit must be a positive integer", chatlog.ErrInvalid)
	}
	return min(limit, maximum), nil
}

func (a *App) handleListChats(w http.ResponseWriter, r *http.Request, s chatlog.Store, scope, _ string) {
	limit, err := queryLimit(r, chatlog.DefaultPageSize, chatlog.MaxPageSize)
	if err == nil {
		var page chatlog.Page
		if page, err = s.List(r.Context(), scope, r.URL.Query().Get("cursor"), limit); err == nil {
			writeJSON(w, http.StatusOK, page)
			return
		}
	}
	writeChatError(w, err)
}

func (a *App) handleOpenChat(w http.ResponseWriter, r *http.Request, s chatlog.Store, scope, id string) {
	var body api.OpenChatRequest
	err := decodeChatBody(w, r, maxSmallBodyBytes, true, &body)
	if err == nil {
		var chat chatlog.OpenedChat
		if chat, err = s.Open(r.Context(), scope, id, body.Title, body.Create == nil || *body.Create); err == nil {
			writeJSON(w, http.StatusOK, chat)
			return
		}
	}
	writeChatError(w, err)
}

// handleChatLog writes row bodies verbatim; encoding/json would compact and
// HTML-escape them.
func (a *App) handleChatLog(w http.ResponseWriter, r *http.Request, s chatlog.Store, scope, id string) {
	limit, err := queryLimit(r, chatlog.DefaultLogLimit, chatlog.MaxLogLimit)
	if err != nil {
		writeChatError(w, err)
		return
	}
	page, err := s.Log(r.Context(), scope, id, r.URL.Query().Get("cursor"), limit)
	if err != nil {
		writeChatError(w, err)
		return
	}
	var b bytes.Buffer
	b.WriteString(`{"rows":[`)
	for i, row := range page.Rows {
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, `{"seq":%d,"idx":%d,"body":`, row.Seq, row.Idx)
		b.Write(row.Body)
		b.WriteByte('}')
	}
	b.WriteByte(']')
	if page.NextCursor != "" {
		cursor, _ := json.Marshal(page.NextCursor)
		b.WriteString(`,"nextCursor":`)
		b.Write(cursor)
	}
	b.WriteString("}\n")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(b.Bytes())
}

func (a *App) handleChatCommit(w http.ResponseWriter, r *http.Request, s chatlog.Store, scope, id string) {
	var commit chatlog.Commit
	err := decodeChatBody(w, r, maxCommitBodyBytes, false, &commit)
	if err == nil {
		var result chatlog.CommitResult
		if result, err = s.Commit(r.Context(), scope, id, commit); err == nil {
			writeJSON(w, http.StatusOK, result)
			return
		}
	}
	writeChatError(w, err)
}

func (a *App) handleRenameChat(w http.ResponseWriter, r *http.Request, s chatlog.Store, scope, id string) {
	var body struct {
		Title *string `json:"title"`
	}
	err := decodeChatBody(w, r, maxSmallBodyBytes, false, &body)
	if err == nil && body.Title == nil {
		err = fmt.Errorf("%w: title is required", chatlog.ErrInvalid)
	}
	if err == nil {
		var chat chatlog.Chat
		if chat, err = s.Rename(r.Context(), scope, id, *body.Title); err == nil {
			writeJSON(w, http.StatusOK, chat)
			return
		}
	}
	writeChatError(w, err)
}

func (a *App) handleDeleteChat(w http.ResponseWriter, r *http.Request, s chatlog.Store, scope, id string) {
	if err := s.Delete(r.Context(), scope, id); err != nil {
		writeChatError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) handleShareChat(w http.ResponseWriter, r *http.Request, s chatlog.Store, scope, id string) {
	token, err := s.Share(r.Context(), scope, id)
	if err != nil {
		writeChatError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, api.ChatShare{Token: token})
}

// handleCopySharedChat copies a shared chat into the caller's chats, for
// example an assistant host thread a user continues in Grafana.
func (a *App) handleCopySharedChat(w http.ResponseWriter, r *http.Request, s chatlog.Store, scope, token string) {
	chat, err := s.CopyShared(r.Context(), token, scope, uuid.NewString())
	if err != nil {
		writeChatError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, chat)
}
