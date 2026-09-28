package plugin

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/elohmeier/grafana-pi-app/pkg/sessionstore"
	"github.com/grafana/authlib/authn"
	"github.com/grafana/authlib/types"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/config"
)

// The SDK's User contains a mutable login, not the stable user UID. Verify the
// identity token Grafana forwards instead of accepting an owner from the client.
func (a *App) sessionScope(r *http.Request) (string, error) {
	p := backend.PluginConfigFromContext(r.Context())
	orgID := p.OrgID //nolint:staticcheck // Grafana ID token audiences use org:<numeric ID>; Namespace is not a substitute.
	if orgID <= 0 || p.User == nil || p.PluginID == "" {
		return "", errors.New("missing user context")
	}
	issuer, err := config.GrafanaConfigFromContext(r.Context()).AppURL()
	if err != nil || issuer == "" {
		return "", errors.New("missing Grafana URL")
	}
	keysURL := strings.TrimRight(issuer, "/") + "/api/signing-keys/keys"
	if base := a.settings.SessionGrafanaURL; base != "" {
		keysURL = strings.TrimRight(base, "/") + "/api/signing-keys/keys"
	}
	if base := os.Getenv("PI_SESSION_GRAFANA_URL"); base != "" {
		keysURL = strings.TrimRight(base, "/") + "/api/signing-keys/keys"
	}
	a.sessionMu.Lock()
	if a.sessionKeys == nil || a.sessionKeysURL != keysURL {
		a.sessionKeys = authn.NewKeyRetriever(authn.KeyRetrieverConfig{SigningKeysURL: keysURL}, authn.WithHTTPClientKeyRetrieverOpt(&http.Client{Timeout: 5 * time.Second}))
		a.sessionKeysURL = keysURL
	}
	keys := a.sessionKeys
	a.sessionMu.Unlock()
	claims, err := authn.NewIDTokenVerifier(authn.VerifierConfig{AllowedAudiences: []string{fmt.Sprintf("org:%d", orgID)}}, keys).Verify(r.Context(), r.Header.Get(grafanaIDHeader))
	if err != nil {
		return "", err
	}
	if claims.Expiry == nil || claims.Issuer != issuer || claims.Rest.Type != types.TypeUser || claims.Rest.Identifier == "" || p.Namespace != "" && p.Namespace != claims.Rest.Namespace {
		return "", errors.New("invalid session identity")
	}
	scope, _ := json.Marshal([]any{a.settings.SessionNamespace, orgID, p.PluginID, claims.Rest.Identifier})
	return string(scope), nil
}
func (a *App) getSessionStore(ctx context.Context) (*sessionstore.Store, error) {
	a.sessionMu.Lock()
	defer a.sessionMu.Unlock()
	if a.disposed {
		return nil, errors.New("plugin instance disposed")
	}
	if a.sessionStore != nil {
		return a.sessionStore, nil
	}
	s, err := sessionstore.Open(ctx, a.settings.SessionPostgresDSN, a.settings.SessionSchema)
	if err == nil {
		a.sessionStore = s
	}
	return s, err
}
func (a *App) handleSessions(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	path := strings.TrimPrefix(r.URL.Path, "/sessions")
	if path == "/status" && r.Method == http.MethodGet && a.settings.SessionPostgresDSN == "" {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false})
		return
	}
	if a.settings.SessionPostgresDSN == "" {
		writeJSONError(w, http.StatusServiceUnavailable, "Session database is not configured")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	scope, err := a.sessionScope(r)
	if err != nil {
		backend.Logger.Warn("Cannot verify session identity", "error", err)
		writeJSONError(w, http.StatusUnauthorized, "Verified Grafana user identity is required for session storage")
		return
	}
	s, err := a.getSessionStore(ctx)
	if err != nil {
		backend.Logger.Error("Session database unavailable", "error", err)
		writeJSONError(w, http.StatusServiceUnavailable, "Session database is unavailable; check its configuration and schema permissions")
		return
	}
	if path == "/status" && r.Method == http.MethodGet {
		var done bool
		done, err = s.ImportComplete(ctx, scope)
		if err == nil {
			key := sha256.Sum256([]byte(a.settings.SessionSchema + ":" + scope))
			writeJSON(w, http.StatusOK, map[string]any{"enabled": true, "importComplete": done, "scopeKey": fmt.Sprintf("%x", key)})
			return
		}
	}
	if path == "/migration" && r.Method == http.MethodPost {
		err = s.CompleteImport(ctx, scope)
		if err == nil {
			writeJSON(w, http.StatusOK, map[string]bool{"complete": true})
			return
		}
	}
	if path == "" && r.Method == http.MethodGet {
		limit := 30
		if raw := r.URL.Query().Get("limit"); raw != "" {
			limit, err = strconv.Atoi(raw)
			if err != nil {
				err = sessionstore.ErrInvalid
			}
		}
		if err == nil {
			var page sessionstore.Page
			page, err = s.List(ctx, scope, r.URL.Query().Get("cursor"), limit)
			if err == nil {
				writeJSON(w, http.StatusOK, page)
				return
			}
		}
	}
	id := strings.TrimPrefix(path, "/")
	if id != "" && id != "status" && id != "migration" && !strings.Contains(id, "/") {
		switch r.Method {
		case http.MethodGet:
			var session sessionstore.Session
			session, err = s.Get(ctx, scope, id)
			if err == nil {
				writeJSON(w, http.StatusOK, session)
				return
			}
		case http.MethodPut, http.MethodDelete:
			var input sessionstore.Write
			decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 33<<20))
			if err = decoder.Decode(&input); err == nil {
				var extra any
				if decoder.Decode(&extra) != io.EOF {
					err = sessionstore.ErrInvalid
				}
			}
			if err != nil {
				writeJSONError(w, http.StatusBadRequest, "Invalid session request (maximum snapshot size: 32 MiB)")
				return
			}
			var metadata sessionstore.Metadata
			metadata, err = s.Mutate(ctx, scope, id, input, r.Method == http.MethodDelete)
			if err == nil {
				writeJSON(w, http.StatusOK, metadata)
				return
			}
		default:
			writeJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
	}
	switch {
	case errors.Is(err, sessionstore.ErrInvalid):
		writeJSONError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, sessionstore.ErrNotFound):
		writeJSONError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, sessionstore.ErrConflict):
		writeJSONError(w, http.StatusConflict, err.Error())
	case err != nil:
		backend.Logger.Error("Session operation failed", "error", err)
		writeJSONError(w, http.StatusServiceUnavailable, "Session database is unavailable; your changes have not been confirmed saved")
	default:
		writeJSONError(w, http.StatusNotFound, "not found")
	}
}
