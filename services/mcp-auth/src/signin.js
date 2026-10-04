import { assertAllowedOrigin, INTERACTION_SECURITY_HEADERS } from "./browser-security.js";
import { ClientError } from "./client-error.js";
import { SIGNIN_PROVIDERS } from "./signin-providers.js";

function escape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function page(response, status, uid, providers, token, message = "") {
  const action = `/interaction/${encodeURIComponent(uid)}/signin`;
  const choices = SIGNIN_PROVIDERS.filter(method => providers.includes(method.id)).map(method =>
    `<form method="post" action="${escape(action)}">
      <input type="hidden" name="csrf_token" value="${escape(token)}">
      <input type="hidden" name="provider" value="${method.id}">
      ${method.id === "email" ? '<label>Email address<input type="email" name="email" autocomplete="email" maxlength="254" required></label>' : ""}
      <button type="submit">${method.label}</button></form>`).join("");
  response.writeHead(status, { ...INTERACTION_SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to CommonSwarm</title>
    <style>body{font-family:system-ui;max-width:30rem;margin:3rem auto;padding:1rem}form{margin:1rem 0}label,input{display:block}input{margin:.5rem 0;padding:.5rem}button{padding:.7rem 1rem}</style></head>
    <body><main><h1>Sign in to CommonSwarm</h1><p>Use the same sign-in method you use in /app to continue this connection.</p>
    ${message ? `<p role="status">${escape(message)}</p>` : ""}${choices}
    ${providers.includes("email") ? '<p>Open the email link in this same browser. This connection attempt expires after ten minutes. Starting another sign-in replaces the previous link.</p>' : ""}
    <a href="https://commonswarm.com/app">Cancel and return to /app</a></main></body></html>`);
}

// The caller has already validated provider details and bound this interaction.
// Legacy one-provider clients keep their immediate OAuth redirect.
export async function handleSignIn({ request, response, operation, parsed, browser, store, gotrue,
  allowedOrigins, callbackUrl, interactionUid }) {
  const providers = gotrue.providers;
  if (request.method === "GET" && operation === "view") {
    const signIn = gotrue.begin({ callbackUrl, interactionUid });
    await store.beginSignIn(interactionUid, browser.id, signIn);
    if (!providers || (gotrue.legacySingleProvider && providers[0] !== "email")) {
      response.writeHead(303, { ...INTERACTION_SECURITY_HEADERS, location: signIn.url.toString() });
      response.end();
    } else page(response, 200, interactionUid, providers, signIn.state);
    return true;
  }
  if (request.method !== "POST" || operation !== "signin") return false;
  try { assertAllowedOrigin(request.headers.origin, allowedOrigins); }
  catch (error) {
    if (error.code !== "origin_forbidden") throw error;
    response.writeHead(403, { ...INTERACTION_SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "origin_forbidden" }));
    return true;
  }
  const body = parsed?.value;
  const token = parsed?.format === "form" ? body?.csrf_token : request.headers["x-cswarm-csrf"];
  if (!providers?.includes(body?.provider) || typeof token !== "string" || token.length < 20 ||
      (body.provider === "email" && (typeof body.email !== "string" || body.email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(body.email)))) throw new ClientError(400);
  // This is a one-use chooser CSRF token until a choice is submitted; then
  // a fresh state/verifier replaces it for the existing callback consumer.
  await store.consumeSignIn(interactionUid, browser.id, token);
  const signIn = gotrue.begin({ callbackUrl, interactionUid, provider: body.provider });
  await store.beginSignIn(interactionUid, browser.id, signIn);
  if (body.provider !== "email") {
    response.writeHead(303, { ...INTERACTION_SECURITY_HEADERS, location: signIn.url.toString() });
    response.end();
    return true;
  }
  try {
    await gotrue.sendEmail({ email: body.email, signIn });
  } catch (error) {
    const limited = error.code === "gotrue_refused" && error.status === 429;
    page(response, limited ? 429 : 502, interactionUid, providers, signIn.state, limited
      ? "Please wait before asking for another sign-in link, or use another sign-in method."
      : "We could not send a sign-in link. Try again or use another sign-in method.");
    return true;
  }
  page(response, 200, interactionUid, providers, signIn.state,
    "Check your email for a sign-in link. Open it in this same browser to continue this connection.");
  return true;
}
