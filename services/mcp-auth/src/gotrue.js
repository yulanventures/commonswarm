import { createHash, randomBytes } from "node:crypto";

import { AUTH_PROVIDER_CATALOG } from "./auth-provider-catalog.js";

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

export function createGoTrueClient({ baseUrl, anonKey, provider, providers = [provider], fetch: fetchImplementation = globalThis.fetch }) {
  const root = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const known = new Set(AUTH_PROVIDER_CATALOG.map(({ id }) => id));
  if (!providers.length || providers.some((id) => !known.has(id))) {
    throw new TypeError("a supported GoTrue provider id is required");
  }
  return {
    providers,
    async verifyProviders() {
      try {
        const response = await fetchImplementation(new URL("settings", root), {
          headers: { apikey: anonKey }, redirect: "manual", signal: AbortSignal.timeout(10_000),
        });
        const settings = await jsonOrError(response);
        if (providers.some((id) => settings.external?.[id] !== true)) throw new Error();
      } catch {
        const error = new Error("Configured sign-in providers are not enabled in GoTrue settings");
        error.code = "gotrue_providers_unavailable";
        throw error;
      }
    },
    begin({ callbackUrl, interactionUid, provider: selected = providers[0], selectAccount = false }) {
      if (!providers.includes(selected)) throw new TypeError("sign-in provider is not configured");
      const state = randomOpaque();
      const verifier = randomBytes(32).toString("base64url");
      const redirect = new URL(callbackUrl);
      redirect.searchParams.set("interaction", interactionUid);
      redirect.searchParams.set("state", state);
      redirect.searchParams.set("provider", selected);
      const authorize = new URL("authorize", root);
      authorize.searchParams.set("provider", selected);
      if (selectAccount && selected === "google") authorize.searchParams.set("prompt", "select_account");
      authorize.searchParams.set("redirect_to", redirect.toString());
      authorize.searchParams.set("code_challenge", challenge(verifier));
      authorize.searchParams.set("code_challenge_method", "s256");
      return { state, verifier, provider: selected, url: authorize };
    },

    async exchange({ code, verifier, provider: selected }) {
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
      const email = user.email_confirmed_at && typeof user.email === "string" ? user.email : null;
      return {
        identity: {
          userId: user.id,
          email,
          provider: providers.includes(selected) ? selected
            : (known.has(user.app_metadata?.provider) ? user.app_metadata.provider : null),
          displayName: typeof user.user_metadata?.display_name === "string"
            ? user.user_metadata.display_name
            : (typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : email ?? "CommonSwarm user"),
          identityVerified: true,
          interactiveAuthAtSeconds: Number.isFinite(tokens.expires_in)
            ? Math.floor(Date.now() / 1000)
            : null,
        },
      };
    },
  };
}
