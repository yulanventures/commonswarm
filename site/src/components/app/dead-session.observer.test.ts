import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { browserTest as test } from "../../../tests/chrome.js";

// The Node-only auth fixture below replaces global fetch. DevTools discovery
// must still use the real loopback transport, independently of that fixture.
const nativeFetch = globalThis.fetch.bind(globalThis);

const userId = "11111111-1111-4111-8111-111111111111";
const user = {
  id: userId,
  aud: "authenticated",
  role: "authenticated",
  email: "owner@example.com",
  email_confirmed_at: "2026-08-01T00:00:00.000Z",
  phone: "",
  confirmed_at: "2026-08-01T00:00:00.000Z",
  last_sign_in_at: "2026-08-01T00:00:00.000Z",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: {},
  identities: [],
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
  is_anonymous: false,
};

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const accessToken = [
  encode({ alg: "ES256", typ: "JWT" }),
  encode({
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
    iat: Math.floor(Date.now() / 1_000),
    iss: "https://example.supabase.co/auth/v1",
    role: "authenticated",
    session_id: "22222222-2222-4222-8222-222222222222",
    sub: userId,
    email: user.email,
    user_metadata: {},
    app_metadata: user.app_metadata,
  }),
  encode({ signature: true }),
].join(".");

let userEndpointStatus = 200;
let commandStatus = 200;
let refreshCount = 0;
let commandBodies: string[] = [];
let recoverCommand = false;

Object.assign(globalThis, {
  document: {
    querySelector(selector: string) {
      if (selector.includes("commonswarm:url")) {
        return { content: "https://example.supabase.co" };
      }
      if (selector.includes("commonswarm:anon-key")) {
        return { content: "test-anon-key" };
      }
      return null;
    },
  },
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) {
      return userEndpointStatus === 200
        ? Response.json(user)
        : Response.json(
            {
              code: userEndpointStatus === 403 ? "session_not_found" : "unexpected_failure",
              error_code: userEndpointStatus === 403 ? "session_not_found" : "unexpected_failure",
              msg: "Session from session_id claim in JWT does not exist",
            },
            { status: userEndpointStatus },
          );
    }
    if (url.includes("/auth/v1/token?grant_type=refresh_token")) {
      refreshCount += 1;
      return Response.json({ access_token: accessToken, refresh_token: "rotated-refresh-token",
        expires_in: 3600, token_type: "bearer", user });
    }
    if (url.endsWith("/functions/v1/command")) {
      commandBodies.push(String(init?.body));
      return commandStatus === 200 || (recoverCommand && commandBodies.length === 2)
        ? Response.json({ status: "accepted" })
        : Response.json({ error: "unauthenticated" }, { status: commandStatus });
    }
    if (url.endsWith("/auth/v1/logout")) return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${url}`);
  },
});

const commonswarm = await import("../../lib/commonswarm.ts");
const api = commonswarm.client();
assert.ok(api);

const dashboard = readFileSync(new URL("./LiveDashboard.astro", import.meta.url), "utf8");

const seedSession = async (): Promise<void> => {
  userEndpointStatus = 200;
  commandStatus = 200;
  refreshCount = 0;
  commandBodies = [];
  recoverCommand = false;
  const { error } = await api.auth.setSession({
    access_token: accessToken,
    refresh_token: "test-refresh-token",
  });
  assert.equal(error, null);
};

test("QA-010 load rejects a locally persisted session missing on the server", async () => {
  await seedSession();
  userEndpointStatus = 403;

  let caught: unknown;
  try {
    await commonswarm.currentSession();
  } catch (error) {
    caught = error;
  }

  assert.equal((await api.auth.getSession()).data.session, null);
  assert.equal((caught as Error | undefined)?.name, "SessionExpired");
});

test("transient user verification retains credentials and recovers", async () => {
  await seedSession();
  userEndpointStatus = 503;
  await assert.rejects(commonswarm.currentSession(), { name: "AuthRecoveryRequired" });
  assert.equal((await api.auth.getSession()).data.session?.refresh_token, "test-refresh-token");
  userEndpointStatus = 200;
  assert.equal((await commonswarm.currentSession())?.user.id, userId);
});

for (const recover of [true, false]) {
  test(`command 401 has one refresh/resend and preserves login (recovery=${recover})`, async () => {
    await seedSession();
    commandStatus = 401;
    recoverCommand = recover;
    const session = await commonswarm.currentSession();
    assert.ok(session);
    const operation = commonswarm.postCommand(session, "same-intent", { kind: "test" });
    if (recover) assert.equal((await operation).status, 200);
    else await assert.rejects(operation, { name: "AuthRecoveryRequired" });
    assert.equal(refreshCount, 1);
    assert.equal(commandBodies.length, 2);
    assert.equal(commandBodies[0], commandBodies[1]);
    assert.equal((await api.auth.getSession()).data.session?.user.id, userId);
  });
}

test("QA-010 invite email validation distinguishes input errors from auth", () => {
  assert.equal(typeof commonswarm.inviteEmailValidationMessage, "function");
  assert.match(commonswarm.inviteEmailValidationMessage(""), /email/i);
  assert.match(commonswarm.inviteEmailValidationMessage("not-an-email"), /valid email/i);
  assert.equal(commonswarm.inviteEmailValidationMessage("teammate@example.com"), null);
  assert.notEqual(
    commonswarm.inviteEmailValidationMessage(""),
    "CommonSwarm did not create the invitation (unauthenticated).",
  );
});

test("QA-010 dashboard renders an expired session as signed out with a re-auth prompt", () => {
  assert.match(
    dashboard,
    /error instanceof SessionExpired[\s\S]*?session = null;[\s\S]*?showPanel\("signed-out"\);[\s\S]*?authError\(error\.message\)/,
  );
});

test("QA-010 invite form routes empty and malformed input through the validator", () => {
  assert.match(dashboard, /<form class="dashboard__invite-form" data-invite-form novalidate>/);
  assert.match(
    dashboard,
    /const emailValidationMessage = inviteEmailValidationMessage\(email\);[\s\S]*?if \(emailValidationMessage\)[\s\S]*?error\.textContent = emailValidationMessage/,
  );
});

// Real browser/storage owner. The same test file is copied unchanged into the
// baseline CI tree; it imports no candidate-only exports in the browser harness.
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

test("saved web sessions survive transient verification/refresh and reload; terminal proof clears them", { timeout: 180000, concurrency: 2 }, async (t) => {
  const { build } = await import("esbuild");
  const root = join(import.meta.dirname, "../../..");
  assert.ok(existsSync(join(root, "dist/app/index.html")), "CI must build the actual dashboard first");
  const bundle = await build({
    stdin: { contents: "export * from './src/lib/commonswarm.ts'; export {createClient as rawClient} from '@supabase/supabase-js';", resolveDir: root, loader: "ts" }, bundle: true,
    write: false, format: "iife", globalName: "cs", platform: "browser",
  });
  const helper = bundle.outputFiles[0]!.text;
  const rotatedAccessToken = accessToken.slice(0, accessToken.lastIndexOf(".") + 1) + encode({ rotated: true });
  const otherUser = { ...user, id: "33333333-3333-4333-8333-333333333333", email: "peer@example.com" };
  const otherAccessToken = [encode({ alg: "ES256", typ: "JWT" }),
    encode({ aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, sub: otherUser.id }),
    encode({ other: true })].join(".");
  const heldMembership = new Map<string, () => void>();
  const recovered = new Set<string>();
  const rotatingTokens = new Map<string, string>();
  const holdRefresh = new Set<string>();
  const releaseRefresh = new Map<string, () => void>();
  const revoked = new Set<string>();
  const releases = new Map<string, number>();
  const commandRequests = new Map<string, { bodies: string[]; fetchCalls: string[]; committed: Map<string, string>; writes: number }>();
  const releaseOldUser = new Map<string, () => void>();
  const observed = new Map<string, { users: number; refreshes: number }>();
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture");
    const mode = url.searchParams.get("mode") ?? "healthy";
    const counts = observed.get(mode) ?? { users: 0, refreshes: 0 };
    observed.set(mode, counts);
    const json = (status: number, body: unknown) => {
      const modern = mode.endsWith("modern");
      const payload = body && typeof body === "object" && "error_code" in body && modern
        ? { code: (body as { error_code: string }).error_code, msg: "Fixture auth refusal" } : body;
      res.writeHead(status, { "content-type": "application/json", ...(modern ? { "x-supabase-api-version": "2024-01-01" } : {}) });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/probe") { json(200, { ...counts, membershipPending: heldMembership.has(mode), refreshPending: releaseRefresh.has(mode) }); return; }
    if (url.pathname === "/deploy") {
      releases.set(mode, (releases.get(mode) ?? 1) + 1);
      json(200, { revision: releases.get(mode) }); return;
    }
    if (url.pathname === "/release") { recovered.add(mode); releaseOldUser.get(mode)?.(); heldMembership.get(mode)?.(); json(200, {}); return; }
    if (url.pathname === "/functions/v1/command") {
      const record = commandRequests.get(mode) ?? { bodies: [], fetchCalls: [], committed: new Map<string, string>(), writes: 0 };
      commandRequests.set(mode, record);
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        record.bodies.push(body);
        record.fetchCalls.push(String(req.headers["x-fixture-fetch-call"]));
        if (mode === "command-unknown") {
          const id = JSON.parse(body).command_id;
          const committed = record.committed.get(id);
          if (committed !== undefined && committed !== body) { json(409, { error: "id_reused_with_different_body" }); return; }
          // Model the command endpoint's durable idempotency receipt: the
          // effect commits before the response is lost, including native HTTP
          // retries below fetch(). A later same-ID retry reads that receipt.
          if (committed === undefined) { record.committed.set(id, body); record.writes += 1; }
          if (!recovered.has(mode)) { req.socket.destroy(); return; }
          json(200, { status: "accepted", effects: record.writes }); return;
        }
        if (mode === "command-repeat" || record.bodies.length === 1) { json(401, { error: "unauthenticated" }); return; }
        if (req.headers.authorization !== `Bearer ${rotatedAccessToken}`) { json(403, { error: "wrong_owner_or_token" }); return; }
        record.writes += 1; json(200, { status: "accepted" });
      });
      return;
    }
    if (url.pathname === "/hold-refresh") { holdRefresh.add(mode); json(200, {}); return; }
    if (url.pathname === "/release-refresh") { releaseRefresh.get(mode)?.(); releaseRefresh.delete(mode); json(200, {}); return; }
    if (url.pathname === "/revoke") { revoked.add(mode); json(200, {}); return; }
    if (url.pathname === "/recover") { recovered.add(mode); json(200, {}); return; }
    if (url.pathname.startsWith("/auth/v1/")) {
      const refresh = url.pathname.endsWith("/token");
      if (req.method === "PUT" && url.pathname.endsWith('/user')) { json(422, { error_code: "validation_failed" }); return; }
      if (url.pathname.endsWith('/otp')) { json(200, {}); return; }
      if (url.pathname.endsWith('/logout')) { res.writeHead(204).end(); return; }
      if (refresh) counts.refreshes += 1; else if (url.pathname.endsWith("/user")) counts.users += 1;
      if (!refresh && revoked.has(mode)) { json(403, { error_code: "session_not_found" }); return; }
      if (refresh && (mode.startsWith("storage-rotation") || ["storage-unwritable", "storage-late-failure"].includes(mode))) {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
          const current = rotatingTokens.get(mode) ?? "browser-refresh";
          if (JSON.parse(body).refresh_token !== current) {
            json(400, { error_code: "refresh_token_not_found" }); return;
          }
          const successor = `consumed-${counts.refreshes}`;
          rotatingTokens.set(mode, successor);
          const respond = () => json(200, { access_token: rotatedAccessToken, refresh_token: successor,
            expires_in: 3600, token_type: "bearer", user });
          if (holdRefresh.delete(mode)) releaseRefresh.set(mode, respond); else respond();
        });
        return;
      }
      if (["race", "race-unlocked"].includes(mode) && !refresh && counts.users === 1) {
        releaseOldUser.set(mode, () => json(403, { error_code: "session_not_found" })); return;
      }
      if (!recovered.has(mode)) {
        if ((mode === "recovery-user" || mode.startsWith("recovery-late-")) && !refresh) { json(503, { error_code: "unexpected_failure" }); return; }
        if (mode === "recovery-refresh-hang" && refresh) return;
        if (mode === "recovery-refresh" && refresh) { json(503, { error_code: "unexpected_failure" }); return; }
        if ((mode === "user-network" && !refresh) || (mode === "refresh-network" && refresh)) {
          req.socket.destroy(); return;
        }
        if (mode === "user503" && !refresh) { json(503, { error_code: "unexpected_failure" }); return; }
        if (["refresh429", "race-refresh429"].includes(mode) && refresh) { json(429, { error_code: "over_request_rate_limit" }); return; }
        if (["terminal-user", "terminal-user-modern", "terminal-proactive"].includes(mode) && !refresh) { json(403, { error_code: "session_not_found" }); return; }
        if (mode === "refresh-already-used" && refresh) { json(400, { error_code: "refresh_token_already_used" }); return; }
        if (["terminal-refresh", "terminal-refresh-modern", "terminal-proactive"].includes(mode) && refresh) { json(400, { error_code: "refresh_token_not_found" }); return; }
      }
      if (refresh) json(200, { access_token: rotatedAccessToken, refresh_token: "browser-rotated",
        expires_in: 3600, token_type: "bearer", user });
      else json(200, req.headers.authorization === `Bearer ${otherAccessToken}` ? otherUser : user);
      return;
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      if (mode.startsWith("recovery-late-") && !heldMembership.has(mode)) {
        heldMembership.set(mode, () => json(200, [])); return;
      }
      if (mode === "recovery-membership") { json(503, { message: "Fixture membership unavailable" }); return; }
      json(200, []); return;
    }
    if (url.pathname === "/helper.js") {
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" })
        .end(helper + `\n/* fixture release ${releases.get(mode) ?? 1} */`); return;
    }
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const bootstrap = `<meta name="commonswarm:url" content="${origin}"><meta name="commonswarm:anon-key" content="fixture-anon"><script>
      const nativeFetch=window.fetch.bind(window);
      const commandFetchCalls=new Map();
      window.fetch=(input,init)=>{
        const u=new URL(typeof input==='string'?input:input.url,location.href);
        const routed=u.pathname.startsWith('/auth/v1/')||u.pathname.startsWith('/rest/v1/')||u.pathname==='/functions/v1/command';
        if(routed)u.searchParams.set('mode',${JSON.stringify(mode)});
        if(u.pathname==='/functions/v1/command'){
          const id=JSON.parse(init.body).command_id;
          const count=(commandFetchCalls.get(id)||0)+1;commandFetchCalls.set(id,count);
          const headers=new Headers(init.headers);headers.set('x-fixture-fetch-call',String(count));
          init={...init,headers};
        }
        return nativeFetch(routed?u:input,init);
      };
    </script>`;
    if (url.pathname === "/lifecycle") {
      // Exercise the production SDK/storage and the built dashboard in a normal
      // temporary profile. HTTP fixture outcomes do not prove GoTrue rotation.
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }).end(`<!doctype html><head>${bootstrap}<script src="/helper.js?mode=${mode}"></script></head><body data-revision="${releases.get(mode) ?? 1}"><script>
        (async()=>{
          const session=await cs.currentSession();
          if(session?.user.id!==${JSON.stringify(userId)}||session.refresh_token!=='browser-refresh')throw Error('saved owner must survive lifecycle without reseeding');
          const frame=document.createElement('iframe');frame.src='/app/?mode=${mode}';document.body.append(frame);
          for(let i=0;i<500;i++){
            if(frame.contentDocument?.querySelector('live-dashboard')?.dataset.state==='create'){
              if(!frame.contentDocument.querySelector('[data-panel="signed-out"]').hidden)throw Error('signed-in dashboard exposed login');
              document.body.dataset.result='passed';return;
            }
            await new Promise(r=>setTimeout(r,20));
          }
          throw Error('persisted dashboard did not recover');
        })().catch(e=>document.body.dataset.failure=e.message);
      </script></body>`); return;
    }
    if (url.pathname === "/durable") {
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><head>${bootstrap}<script src="/helper.js"></script></head><body><script>
        cs.currentSession().then(session=>{
          if(!session?.refresh_token.startsWith('consumed-'))throw Error('durable successor lost on process reopen');
          document.body.dataset.result='passed';
        }).catch(e=>document.body.dataset.failure=e.message);
      </script></body>`); return;
    }
    if (url.pathname === "/peer") {
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><head>${bootstrap}<script src="/helper.js"></script></head><body></body>`); return;
    }
    if (url.pathname === "/measure") {
      const expired = mode.startsWith("recovery-refresh") || mode.startsWith("refresh") || mode.startsWith("terminal-refresh") || mode === "race-refresh429";
      const seed = { access_token: accessToken, refresh_token: "browser-refresh",
        expires_at: expired ? Math.floor(Date.now()/1000)-60 : Math.floor(Date.now()/1000)+(mode === "terminal-proactive" ? 60 : 3600),
        token_type: "bearer", user };
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><head>${bootstrap}<script src="/helper.js"></script></head><body><script>
        (async()=>{
          const check=(value,label)=>{if(!value)throw Error(label);};
          const wait=async(fn,stage='dashboard')=>{for(let i=0;i<500;i++){if(fn())return;await new Promise(r=>setTimeout(r,20));}throw Error(stage+' wait timed out');};
          const mode=${JSON.stringify(mode)};
          localStorage.clear();
          localStorage.setItem('sb-127-auth-token',${JSON.stringify(JSON.stringify(seed))});
          const checkReloadSignedOut=async()=>{
            const peer=document.createElement('iframe');peer.src='/peer?mode='+mode;
            const loaded=new Promise(resolve=>peer.addEventListener('load',resolve,{once:true}));
            document.body.append(peer);await loaded;
            const reloaded=new Promise(resolve=>peer.addEventListener('load',resolve,{once:true}));
            peer.contentWindow.location.reload();await reloaded;
            check(await peer.contentWindow.cs.currentSession()===null,'reload must not resurrect superseded credentials');
          };
          if(mode.startsWith('lifecycle-')){
            location.replace('/lifecycle?mode='+mode);return;
          }
          if(mode==='storage-fresh-signin'||mode==='storage-read-denied'){
            const key='sb-127-auth-token';
            const nativeSet=Storage.prototype.setItem;
            const nativeGet=Storage.prototype.getItem;
            const old=localStorage.getItem(key);
            if(mode==='storage-fresh-signin')localStorage.removeItem(key);
            else Storage.prototype.getItem=function(){throw new DOMException('Fixture read denial','SecurityError');};
            Storage.prototype.setItem=function(){throw new DOMException('Fixture quota','QuotaExceededError');};
            const api=cs.client();
            await api.auth.getSession();
            check(!(await api.auth.setSession({access_token:${JSON.stringify(rotatedAccessToken)},refresh_token:'fresh-signin'})).error,'fresh sign-in succeeds in memory');
            Storage.prototype.getItem=nativeGet;
            check((await cs.currentSession())?.refresh_token==='fresh-signin','read recovery must preserve the page successor');
            if(mode==='storage-read-denied'){
              Storage.prototype.setItem=nativeSet;
              await new Promise(r=>setTimeout(r,3500));
              check(localStorage.getItem(key)===old,'unknown ownership cannot overwrite native bytes');
              check((await cs.currentSession())?.refresh_token==='fresh-signin','unknown disk snapshot cannot replace memory successor');
              const peer=document.createElement('iframe');peer.src='/peer?mode='+mode;
              document.body.append(peer);await wait(()=>peer.contentWindow.cs);
              check(!(await peer.contentWindow.cs.client().auth.signOut({scope:'local'})).error,'peer logout with unknown snapshot');
              await wait(()=>localStorage.getItem(key)===null,'peer removal');
              check(await cs.currentSession()===null,'observed peer logout cancels unknown-snapshot save');
            }else{
              let ready,release;
              const acquired=new Promise(r=>ready=r);
              const held=navigator.locks.request('lock:'+key,async()=>{ready();await new Promise(r=>release=r);});
              await acquired;
              Storage.prototype.setItem=nativeSet;
              await new Promise(r=>setTimeout(r,3500));
              check(localStorage.getItem(key)===null,'fresh sign-in retry must respect the SDK session lock');
              check(!(await navigator.locks.query()).pending.some(lock=>lock.name==='lock:'+key),'busy retry must not leave a queued lock request');
              release();await held;
              await wait(()=>JSON.parse(localStorage.getItem(key)||'null')?.refresh_token==='fresh-signin','fresh sign-in durable retry after lock release');
            }
            document.body.dataset.result='passed';return;
          }
          if(mode==='storage-unwritable'||mode==='storage-late-failure'||mode.startsWith('storage-rotation')){
            const key='sb-127-auth-token';
            let predecessor='browser-refresh';
            if(mode==='storage-late-failure'){
              await cs.currentSession();
              const established=await cs.client().auth.refreshSession();
              check(!established.error,'native storage works before late denial');
              predecessor=established.data.session.refresh_token;
            }
            const old=localStorage.getItem(key);
            const nativeSet=Storage.prototype.setItem;
            Storage.prototype.setItem=function(){throw new DOMException('Fixture quota','QuotaExceededError');};
            const api=cs.client();
            check((await cs.currentSession())?.refresh_token===predecessor,'failed write probe must retain readable login');
            check(localStorage.getItem(key)===old,'probe must preserve exact saved bytes');
            const rotated=await api.auth.refreshSession();
            check(!rotated.error,'real SDK refresh must succeed despite denied native writes');
            const successor=rotated.data.session.refresh_token;
            check((await cs.currentSession())?.refresh_token===successor,'page must use rotated successor');
            check(localStorage.getItem(key)===old,'failed replacement must preserve exact saved bytes');
            const obsolete=await fetch('/auth/v1/token?grant_type=refresh_token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refresh_token:predecessor})});
            check(obsolete.status===400&&(await obsolete.json()).error_code==='refresh_token_not_found','consumed predecessor must actually be invalid');
            check(!(await api.auth.refreshSession()).error,'current successor is the consuming fixture positive control');
            if(mode==='storage-rotation-terminal'){
              await fetch('/revoke?mode='+mode);
              let error;try{await cs.currentSession();}catch(e){error=e;}
              check(error?.name==='SessionExpired','matching terminal proof defeats pending successor');
              check(localStorage.getItem(key)===null,'terminal proof still removes persistent auth');
              Storage.prototype.setItem=nativeSet;
              await new Promise(r=>setTimeout(r,3500));
              check(localStorage.getItem(key)===null,'retry cannot resurrect terminally removed login');
              await checkReloadSignedOut();
            }else if(mode.includes('peer-')){
              const peer=document.createElement('iframe');peer.src='/peer?mode='+mode;
              document.body.append(peer);await wait(()=>peer.contentWindow.cs);
              const peerApi=mode.endsWith('-unlocked')?peer.contentWindow.cs.rawClient(location.origin,'fixture-anon',{auth:{autoRefreshToken:false}}):peer.contentWindow.cs.client();
              check((await peerApi.auth.getSession()).data.session!==null,'peer loads saved owner');
              let lateRefresh;
              let beforeLate;
              if(mode.endsWith('-unlocked')){
                beforeLate=(await (await fetch('/probe?mode='+mode)).json()).refreshes;
                await fetch('/hold-refresh?mode='+mode);
                lateRefresh=api.auth.refreshSession();
                for(let i=0;i<100;i++){
                  if((await (await fetch('/probe?mode='+mode)).json()).refreshPending)break;
                  await new Promise(r=>setTimeout(r,20));
                }
                check((await (await fetch('/probe?mode='+mode)).json()).refreshPending,'consuming refresh response must be held');
              }
              let signedOut=false;peerApi.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT')signedOut=true;});
              if(mode.includes('peer-logout'))check(!(await peerApi.auth.signOut({scope:'local'})).error,'peer logout');
              else check(!(await peerApi.auth.setSession({access_token:${JSON.stringify(rotatedAccessToken)},refresh_token:'peer-successor'})).error,'peer successor');
              await new Promise(r=>setTimeout(r,100));
              if(lateRefresh){
                await fetch('/release-refresh?mode='+mode);
                const discarded=await Promise.race([lateRefresh,new Promise(resolve=>setTimeout(()=>resolve(null),2000))]);
                check(discarded?.error?.name==='AuthRefreshDiscardedError','peer ownership must discard consumed refresh without retry or cooldown');
                check((await (await fetch('/probe?mode='+mode)).json()).refreshes===beforeLate+1,'consumed refresh must reach HTTP exactly once');
              }
              Storage.prototype.setItem=nativeSet;
              await new Promise(r=>setTimeout(r,3500));
              if(mode.includes('peer-logout')){
                check(localStorage.getItem(key)===null,'pending save must not resurrect peer logout');
                check(await cs.currentSession()===null,'peer logout defeats page successor');
              }else{
                check(JSON.parse(localStorage.getItem(key)).refresh_token==='peer-successor','peer successor defeats pending save');
                check((await cs.currentSession())?.refresh_token==='peer-successor','page reconciles peer successor');
                check(!signedOut,'pending save cannot broadcast sign-out over peer successor');
              }
            }else{
              const latest=(await cs.currentSession()).refresh_token;
              Storage.prototype.setItem=nativeSet;
              await wait(()=>JSON.parse(localStorage.getItem(key)||'null')?.refresh_token===latest,'native write/readback recovery');
              const peer=document.createElement('iframe');peer.src='/peer?mode='+mode;
              document.body.append(peer);await wait(()=>peer.contentWindow.cs);
              check((await peer.contentWindow.cs.currentSession())?.refresh_token===latest,'fresh client reads durable successor');
            }
            document.body.dataset.result='passed';return;
          }
          if(mode==='storage-explicit-logout'||mode==='storage-removal-retry'){
            const nativeRemove=Storage.prototype.removeItem;
            if(mode==='storage-explicit-logout')Storage.prototype.setItem=function(){throw new DOMException('Fixture quota','QuotaExceededError');};
            const api=cs.client();
            check((await cs.currentSession())?.refresh_token==='browser-refresh','readable login before logout');
            if(mode==='storage-explicit-logout')check(!(await api.auth.refreshSession()).error,'logout must cancel a real pending successor');
            if(mode==='storage-removal-retry'){
              Storage.prototype.removeItem=function(){throw new DOMException('Fixture denial','SecurityError');};
              check(!(await api.auth.signOut({scope:'local'})).error,'logout with denied persistent removal');
              check(await cs.currentSession()===null,'denied removal keeps memory signed out');
              check(localStorage.getItem('sb-127-auth-token')!==null,'fixture must leave old persistent credential when removal is denied');
              Storage.prototype.removeItem=nativeRemove;
            }
            check(!(await api.auth.signOut({scope:'local'})).error,'explicit fallback logout');
            check(await cs.currentSession()===null,'explicit logout clears fallback memory');
            check(localStorage.getItem('sb-127-auth-token')===null,'explicit logout always retries persistent removal');
            await checkReloadSignedOut();
            document.body.dataset.result='passed';return;
          }
          if(mode==='corrupt-storage'){
            await cs.currentSession();
            localStorage.setItem('sb-127-auth-token','{broken');
            const api=cs.client();
            check(!(await api.auth.signInWithOtp({email:'owner@example.com'})).error,'corrupt slot must not block OTP');
            check(!(await api.auth.setSession({access_token:${JSON.stringify(rotatedAccessToken)},refresh_token:'corrupt-recovered'})).error,'corrupt slot re-login');
            check((await cs.currentSession())?.refresh_token==='corrupt-recovered','re-login retains identity');
            const update=await api.auth.updateUser({data:{fixture:true}});
            check(update.error?.status===422&&update.error?.code==='validation_failed','PUT user keeps SDK error contract');
            await api.auth.signOut({scope:'local'});
            check(await cs.currentSession()===null,'explicit logout is signed out without expired error');
            document.body.dataset.result='passed';return;
          }
          if(mode==='refresh-already-used'){
            let error;try{await cs.currentSession();}catch(e){error=e;}
            check(error?.name==='AuthRecoveryRequired','already_used needs recovery');
            await fetch('/recover?mode='+mode);
            const successor={...${JSON.stringify(seed)},access_token:${JSON.stringify(rotatedAccessToken)},refresh_token:'peer-successor',expires_at:Math.floor(Date.now()/1000)+3600};
            localStorage.setItem('sb-127-auth-token',JSON.stringify(successor));
            await new Promise(r=>setTimeout(r,32000));
            check((await cs.currentSession())?.refresh_token==='peer-successor','ambiguous old failure cannot revoke successor');
            document.body.dataset.result='passed';return;
          }
          if(mode==='race-refresh429'){
            const started=performance.now();let error;try{await cs.currentSession();}catch(e){error=e;}
            check(error?.name==='AuthRecoveryRequired'&&performance.now()-started<6000,'bounded retry panel');
            const peer=document.createElement('iframe');peer.src='/peer?mode='+mode;document.body.append(peer);await wait(()=>peer.contentWindow.cs);
            let done=false;
            const successor=peer.contentWindow.cs.client().auth.setSession({access_token:${JSON.stringify(rotatedAccessToken)},refresh_token:'peer-successor'}).then(r=>{done=true;return r;});
            await new Promise(r=>setTimeout(r,5500));check(!done,'peer must not steal a lock after five seconds');
            const probe=await(await fetch('/probe?mode='+mode)).json();check(probe.refreshes===1,'429 must not hammer auth');
            await fetch('/recover?mode='+mode);check(!(await successor).error,'queued peer recovers');
            check((await cs.currentSession())?.refresh_token==='peer-successor','peer successor retained');
            document.body.dataset.result='passed';return;
          }
          if(${JSON.stringify(mode)}.startsWith('command')){
            const active=await cs.currentSession();let result,error;
            const commandId='11111111-1111-4111-8111-111111111111';
            try{result=await cs.postCommand(active,commandId,{kind:'fixture'}, {}, 'outcome unknown');}catch(e){error=e;}
            if(${JSON.stringify(mode)}==='command-recover')check(result?.status===200,'command must recover with one resend');
            if(${JSON.stringify(mode)}==='command-repeat')check(error?.name==='AuthRecoveryRequired','repeated refusal must retain recoverable login');
            if(mode==='command-unknown'){
              check(error?.name==='CommandOutcomeUnknown','unknown outcome must stay unknown');
              check(commandFetchCalls.get(commandId)===1,'unknown outcome must make exactly one application fetch');
              await fetch('/recover?mode='+mode);
              const receipt=await cs.postCommand(active,commandId,{kind:'fixture'}, {}, 'outcome unknown');
              check(receipt.status===200&&receipt.body.effects===1,'same-ID retry must recover one committed effect');
              check(commandFetchCalls.get(commandId)===2,'only the explicit same-ID retry adds an application fetch');
            }
            check((await cs.currentSession())?.user.id===${JSON.stringify(userId)},'command failure must preserve login');
            document.body.dataset.result='passed';return;
          }
          if(${JSON.stringify(mode)}.startsWith('race')){
            const old=cs.currentSession().catch(e=>e.name);
            for(let i=0;i<100;i++){const probe=await (await fetch('/probe?mode=${mode}')).json();if(probe.users>0)break;await new Promise(r=>setTimeout(r,10));}
            const peer=document.createElement('iframe');peer.src='/peer?mode=${mode}';document.body.append(peer);
            await wait(()=>peer.contentWindow.cs);
            let successorDone=false;
            const peerApi=${JSON.stringify(mode)}==='race-unlocked'?peer.contentWindow.cs.rawClient(location.origin,'fixture-anon',{auth:{autoRefreshToken:false}}):peer.contentWindow.cs.client();
            let successorSignedOut=false;
            peerApi.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT'&&successorDone)successorSignedOut=true;});
            const successor=peerApi.auth.setSession({access_token:${JSON.stringify(rotatedAccessToken)},refresh_token:'successor-refresh'}).then(value=>{successorDone=true;return value;});
            if(${JSON.stringify(mode)}==='race-unlocked')await wait(()=>successorDone);
            else {await new Promise(r=>setTimeout(r,1000));check(!successorDone,'SDK lock must serialize successor behind terminal verification');}
            await fetch('/release?mode=${mode}');await old;check(!(await successor).error,'successor sign-in must succeed');
            check((await cs.currentSession())?.refresh_token==='successor-refresh','late terminal result must not clear successor');
            await new Promise(r=>setTimeout(r,100));check(!successorSignedOut,'stale terminal proof must not broadcast successor sign-out');
            document.body.dataset.result='passed';return;
          }
          if(mode.startsWith('recovery-')){
            let peer;
            const readyPeer=async()=>{
              peer=document.createElement('iframe');peer.src='/peer?mode='+mode;
              document.body.append(peer);await wait(()=>peer.contentWindow.cs);
              check((await peer.contentWindow.cs.client().auth.getSession()).data.session,'peer initialized before refresh');
            };
            // Initialize an unexpired peer before the dashboard subscribes, so
            // peer initialization cannot supply a SIGNED_IN recovery shortcut.
            if(!mode.startsWith('recovery-refresh'))await readyPeer();
            const frame=document.createElement('iframe');frame.src='/app/?mode='+mode;document.body.append(frame);
            const state=()=>frame.contentDocument?.querySelector('live-dashboard')?.dataset.state;
            await wait(()=>state()==='workspace-error','auth or membership recovery panel');
            const before=frame.contentDocument.querySelector('[data-workspace-error]').textContent;
            await fetch('/recover?mode='+mode);
            // Expired/hanging cases finish the dashboard's own pending SDK
            // refresh. Other cases get a real peer TOKEN_REFRESHED broadcast.
            if(peer)check(!(await peer.contentWindow.cs.client().auth.refreshSession()).error,'SDK same-user refresh succeeds');
            if(mode.startsWith('recovery-late-')){
              for(let i=0;i<200;i++){
                if((await(await fetch('/probe?mode='+mode)).json()).membershipPending)break;
                await new Promise(r=>setTimeout(r,20));
              }
              check((await(await fetch('/probe?mode='+mode)).json()).membershipPending,'recovery boot must actually reach held membership');
              const peerApi=peer.contentWindow.cs.client();
              if(mode==='recovery-late-logout')check(!(await peerApi.auth.signOut({scope:'local'})).error,'logout during recovery boot');
              else check(!(await peerApi.auth.setSession({access_token:${JSON.stringify(otherAccessToken)},refresh_token:'other-owner'})).error,'identity changes during recovery boot');
              await new Promise(r=>setTimeout(r,100));
              await fetch('/release?mode='+mode);
              const wanted=mode==='recovery-late-logout'?'signed-out':'create';
              await wait(()=>state()===wanted,'new identity defeats late recovery boot');
              if(wanted==='signed-out')check(localStorage.getItem('sb-127-auth-token')===null,'late boot cannot resurrect logout');
              else check(JSON.parse(localStorage.getItem('sb-127-auth-token')).user.id===${JSON.stringify(otherUser.id)},'late boot cannot replace new owner');
            }else if(mode==='recovery-membership'){
              await new Promise(r=>setTimeout(r,500));
              check(state()==='workspace-error'&&frame.contentDocument.querySelector('[data-workspace-error]').textContent===before,'membership error must retain its own recovery');
            }else{
              for(let i=0;i<2000&&state()!=='create';i++)await new Promise(r=>setTimeout(r,20));
              check(state()==='create','same-user refresh must recover without click or reload');
              check(frame.contentDocument.querySelector('[data-panel="workspace-error"]').hidden,'auth recovery panel closes');
              if(!peer)await readyPeer();
              // Healthy refresh bursts must leave the rendered workspace intact.
              const heading=frame.contentDocument.querySelector('[data-panel="create"] h1');
              check(heading,'healthy workspace positive control');
              await peer.contentWindow.cs.client().auth.refreshSession();
              await peer.contentWindow.cs.client().auth.refreshSession();
              await new Promise(r=>setTimeout(r,100));
              check(state()==='create'&&heading===frame.contentDocument.querySelector('[data-panel="create"] h1'),'healthy refresh does not rebuild workspace');
            }
            document.body.dataset.result='passed';return;
          }
          const frame=document.createElement('iframe');frame.src='/app/?mode=${mode}';document.body.append(frame);
          await wait(()=>['workspace-error','signed-out','create'].includes(frame.contentDocument?.querySelector('live-dashboard')?.dataset.state),'initial recovery panel');
          const state=()=>frame.contentDocument.querySelector('live-dashboard').dataset.state;
          const stored=()=>JSON.parse(localStorage.getItem('sb-127-auth-token')||'null');
          if(${JSON.stringify(mode)}.startsWith('terminal')){
            check(state()==='signed-out','terminal must show signed out');check(stored()===null,'terminal must clear credentials');
          }else{
            check(state()==='workspace-error','transient must offer retry rather than signin');
            check(stored()?.refresh_token==='browser-refresh','transient must retain saved refresh token');
            check(frame.contentDocument.querySelector('[data-panel="signed-out"]').hidden,'signin controls must stay hidden');
            check(frame.contentDocument.querySelector('[data-panel="workspace-error"] .dashboard__account-line').hidden,'initial load must not claim a verified identity');
            const reloaded=new Promise(resolve=>frame.addEventListener('load',resolve,{once:true}));
            frame.contentWindow.location.reload(); await reloaded;
            await wait(()=>frame.contentDocument?.querySelector('live-dashboard')?.dataset.state==='workspace-error','reloaded recovery panel');
            check(stored()?.refresh_token==='browser-refresh','reload must retain refresh credentials');
            await fetch('/recover?mode=${mode}');
            if(mode.startsWith('refresh'))await new Promise(r=>setTimeout(r,32000));
            frame.contentDocument.querySelector('[data-retry-workspaces]').click();
            await wait(()=>state()==='create','verified recovery after retry');check(stored()?.user.id===${JSON.stringify(userId)},'retry must recover same owner');
            if(mode.startsWith('refresh'))check(stored()?.refresh_token==='browser-rotated','recovery must persist the server-rotated credential');
          }
          document.body.dataset.result='passed';
        })().catch(e=>document.body.dataset.failure=e.message);
      </script></body>`); return;
    }
    try {
      const relative = url.pathname === "/app/" ? "app/index.html" : url.pathname.replace(/^\//, "");
      const file = join(root, "dist", relative);
      if (!file.startsWith(join(root, "dist") + "/")) { res.writeHead(404).end(); return; }
      let content = readFileSync(file);
      if (relative.endsWith(".html")) content = Buffer.from(content.toString().replace("<head>", `<head>${bootstrap}`));
      const type = ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string,string>)[extname(file)] ?? "application/octet-stream";
      res.writeHead(200, { "content-type": type }).end(content);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const chrome = await findChrome();
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    assert.equal(process.env.SESSION_CONTINUITY_CASES, undefined, "case subsets are forbidden for this gate");
    const modes = [
      "recovery-user", "recovery-refresh", "recovery-refresh-hang", "recovery-membership", "recovery-late-logout", "recovery-late-user",
      "storage-fresh-signin", "storage-read-denied",
      "storage-rotation-terminal", "storage-rotation-peer-successor", "storage-rotation-peer-logout",
      "storage-rotation-peer-successor-unlocked", "storage-rotation-peer-logout-unlocked",
      "user503", "user-network", "refresh429", "refresh-network", "terminal-user", "terminal-refresh", "terminal-proactive",
      "command-recover", "command-repeat", "command-unknown", "race", "race-unlocked",
      "storage-unwritable", "storage-late-failure", "storage-explicit-logout", "storage-removal-retry",
      "corrupt-storage", "race-refresh429", "refresh-already-used",
      "terminal-user-modern", "terminal-refresh-modern", "lifecycle-multitab", "lifecycle-restart-deploy",
    ];
    // Independent profiles and per-mode server state let two real-time retry
    // cases progress together within the existing 180s file gate.
    await Promise.all(modes.map(mode => t.test(mode, async () => {
      const lifecycle = mode.startsWith("lifecycle-");
      const durable = ["storage-unwritable", "storage-late-failure"].includes(mode);
      const profile = lifecycle || durable ? await mkdtemp(join(tmpdir(), "cswarm-web-continuity-")) : undefined;
      if (profile) t.after(async () => { await rm(profile, { recursive: true, force: true }); });
      const phases = mode === "lifecycle-restart-deploy" ? ["seed", "restart", "deploy"] : durable ? ["seed", "durable"] : ["seed"];
      for (const phase of phases) {
      if (phase === "deploy") await nativeFetch(`${origin}/deploy?mode=${mode}`, { method: "POST" });
      // Each phase launches a fresh browser process; lifecycle and durable-save
      // modes retain only their own temporary profile, without reseeding.
      const reservation = createServer();
      await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
      const port = (reservation.address() as { port: number }).port;
      await new Promise<void>(resolve => reservation.close(() => resolve()));
      const run = launchChrome(chrome, [`--remote-debugging-port=${port}`, ...(profile ? [`--user-data-dir=${profile}`] : []), "about:blank"], { timeout: 60000 });
      let launchError: unknown;
      let exited = false;
      const settled = run.then(() => { exited = true; }, error => { exited = true; launchError = error; });
      let socket: WebSocket | undefined;
      let failure: unknown;
      try {
        let target: { webSocketDebuggerUrl: string } | undefined;
        for (let attempt = 0; attempt < 100 && !target; attempt++) {
          if (exited) throw launchError ?? new Error("Chromium exited before DevTools discovery");
          try { target = (await (await nativeFetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json()).find((page: { type: string }) => page.type === "page"); } catch { /* Browser starting. */ }
          if (!target) await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.ok(target, "Chromium must expose its fresh test page");
        socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("DevTools socket did not open")), 5000);
          socket!.onopen = () => { clearTimeout(timer); resolve(); };
          socket!.onerror = socket!.onclose = () => { clearTimeout(timer); reject(new Error("DevTools socket failed to open")); };
        });
        let sequence = 0;
        const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
        const rejectPending = () => {
          for (const waiter of pending.values()) waiter.reject(new Error("DevTools socket closed"));
          pending.clear();
        };
        socket.onclose = socket.onerror = rejectPending;
        socket.onmessage = event => {
          const message = JSON.parse(String(event.data));
          const waiter = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) waiter?.reject(new Error(message.error.message));
          else waiter?.resolve(message);
        };
        const send = (method: string, params = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
          if (socket?.readyState !== WebSocket.OPEN) { reject(new Error("DevTools socket is not open")); return; }
          const id = ++sequence;
          const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools ${method} did not answer`)); }, 5000);
          pending.set(id, {
            resolve: value => { clearTimeout(timer); resolve(value); },
            reject: error => { clearTimeout(timer); reject(error); },
          });
          socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
        await send("Page.navigate", { url: `${origin}/${phase === "seed" ? "measure" : phase === "durable" ? "durable" : "lifecycle"}?mode=${mode}` });
        let result: { result?: string; failure?: string } = {};
        for (let attempt = 0; attempt < 550; attempt++) {
          const message = await send("Runtime.evaluate", { expression: "JSON.stringify({result:document.body?.dataset.result,failure:document.body?.dataset.failure})", returnByValue: true });
          result = JSON.parse(message.result?.result?.value ?? "{}");
          if (result.result || result.failure) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(result.result, "passed", `${mode}/${phase}: ${result.failure ?? "real-time observer timeout"}`);
        if (phase === "deploy") {
          const revision = await send("Runtime.evaluate", { expression: "document.body.dataset.revision", returnByValue: true });
          assert.equal(revision.result.result.value, "2", "new static fixture revision must actually be served");
        }
        if (mode === "lifecycle-multitab") {
          const peer = await send("Target.createTarget", { url: `${origin}/lifecycle?mode=${mode}` });
          const attached = await send("Target.attachToTarget", { targetId: peer.result.targetId, flatten: true });
          let ready = false;
          for (let attempt = 0; attempt < 100 && !ready; attempt++) {
            const observed = await send("Runtime.evaluate", { expression: "document.body?.dataset.result", returnByValue: true }, attached.result.sessionId);
            ready = observed.result.result.value === "passed";
            if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
          }
          assert.equal(ready, true, "a separate real tab must recover the same saved owner");
          await send("Target.closeTarget", { targetId: peer.result.targetId });
          await send("Runtime.evaluate", { expression: "document.body.dataset.result='reloading'" });
          await send("Page.reload");
          let reloaded = false;
          for (let attempt = 0; attempt < 100 && !reloaded; attempt++) {
            const observed = await send("Runtime.evaluate", { expression: "document.body?.dataset.result", returnByValue: true });
            reloaded = observed.result.result.value === "passed";
            if (!reloaded) await new Promise(resolve => setTimeout(resolve, 100));
          }
          assert.equal(reloaded, true, "original tab remains signed in after peer open/close and reload");
        }
      } catch (error) {
        failure = error;
      } finally {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: 99999, method: "Browser.close" }));
        // Keep the transport alive until Chrome consumes Browser.close. The
        // shared launcher's unchanged 60s deadline owns forced termination.
        await settled;
        socket?.close();
      }
      if (failure) throw failure;
      if (launchError) throw launchError;
      } // Browser lifecycle phase.
      const counts = observed.get(mode)!;
      assert.ok(counts.users > 0 || counts.refreshes > 0, `${mode} must reach real SDK HTTP`);
      if (lifecycle) assert.equal(counts.refreshes, 0, "valid saved web access survives tabs/processes/static replacement without rotation");
      if (mode.startsWith("command")) {
        const record = commandRequests.get(mode)!;
        if (mode === "command-unknown") {
          // Native HTTP retries reuse the first fetch-call marker. The browser
          // also checks its application call count before explicitly recovering
          // the same ID; the fixture must have committed exactly one effect.
          const operations = new Map<string, string[]>();
          for (const body of record.bodies) {
            const id = JSON.parse(body).command_id;
            assert.equal(typeof id, "string");
            assert.ok(id.length > 0);
            const attempts = operations.get(id) ?? [];
            attempts.push(body);
            operations.set(id, attempts);
          }
          assert.equal(operations.size, 1, "recovery must keep the original operation ID");
          for (const attempts of operations.values()) {
            assert.ok(attempts.length >= 2, "lost response and explicit recovery must both reach HTTP");
            assert.ok(attempts.every(body => body === attempts[0]), "every transport attempt must preserve the exact command");
          }
          assert.ok(record.fetchCalls.slice(0, -1).every(call => call === "1"), "lost-response HTTP attempts must belong to one application fetch");
          assert.equal(record.fetchCalls.at(-1), "2", "the explicit recovery is the second application fetch");
          assert.equal(record.committed.size, 1);
          assert.equal(record.writes, 1, "transport retries and explicit recovery must have one effect");
        } else {
          assert.equal(record.bodies.length, 2);
          assert.equal(record.writes, mode === "command-repeat" ? 0 : 1);
          assert.equal(record.bodies[0], record.bodies[1]);
        }
        assert.equal(counts.refreshes, mode === "command-unknown" ? 0 : 1);
      }
    })));
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
