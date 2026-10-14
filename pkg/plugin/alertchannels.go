package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/grafana/grafana-plugin-sdk-go/backend"

	"github.com/elohmeier/grafana-pi-app/pkg/api"
)

// Alert channels: Grafana webhook contact points that send notifications to a
// chat channel of the assistant host (docs/alert-channels.md). Admins list the
// channels the host's bot can post to and get the webhook settings for one;
// the browser then creates the contact point as the admin. The host token
// authenticates the plugin to the host and signs the notifications (HMAC).

const (
	alertSignatureHeader = "X-Grafana-Alerting-Signature"
	alertTimestampHeader = "X-Grafana-Alerting-Timestamp"
	assistantHostTimeout = 10 * time.Second
)

func (a *App) registerAlertChannelRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /alert-channels", a.withAppAccess(a.adminsOnly(a.handleAlertChannels)))
	mux.HandleFunc("POST /alert-channels/webhook", a.withAppAccess(a.adminsOnly(a.handleAlertWebhook)))
}

// adminsOnly allows organization admins: the webhook settings contain the host token.
func (a *App) adminsOnly(handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if !isOrgAdmin(backend.UserFromContext(r.Context())) {
			writeJSONError(w, http.StatusForbidden, "only organization admins can set up alert channels")
			return
		}
		handler(w, r)
	}
}

func (a *App) handleAlertChannels(w http.ResponseWriter, r *http.Request) {
	platforms, status, err := a.assistantHostChannels(r.Context())
	if err != nil {
		writeJSONError(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, api.AlertChannelsResponse{HostURL: a.settings.AssistantHostURL, Platforms: platforms})
}

func (a *App) handleAlertWebhook(w http.ResponseWriter, r *http.Request) {
	var req api.AlertWebhookRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	query, err := alertWebhookQuery(req)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	platforms, status, err := a.assistantHostChannels(r.Context())
	if err != nil {
		writeJSONError(w, status, err.Error())
		return
	}
	channel, ok := findAlertChannel(platforms, req.Platform, req.ChannelID)
	if !ok {
		writeJSONError(w, http.StatusNotFound, fmt.Sprintf("the %s bot cannot post to channel %q", req.Platform, req.ChannelID))
		return
	}
	writeJSON(w, http.StatusOK, api.AlertWebhookSettings{
		URL:        alertChannelURL(a.settings.AssistantHostURL, req.Platform, channel, query),
		HTTPMethod: http.MethodPost,
		HMACConfig: api.AlertWebhookHMAC{
			Secret:          a.settings.AssistantHostToken,
			Header:          alertSignatureHeader,
			TimestampHeader: alertTimestampHeader,
		},
	})
}

// assistantHostChannels asks the host for the channels its bots can post to.
func (a *App) assistantHostChannels(ctx context.Context) ([]api.AlertChannelPlatform, int, error) {
	if a.settings.AssistantHostURL == "" || a.settings.AssistantHostToken == "" {
		return nil, http.StatusConflict, fmt.Errorf("set the assistant host URL and token in the app settings first")
	}
	ctx, cancel := context.WithTimeout(ctx, assistantHostTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.settings.AssistantHostURL+"/api/channels", nil)
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	req.Header.Set("Authorization", "Bearer "+a.settings.AssistantHostToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		backend.Logger.Warn("Assistant host unreachable", "error", err)
		return nil, http.StatusBadGateway, fmt.Errorf("the assistant host at %s is unreachable", a.settings.AssistantHostURL)
	}
	defer func() { _ = res.Body.Close() }()
	switch {
	case res.StatusCode == http.StatusUnauthorized:
		return nil, http.StatusBadGateway, fmt.Errorf("the assistant host refused the token: check that it matches the host's ALERT_WEBHOOK_TOKEN")
	case res.StatusCode != http.StatusOK:
		return nil, http.StatusBadGateway, fmt.Errorf("the assistant host answered %d", res.StatusCode)
	}
	var body struct {
		Platforms []api.AlertChannelPlatform `json:"platforms"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&body); err != nil {
		return nil, http.StatusBadGateway, fmt.Errorf("the assistant host sent an invalid channel list")
	}
	return body.Platforms, http.StatusOK, nil
}

func findAlertChannel(platforms []api.AlertChannelPlatform, platform, id string) (api.AlertChannel, bool) {
	for _, p := range platforms {
		if p.Platform != platform {
			continue
		}
		for _, channel := range p.Channels {
			if channel.ID == id {
				return channel, true
			}
		}
	}
	return api.AlertChannel{}, false
}

// alertWebhookQuery validates the options; those at their defaults are left out of the URL.
func alertWebhookQuery(req api.AlertWebhookRequest) (url.Values, error) {
	query := url.Values{}
	switch req.Investigate {
	case "", "mention":
	case "auto", "off":
		query.Set("investigate", req.Investigate)
	default:
		return nil, fmt.Errorf("investigate must be auto, mention, or off")
	}
	if req.Screenshots != nil && !*req.Screenshots {
		query.Set("screenshots", "off")
	}
	switch req.Format {
	case "", "host":
	case "grafana":
		query.Set("format", "grafana")
	default:
		return nil, fmt.Errorf("format must be host or grafana")
	}
	return query, nil
}

// alertChannelURL is the host route of a channel: Webex rooms by ID, Mattermost channels by team/channel.
func alertChannelURL(hostURL, platform string, channel api.AlertChannel, query url.Values) string {
	path := url.PathEscape(channel.ID)
	if platform == "mattermost" {
		parts := strings.Split(channel.Name, "/")
		for i, part := range parts {
			parts[i] = url.PathEscape(part)
		}
		path = strings.Join(parts, "/")
	}
	u := fmt.Sprintf("%s/alerts/%s/%s", hostURL, url.PathEscape(platform), path)
	if encoded := query.Encode(); encoded != "" {
		u += "?" + encoded
	}
	return u
}
