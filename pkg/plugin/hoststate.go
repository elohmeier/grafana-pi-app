package plugin

import (
	"net/http"

	"github.com/elohmeier/grafana-pi-app/pkg/api"
	"github.com/elohmeier/grafana-pi-app/pkg/chatlog"
)

// The assistant host keeps its state (threads, alert episodes) here when it
// runs with several replicas: the leader writes, a new leader reads. Each
// service account has its own documents.

const maxHostStateBytes = 16 << 20

func (a *App) registerHostStateRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /host-state/{key}", a.withAppAccess(a.identityRoute(a.hostOnly(a.handleGetHostState))))
	mux.HandleFunc("PUT /host-state/{key}", a.withAppAccess(a.identityRoute(a.hostOnly(a.handleSetHostState))))
}

func (a *App) handleGetHostState(w http.ResponseWriter, r *http.Request, s chatlog.Store, identity sessionIdentity) {
	body, version, err := s.HostState(r.Context(), identity.Scope, r.PathValue("key"))
	if err != nil {
		writeChatError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, api.HostStateDocument{Version: version, Body: body})
}

func (a *App) handleSetHostState(w http.ResponseWriter, r *http.Request, s chatlog.Store, identity sessionIdentity) {
	var document api.HostStateDocument
	if err := decodeChatBody(w, r, maxHostStateBytes, false, &document); err != nil {
		writeChatError(w, err)
		return
	}
	version, err := s.SetHostState(r.Context(), identity.Scope, r.PathValue("key"), document.Version, document.Body)
	if err != nil {
		writeChatError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, api.HostStateDocument{Version: version})
}
