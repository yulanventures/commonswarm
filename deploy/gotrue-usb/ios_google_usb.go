package api

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gofrs/uuid"
	"github.com/supabase/auth/internal/models"
	"github.com/supabase/auth/internal/storage"
)

const googleUSBReturn = "commonswarm://auth/callback"

func googleUSBScheme(raw string) bool {
	scheme, _, _ := strings.Cut(raw, ":")
	return strings.EqualFold(scheme, "commonswarm")
}

func googleUSBFlow(f *models.FlowState) bool {
	return f != nil && f.Referrer != nil && googleUSBScheme(*f.Referrer)
}

func googleUSBState(raw string) (string, bool) {
	state, ok := strings.CutPrefix(raw, googleUSBReturn+"?state=")
	return state, ok && iosUSBState.MatchString(state)
}

func googleUSBBinding(challenge, state string) string {
	digest := sha256.Sum256([]byte("commonswarm-google-usb-v1\n" + challenge + "\n" + state))
	return hex.EncodeToString(digest[:])
}

func (a *API) googleUSBEnabled() bool {
	owner, err := uuid.FromString(a.config.IOSGoogleUSBOwnerID)
	return err == nil && owner != uuid.Nil && owner.String() == a.config.IOSGoogleUSBOwnerID
}

func (a *API) googleUSBStartAllowed(r *http.Request, raw string, linking *models.User) bool {
	if !a.googleUSBEnabled() || linking != nil || r.Method != http.MethodGet || r.Header.Get("redirect_to") != "" {
		return false
	}
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || len(q) != 4 {
		return false
	}
	for _, k := range []string{"provider", "redirect_to", "code_challenge", "code_challenge_method"} {
		if len(q[k]) != 1 {
			return false
		}
	}
	_, valid := googleUSBState(raw)
	return valid && q.Get("provider") == "google" && iosUSBS256(q.Get("code_challenge_method"), q.Get("code_challenge"))
}

// A trusted operator provisions only the phone's binding digest. No public grant-creation route exists.
// Check the same five-minute database-clock window at claim, callback, and redemption.
func (a *API) googleUSBAdmission(tx *storage.Connection, f *models.FlowState, claim bool, subject string) error {
	if !a.googleUSBEnabled() || !googleUSBFlow(f) || f.ProviderType != "google" || f.InviteToken != nil ||
		f.LinkingTargetID != nil || f.AuthenticationMethod != models.OAuth.String() || f.AuthCode == nil ||
		f.CodeChallenge == nil || f.CodeChallengeMethod == nil || !iosUSBS256(*f.CodeChallengeMethod, *f.CodeChallenge) {
		return iosUSBRefused()
	}
	state, ok := googleUSBState(*f.Referrer)
	if !ok {
		return iosUSBRefused()
	}
	owner := a.config.IOSGoogleUSBOwnerID
	binding := googleUSBBinding(*f.CodeChallenge, state)
	const live = `owner_id = ? AND binding = ? AND armed_at <= clock_timestamp()
        AND armed_at > clock_timestamp() - interval '5 minutes'
        AND EXISTS (SELECT 1 FROM identities i WHERE i.user_id = ios_google_usb_attempts.owner_id
            AND i.provider = 'google' AND i.provider_id = ios_google_usb_attempts.google_subject)`
	var grant struct {
		FlowID uuid.UUID `db:"flow_id"`
	}
	var err error
	if claim {
		err = tx.RawQuery("UPDATE ios_google_usb_attempts SET flow_id = ? WHERE "+live+" AND flow_id IS NULL RETURNING flow_id", f.ID, owner, binding).First(&grant)
	} else {
		err = tx.RawQuery("SELECT flow_id FROM ios_google_usb_attempts WHERE "+live+" AND flow_id = ? AND (? = '' OR google_subject = ?) FOR UPDATE", owner, binding, f.ID, subject, subject).First(&grant)
	}
	if err != nil || grant.FlowID != f.ID {
		return iosUSBRefused()
	}
	return nil
}

func (a *API) googleUSBCallback(w http.ResponseWriter, r *http.Request, f *models.FlowState) error {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	q, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil || r.Method != http.MethodGet || len(q["state"]) != 1 || q.Get("state") != f.ID.String() ||
		len(q["code"]) != 1 || q.Get("code") == "" || q.Has("error") || f.UserID != nil ||
		a.googleUSBAdmission(a.db.WithContext(r.Context()), f, false, "") != nil {
		return iosUSBRefused()
	}

	// Use the pinned Google provider’s verified ID-token path only. Its legacy userinfo fallback
	// accepts a missing ID token for browser clients and is unsuitable for this grant.
	google, _, err := a.OAuthProvider(r.Context(), "google")
	if err != nil {
		return iosUSBRefused()
	}
	token, err := google.GetOAuthToken(r.Context(), q.Get("code"))
	if err != nil || token == nil {
		return iosUSBRefused()
	}
	idToken, ok := token.Extra("id_token").(string)
	if !ok || idToken == "" {
		return iosUSBRefused()
	}
	identityData, err := google.GetUserData(r.Context(), token)
	if err != nil || identityData == nil || identityData.Metadata == nil || identityData.Metadata.Subject == "" {
		return iosUSBRefused()
	}

	var location string
	err = a.db.WithContext(r.Context()).Transaction(func(tx *storage.Connection) error {
		locked, err := models.FindFlowStateByIDForUpdate(tx, f.ID.String())
		if err != nil || locked.UserID != nil || locked.AuthCodeIssuedAt != nil || a.googleUSBAdmission(tx, locked, false, identityData.Metadata.Subject) != nil {
			return iosUSBRefused()
		}
		identity, err := models.FindIdentityByIdAndProvider(tx, identityData.Metadata.Subject, "google")
		if err != nil || identity.UserID.String() != a.config.IOSGoogleUSBOwnerID {
			return iosUSBRefused()
		}
		user, err := models.FindUserByID(tx, identity.UserID)
		if err != nil || !iosUSBEligibleUser(user, a.requestAud(r.Context(), r)) {
			return iosUSBRefused()
		}
		now := time.Now()
		locked.UserID, locked.AuthCodeIssuedAt = &user.ID, &now
		if err := tx.UpdateOnly(locked, "user_id", "auth_code_issued_at"); err != nil {
			return iosUSBRefused()
		}
		state, _ := googleUSBState(*locked.Referrer)
		location = googleUSBReturn + "?" + url.Values{"state": {state}, "code": {*locked.AuthCode}}.Encode()
		return nil
	})
	if err != nil {
		return iosUSBRefused()
	}
	w.Header().Set("Location", location)
	w.WriteHeader(http.StatusFound)
	return nil
}
