import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

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
import { extname, join } from "node:path";
import { browserTest, findChrome, launchChrome } from "../../../tests/chrome.js";

browserTest("saved web sessions survive transient verification/refresh and reload; terminal proof clears them", { timeout: 360000 }, async (t) => {
  const { build } = await import("esbuild");
  const root = join(import.meta.dirname, "../../..");
  assert.ok(existsSync(join(root, "dist/app/index.html")), "CI must build the actual dashboard first");
  const bundle = await build({
    stdin: { contents: "export * from './src/lib/commonswarm.ts'; export {createClient as rawClient} from '@supabase/supabase-js';", resolveDir: root, loader: "ts" }, bundle: true,
    write: false, format: "iife", globalName: "cs", platform: "browser",
  });
  const helper = bundle.outputFiles[0]!.text;
  const rotatedAccessToken = accessToken.slice(0, accessToken.lastIndexOf(".") + 1) + encode({ rotated: true });
  const recovered = new Set<string>();
  const commandRequests = new Map<string, { bodies: string[]; writes: number }>();
  let releaseOldUser: (() => void) | undefined;
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
    if (url.pathname === "/probe") { json(200, counts); return; }
    if (url.pathname === "/release") { recovered.add(mode); releaseOldUser?.(); json(200, {}); return; }
    if (url.pathname === "/functions/v1/command") {
      const record = commandRequests.get(mode) ?? { bodies: [], writes: 0 };
      commandRequests.set(mode, record);
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        record.bodies.push(body);
        if (mode === "command-unknown") { record.writes += 1; req.socket.destroy(); return; }
        if (mode === "command-repeat" || record.bodies.length === 1) { json(401, { error: "unauthenticated" }); return; }
        if (req.headers.authorization !== `Bearer ${rotatedAccessToken}`) { json(403, { error: "wrong_owner_or_token" }); return; }
        record.writes += 1; json(200, { status: "accepted" });
      });
      return;
    }
    if (url.pathname === "/recover") { recovered.add(mode); json(200, {}); return; }
    if (url.pathname.startsWith("/auth/v1/")) {
      const refresh = url.pathname.endsWith("/token");
      if (req.method === "PUT" && url.pathname.endsWith('/user')) { json(422, { error_code: "validation_failed" }); return; }
      if (url.pathname.endsWith('/otp')) { json(200, {}); return; }
      if (url.pathname.endsWith('/logout')) { res.writeHead(204).end(); return; }
      if (refresh) counts.refreshes += 1; else if (url.pathname.endsWith("/user")) counts.users += 1;
      if (["race", "race-unlocked"].includes(mode) && !refresh && counts.users === 1) {
        releaseOldUser = () => json(403, { error_code: "session_not_found" }); return;
      }
      if (!recovered.has(mode)) {
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
      else json(200, user);
      return;
    }
    if (url.pathname.startsWith("/rest/v1/")) { json(200, []); return; }
    if (url.pathname === "/helper.js") {
      res.writeHead(200, { "content-type": "text/javascript" }).end(helper); return;
    }
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const bootstrap = `<meta name="commonswarm:url" content="${origin}"><meta name="commonswarm:anon-key" content="fixture-anon"><script>
      const nativeFetch=window.fetch.bind(window);
      window.fetch=(input,init)=>{
        const u=new URL(typeof input==='string'?input:input.url,location.href);
        const routed=u.pathname.startsWith('/auth/v1/')||u.pathname==='/functions/v1/command';
        if(routed)u.searchParams.set('mode',${JSON.stringify(mode)});
        return nativeFetch(routed?u:input,init);
      };
    </script>`;
    if (url.pathname === "/peer") {
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><head>${bootstrap}<script src="/helper.js"></script></head><body></body>`); return;
    }
    if (url.pathname === "/measure") {
      const expired = mode.startsWith("refresh") || mode.startsWith("terminal-refresh") || mode === "race-refresh429";
      const seed = { access_token: accessToken, refresh_token: "browser-refresh",
        expires_at: expired ? Math.floor(Date.now()/1000)-60 : Math.floor(Date.now()/1000)+(mode === "terminal-proactive" ? 60 : 3600),
        token_type: "bearer", user };
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><head>${bootstrap}<script src="/helper.js"></script></head><body><script>
        (async()=>{
          const check=(value,label)=>{if(!value)throw Error(label);};
          const wait=async(fn)=>{for(let i=0;i<500;i++){if(fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('dashboard wait timed out');};
          const mode=${JSON.stringify(mode)};
          localStorage.clear();localStorage.setItem('sb-127-auth-token',${JSON.stringify(JSON.stringify(seed))});
          const checkReloadSignedOut=async()=>{
            const peer=document.createElement('iframe');peer.src='/peer?mode='+mode;
            const loaded=new Promise(resolve=>peer.addEventListener('load',resolve,{once:true}));
            document.body.append(peer);await loaded;
            const reloaded=new Promise(resolve=>peer.addEventListener('load',resolve,{once:true}));
            peer.contentWindow.location.reload();await reloaded;
            check(await peer.contentWindow.cs.currentSession()===null,'reload must not resurrect superseded credentials');
          };
          if(mode==='storage-unwritable'||mode==='storage-late-failure'){
            if(mode==='storage-late-failure')await cs.currentSession();
            Storage.prototype.setItem=function(){throw new DOMException('Fixture quota','QuotaExceededError');};
            const api=cs.client();
            check((await cs.currentSession())?.refresh_token==='browser-refresh','failed write probe must retain readable login');
            check(JSON.parse(localStorage.getItem('sb-127-auth-token')).refresh_token==='browser-refresh','probe alone must not erase persistent login');
            check(!(await api.auth.setSession({access_token:${JSON.stringify(rotatedAccessToken)},refresh_token:'memory-successor'})).error,'fallback sign-in');
            check((await cs.currentSession())?.refresh_token==='memory-successor','fallback must shadow old readable slot');
            check(localStorage.getItem('sb-127-auth-token')===null,'failed replacement must remove superseded persistent credential');
            check((await api.auth.refreshSession()).data.session?.refresh_token==='browser-rotated','fallback refresh');
            check((await cs.currentSession())?.refresh_token==='browser-rotated','fallback must retain rotation within page');
            await checkReloadSignedOut();
            document.body.dataset.result='passed';return;
          }
          if(mode==='storage-explicit-logout'||mode==='storage-removal-retry'){
            const nativeRemove=Storage.prototype.removeItem;
            if(mode==='storage-explicit-logout')Storage.prototype.setItem=function(){throw new DOMException('Fixture quota','QuotaExceededError');};
            const api=cs.client();
            check((await cs.currentSession())?.refresh_token==='browser-refresh','readable login before logout');
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
            try{result=await cs.postCommand(active,'browser-same-intent',{kind:'fixture'}, {}, 'outcome unknown');}catch(e){error=e;}
            if(${JSON.stringify(mode)}==='command-recover')check(result?.status===200,'command must recover with one resend');
            if(${JSON.stringify(mode)}==='command-repeat')check(error?.name==='AuthRecoveryRequired','repeated refusal must retain recoverable login');
            if(${JSON.stringify(mode)}==='command-unknown')check(error?.name==='CommandOutcomeUnknown','unknown outcome must stay unknown');
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
          const frame=document.createElement('iframe');frame.src='/app/?mode=${mode}';document.body.append(frame);
          await wait(()=>['workspace-error','signed-out','create'].includes(frame.contentDocument?.querySelector('live-dashboard')?.dataset.state));
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
            await wait(()=>frame.contentDocument?.querySelector('live-dashboard')?.dataset.state==='workspace-error');
            check(stored()?.refresh_token==='browser-refresh','reload must retain refresh credentials');
            await fetch('/recover?mode=${mode}');
            if(mode.startsWith('refresh'))await new Promise(r=>setTimeout(r,32000));
            frame.contentDocument.querySelector('[data-retry-workspaces]').click();
            await wait(()=>state()==='create');check(stored()?.user.id===${JSON.stringify(userId)},'retry must recover same owner');
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
      "user503", "user-network", "refresh429", "refresh-network", "terminal-user", "terminal-refresh", "terminal-proactive",
      "command-recover", "command-repeat", "command-unknown", "race", "race-unlocked",
      "storage-unwritable", "storage-late-failure", "storage-explicit-logout", "storage-removal-retry",
      "corrupt-storage", "race-refresh429", "refresh-already-used",
      "terminal-user-modern", "terminal-refresh-modern",
    ];
    for (const mode of modes) await t.test(mode, async () => {
      // CDP observes real elapsed time. No virtual time or Date.now jumps.
      const reservation = createServer();
      await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
      const port = (reservation.address() as { port: number }).port;
      await new Promise<void>(resolve => reservation.close(() => resolve()));
      const run = launchChrome(chrome, [`--remote-debugging-port=${port}`, "about:blank"], { timeout: 60000 });
      void run.catch(() => {});
      let socket: WebSocket | undefined;
      try {
        let target: { webSocketDebuggerUrl: string } | undefined;
        for (let attempt = 0; attempt < 100 && !target; attempt++) {
          try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((page: { type: string }) => page.type === "page"); } catch { /* Browser starting. */ }
          if (!target) await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.ok(target, "Chromium must expose its fresh test page");
        socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = reject; });
        let sequence = 0;
        const pending = new Map<number, (result: any) => void>();
        socket.onmessage = event => { const message = JSON.parse(String(event.data)); pending.get(message.id)?.(message); pending.delete(message.id); };
        const send = (method: string, params = {}): Promise<any> => new Promise(resolve => {
          const id = ++sequence; pending.set(id, resolve); socket!.send(JSON.stringify({ id, method, params }));
        });
        await send("Page.navigate", { url: `${origin}/measure?mode=${mode}` });
        let result: { result?: string; failure?: string } = {};
        for (let attempt = 0; attempt < 550; attempt++) {
          const message = await send("Runtime.evaluate", { expression: "JSON.stringify({result:document.body?.dataset.result,failure:document.body?.dataset.failure})", returnByValue: true });
          result = JSON.parse(message.result?.result?.value ?? "{}");
          if (result.result || result.failure) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(result.result, "passed", `${mode}: ${result.failure ?? "real-time observer timeout"}`);
      } finally {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: 99999, method: "Browser.close" }));
        socket?.close();
        await run;
      }
      const counts = observed.get(mode)!;
      assert.ok(counts.users > 0 || counts.refreshes > 0, `${mode} must reach real SDK HTTP`);
      if (mode.startsWith("command")) {
        const record = commandRequests.get(mode)!;
        assert.equal(record.bodies.length, mode === "command-unknown" ? 1 : 2);
        assert.equal(record.writes, mode === "command-repeat" ? 0 : 1);
        if (record.bodies.length === 2) assert.equal(record.bodies[0], record.bodies[1]);
        assert.equal(counts.refreshes, mode === "command-unknown" ? 0 : 1);
      }
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
