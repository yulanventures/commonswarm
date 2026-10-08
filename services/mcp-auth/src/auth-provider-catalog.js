// Consent-server provider ids and display names have one owner.
export const AUTH_PROVIDER_CATALOG = Object.freeze([
  {
    id: /** @type {"google"} */ ("google"),
    label: "Sign in with Google",
    name: "Google",
    legalEntity: "Google LLC",
  },
  {
    id: /** @type {"github"} */ ("github"),
    label: "Sign in with GitHub",
    name: "GitHub",
    legalEntity: "GitHub, Inc.",
  },
].map((provider) => Object.freeze(provider)));
