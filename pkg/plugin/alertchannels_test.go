package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/grafana/grafana-plugin-sdk-go/backend"

	"github.com/elohmeier/grafana-pi-app/pkg/api"
)

// fakeAssistantHost serves GET /api/channels for the token "host-token".
func fakeAssistantHost(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/channels" || r.Header.Get("Authorization") != "Bearer host-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"platforms": []api.AlertChannelPlatform{
			{Platform: "webex", Bot: "Grafana Assistant", Channels: []api.AlertChannel{{ID: "Y2lzY29zcGFyazovL3VzL1JPT00vYQ", Name: "Ops Alerts", Title: "Ops Alerts"}}},
			{Platform: "mattermost", Bot: "grafana-assistant", Channels: []api.AlertChannel{{ID: "abc123", Name: "ops/alerts", Title: "Alerts"}}},
		}})
	}))
	t.Cleanup(server.Close)
	return server
}

func alertChannelApp(t *testing.T, hostURL, token string) *App {
	t.Helper()
	jsonData, _ := json.Marshal(map[string]any{"accessMode": accessModeAll, "assistantHostUrl": hostURL + "/"})
	inst, err := NewApp(context.Background(), backend.AppInstanceSettings{
		JSONData:                jsonData,
		DecryptedSecureJSONData: map[string]string{"assistantHostToken": token},
	})
	if err != nil {
		t.Fatalf("new app: %s", err)
	}
	return inst.(*App)
}

func callAlertChannels(t *testing.T, app *App, pc backend.PluginContext, method, path, body string) (int, []byte) {
	t.Helper()
	var sender mockCallResourceResponseSender
	if err := app.CallResource(context.Background(), &backend.CallResourceRequest{
		PluginContext: pc, Method: method, Path: path, Body: []byte(body),
	}, &sender); err != nil {
		t.Fatalf("CallResource: %s", err)
	}
	if len(sender.responses) != 1 {
		t.Fatalf("expected 1 response, got %d", len(sender.responses))
	}
	return sender.responses[0].Status, sender.responses[0].Body
}

func TestAlertChannelsListsTheHostChannelsForAdmins(t *testing.T) {
	host := fakeAssistantHost(t)
	app := alertChannelApp(t, host.URL, "host-token")

	status, body := callAlertChannels(t, app, adminPluginContext(), http.MethodGet, "alert-channels", "")
	if status != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", status, body)
	}
	var res api.AlertChannelsResponse
	if err := json.Unmarshal(body, &res); err != nil {
		t.Fatal(err)
	}
	if res.HostURL != host.URL || len(res.Platforms) != 2 || res.Platforms[0].Channels[0].Title != "Ops Alerts" {
		t.Fatalf("unexpected response %+v", res)
	}

	status, _ = callAlertChannels(t, app, viewerPluginContext("viewer", "viewer@example.com"), http.MethodGet, "alert-channels", "")
	if status != http.StatusForbidden {
		t.Fatalf("expected 403 for a viewer, got %d", status)
	}
}

func TestAlertChannelsReportsMissingSettingsAndWrongTokens(t *testing.T) {
	host := fakeAssistantHost(t)
	status, body := callAlertChannels(t, alertChannelApp(t, "", ""), adminPluginContext(), http.MethodGet, "alert-channels", "")
	if status != http.StatusConflict {
		t.Fatalf("expected 409 without settings, got %d: %s", status, body)
	}
	status, body = callAlertChannels(t, alertChannelApp(t, host.URL, "wrong"), adminPluginContext(), http.MethodGet, "alert-channels", "")
	if status != http.StatusBadGateway || !json.Valid(body) {
		t.Fatalf("expected 502 for a refused token, got %d: %s", status, body)
	}
}

func TestAlertWebhookSettingsForWebexAndMattermost(t *testing.T) {
	host := fakeAssistantHost(t)
	app := alertChannelApp(t, host.URL, "host-token")

	cases := []struct {
		body string
		url  string
	}{
		{`{"platform":"webex","channelId":"Y2lzY29zcGFyazovL3VzL1JPT00vYQ"}`, host.URL + "/alerts/webex/Y2lzY29zcGFyazovL3VzL1JPT00vYQ"},
		{`{"platform":"webex","channelId":"Y2lzY29zcGFyazovL3VzL1JPT00vYQ","investigate":"auto","screenshots":false,"format":"grafana"}`, host.URL + "/alerts/webex/Y2lzY29zcGFyazovL3VzL1JPT00vYQ?format=grafana&investigate=auto&screenshots=off"},
		{`{"platform":"mattermost","channelId":"abc123","investigate":"mention"}`, host.URL + "/alerts/mattermost/ops/alerts"},
	}
	for _, c := range cases {
		status, body := callAlertChannels(t, app, adminPluginContext(), http.MethodPost, "alert-channels/webhook", c.body)
		if status != http.StatusOK {
			t.Fatalf("%s: expected 200, got %d: %s", c.body, status, body)
		}
		var settings api.AlertWebhookSettings
		if err := json.Unmarshal(body, &settings); err != nil {
			t.Fatal(err)
		}
		want := api.AlertWebhookSettings{URL: c.url, HTTPMethod: "POST", HMACConfig: api.AlertWebhookHMAC{
			Secret: "host-token", Header: "X-Grafana-Alerting-Signature", TimestampHeader: "X-Grafana-Alerting-Timestamp",
		}}
		if settings != want {
			t.Fatalf("%s: got %+v, want %+v", c.body, settings, want)
		}
	}
}

func TestAlertWebhookRefusesUnknownChannelsAndOptions(t *testing.T) {
	host := fakeAssistantHost(t)
	app := alertChannelApp(t, host.URL, "host-token")
	for body, want := range map[string]int{
		`{"platform":"webex","channelId":"elsewhere"}`:                           http.StatusNotFound,
		`{"platform":"mattermost","channelId":"Y2lzY29zcGFyazovL3VzL1JPT00vYQ"}`: http.StatusNotFound,
		`{"platform":"webex","channelId":"x","investigate":"always"}`:            http.StatusBadRequest,
		`{"platform":"webex","channelId":"x","format":"html"}`:                   http.StatusBadRequest,
	} {
		if status, res := callAlertChannels(t, app, adminPluginContext(), http.MethodPost, "alert-channels/webhook", body); status != want {
			t.Fatalf("%s: expected %d, got %d: %s", body, want, status, res)
		}
	}
	if status, _ := callAlertChannels(t, app, viewerPluginContext("v", "v@example.com"), http.MethodPost, "alert-channels/webhook", `{"platform":"webex","channelId":"Y2lzY29zcGFyazovL3VzL1JPT00vYQ"}`); status != http.StatusForbidden {
		t.Fatalf("expected 403 for a viewer, got %d", status)
	}
}
