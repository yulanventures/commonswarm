package api

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/gofrs/uuid"
	"github.com/golang-jwt/jwt/v5"
	"github.com/stretchr/testify/require"
	"github.com/supabase/auth/internal/api/provider"
	"github.com/supabase/auth/internal/models"
	"github.com/supabase/auth/internal/utilities"
)

// Discovery, signature, audience and expiry go through the pinned Google provider verifier.
func googleUSBIssuer(t *testing.T, audience string) *httptest.Server {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	other, err := rsa.GenerateKey(rand.Reader, 2048)
	require.NoError(t, err)
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			json.NewEncoder(w).Encode(map[string]any{"issuer": srv.URL, "authorization_endpoint": srv.URL + "/authorize", "token_endpoint": srv.URL + "/token", "jwks_uri": srv.URL + "/keys", "id_token_signing_alg_values_supported": []string{"RS256"}})
		case "/keys":
			json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &key.PublicKey, KeyID: "fixture", Algorithm: "RS256", Use: "sig"}}})
		case "/token":
			code := r.FormValue("code")
			reply := map[string]any{"access_token": "fixture", "token_type": "Bearer", "expires_in": 3600}
			if code != "no-id-token" {
				subject := "owner-sub"
				if code == "unlinked" || code == "non-owner" {
					subject = code
				}
				if code == "empty-sub" {
					subject = ""
				}
				claims := jwt.MapClaims{"iss": srv.URL, "sub": subject, "aud": audience, "exp": time.Now().Add(time.Minute).Unix(), "email": "owner@example.test", "email_verified": true}
				signer := key
				switch code {
				case "wrong-aud":
					claims["aud"] = "other-client"
				case "wrong-iss":
					claims["iss"] = "https://other.invalid"
				case "expired":
					claims["exp"] = time.Now().Add(-time.Minute).Unix()
				case "wrong-signature":
					signer = other
				}
				token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
				token.Header["kid"] = "fixture"
				signed, e := token.SignedString(signer)
				if e != nil {
					t.Error(e)
					return
				}
				reply["id_token"] = signed
			}
			json.NewEncoder(w).Encode(reply)
		default:
			http.NotFound(w, r)
		}
	}))
	provider.OverrideGoogleProvider(srv.URL, srv.URL+"/userinfo")
	t.Cleanup(func() { provider.ResetGoogleProvider(); srv.Close() })
	return srv
}

func (ts *ExternalTestSuite) TestGoogleUSBCodeOnly() {
	t := ts.T()
	googleUSBIssuer(t, ts.Config.External.Google.ClientID[0])
	owner, err := ts.createUser("", "owner@example.test", "", "", "")
	require.NoError(t, err)
	require.NoError(t, owner.Confirm(ts.API.db))
	other, err := ts.createUser("", "other@example.test", "", "", "")
	require.NoError(t, err)
	for sub, user := range map[string]*models.User{"owner-sub": owner, "non-owner": other} {
		identity, err := models.NewIdentity(user, "google", map[string]interface{}{"sub": sub})
		require.NoError(t, err)
		require.NoError(t, ts.API.db.Create(identity))
	}
	prior := ts.Config.IOSGoogleUSBOwnerID
	defer func() { ts.Config.IOSGoogleUSBOwnerID = prior }()
	const verifier = "fixture-google-usb-pkce-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])
	state := strings.Repeat("a", 64)
	target := googleUSBReturn + "?state=" + state
	args := url.Values{"provider": {"google"}, "redirect_to": {target}, "code_challenge_method": {"s256"}, "code_challenge": {challenge}}
	get := func(path string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		ts.API.handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		return w
	}
	refused := func(w *httptest.ResponseRecorder) {
		require.False(t, googleUSBScheme(w.Header().Get("Location")))
		require.NotEqual(t, 200, w.Code)
	}
	start := func() *httptest.ResponseRecorder { return get("/authorize?" + args.Encode()) }
	arm := func() {
		require.NoError(t, ts.API.db.RawQuery("DELETE FROM ios_google_usb_attempts WHERE owner_id = ?", owner.ID).Exec())
		require.NoError(t, ts.API.db.RawQuery("INSERT INTO ios_google_usb_attempts(owner_id,google_subject,binding) VALUES (?,'owner-sub',?)", owner.ID, googleUSBBinding(challenge, state)).Exec())
	}
	flowID := func(w *httptest.ResponseRecorder) string {
		require.Equal(t, 302, w.Code)
		dest, err := url.Parse(w.Header().Get("Location"))
		require.NoError(t, err)
		require.Contains(t, strings.Fields(dest.Query().Get("scope")), "openid")
		require.False(t, dest.Query().Has("redirect_to"))
		id := dest.Query().Get("state")
		require.NotEmpty(t, id)
		require.NotEqual(t, state, id)
		return id
	}
	callback := func(flow, code string) *httptest.ResponseRecorder {
		return get("/callback?" + url.Values{"state": {flow}, "code": {code}}.Encode())
	}
	redeem := func(code, proof string) int {
		body, _ := json.Marshal(map[string]string{"auth_code": code, "code_verifier": proof})
		r := httptest.NewRequest(http.MethodPost, "/token?grant_type=pkce", strings.NewReader(string(body)))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		ts.API.handler.ServeHTTP(w, r)
		return w.Code
	}
	require.False(t, utilities.IsRedirectURLValid(ts.Config, target))
	denied := func(w *httptest.ResponseRecorder) { require.GreaterOrEqual(t, w.Code, 400); refused(w) }
	ts.Config.IOSGoogleUSBOwnerID = ""
	denied(start())
	ts.Config.IOSGoogleUSBOwnerID = owner.ID.String()
	denied(start())
	arm()
	for _, row := range []struct{ k, v string }{
		{"code_challenge_method", "plain"}, {"code_challenge", strings.Repeat("A", 43)}, {"redirect_to", googleUSBReturn}, {"redirect_to", googleUSBReturn + "?state=" + strings.Repeat("b", 64)},
		{"redirect_to", target + "&extra=x"}, {"redirect_to", "commonswarm://auth/other?state=" + state}, {"provider", "github"},
	} {
		old := args.Get(row.k)
		args.Set(row.k, row.v)
		denied(start())
		args.Set(row.k, old)
	}
	denied(get("/authorize?" + args.Encode() + "&code_challenge=" + challenge))
	denied(get("/authorize?provider=google&redirect_to=" + url.QueryEscape(target)))
	_, err = ts.API.GetExternalProviderRedirectURL(httptest.NewRecorder(), httptest.NewRequest("GET", "/user/identities/authorize?"+args.Encode(), nil), owner)
	require.Error(t, err)
	// Leave the existing native GitHub switch closed.
	denied(get("/authorize?provider=github&redirect_to=" + url.QueryEscape(iosUSBCallback+"?state="+state)))
	emailUser, err := ts.createUser("", "usb-email@example.test", "", "", "usb-email-fixture")
	require.NoError(t, err)
	now := time.Now()
	emailUser.ConfirmationSentAt = &now
	require.NoError(t, ts.API.db.Update(emailUser))
	refused(get("/verify?type=signup&token=usb-email-fixture&redirect_to=" + url.QueryEscape(target)))
	counts := func() [2]int {
		u, e := ts.API.db.Count(&models.User{})
		require.NoError(t, e)
		i, e := ts.API.db.Count(&models.Identity{})
		require.NoError(t, e)
		return [2]int{u, i}
	}
	before := counts()
	for _, code := range []string{"unlinked", "non-owner", "no-id-token", "empty-sub", "wrong-aud", "wrong-iss", "wrong-signature", "expired"} {
		arm()
		denied(callback(flowID(start()), code))
	}
	require.Equal(t, before, counts())
	arm()
	require.NoError(t, ts.API.db.RawQuery("UPDATE ios_google_usb_attempts SET armed_at=now()-interval '6 minutes' WHERE owner_id=?", owner.ID).Exec())
	denied(start())
	arm()
	var wg sync.WaitGroup
	starts := make(chan *httptest.ResponseRecorder, 2)
	for range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); starts <- start() }()
	}
	wg.Wait()
	close(starts)
	var flow string
	for w := range starts {
		if w.Code == 302 {
			require.Empty(t, flow)
			flow = flowID(w)
		} else {
			denied(w)
		}
	}
	require.NotEmpty(t, flow)
	refused(callback(uuid.Must(uuid.NewV4()).String(), "ok"))
	refused(get("/callback?state=" + flow + "&state=" + flow + "&code=ok"))
	refused(get("/callback?state=" + flow + "&code=ok&code=ok"))
	ts.Config.IOSGoogleUSBOwnerID = ""
	denied(callback(flow, "ok"))
	ts.Config.IOSGoogleUSBOwnerID = owner.ID.String()
	success := callback(flow, "ok")
	require.Equal(t, 302, success.Code)
	dest, err := url.Parse(success.Header().Get("Location"))
	require.NoError(t, err)
	code := dest.Query().Get("code")
	require.NotEmpty(t, code)
	require.True(t, dest.String() == googleUSBReturn+"?"+url.Values{"state": {state}, "code": {code}}.Encode())
	require.Empty(t, success.Body.String())
	require.Equal(t, "no-store", success.Header().Get("Cache-Control"))
	refused(callback(flow, "ok"))
	denied(start())
	require.NotEqual(t, 200, redeem(code, ""))
	require.NotEqual(t, 200, redeem(code, "wrong"))
	ts.Config.IOSGoogleUSBOwnerID = ""
	require.NotEqual(t, 200, redeem(code, verifier))
	ts.Config.IOSGoogleUSBOwnerID = owner.ID.String()
	results := make(chan int, 2)
	for range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); results <- redeem(code, verifier) }()
	}
	wg.Wait()
	close(results)
	successes := 0
	for status := range results {
		if status == 200 {
			successes++
		}
	}
	require.Equal(t, 1, successes)
	require.NotEqual(t, 200, redeem(code, verifier))
	denied(start())
	arm()
	flow = flowID(start())
	require.NoError(t, ts.API.db.RawQuery("DELETE FROM ios_google_usb_attempts WHERE owner_id=?", owner.ID).Exec())
	denied(callback(flow, "ok"))
}
