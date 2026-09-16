import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const deployRoot = join(repoRoot, "deploy/site");

interface Route {
  path: string;
  status: number;
  contentType: string | null;
  headers: Record<string, string | null>;
}

interface Reference {
  artifactCount: number;
  artifacts: string[];
  routeCount: number;
  recordedHeaders: string[];
  routes: Route[];
}

async function reference(): Promise<Reference> {
  return JSON.parse(
    await readFile(join(deployRoot, "vercel-reference.json"), "utf8"),
  ) as Reference;
}

function caddyArtifact(path: string, artifacts: Set<string>): string | undefined {
  const relativePath = path.slice(1);
  if (path.endsWith("/")) {
    const index = `${relativePath}index.html`;
    return artifacts.has(index) ? index : undefined;
  }
  const cleanIndex = `${relativePath}/index.html`;
  if (artifacts.has(cleanIndex)) return cleanIndex;
  return artifacts.has(relativePath) ? relativePath : undefined;
}

test("the Caddy clean-URL rules match every recorded Vercel route", async () => {
  const inventory = await reference();
  const caddyfile = await readFile(join(deployRoot, "commonswarm-site.caddy"), "utf8");
  const artifacts = new Set(inventory.artifacts);

  assert.equal(inventory.artifactCount, inventory.artifacts.length);
  assert.equal(inventory.routeCount, inventory.routes.length);
  assert.match(caddyfile, /rewrite @trailingSlash \{path\}index\.html/);
  assert.match(caddyfile, /try_files @cleanUrl \{path\}\/index\.html \{path\} =404/);
  assert.match(caddyfile, /root \* \/srv\/commonswarm\/site\/current/);

  for (const route of inventory.routes) {
    const resolved = caddyArtifact(route.path, artifacts);
    assert.equal(
      route.status === 200,
      resolved !== undefined,
      `${route.path}: reference status ${route.status}, Caddy resolves ${String(resolved)}`,
    );
  }

  for (const path of ["/__commonswarm_missing__", "/_astro/", "/fonts/"]) {
    const route = inventory.routes.find((candidate) => candidate.path === path);
    assert.equal(route?.status, 404, `${path} must be in the negative inventory`);
    assert.equal(caddyArtifact(path, artifacts), undefined);
  }
  assert.match(caddyfile, /header @install Content-Type "application\/x-sh"/);
  assert.match(caddyfile, /header @markdown Content-Type "text\/markdown; charset=utf-8"/);
  assert.match(caddyfile, /header @javascript Content-Type "application\/javascript; charset=utf-8"/);
  assert.match(caddyfile, /header @manifest Content-Type "application\/manifest\+json; charset=utf-8"/);
  assert.match(caddyfile, /header @xml Content-Type "application\/xml"/);
  assert.doesNotMatch(caddyfile, /immutable|max-age=31536000/i);
});

test("deploy dry-run refuses an empty /start backend URL", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "commonswarm-site-empty-meta-"));
  try {
    await mkdir(join(fixture, "start"));
    await writeFile(
      join(fixture, "start/index.html"),
      '<meta name="commonswarm:url" content="">',
      "utf8",
    );
    await assert.rejects(
      execFileAsync("sh", [join(deployRoot, "deploy.sh"), "--dry-run", "--dist", fixture], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 10_000,
      }),
      (error: unknown) => {
        const result = error as { code?: number; stderr?: string };
        assert.equal(result.code, 1);
        assert.match(result.stderr ?? "", /commonswarm:url meta value is empty/);
        return true;
      },
    );

    await writeFile(
      join(fixture, "start/index.html"),
      '<meta name="commonswarm:url" content="https://example.invalid">',
      "utf8",
    );
    const accepted = await execFileAsync(
      "sh",
      [join(deployRoot, "deploy.sh"), "--dry-run", "--dist", fixture],
      { cwd: repoRoot, encoding: "utf8", timeout: 10_000 },
    );
    assert.match(accepted.stdout, /Dry run passed/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("parity check exits nonzero for one injected header difference", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "commonswarm-site-parity-"));
  const server = createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.setHeader("cache-control", "public, max-age=1");
    response.end("ok");
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const injectedReference = {
      recordedHeaders: ["cache-control"],
      routes: [{
        path: "/probe",
        status: 200,
        contentType: "text/plain; charset=utf-8",
        headers: { "cache-control": "public, max-age=0, must-revalidate" },
      }],
    };
    const referencePath = join(fixture, "reference.json");
    await writeFile(referencePath, JSON.stringify(injectedReference), "utf8");

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          join(deployRoot, "parity-check.mjs"),
          `http://127.0.0.1:${address.port}`,
          "--reference",
          referencePath,
        ],
        { cwd: repoRoot, encoding: "utf8", timeout: 10_000 },
      ),
      (error: unknown) => {
        const result = error as { code?: number; stderr?: string };
        assert.equal(result.code, 1);
        assert.match(result.stderr ?? "", /\/probe: cache-control expected/);
        assert.match(result.stderr ?? "", /max-age=1/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
    await rm(fixture, { recursive: true, force: true });
  }
});
