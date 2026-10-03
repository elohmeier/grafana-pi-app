package plugin

import (
	"context"
	"net/http"
	"strings"

	"github.com/grafana/grafana-plugin-sdk-go/backend"

	"github.com/elohmeier/grafana-pi-app/pkg/api"
	"github.com/elohmeier/grafana-pi-app/pkg/chatlog"
)

// Identity links connect chat platform accounts (Mattermost, Webex) to Grafana
// users. The assistant host, a service account, creates a one-time code for a
// platform account; the Grafana user who opens and confirms it is linked,
// which proves control of both accounts. See docs/identity.md.

type identityHandler func(w http.ResponseWriter, r *http.Request, s chatlog.Store, identity sessionIdentity)

func (a *App) registerIdentityRoutes(mux *http.ServeMux) {
	routes := map[string]identityHandler{
		"POST /identity/link-codes":                a.hostOnly(a.handleCreateLinkCode),
		"GET /identity/link-codes/{code}":          a.usersOnly(a.handleLinkCode),
		"POST /identity/link-codes/{code}/confirm": a.usersOnly(a.handleConfirmLinkCode),
		"GET /identity/links":                      a.usersOnly(a.handleUserLinks),
		"GET /identity/links/{platform}/{user}":    a.hostOnly(a.handleLink),
		"PUT /identity/links/{platform}/{user}":    a.hostOnly(a.handleSetLink),
		"DELETE /identity/links/{platform}/{user}": a.handleUnlink,
	}
	for pattern, handler := range routes {
		mux.HandleFunc(pattern, a.withAppAccess(a.identityRoute(handler)))
	}
}

func (a *App) identityRoute(handler identityHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		ctx, cancel := context.WithTimeout(r.Context(), chatRequestTimeout)
		defer cancel()
		r = r.WithContext(ctx)
		identity, err := a.sessionIdentity(r)
		if err != nil {
			backend.Logger.Warn("Cannot verify identity", "error", err)
			writeJSONError(w, http.StatusUnauthorized, "Verified Grafana identity is required")
			return
		}
		s, err := a.getChatStore(ctx)
		if err != nil {
			writeJSONError(w, http.StatusServiceUnavailable, "Storage is unavailable")
			return
		}
		handler(w, r, s, identity)
	}
}

// hostOnly allows service accounts: the assistant host acts for its platform users.
func (a *App) hostOnly(handler identityHandler) identityHandler {
	return func(w http.ResponseWriter, r *http.Request, s chatlog.Store, identity sessionIdentity) {
		if !identity.ServiceAccount {
			writeJSONError(w, http.StatusForbidden, "only the assistant host's service account can do this")
			return
		}
		handler(w, r, s, identity)
	}
}

// usersOnly allows Grafana users: a link belongs to a person.
func (a *App) usersOnly(handler identityHandler) identityHandler {
	return func(w http.ResponseWriter, r *http.Request, s chatlog.Store, identity sessionIdentity) {
		if identity.ServiceAccount {
			writeJSONError(w, http.StatusForbidden, "a service account cannot be linked")
			return
		}
		handler(w, r, s, identity)
	}
}

func (a *App) handleCreateLinkCode(w http.ResponseWriter, r *http.Request, s chatlog.Store, _ sessionIdentity) {
	var body api.CreateLinkCodeRequest
	if err := decodeChatBody(w, r, maxSmallBodyBytes, false, &body); err != nil {
		writeChatError(w, err)
		return
	}
	code, expires, err := s.CreateLinkCode(r.Context(), strings.TrimSpace(body.Platform), strings.TrimSpace(body.PlatformUser), strings.TrimSpace(body.DisplayName))
	if err != nil {
		writeChatError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, api.LinkCode{Code: code, ExpiresAt: expires})
}

func (a *App) handleLinkCode(w http.ResponseWriter, r *http.Request, s chatlog.Store, _ sessionIdentity) {
	link, err := s.LinkCode(r.Context(), r.PathValue("code"))
	if err != nil {
		writeChatError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, link)
}

func (a *App) handleConfirmLinkCode(w http.ResponseWriter, r *http.Request, s chatlog.Store, identity sessionIdentity) {
	link, err := s.ConfirmLinkCode(r.Context(), r.PathValue("code"), identity.OrgID, identity.UID, identity.Login)
	if err != nil {
		writeChatError(w, err)
		return
	}
	backend.Logger.Info("Linked chat account", "platform", link.Platform, "platformUser", link.PlatformUser, "user", link.UserLogin)
	writeJSON(w, http.StatusOK, link)
}

func (a *App) handleUserLinks(w http.ResponseWriter, r *http.Request, s chatlog.Store, identity sessionIdentity) {
	links, err := s.UserLinks(r.Context(), identity.OrgID, identity.UID)
	if err != nil {
		writeChatError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, links)
}

func (a *App) handleLink(w http.ResponseWriter, r *http.Request, s chatlog.Store, identity sessionIdentity) {
	link, err := s.Link(r.Context(), r.PathValue("platform"), r.PathValue("user"))
	if err == nil && link.OrgID != identity.OrgID {
		err = chatlog.ErrNotFound
	}
	if err != nil {
		writeChatError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, link)
}

// handleSetLink links an account the host matched, for example by a verified email address.
func (a *App) handleSetLink(w http.ResponseWriter, r *http.Request, s chatlog.Store, identity sessionIdentity) {
	var body api.IdentityLink
	if err := decodeChatBody(w, r, maxSmallBodyBytes, false, &body); err != nil {
		writeChatError(w, err)
		return
	}
	body.Platform, body.PlatformUser, body.OrgID = r.PathValue("platform"), r.PathValue("user"), identity.OrgID
	link, err := s.SetLink(r.Context(), body)
	if err != nil {
		writeChatError(w, err)
		return
	}
	backend.Logger.Info("Linked chat account", "platform", link.Platform, "platformUser", link.PlatformUser, "user", link.UserLogin, "source", link.Source)
	writeJSON(w, http.StatusOK, link)
}

// handleUnlink removes a link: the host for its platform users, or the linked Grafana user.
func (a *App) handleUnlink(w http.ResponseWriter, r *http.Request, s chatlog.Store, identity sessionIdentity) {
	platform, user := r.PathValue("platform"), r.PathValue("user")
	if !identity.ServiceAccount {
		link, err := s.Link(r.Context(), platform, user)
		if err != nil || link.OrgID != identity.OrgID || link.UserUID != identity.UID {
			writeChatError(w, chatlog.ErrNotFound)
			return
		}
	}
	if err := s.Unlink(r.Context(), platform, user); err != nil {
		writeChatError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
