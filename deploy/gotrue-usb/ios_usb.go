package api

import (
	"encoding/base64"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/gofrs/uuid"
	"github.com/supabase/auth/internal/api/apierrors"
	"github.com/supabase/auth/internal/models"
	"github.com/supabase/auth/internal/storage"
)

// Personal Team USB test only. This URI must never enter the shared URIAllowList.
const iosUSBCallback = "com.commonswarm.ios://auth/callback"

var iosUSBState = regexp.MustCompile("^[0-9a-f]{64}$")

func iosUSBRefused() error {
	return apierrors.NewForbiddenError(apierrors.ErrorCodeValidationFailed, "Native test sign-in unavailable")
}

func isIOSUSBURI(raw string) bool {
	scheme, _, _ := strings.Cut(raw, ":")
	return strings.EqualFold(scheme, "com.commonswarm.ios")
}

func isIOSUSBFlow(flow *models.FlowState) bool {
	return flow != nil && flow.Referrer != nil && isIOSUSBURI(*flow.Referrer)
}

func iosUSBSavedState(raw string) (string, bool) {
	state, ok := strings.CutPrefix(raw, iosUSBCallback+"?state=")
	return state, ok && iosUSBState.MatchString(state)
}

func iosUSBS256(method, challenge string) bool {
	data, err := base64.RawURLEncoding.Strict().DecodeString(challenge)
	return strings.EqualFold(method, "s256") && err == nil && len(data) == 32 && len(challenge) == 43
}

func (a *API) iosUSBStartAllowed(r *http.Request, raw string, link *models.User) bool {
	owner, err := uuid.FromString(a.config.IOSUSBOwnerID)
	if err != nil || owner == uuid.Nil || owner.String() != a.config.IOSUSBOwnerID ||
		link != nil || r.Method != http.MethodGet || r.Header.Get("redirect_to") != "" {
		return false
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || len(query) != 4 {
		return false
	}
	for _, name := range []string{"provider", "redirect_to", "code_challenge_method", "code_challenge"} {
		if len(query[name]) != 1 {
			return false
		}
	}
	_, ok := iosUSBSavedState(raw)
	return ok && query.Get("provider") == "github" && iosUSBS256(query.Get("code_challenge_method"), query.Get("code_challenge"))
}

func (a *API) iosUSBGrantAllowed(flow *models.FlowState) bool {
	if !isIOSUSBFlow(flow) || a.config.IOSUSBOwnerID == "" || flow.ProviderType != "github" ||
		flow.AuthenticationMethod != models.OAuth.String() || flow.InviteToken != nil || flow.LinkingTargetID != nil ||
		flow.CodeChallengeMethod == nil || flow.CodeChallenge == nil || flow.AuthCode == nil {
		return false
	}
	_, ok := iosUSBSavedState(*flow.Referrer)
	return ok && iosUSBS256(*flow.CodeChallengeMethod, *flow.CodeChallenge)
}

func iosUSBEligibleUser(user *models.User, aud string) bool {
	return user != nil && !user.IsAnonymous && !user.IsBanned() && user.DeletedAt == nil && user.IsConfirmed() && user.Aud == aud
}

func (a *API) iosUSBCallback(w http.ResponseWriter, r *http.Request, flow *models.FlowState) error {
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || r.Method != http.MethodGet || !a.iosUSBGrantAllowed(flow) ||
		len(q["state"]) != 1 || q.Get("state") != flow.ID.String() ||
		len(q["code"]) != 1 || q.Get("code") == "" || q.Has("error") {
		return iosUSBRefused()
	}
	data, err := a.handleOAuthCallback(r)
	if err != nil || data.userData == nil || data.userData.Metadata == nil || data.userData.Metadata.Subject == "" {
		return iosUSBRefused()
	}

	var location string
	err = a.db.WithContext(r.Context()).Transaction(func(tx *storage.Connection) error {
		locked, err := models.FindFlowStateByIDForUpdate(tx, flow.ID.String())
		if err != nil || !a.iosUSBGrantAllowed(locked) || locked.UserID != nil ||
			locked.IsExpired(a.config.External.FlowStateExpiryDuration) {
			return iosUSBRefused()
		}
		identity, err := models.FindIdentityByIdAndProvider(tx, data.userData.Metadata.Subject, locked.ProviderType)
		if err != nil || identity.UserID.String() != a.config.IOSUSBOwnerID {
			return iosUSBRefused()
		}
		user, err := models.FindUserByID(tx, identity.UserID)
		if err != nil || !iosUSBEligibleUser(user, a.requestAud(r.Context(), r)) {
			return iosUSBRefused()
		}
		now := time.Now()
		locked.UserID = &user.ID
		locked.AuthCodeIssuedAt = &now
		if err := tx.UpdateOnly(locked, "user_id", "auth_code_issued_at"); err != nil {
			return err
		}
		state, _ := iosUSBSavedState(*locked.Referrer)
		location = iosUSBCallback + "?" + url.Values{"state": {state}, "code": {*locked.AuthCode}}.Encode()
		return nil
	})
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Location", location)
	w.WriteHeader(http.StatusFound)
	return nil
}
