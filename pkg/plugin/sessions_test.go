package plugin

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

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
	app := &App{settings: appSettings{SessionNamespace: "deployment-a"}, sessionKeys: sessionTestKey{jose.JSONWebKey{Key: &key.PublicKey}}, sessionKeysURL: issuer + "api/signing-keys/keys"}
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
	r := httptest.NewRequest("GET", "/sessions", nil).WithContext(ctx)
	r.Header.Set(grafanaIDHeader, valid)
	scope, err := app.sessionScope(r)
	if err != nil {
		t.Fatal(err)
	}
	var parts []any
	if json.Unmarshal([]byte(scope), &parts) != nil || parts[3] != "stable-uid" {
		t.Fatal(scope)
	}
	for name, bad := range map[string]string{
		"missing": "", "forged": "not-a-token", "other org": token(issuer, "org:2", "stable-uid", types.TypeUser, time.Now().Add(time.Hour)),
		"other issuer":    token("https://evil.example/", "org:1", "stable-uid", types.TypeUser, time.Now().Add(time.Hour)),
		"expired":         token(issuer, "org:1", "stable-uid", types.TypeUser, time.Now().Add(-time.Hour)),
		"missing UID":     token(issuer, "org:1", "", types.TypeUser, time.Now().Add(time.Hour)),
		"service account": token(issuer, "org:1", "stable-uid", types.TypeServiceAccount, time.Now().Add(time.Hour)),
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
