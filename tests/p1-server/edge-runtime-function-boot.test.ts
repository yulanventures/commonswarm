/**
 * Boot every supabase/functions worker in the self-hosted edge-runtime image.
 *
 * Staging could run a function under the Supabase CLI while production's
 * edge-runtime image failed to create the worker (bare specifier, no
 * per-function import map). This gate starts deploy/edge-runtime's pinned
 * image with production mounts and requires each listed function to boot.
 *
 * Reached by `npm run test:p1-server` via the p1-server glob in
 * tests/lists/test:p1-server.txt. Skips with "Docker unavailable" when Docker
 * is absent. GitHub Actions workflow server-suite.yml runs that script.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { FILE_TEXT_TOKEN_HEADER } from "../../deploy/edge-runtime/main/file-text.js";
import { test } from "node:test";
import { KONG_FUNCTION_NOT_FOUND_BODY } from "../../deploy/edge-runtime/main/router.js";
import { createClient } from "@supabase/supabase-js";
import {
  DOCKER_UNAVAILABLE,
  DUMMY_DATABASE_URL,
  DUMMY_HTTP_URL,
  awaitHealth,
  bootFunction,
  classifyWorkerBoot,
  composeEdgeRuntimeImage,
  composePath,
  dockerAvailable,
  dummyEdgeEnv,
  functionsRoot,
  listFunctionDirectories,
  rewriteFunctionsBind,
  rewritePublishedPort,
  startComposeEdgeRuntime,
  type EdgeRuntimeHandle,
} from "../support/edge-runtime-function-boot.js";

function guardedRemove(directory: string): void {
  const cleanup = spawnSync("rm", ["-rf", "--", directory], { encoding: "utf8" });
  assert.equal(cleanup.status, 0, `guarded cleanup refused ${directory}: ${cleanup.stderr}`);
}

test("runtime 5xx boot failure is distinct from a function 401 or 404", () => {
  assert.deepEqual(classifyWorkerBoot(401, '{"error":"unauthenticated"}', ""), { ok: true });
  assert.deepEqual(classifyWorkerBoot(400, '{"error":"invalid_request"}', ""), { ok: true });
  assert.deepEqual(classifyWorkerBoot(404, '{"error":"not_found"}', ""), { ok: true });
  assert.deepEqual(classifyWorkerBoot(500, '{"error":"internal_error"}', ""), { ok: true });
  assert.deepEqual(
    classifyWorkerBoot(404, KONG_FUNCTION_NOT_FOUND_BODY, ""),
    { ok: false, reason: "gateway 404 did not create a user worker" },
  );
  assert.deepEqual(
    classifyWorkerBoot(504, '{"code":"WORKER_LIMIT"}', ""),
    { ok: false, reason: "runtime 5xx boot failure" },
  );
  assert.deepEqual(
    classifyWorkerBoot(500, '{"error":"internal_error"}', "edge-runtime request failed"),
    { ok: false, reason: "container log has worker boot error" },
  );
  assert.deepEqual(
    classifyWorkerBoot(200, "ok", "something worker boot error in isolate"),
    { ok: false, reason: "container log has worker boot error" },
  );
});

function parseDummyEnv(source: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of source.split("\n")) {
    if (!line) continue;
    const eq = line.indexOf("=");
    assert.ok(eq > 0, `dummy env line must be NAME=value: ${line}`);
    values.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return values;
}

test("dummy edge env uses syntactically valid non-routable URLs", () => {
  const values = parseDummyEnv(dummyEdgeEnv());
  assert.equal(values.get("SUPABASE_URL"), DUMMY_HTTP_URL);
  assert.equal(values.get("SWARM_DATABASE_URL"), DUMMY_DATABASE_URL);
  assert.equal(values.get("SUPABASE_DB_URL"), DUMMY_DATABASE_URL);
  const urlTyped = [...values.entries()].filter(([name]) => name.endsWith("_URL"));
  assert.ok(urlTyped.length > 0, "dummy env must include URL-typed variables");
  for (const [, value] of urlTyped) {
    assert.match(value, /^(https?|postgres):\/\//);
    assert.ok(new URL(value));
  }
  const client = createClient(DUMMY_HTTP_URL, "dummy-supabase_anon_key", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  assert.equal(typeof client.auth, "object");
  assert.throws(
    () => createClient("dummy-supabase_url", "dummy-supabase_anon_key"),
    /Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL/,
  );
});

test("compose.yaml is the edge-runtime image pin and functions are listed from disk", () => {
  const source = readFileSync(composePath, "utf8");
  const image = composeEdgeRuntimeImage(source);
  assert.match(image, /^public\.ecr\.aws\/supabase\/edge-runtime:/);
  assert.equal(composePath.endsWith("deploy/edge-runtime/compose.yaml"), true);
  assert.match(rewritePublishedPort(source), /127\.0\.0\.1:0:9000/);
  assert.match(
    rewriteFunctionsBind(source, "/tmp/c1-27-functions"),
    /\/tmp\/c1-27-functions:\/home\/deno\/functions-source:ro/,
  );
  assert.match(source, /^\s+- \.\/main:\/home\/deno\/main:ro$/m);
  assert.match(source, /^\s+- \.\/bootstrap\.sh:\/home\/deno\/deploy\/bootstrap\.sh:ro$/m);
  assert.match(source, /^\s+- \.\/h0-deno\.json:\/home\/deno\/deploy\/h0-deno\.json:ro$/m);
  const names = listFunctionDirectories();
  assert.ok(names.includes("admin"));
  assert.equal(names.includes("_shared"), false);
});

test("every edge function boots in the self-hosted edge-runtime image", { timeout: 600_000 }, async (t) => {
  if (!dockerAvailable()) {
    t.skip(DOCKER_UNAVAILABLE);
    return;
  }
  const names = listFunctionDirectories();
  assert.ok(names.length > 0, "supabase/functions must list function directories");
  assert.equal(names.includes("_shared"), false);
  const workDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "edge-runtime-boot.")));
  let runtime: EdgeRuntimeHandle | undefined;
  t.after(() => {
    runtime?.close();
    guardedRemove(workDir);
  });
  runtime = await startComposeEdgeRuntime({ workDir });
  await awaitHealth(runtime.baseUrl);
  const failures: string[] = [];
  for (const name of names) {
    const result = await bootFunction(runtime, name);
    if (!result.classification.ok) {
      failures.push(
        `${name}: HTTP ${result.status} ${result.classification.reason} body=${result.body.slice(0, 200)}`,
      );
    }
  }
  assert.deepEqual(failures, []);
});

test("a function with a bare unmapped specifier fails the boot check", { timeout: 600_000 }, async (t) => {
  if (!dockerAvailable()) {
    t.skip(DOCKER_UNAVAILABLE);
    return;
  }
  const workDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "edge-runtime-boot-neg.")));
  let runtime: EdgeRuntimeHandle | undefined;
  t.after(() => {
    runtime?.close();
    guardedRemove(workDir);
  });
  const copy = join(workDir, "functions");
  mkdirSync(copy, { recursive: true });
  cpSync(functionsRoot, copy, { recursive: true });
  writeFileSync(
    join(copy, "activity", "index.ts"),
    'import "c1-27-unmapped-specifier";\nDeno.serve(() => new Response("should not boot"));\n',
  );
  runtime = await startComposeEdgeRuntime({ workDir, functionsRoot: copy });
  await awaitHealth(runtime.baseUrl);
  const result = await bootFunction(runtime, "activity");
  assert.equal(result.classification.ok, false, `negative control booted: HTTP ${result.status} ${result.body.slice(0, 200)}`);
  assert.match(
    `${result.body}\n${result.logSlice}`,
    /c1-27-unmapped-specifier/,
    `negative control failed without naming c1-27-unmapped-specifier: HTTP ${result.status} body=${result.body.slice(0, 200)}`,
  );
});

/** A minimal text PDF, one content stream per page. */
function textPdf(pages: string[]): Buffer {
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`];
  const font = 3 + pages.length * 2;
  pages.forEach((content, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** POST from inside the container (a real loopback peer, like the mcp worker). */
function postInside(container: string, token: string, body: Buffer): { status: number; body: string } {
  const head = `POST /__internal/file-text HTTP/1.0\r\nHost: 127.0.0.1\r\n${FILE_TEXT_TOKEN_HEADER}: ${token}\r\n` +
    `Content-Type: application/pdf\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
  const result = spawnSync("docker", ["exec", "-i", container, "bash", "-c",
    "exec 3<>/dev/tcp/127.0.0.1/9000; cat >&3; cat <&3"], {
    input: Buffer.concat([Buffer.from(head, "latin1"), body]), encoding: "latin1", timeout: 60_000,
  });
  const raw = String(result.stdout ?? "");
  const status = Number(raw.match(/^HTTP\/1\.[01] (\d{3})/)?.[1] ?? 0);
  return { status, body: Buffer.from(raw.slice(raw.indexOf("\r\n\r\n") + 4), "latin1").toString("utf8") };
}

test("the PDF text worker runs only on main's internal path with the token, and a heavy PDF never stalls other work", { timeout: 600_000 }, async (t) => {
  if (!dockerAvailable()) {
    t.skip(DOCKER_UNAVAILABLE);
    return;
  }
  const token = randomBytes(24).toString("hex");
  const workDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "edge-runtime-file-text.")));
  let runtime: EdgeRuntimeHandle | undefined;
  t.after(() => {
    runtime?.close();
    guardedRemove(workDir);
  });
  runtime = await startComposeEdgeRuntime({ workDir, envText: `${dummyEdgeEnv()}SWARM_FILE_TEXT_TOKEN=${token}\n` });
  await awaitHealth(runtime.baseUrl);
  const pdf = textPdf(["BT /F1 12 Tf 72 720 Td (Hello from page one) Tj ET", "BT /F1 12 Tf 72 720 Td (Second page text) Tj ET"]);

  const viaPublicRoute = await fetch(`${runtime.baseUrl}/functions/v1/file-text`, { method: "POST", body: "{}" });
  assert.equal(viaPublicRoute.status, 404, "never publicly routed");
  await viaPublicRoute.body?.cancel();
  // Token-only (HezSec 07:19Z): the pinned runtime gives main no socket peer address.
  // Reachability is the host-loopback port plus the token; Caddy/Kong route only /functions/v1.
  const fromHostNoToken = await fetch(`${runtime.baseUrl}/__internal/file-text`, {
    method: "POST", headers: { "content-type": "application/pdf" }, body: new Uint8Array(pdf),
  });
  assert.equal(fromHostNoToken.status, 404, "no token, no parser");
  await fromHostNoToken.body?.cancel();
  assert.equal(postInside(runtime.container, "x".repeat(48), pdf).status, 404, "a wrong token is refused");
  const good = postInside(runtime.container, token, pdf);
  assert.equal(good.status, 200, good.body);
  const parsed = JSON.parse(good.body) as { text: string; pages_read: number; page_count: number; truncated: boolean };
  assert.equal(parsed.text.includes("Hello from page one"), true, good.body);
  assert.equal(parsed.text.includes("Second page text"), true, good.body);
  assert.deepEqual([parsed.pages_read, parsed.page_count, parsed.truncated], [2, 2, false]);

  // Memory: five sequential extractions, each waiting for the previous parser isolate to be
  // gone (busy until then). Container memory is measured before and after; isolates being
  // absent from memStats is not by itself proof that memory came back.
  const memory = () => {
    const out = spawnSync("docker", ["stats", "--no-stream", "--format", "{{.MemUsage}}", runtime!.container], { encoding: "utf8" });
    const match = String(out.stdout).match(/([\d.]+)\s*(KiB|MiB|GiB)/u);
    assert.ok(match, String(out.stdout));
    const scale = match[2] === "KiB" ? 1 / 1024 : match[2] === "GiB" ? 1024 : 1;
    return Number(match[1]) * scale;
  };
  const extractWhenFree = async (body: Buffer) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = postInside(runtime!.container, token, body);
      if (result.status !== 503) return result;
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
    }
    assert.fail("the parser slot never freed");
  };
  const before = memory();
  for (let run = 0; run < 5; run++) assert.equal((await extractWhenFree(pdf)).status, 200);
  await new Promise((resolveWait) => setTimeout(resolveWait, 12_000));
  const afterRuns = memory();
  t.diagnostic(`edge container memory: ${before.toFixed(1)} MiB before, ${afterRuns.toFixed(1)} MiB after five extractions`);
  assert.ok(afterRuns - before < 96, `memory grew ${(afterRuns - before).toFixed(1)} MiB over five extractions`);

  // A heavy page: ~6 MiB of text operators in one content stream. Whatever the parser
  // manages (capped text, or killed at its CPU or memory limit), it never stalls other workers.
  const heavy = textPdf(["BT /F1 1 Tf " + "(abcdefghijklmnopqrstuvwxyz) Tj 0 -1 Td ".repeat(150_000) + "ET"]);
  const parse = new Promise<{ status: number; body: string }>((resolveParse) => {
    setImmediate(() => resolveParse(postInside(runtime!.container, token, heavy)));
  });
  const concurrent = await bootFunction(runtime, "read");
  assert.equal(concurrent.classification.ok, true, `a concurrent worker must still boot: ${concurrent.body.slice(0, 200)}`);
  const heavyResult = await parse;
  assert.ok([200, 422, 503].includes(heavyResult.status), heavyResult.body.slice(0, 200));
  if (heavyResult.status === 200) {
    const text = (JSON.parse(heavyResult.body) as { text: string; truncated: boolean });
    assert.ok(Buffer.byteLength(text.text) <= 512 * 1024, "output stays within the cap");
  } else {
    assert.match(heavyResult.body, /^\{"error":"(pdf_too_complex|pdf_unreadable|busy)"\}$/u, "fixed errors only");
  }
  const health = await fetch(`${runtime.baseUrl}/health`);
  assert.equal(health.status, 200, "main stays healthy");
  await health.body?.cancel();
  assert.equal(runtime.logs().includes("Hello from page one"), false, "extracted text never reaches the logs");
});

test("the PDF parser worker really runs with network, filesystem, process, env and system access denied", { timeout: 600_000 }, async (t) => {
  if (!dockerAvailable()) {
    t.skip(DOCKER_UNAVAILABLE);
    return;
  }
  const token = randomBytes(24).toString("hex");
  const workDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "edge-runtime-file-text-probe.")));
  let runtime: EdgeRuntimeHandle | undefined;
  t.after(() => {
    runtime?.close();
    guardedRemove(workDir);
  });
  // The same name and the same main-created worker options, with a probe in place of the parser.
  const copy = join(workDir, "functions");
  cpSync(functionsRoot, copy, { recursive: true });
  writeFileSync(join(copy, "file-text", "index.ts"), `
const attempt = async (run: () => Promise<unknown>) => {
  try { await run(); return "allowed"; }
  catch (error) {
    const name = (error as { name?: string })?.name ?? "unknown";
    return name === "NotCapable" || name === "PermissionDenied" ? "denied" : "error:" + name;
  }
};
Deno.serve(async (request) => {
  await request.arrayBuffer();
  const results = {
    net: await attempt(() => fetch("http://1.1.1.1/", { signal: AbortSignal.timeout(3000) })),
    read: await attempt(() => Deno.readTextFile("/etc/hostname")),
    write: await attempt(() => Deno.writeTextFile("/tmp/file-text-probe", "x")),
    env: await attempt(async () => Deno.env.get("PATH")),
    run: await attempt(() => new Deno.Command("true").output()),
    sys: await attempt(async () => Deno.hostname()),
  };
  return new Response(JSON.stringify({ text: JSON.stringify(results), truncated: false, pages_read: 0, page_count: 0 }),
    { status: 200, headers: { "content-type": "application/json" } });
});
`);
  runtime = await startComposeEdgeRuntime({ workDir, functionsRoot: copy, envText: `${dummyEdgeEnv()}SWARM_FILE_TEXT_TOKEN=${token}\n` });
  await awaitHealth(runtime.baseUrl);
  const probe = postInside(runtime.container, token, textPdf(["BT ET"]));
  assert.equal(probe.status, 200, probe.body);
  const results = JSON.parse((JSON.parse(probe.body) as { text: string }).text) as Record<string, string>;
  assert.deepEqual(results, { net: "denied", read: "denied", write: "denied", env: "denied", run: "denied", sys: "denied" });
});
