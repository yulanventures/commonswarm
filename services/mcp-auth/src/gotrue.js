import { createHash, randomBytes } from "node:crypto";

import { enabledSignInProviders } from "./signin-providers.js";

import { randomOpaque } from "./browser-security.js";

function challenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function jsonOrError(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error("GoTrue request was refused");
    error.code = "gotrue_refused";
    error.status = response.status;
    throw error;
  }
  return body;
}

export function createGoTrueClient({ baseUrl, anonKey, provider, providers, fetch: fetchImplementation = globalThis.fetch }) {
  const root = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const enabled = enabledSignInProviders(providers ?? (provider ? [provider] : undefined));
  return {
    providers: enabled,
    legacySingleProvider: provider != null && providers == null,
    begin({ callbackUrl, interactionUid, provider: selected = enabled[0] }) {
      if (!enabled.includes(selected)) throw new TypeError("sign-in provider is not enabled");
      const state = randomOpaque();
      const verifier = randomBytes(32).toString("base64url");
      const redirect = new URL(callbackUrl);
      redirect.searchParams.set("interaction", interactionUid);
      redirect.searchParams.set("state", state);
      const authorize = new URL(selected === "email" ? "otp" : "authorize", root);
      if (selected !== "email") authorize.searchParams.set("provider", selected);
      authorize.searchParams.set("redirect_to", redirect.toString());
      authorize.searchParams.set("code_challenge", challenge(verifier));
      authorize.searchParams.set("code_challenge_method", "s256");
      return { state, verifier, url: authorize };
    },

    async sendEmail({ email, signIn }) {
      // Only a server-created begin() result supplies the redirect and challenge.
      const otp = new URL("otp", root);
      otp.searchParams.set("redirect_to", signIn.url.searchParams.get("redirect_to"));
      await jsonOrError(await fetchImplementation(otp, {
        method: "POST", headers: { apikey: anonKey, "content-type": "application/json" },
        body: JSON.stringify({ email, create_user: true,
          code_challenge: signIn.url.searchParams.get("code_challenge"), code_challenge_method: "s256" }),
        redirect: "manual", signal: AbortSignal.timeout(10_000),
      }));
    },

    async exchange({ code, verifier }) {
      const tokenUrl = new URL("token", root);
      tokenUrl.searchParams.set("grant_type", "pkce");
      const tokenResponse = await fetchImplementation(tokenUrl, {
        method: "POST",
        headers: { "apikey": anonKey, "content-type": "application/json" },
        body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
        redirect: "manual",
      });
      const tokens = await jsonOrError(tokenResponse);
      if (typeof tokens.access_token !== "string") throw new Error("GoTrue returned no access token");
      const userResponse = await fetchImplementation(new URL("user", root), {
        headers: { apikey: anonKey, authorization: `Bearer ${tokens.access_token}` },
        redirect: "manual",
      });
      const user = await jsonOrError(userResponse);
      if (typeof user.id !== "string") throw new Error("GoTrue returned no user identity");
      return {
        identity: {
          userId: user.id,
          email: typeof user.email === "string" ? user.email : null,
          displayName: typeof user.user_metadata?.display_name === "string"
            ? user.user_metadata.display_name
            : (typeof user.email === "string" ? user.email : "CommonSwarm user"),
          identityVerified: true,
          interactiveAuthAtSeconds: Number.isFinite(tokens.expires_in)
            ? Math.floor(Date.now() / 1000)
            : null,
        },
      };
    },
  };
}
