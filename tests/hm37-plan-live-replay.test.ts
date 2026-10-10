import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { test } from "node:test";

const PLAN = "docs/evidence/2026-09-28-box-hm37/BOX-WINDOW.md";
const RECORDING =
  "docs/evidence/2026-09-28-box-hm37/lane6-live-responses.json";
const HOSTED_AUTHORITY = "src/protocol/hosted-authority.ts";
const PREVIOUS_REVISION = "7e87bceb";
const BASE = "https://mcp.commonswarm.com";

const REPLAY_MODULE = String.raw`
import base64
import io
import json
import os
import urllib.error
import urllib.request
from email.message import Message

with open(os.environ["CSWARM_REPLAY_RECORDING"], encoding="utf-8") as source:
    recording = json.load(source)

responses = {}
for response in recording["responses"]:
    key = json.dumps(
        [response["method"], response["url"], response["request_body"]],
        sort_keys=True,
        separators=(",", ":"),
    )
    if key in responses:
        raise RuntimeError("duplicate recorded request: " + key)
    responses[key] = response

def request_body(request):
    if request.data is None:
        return None
    return json.loads(request.data.decode("utf-8"))

def record_attempt(method, url, body, matched):
    with open(os.environ["CSWARM_REPLAY_LOG"], "a", encoding="utf-8") as log:
        log.write(json.dumps({
            "method": method,
            "url": url,
            "request_body": body,
            "matched": matched,
        }, sort_keys=True) + "\n")

class ReplayResponse:
    def __init__(self, response):
        self.code = response["status"]
        self.status = response["status"]
        self.headers = Message()
        self.headers["Content-Type"] = response["content_type"]
        self._body = io.BytesIO(base64.b64decode(response["body_b64"]))

    def read(self, amount=-1):
        return self._body.read(amount)

    def close(self):
        self._body.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()

class ReplayOpener:
    def open(self, request, timeout=None):
        method = request.get_method()
        url = request.full_url
        body = request_body(request)
        key = json.dumps([method, url, body], sort_keys=True, separators=(",", ":"))
        response = responses.get(key)
        record_attempt(method, url, body, response is not None)
        if response is None:
            raise RuntimeError("unrecorded request: " + key)
        replay = ReplayResponse(response)
        if replay.code >= 400:
            raise urllib.error.HTTPError(
                url, replay.code, "recorded response", replay.headers, replay._body)
        return replay

def build_replay_opener(*handlers):
    return ReplayOpener()

urllib.request.build_opener = build_replay_opener
`;

interface RecordedResponse {
  method: string;
  url: string;
  request_body: unknown;
  status: number;
  content_type: string;
  body_b64: string;
}

interface Recording {
  recorded_at: string;
  client: string;
  responses: RecordedResponse[];
}

interface ProgramResult {
  status: number | null;
  stdout: string;
  stderr: string;
  attempts: Array<{
    method: string;
    url: string;
    request_body: unknown;
    matched: boolean;
  }>;
}

function extractStep(plan: string, step: string): string {
  const opening = `\`\`\`sh\n# step: ${step}\n`;
  const start = plan.indexOf(opening);
  assert.ok(start >= 0, `${step} shell block is missing`);
  assert.equal(
    plan.indexOf(opening, start + opening.length),
    -1,
    `${step} shell block is duplicated`,
  );
  const bodyStart = start + "```sh\n".length;
  const end = plan.indexOf("\n```", bodyStart);
  assert.ok(end > bodyStart, `${step} shell block is unterminated`);
  return plan.slice(bodyStart, end) + "\n";
}

function extractPythonHeredoc(step: string, command: string): string {
  const commandStart = step.indexOf(command);
  assert.ok(commandStart >= 0, `missing command ${command}`);
  assert.equal(
    step.indexOf(command, commandStart + command.length),
    -1,
    `duplicated command ${command}`,
  );
  const marker = "<<'PY'";
  const markerStart = step.indexOf(marker, commandStart + command.length);
  assert.ok(markerStart >= 0, `missing PY heredoc after ${command}`);
  const bodyStart = step.indexOf("\n", markerStart + marker.length) + 1;
  assert.ok(bodyStart > 0, `unterminated heredoc header after ${command}`);
  const end = step.indexOf("\nPY\n", bodyStart);
  assert.ok(end >= bodyStart, `unterminated PY heredoc after ${command}`);
  return step.slice(bodyStart, end) + "\n";
}

function extractPrecondition(plan: string): string {
  return extractPythonHeredoc(
    extractStep(plan, "hm37-hm6-oauth-precondition"),
    "python3 - https://mcp.commonswarm.com",
  );
}

function extractRefusalPrecondition(plan: string): string {
  return extractPythonHeredoc(
    extractStep(plan, "hm37-hm6-oauth-refusal-probe"),
    "python3 - https://mcp.commonswarm.com",
  );
}

function buildPublicRead(plan: string): string {
  return extractPythonHeredoc(
    extractStep(plan, "hm37-public-boundary-reads"),
    'cat >"$READS"',
  );
}

function buildPublicProbe(plan: string, authorityPath: string): string {
  const step = extractStep(plan, "hm37-public-boundaries");
  const kindsProgram = extractPythonHeredoc(
    step,
    "python3 - src/protocol/hosted-authority.ts",
  );
  const kinds = spawnSync("python3", ["-", authorityPath], {
    encoding: "utf8",
    input: kindsProgram,
  });
  assert.equal(kinds.status, 0, kinds.stderr);
  assert.match(kinds.stdout, /^KINDS = \[/);
  const probeProgram = extractPythonHeredoc(step, 'cat >>"$PROBE"');
  return kinds.stdout + probeProgram;
}

async function removeTemporaryRoot(root: string): Promise<void> {
  const resolvedRoot = resolve(root);
  assert.equal(dirname(resolvedRoot), resolve(tmpdir()));
  assert.ok(basename(resolvedRoot).startsWith("cswarm-hm37-replay-"));
  await rm(resolvedRoot, { recursive: true });
}

async function readAttempts(path: string): Promise<ProgramResult["attempts"]> {
  const log = await readFile(path, "utf8");
  return log.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function runProgram(
  root: string,
  label: string,
  program: string,
  args: string[],
  recording: string,
): Promise<ProgramResult> {
  const log = join(root, `${label}.jsonl`);
  await writeFile(log, "");
  const result = spawnSync("python3", ["-", ...args], {
    encoding: "utf8",
    input: program,
    env: {
      ...process.env,
      CSWARM_REPLAY_LOG: log,
      CSWARM_REPLAY_RECORDING: recording,
      PYTHONPATH: process.env.PYTHONPATH
        ? `${root}${delimiter}${process.env.PYTHONPATH}`
        : root,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    attempts: await readAttempts(log),
  };
}

function changedRecording(
  source: Recording,
  method: string,
  url: string,
  contentType: string,
): Recording {
  const copy = JSON.parse(JSON.stringify(source)) as Recording;
  const response = copy.responses.find(
    (candidate) => candidate.method === method && candidate.url === url,
  );
  assert.ok(response, `recording is missing ${method} ${url}`);
  response.content_type = contentType;
  return copy;
}

function assertPassed(result: ProgramResult): Record<string, unknown> {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function assertFailedAt(result: ProgramResult, path: string): void {
  assert.notEqual(result.status, 0, "program unexpectedly passed");
  if (!/AssertionError/.test(result.stderr)) {
    const diagnostic = JSON.parse(result.stdout) as {
      pass?: boolean;
      failure?: { path?: string; headers?: Record<string, unknown> };
    };
    assert.equal(diagnostic.pass, false);
    assert.equal(diagnostic.failure?.path, path);
    assert.ok(diagnostic.failure?.headers, "failure evidence omitted response headers");
  }
  const last = result.attempts.at(-1);
  assert.ok(last, "failed program made no replay request");
  assert.equal(new URL(last.url).pathname, path);
  assert.equal(last.matched, true);
}

test("HM37 plan probes replay the recorded lane 6 responses and reject bad media types", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cswarm-hm37-replay-"));
  try {
    await writeFile(join(temporaryRoot, "sitecustomize.py"), REPLAY_MODULE);
    const currentPlan = await readFile(PLAN, "utf8");
    const currentPrecondition = extractPrecondition(currentPlan);
    const currentRefusalPrecondition = extractRefusalPrecondition(currentPlan);
    const currentPublicRead = buildPublicRead(currentPlan);
    // This is a replay of six historical requests. Resolve the authority input
    // at the recording's revision; the current close command has no recording.
    const authority = spawnSync("git", ["show", `${PREVIOUS_REVISION}:${HOSTED_AUTHORITY}`], { encoding: "utf8" });
    assert.equal(authority.status, 0, authority.stderr);
    const authorityPath = join(temporaryRoot, "hosted-authority.ts");
    await writeFile(authorityPath, authority.stdout);
    const currentPublicProbe = buildPublicProbe(currentPlan, authorityPath);
    const recordingText = await readFile(RECORDING, "utf8");
    const recording = JSON.parse(recordingText) as Recording;

    const precondition = await runProgram(
      temporaryRoot,
      "current-precondition",
      currentPrecondition,
      [BASE],
      RECORDING,
    );
    const preconditionJson = assertPassed(precondition);
    assert.equal(preconditionJson.pass, true);

    const refusalPrecondition = await runProgram(
      temporaryRoot,
      "current-refusal-precondition",
      currentRefusalPrecondition,
      [BASE],
      RECORDING,
    );
    const refusalPreconditionJson = assertPassed(refusalPrecondition);
    assert.equal(refusalPreconditionJson.pass, true);

    // Gateway mode covers api/edge-staging hosts and the box loopback. Those
    // requests are intentionally absent from this lane 6 MCP-host recording.
    const publicRead = await runProgram(
      temporaryRoot,
      "current-public-read",
      currentPublicRead,
      ["mcp", BASE],
      RECORDING,
    );
    const publicReadJson = assertPassed(publicRead);
    assert.equal(publicReadJson.mode, "mcp");

    const publicProbe = await runProgram(
      temporaryRoot,
      "current-public",
      currentPublicProbe,
      ["mcp", BASE],
      RECORDING,
    );
    const publicJson = assertPassed(publicProbe);
    assert.equal(publicJson.mode, "mcp");
    const publicResults = publicJson.results as Array<{ pass: boolean }>;
    assert.ok(publicResults.length > 0);
    assert.ok(publicResults.every((result) => result.pass === true));

    const previous = spawnSync(
      "git",
      ["show", `${PREVIOUS_REVISION}:${PLAN}`],
      { encoding: "utf8" },
    );
    assert.equal(previous.status, 0, previous.stderr);
    for (const [label, program, args] of [
      ["old-precondition", extractPrecondition(previous.stdout), [BASE]],
      ["old-public", buildPublicProbe(previous.stdout, authorityPath), ["mcp", BASE]],
    ] as const) {
      assert.match(program, /assert "application\/json" in content_type/);
      const result = await runProgram(
        temporaryRoot,
        label,
        program,
        [...args],
        RECORDING,
      );
      assertFailedAt(result, "/jwks");
    }

    const htmlJwks = join(temporaryRoot, "jwks-text-html.json");
    await writeFile(
      htmlJwks,
      JSON.stringify(changedRecording(
        recording,
        "GET",
        `${BASE}/jwks`,
        "text/html",
      )),
    );
    for (const [label, program, args] of [
      ["html-precondition", currentPrecondition, [BASE]],
      ["html-public", currentPublicRead, ["mcp", BASE]],
    ] as const) {
      const result = await runProgram(
        temporaryRoot,
        label,
        program,
        [...args],
        htmlJwks,
      );
      assertFailedAt(result, "/jwks");
    }

    const genericJwks = join(temporaryRoot, "jwks-application-json.json");
    await writeFile(
      genericJwks,
      JSON.stringify(changedRecording(
        recording,
        "GET",
        `${BASE}/jwks`,
        "application/json",
      )),
    );
    for (const [label, program, args] of [
      ["generic-precondition", currentPrecondition, [BASE]],
      ["generic-public", currentPublicRead, ["mcp", BASE]],
    ] as const) {
      const result = await runProgram(
        temporaryRoot,
        label,
        program,
        [...args],
        genericJwks,
      );
      assertFailedAt(result, "/jwks");
    }

    const jwksMcp = join(temporaryRoot, "mcp-jwks-content-type.json");
    await writeFile(
      jwksMcp,
      JSON.stringify(changedRecording(
        recording,
        "GET",
        `${BASE}/mcp`,
        "application/jwk-set+json",
      )),
    );
    const wrongMcpType = await runProgram(
      temporaryRoot,
      "wrong-mcp-content-type",
      currentPublicProbe,
      ["mcp", BASE],
      jwksMcp,
    );
    assertFailedAt(wrongMcpType, "/mcp");

    const unrecorded = await runProgram(
      temporaryRoot,
      "unrecorded",
      currentPrecondition,
      ["https://unrecorded.invalid"],
      RECORDING,
    );
    assert.notEqual(unrecorded.status, 0, "unrecorded request unexpectedly passed");
    assert.match(unrecorded.stderr, /unrecorded request/);
    assert.equal(unrecorded.attempts.length, 1);
    assert.equal(unrecorded.attempts[0]?.matched, false);
  } finally {
    await removeTemporaryRoot(temporaryRoot);
  }
});
