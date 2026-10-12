// Finish HTTP flow. Inputs: activated consent and provider-validated bindings;
// outputs: connected HTML or a saved code-free AS 303 with provider cookies.
// P8 gates/routes this flow before normal binding; P9a calls prepareFinish only
// after CSRF, live-session checks and activation. P4 owns expiry and single creation.
import { errors } from 'oidc-provider';
import { parseCookies, SESSION_COOKIE } from './browser-security.js';
import { InteractionStateError } from './client-error.js';
import { finishPaths, FINISH_SECURITY_HEADERS, renderFinishPage, renderFinishExpiredPage } from './finish-page.js';

const restart = () => new InteractionStateError('interaction_expired');
// Capture without a socket: nothing reaches the browser before P4 saves it.
function captureResponse() {
  const headers = new Map();
  return {
    statusCode: 200,
    setHeader(name, value) { headers.set(name.toLowerCase(), value); },
    getHeader(name) { return headers.get(name.toLowerCase()); },
    removeHeader(name) { headers.delete(name.toLowerCase()); },
    end() {},
  };
}
function redirect(response, location, cookies = []) {
  response.writeHead(303, { ...FINISH_SECURITY_HEADERS, location,
    ...(cookies.length ? { 'set-cookie': cookies } : {}) });
  response.end();
}
function html(response, status, body) {
  response.writeHead(status, { ...FINISH_SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' });
  response.end(body);
}

export function createFinishFlow({ provider, store, finishStore }) {
  return {
    // binding is P4's { interactionUid, sessionId, userId, request }. Both form
    // and JSON consent use this 303; fetch callers navigate the followed URL.
    async prepareFinish(request, response, binding, input) {
      if (request.method !== 'POST') throw restart();
      const paths = finishPaths(binding.interactionUid);
      await finishStore.prepareFinish(binding, input);
      await store.complete(binding.interactionUid);
      redirect(response, paths.connectedPath);
      return true;
    },

    async handle(request, response, url = new URL(request.url, provider.issuer)) {
      const match = /^\/interaction\/([^/]+)\/(connected|finish)$/u.exec(url.pathname);
      if (!match) return false;
      if (request.method !== 'GET') {
        response.writeHead(405, { ...FINISH_SECURITY_HEADERS, allow: 'GET' });
        response.end();
        return true;
      }
      let clientDisplay = { verified: false, primary: 'your app' };
      try {
        const uid = match[1];
        if (!/^[A-Za-z0-9_-]+$/u.test(uid)) throw restart();
        const sessionId = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
        const session = await store.requireSession(sessionId);
        if (!session?.user_id || !session.authenticated_at) throw restart();
        const captured = captureResponse();
        const details = await provider.interactionDetails(request, captured);
        const p = details.params;
        if (details.uid !== uid || !p || p.resource !== 'https://mcp.commonswarm.com/mcp') throw restart();
        const binding = { interactionUid: uid, sessionId, userId: session.user_id,
          request: { clientId: p.client_id, redirectUri: p.redirect_uri, resource: p.resource,
            scopes: String(p.scope ?? '').split(' ').filter(Boolean),
            pkceChallenge: p.code_challenge, oauthState: p.state ?? null } };
        const record = await finishStore.getFinish(binding);
        clientDisplay = record.display_model.clientDisplay;
        if (match[2] === 'connected') {
          if (!['prepared', 'resume_ready'].includes(record.state)) throw restart();
          html(response, 200, renderFinishPage({ ...record.display_model,
            interactionUid: uid, deadline: new Date(record.expires_at).getTime() }));
        } else {
          const saved = await finishStore.ensureResume(binding, async row => {
            await provider.interactionFinished(request, captured, row.provider_result);
            const cookies = captured.getHeader('set-cookie');
            return { status: captured.statusCode, location: captured.getHeader('location'),
              cookies: cookies == null ? [] : Array.isArray(cookies) ? cookies : [cookies] };
          });
          redirect(response, saved.location, saved.cookies);
        }
      } catch (error) {
        if (!(error instanceof InteractionStateError) && !(error instanceof errors.SessionNotFound)) throw error;
        html(response, 410, renderFinishExpiredPage({ clientDisplay }));
      }
      return true;
    },
  };
}
