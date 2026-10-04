// Display order and enforcement share this list. Labels match /app.
export const SIGNIN_PROVIDERS = Object.freeze([
  Object.freeze({ id: "google", label: "Sign in with Google" }),
  Object.freeze({ id: "email", label: "Email me a sign-in link" }),
  Object.freeze({ id: "github", label: "Sign in with GitHub" }),
]);

export function enabledSignInProviders(value) {
  const ids = value == null ? SIGNIN_PROVIDERS.map(method => method.id)
    : typeof value === "string" ? value.split(",").map(id => id.trim()) : value;
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length ||
      ids.some(id => !SIGNIN_PROVIDERS.some(method => method.id === id))) {
    throw new TypeError("enabled GoTrue sign-in providers must be a nonempty supported allowlist");
  }
  return Object.freeze(SIGNIN_PROVIDERS.filter(method => ids.includes(method.id)).map(method => method.id));
}
