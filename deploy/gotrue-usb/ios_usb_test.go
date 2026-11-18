package api

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gofrs/uuid"
	"github.com/stretchr/testify/require"
	"github.com/supabase/auth/internal/models"
	"github.com/supabase/auth/internal/utilities"
)

func (ts *ExternalTestSuite) TestIOSUSBCodeOnly() {
	t := ts.T()
	const verifier = "local-pkce-test-verifier-000000000000000000000000"
	hash := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(hash[:])
	state := strings.Repeat("a", 64)
	target := iosUSBCallback + "?state=" + state
	base := url.Values{"provider": {"github"}, "code_challenge_method": {"s256"}, "code_challenge": {challenge}, "redirect_to": {target}}

	get := func(path string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		ts.API.handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		return w
	}
	start := func() string {
		w := get("/authorize?" + base.Encode())
		require.Equal(t, http.StatusFound, w.Code)
		dest, err := url.Parse(w.Header().Get("Location"))
		require.NoError(t, err)
		require.Empty(t, dest.Query().Get("redirect_to"))
		id := dest.Query().Get("state")
		require.NotEmpty(t, id)
		return id
	}
	assertNoNative := func(w *httptest.ResponseRecorder) {
		require.False(t, isIOSUSBURI(w.Header().Get("Location")))
	}
	callback := func(id string) *httptest.ResponseRecorder { return get("/callback?code=fixture&state=" + id) }
	requestToken := func(code, proof string) int {
		body, _ := json.Marshal(map[string]string{"auth_code": code, "code_verifier": proof})
		req := httptest.NewRequest(http.MethodPost, "/token?grant_type=pkce", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		ts.API.handler.ServeHTTP(w, req)
		return w.Code
	}

	oldOwner, oldProvider := ts.Config.IOSUSBOwnerID, ts.Config.External.Github.URL
	defer func() { ts.Config.IOSUSBOwnerID = oldOwner; ts.Config.External.Github.URL = oldProvider }()
	ts.Config.IOSUSBOwnerID = ""
	require.Equal(t, http.StatusForbidden, get("/authorize?"+base.Encode()).Code)
	owner, err := ts.createUser("", "usb@example.com", "", "", "")
	require.NoError(t, err)
	require.NoError(t, owner.Confirm(ts.API.db))
	ts.Config.IOSUSBOwnerID = owner.ID.String()
	require.False(t, utilities.IsRedirectURLValid(ts.Config, target))
	linkRequest := httptest.NewRequest(http.MethodGet, "/user/identities/authorize?"+base.Encode(), nil)
	_, err = ts.API.GetExternalProviderRedirectURL(httptest.NewRecorder(), linkRequest, owner)
	require.Error(t, err)

	emailUser, err := ts.createUser("", "email-flow@example.com", "", "", "fixture-confirmation")
	require.NoError(t, err)
	now := time.Now()
	emailUser.ConfirmationSentAt = &now
	require.NoError(t, ts.API.db.Update(emailUser))
	emailResponse := get("/verify?type=signup&token=fixture-confirmation&redirect_to=" + url.QueryEscape(target))
	require.Equal(t, http.StatusSeeOther, emailResponse.Code)
	assertNoNative(emailResponse)
	confirmed, err := models.FindUserByID(ts.API.db, emailUser.ID)
	require.NoError(t, err)
	require.True(t, confirmed.IsConfirmed())

	for _, row := range []struct{ key, value string }{
		{"code_challenge_method", "plain"}, {"code_challenge", ""}, {"redirect_to", iosUSBCallback},
		{"redirect_to", target + "&extra=value"}, {"redirect_to", iosUSBCallback + "?state=short"},
		{"redirect_to", strings.Replace(target, "/callback", "/elsewhere", 1)},
		{"invite_token", "a"}, {"provider", "google"},
	} {
		q, err := url.ParseQuery(base.Encode())
		require.NoError(t, err)
		q.Set(row.key, row.value)
		w := get("/authorize?" + q.Encode())
		require.GreaterOrEqual(t, w.Code, 400)
		assertNoNative(w)
	}
	require.GreaterOrEqual(t, get("/authorize?provider=github&redirect_to="+url.QueryEscape(target)).Code, 400)
	assertNoNative(callback(""))
	assertNoNative(callback(uuid.Must(uuid.NewV4()).String()))
	id := start()
	ts.Config.IOSUSBOwnerID = ""
	assertNoNative(callback(id))
	ts.Config.IOSUSBOwnerID = owner.ID.String()
	tokenCalls, userCalls := 0, 0
	provider := GitHubTestSignupSetup(ts, &tokenCalls, &userCalls, "fixture", `[{"email":"usb@example.com","primary":true,"verified":true}]`)
	defer provider.Close()

	counts := func() [2]int {
		u, err := ts.API.db.Count(&models.User{})
		require.NoError(t, err)
		i, err := ts.API.db.Count(&models.Identity{})
		require.NoError(t, err)
		return [2]int{u, i}
	}
	before := counts()
	// The provider email matches the owner, but this subject has never been linked.
	w := callback(start())
	require.Equal(t, http.StatusForbidden, w.Code)
	assertNoNative(w)
	require.Equal(t, before, counts())
	identity, err := models.NewIdentity(owner, "github", map[string]interface{}{"sub": "123"})
	require.NoError(t, err)
	require.NoError(t, ts.API.db.Create(identity))
	other, err := ts.createUser("", "other@example.com", "", "", "")
	require.NoError(t, err)
	ts.Config.IOSUSBOwnerID = other.ID.String()
	before = counts()
	w = callback(start())
	require.Equal(t, http.StatusForbidden, w.Code)
	assertNoNative(w)
	require.Equal(t, before, counts())
	ts.Config.IOSUSBOwnerID = owner.ID.String()

	id = start()
	assertNoNative(get("/callback?state=" + id + "&error=access_denied"))
	w = callback(start())
	require.Equal(t, http.StatusFound, w.Code)
	dest, err := url.Parse(w.Header().Get("Location"))
	require.NoError(t, err)
	code := dest.Query().Get("code")
	require.NotEmpty(t, code)
	expected := url.Values{"code": {code}, "state": {state}}
	require.Equal(t, iosUSBCallback+"?"+expected.Encode(), dest.String())
	require.Empty(t, w.Body.String())
	require.NotEqual(t, 200, requestToken(code, ""))
	require.NotEqual(t, 200, requestToken(code, "wrong"))
	ts.Config.IOSUSBOwnerID = ""
	require.NotEqual(t, 200, requestToken(code, verifier))
	ts.Config.IOSUSBOwnerID = owner.ID.String()
	var wg sync.WaitGroup
	results := make(chan int, 2)
	for range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); results <- requestToken(code, verifier) }()
	}
	wg.Wait()
	close(results)
	success := 0
	for status := range results {
		if status == 200 {
			success++
		}
	}
	require.Equal(t, 1, success)
	require.NotEqual(t, 200, requestToken(code, verifier))
}
