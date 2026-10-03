package plugin

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/elohmeier/grafana-pi-app/pkg/chatlog"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
	"github.com/grafana/authlib/authn"
	"github.com/grafana/authlib/types"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/config"
)

type sessionTestKey struct{ key jose.JSONWebKey }

func (k sessionTestKey) Get(context.Context, string) (*jose.JSONWebKey, error) { return &k.key, nil }

//nolint:staticcheck // Exercise the numeric organization context required by Grafana's ID token audience.
func TestSessionIdentityScope(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	const issuer = "http://grafana.example/"
	app := &App{settings: appSettings{SessionNamespace: "deployment-a"}, idKeys: sessionTestKey{jose.JSONWebKey{Key: &key.PublicKey}}, idKeysURL: issuer + "api/signing-keys/keys"}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: key}, (&jose.SignerOptions{}).WithType("jwt").WithHeader("kid", "test-key"))
	if err != nil {
		t.Fatal(err)
	}
	token := func(iss, audience, uid string, identity types.IdentityType, expiry time.Time) string {
		raw, err := jwt.Signed(signer).Claims(jwt.Claims{Issuer: iss, Subject: "user:1", Audience: []string{audience}, Expiry: jwt.NewNumericDate(expiry), IssuedAt: jwt.NewNumericDate(time.Now())}).Claims(authn.IDTokenClaims{Identifier: uid, Type: identity, Namespace: "default"}).Serialize()
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	ctx := config.WithGrafanaConfig(t.Context(), config.NewGrafanaCfg(map[string]string{config.AppURL: issuer}))
	ctx = backend.WithPluginContext(ctx, backend.PluginContext{OrgID: 1, PluginID: "grafana-assistant-app", Namespace: "default", User: &backend.User{Login: "mutable-login"}})
	valid := token(issuer, "org:1", "stable-uid", types.TypeUser, time.Now().Add(time.Hour))
	r := httptest.NewRequest("GET", "/chats", nil).WithContext(ctx)
	r.Header.Set(grafanaIDHeader, valid)
	scope, err := app.sessionScope(r)
	if err != nil {
		t.Fatal(err)
	}
	var parts []any
	if json.Unmarshal([]byte(scope), &parts) != nil || parts[3] != "stable-uid" {
		t.Fatal(scope)
	}
	// The assistant host stores chats as a service account, in a scope apart from users.
	r.Header.Set(grafanaIDHeader, token(issuer, "org:1", "stable-uid", types.TypeServiceAccount, time.Now().Add(time.Hour)))
	scope, err = app.sessionScope(r)
	if err != nil {
		t.Fatal(err)
	}
	if json.Unmarshal([]byte(scope), &parts) != nil || parts[3] != "service-account:stable-uid" {
		t.Fatal(scope)
	}
	for name, bad := range map[string]string{
		"missing": "", "forged": "not-a-token", "other org": token(issuer, "org:2", "stable-uid", types.TypeUser, time.Now().Add(time.Hour)),
		"other issuer": token("https://evil.example/", "org:1", "stable-uid", types.TypeUser, time.Now().Add(time.Hour)),
		"expired":      token(issuer, "org:1", "stable-uid", types.TypeUser, time.Now().Add(-time.Hour)),
		"missing UID":  token(issuer, "org:1", "", types.TypeUser, time.Now().Add(time.Hour)),
		"anonymous":    token(issuer, "org:1", "stable-uid", types.TypeAnonymous, time.Now().Add(time.Hour)),
	} {
		t.Run(name, func(t *testing.T) {
			r.Header.Set(grafanaIDHeader, bad)
			if _, err := app.sessionScope(r); err == nil {
				t.Fatal("accepted invalid identity")
			}
		})
	}
	for _, other := range []backend.PluginContext{
		{OrgID: 2, PluginID: "grafana-assistant-app", User: &backend.User{}},
		{OrgID: 1, PluginID: "g42-pi-app", User: &backend.User{}},
	} {
		otherCtx := backend.WithPluginContext(ctx, other)
		r = r.WithContext(otherCtx)
		r.Header.Set(grafanaIDHeader, token(issuer, "org:"+strconv.FormatInt(other.OrgID, 10), "stable-uid", types.TypeUser, time.Now().Add(time.Hour)))
		value, err := app.sessionScope(r)
		if err != nil || value == scope {
			t.Fatalf("scope not isolated: %s %v", value, err)
		}
	}
}

type chatTestEnv struct {
	t      *testing.T
	mux    *http.ServeMux
	ctx    context.Context
	token  func(uid string) string
	signer jose.Signer
}

func newChatTestEnv(t *testing.T) *chatTestEnv {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	const issuer = "http://grafana.example/"
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: key}, (&jose.SignerOptions{}).WithType("jwt").WithHeader("kid", "test-key"))
	if err != nil {
		t.Fatal(err)
	}
	store, err := chatlog.OpenSQLite(t.Context(), filepath.Join(t.TempDir(), "chats.db"))
	if err != nil {
		t.Fatal(err)
	}
	app := &App{
		settings:  appSettings{SessionNamespace: "default", AccessMode: accessModeAll},
		idKeys:    sessionTestKey{jose.JSONWebKey{Key: &key.PublicKey}},
		idKeysURL: issuer + "api/signing-keys/keys",
		chatStore: store,
	}
	t.Cleanup(app.Dispose)
	mux := http.NewServeMux()
	app.registerRoutes(mux)
	ctx := config.WithGrafanaConfig(context.Background(), config.NewGrafanaCfg(map[string]string{config.AppURL: issuer}))
	ctx = backend.WithPluginContext(ctx, backend.PluginContext{OrgID: 1, PluginID: "grafana-assistant-app", User: &backend.User{Login: "user"}}) //nolint:staticcheck // OrgID is required by the ID token audience.
	return &chatTestEnv{t: t, mux: mux, ctx: ctx, signer: signer, token: func(uid string) string {
		raw, err := jwt.Signed(signer).Claims(jwt.Claims{Issuer: issuer, Subject: "user:1", Audience: []string{"org:1"}, Expiry: jwt.NewNumericDate(time.Now().Add(time.Hour)), IssuedAt: jwt.NewNumericDate(time.Now())}).Claims(authn.IDTokenClaims{Identifier: uid, Type: types.TypeUser, Namespace: "default"}).Serialize()
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}}
}

// do sends a request as user uid and returns status and body.
func (e *chatTestEnv) do(uid, method, path, body string) (int, string) {
	e.t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body)).WithContext(e.ctx)
	if uid != "" {
		r.Header.Set(grafanaIDHeader, e.token(uid))
	}
	w := httptest.NewRecorder()
	e.mux.ServeHTTP(w, r)
	if uid != "" && w.Code != http.StatusNoContent && w.Code != http.StatusMethodNotAllowed && w.Header().Get("Cache-Control") != "no-store" {
		e.t.Fatalf("%s %s: missing Cache-Control", method, path)
	}
	return w.Code, w.Body.String()
}

func (e *chatTestEnv) expect(uid, method, path, body string, status int, v any) string {
	e.t.Helper()
	code, text := e.do(uid, method, path, body)
	if code != status {
		e.t.Fatalf("%s %s: status %d, want %d: %s", method, path, code, status, text)
	}
	if v != nil {
		if err := json.Unmarshal([]byte(text), v); err != nil {
			e.t.Fatalf("%s %s: %v: %s", method, path, err, text)
		}
	}
	return text
}

type openResponse struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	Epoch     int64     `json:"epoch"`
	LastSeq   int64     `json:"lastSeq"`
}

func TestChatRoutes(t *testing.T) {
	e := newChatTestEnv(t)
	const alice, bob = "alice-uid", "bob-uid"

	var opened openResponse
	e.expect(alice, "POST", "/chats/chat-1/open", `{"title":" Disk usage "}`, 200, &opened)
	if opened.ID != "chat-1" || opened.Title != "Disk usage" || opened.Epoch != 1 || opened.LastSeq != 0 || opened.CreatedAt.IsZero() {
		t.Fatalf("%+v", opened)
	}
	var reopened openResponse
	e.expect(alice, "POST", "/chats/chat-1/open", "", 200, &reopened)
	if reopened.Epoch != 2 || reopened.Title != "Disk usage" {
		t.Fatalf("%+v", reopened)
	}
	e.expect(alice, "POST", "/chats/unknown/open", `{"create":false}`, 404, nil)
	e.expect(alice, "POST", "/chats/existing/open", `{}`, 200, nil)
	e.expect(alice, "POST", "/chats/existing/open", `{"create":false}`, 200, &reopened)
	if reopened.Epoch != 2 {
		t.Fatalf("%+v", reopened)
	}
	e.expect(alice, "DELETE", "/chats/existing", "", 204, nil)

	body := "{\"role\": \"user\",\n \"content\":\"<b>a & b</b> \\u00e9\"}"
	commit := func(epoch, seq int64, digest, rows string) string {
		return fmt.Sprintf(`{"epoch":%d,"seq":%d,"digest":%q,"rows":%s}`, epoch, seq, digest, rows)
	}
	var committed struct {
		Seq       int64     `json:"seq"`
		UpdatedAt time.Time `json:"updatedAt"`
	}
	rows := `[{"body":` + body + `},{"body":{"state":1},"key":"state","replace":true},{"body":[1, 2]}]`
	e.expect(alice, "POST", "/chats/chat-1/commits", commit(2, 1, "d1", rows), 200, &committed)
	if committed.Seq != 1 || committed.UpdatedAt.IsZero() {
		t.Fatalf("%+v", committed)
	}
	e.expect(alice, "POST", "/chats/chat-1/commits", commit(2, 1, "d1", rows), 200, nil) // Lost-response retry.
	conflict := func(epoch, seq int64, reason string) {
		t.Helper()
		var res map[string]string
		e.expect(alice, "POST", "/chats/chat-1/commits", commit(epoch, seq, "x", `[]`), 409, &res)
		if res["reason"] != reason || res["error"] == "" {
			t.Fatal(res)
		}
	}
	conflict(2, 1, "sequence")
	conflict(1, 2, "lease")
	e.expect(alice, "POST", "/chats/chat-1/commits", `{"epoch":2,"seq":2,"digest":"d2","title":"Renamed by commit","rows":[{"body":{"state":2},"key":"state","replace":true}]}`, 200, nil)

	// The log embeds bodies verbatim, not as strings and not re-encoded.
	text := e.expect(alice, "GET", "/chats/chat-1/log", "", 200, nil)
	want := `{"rows":[{"seq":1,"idx":0,"body":` + body + `},{"seq":1,"idx":2,"body":[1, 2]},{"seq":2,"idx":0,"body":{"state":2}}]}` + "\n"
	if text != want {
		t.Fatalf("log\n%s\nwant\n%s", text, want)
	}
	var page struct {
		Rows []struct {
			Seq  int64           `json:"seq"`
			Idx  int             `json:"idx"`
			Body json.RawMessage `json:"body"`
		} `json:"rows"`
		NextCursor string `json:"nextCursor"`
	}
	e.expect(alice, "GET", "/chats/chat-1/log?limit=2", "", 200, &page)
	if len(page.Rows) != 2 || page.NextCursor == "" {
		t.Fatalf("%+v", page)
	}
	logCursor := page.NextCursor
	page.NextCursor = ""
	e.expect(alice, "GET", "/chats/chat-1/log?limit=2&cursor="+logCursor, "", 200, &page)
	if len(page.Rows) != 1 || page.Rows[0].Seq != 2 || page.NextCursor != "" {
		t.Fatalf("%+v", page)
	}

	var list struct {
		Items []struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		} `json:"items"`
		NextCursor string `json:"nextCursor"`
	}
	e.expect(alice, "POST", "/chats/chat-2/open", `{}`, 200, nil)
	e.expect(alice, "GET", "/chats?limit=1", "", 200, &list)
	if len(list.Items) != 1 || list.Items[0].ID != "chat-2" || list.NextCursor == "" {
		t.Fatalf("%+v", list)
	}
	cursor := list.NextCursor
	list.NextCursor = ""
	e.expect(alice, "GET", "/chats?cursor="+cursor, "", 200, &list)
	if len(list.Items) != 1 || list.Items[0].ID != "chat-1" || list.Items[0].Title != "Renamed by commit" || list.NextCursor != "" {
		t.Fatalf("%+v", list)
	}

	var renamed map[string]any
	e.expect(alice, "PATCH", "/chats/chat-2", `{"title":"Second"}`, 200, &renamed)
	if renamed["title"] != "Second" || renamed["id"] != "chat-2" || renamed["epoch"] != nil {
		t.Fatal(renamed)
	}

	// Bob sees none of Alice's chats.
	e.expect(bob, "GET", "/chats", "", 200, &list)
	if len(list.Items) != 0 {
		t.Fatalf("%+v", list)
	}
	e.expect(bob, "GET", "/chats/chat-1/log", "", 404, nil)
	e.expect(bob, "POST", "/chats/chat-1/commits", commit(2, 3, "d3", `[]`), 404, nil)
	e.expect(bob, "PATCH", "/chats/chat-1", `{"title":"x"}`, 404, nil)

	e.expect(alice, "DELETE", "/chats/chat-1", "", 204, nil)
	e.expect(alice, "DELETE", "/chats/chat-1", "", 204, nil)
	e.expect(alice, "POST", "/chats/chat-1/open", `{"title":"again"}`, 410, nil)
	e.expect(alice, "POST", "/chats/chat-1/commits", commit(2, 3, "d3", `[]`), 410, nil)
	e.expect(alice, "GET", "/chats/chat-1/log", "", 410, nil)
	e.expect(alice, "PATCH", "/chats/chat-1", `{"title":"x"}`, 410, nil)
	e.expect(alice, "GET", "/chats", "", 200, &list)
	if len(list.Items) != 1 || list.Items[0].ID != "chat-2" {
		t.Fatalf("%+v", list)
	}
}

func TestChatRouteErrors(t *testing.T) {
	e := newChatTestEnv(t)
	const u = "user-uid"
	e.expect(u, "POST", "/chats/c/open", "", 200, nil)
	for _, tc := range []struct {
		method, path, body string
		status             int
	}{
		{"GET", "/chats", "", 200},
		{"GET", "/chats?limit=0", "", 400},
		{"GET", "/chats?limit=x", "", 400},
		{"GET", "/chats?limit=1000", "", 200}, // Clamped to the maximum.
		{"GET", "/chats?cursor=bogus!", "", 400},
		{"POST", "/chats/bad.id/open", "", 400},
		{"POST", "/chats/c/open", "{", 400},
		{"POST", "/chats/c/open", `{} {}`, 400},
		{"GET", "/chats/missing/log", "", 404},
		{"GET", "/chats/c/log?limit=-1", "", 400},
		{"POST", "/chats/missing/commits", `{"epoch":1,"seq":1,"digest":"d","rows":[]}`, 404},
		{"POST", "/chats/c/commits", `{"epoch":1,"seq":1,"digest":"d","rows":[{"key":"k"}]}`, 400},
		{"POST", "/chats/c/commits", `{"epoch":1,"seq":1,"digest":"d","rows":[{"body":1,"replace":true}]}`, 400},
		{"POST", "/chats/c/commits", "", 400},
		{"PATCH", "/chats/c", `{}`, 400},
		{"PATCH", "/chats/missing", `{"title":"x"}`, 404},
		{"PUT", "/chats/c", `{}`, 405},
	} {
		if code, text := e.do(u, tc.method, tc.path, tc.body); code != tc.status {
			t.Errorf("%s %s %s: %d, want %d: %s", tc.method, tc.path, tc.body, code, tc.status, text)
		}
	}
	if code, text := e.do("", "GET", "/chats", ""); code != 401 || !strings.Contains(text, `"error"`) {
		t.Fatal(code, text)
	}
	big := `{"epoch":1,"seq":1,"digest":"d","rows":[{"body":"` + strings.Repeat("x", maxCommitBodyBytes) + `"}]}`
	if code, _ := e.do(u, "POST", "/chats/c/commits", big); code != http.StatusRequestEntityTooLarge {
		t.Fatal(code)
	}
}

func TestCheckHealthReportsChatStorage(t *testing.T) {
	t.Setenv("GF_PLUGIN_SQLITE_PATH", filepath.Join(t.TempDir(), "data", "chats.db"))
	app := &App{settings: appSettings{PluginID: "grafana-assistant-app", OpenAIAPIKey: "key", Models: []modelSettings{{ID: "m", Default: true}}}}
	defer app.Dispose()
	res, err := app.CheckHealth(t.Context(), &backend.CheckHealthRequest{})
	if err != nil || res.Status != backend.HealthStatusOk || !strings.Contains(res.Message, "SQLite") {
		t.Fatal(res, err)
	}
	app.settings.OpenAIAPIKey = ""
	if res, _ = app.CheckHealth(t.Context(), &backend.CheckHealthRequest{}); res.Status != backend.HealthStatusError || res.Message != "OpenAI-compatible API key is not configured" {
		t.Fatal(res)
	}
	broken := &App{settings: appSettings{SessionPostgresDSN: "postgres://invalid host", SessionSchema: "grafana_pi", OpenAIAPIKey: "key"}}
	defer broken.Dispose()
	if res, _ = broken.CheckHealth(t.Context(), &backend.CheckHealthRequest{}); res.Status != backend.HealthStatusError || !strings.Contains(res.Message, "PostgreSQL") {
		t.Fatal(res)
	}
}
