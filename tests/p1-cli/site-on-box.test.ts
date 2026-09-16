import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
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
  stableArtifactCount: number;
  artifacts: string[];
  routeCount: number;
  recordedHeaders: string[];
  routes: Route[];
  fingerprintedAssetPolicies: Array<{
    extension: string;
    status: number;
    contentType: string;
    headers: Record<string, string | null>;
    observedFileCount: number;
  }>;
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

  assert.equal(inventory.stableArtifactCount, inventory.artifacts.length);
  assert.equal(
    inventory.artifactCount,
    inventory.stableArtifactCount + inventory.fingerprintedAssetPolicies.reduce(
      (count, policy) => count + policy.observedFileCount,
      0,
    ),
  );
  assert.equal(inventory.routeCount, inventory.routes.length);
  assert.match(caddyfile, /handle @cleanUrl \{/);
  assert.match(caddyfile, /try_files \{path\}\/index\.html \{path\}/);
  assert.doesNotMatch(caddyfile, /try_files\s+@cleanUrl|=404/);
  assert.match(caddyfile, /error @dotfile 404/);
  assert.match(caddyfile, /root \* \/srv\/commonswarm\/site\/current/);

  for (const route of inventory.routes) {
    const resolved = caddyArtifact(route.path, artifacts);
    assert.equal(
      route.status === 200,
      resolved !== undefined,
      `${route.path}: reference status ${route.status}, Caddy resolves ${String(resolved)}`,
    );
  }

  for (const path of ["/__commonswarm_missing__", "/_astro/", "/fonts/", "/.well-known/security.txt"]) {
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
  assert.equal(inventory.artifacts.some((file) => file.startsWith("_astro/")), false);
  assert.equal(inventory.routes.some((route) => /^\/_astro\/.+\.[A-Za-z0-9]+$/.test(route.path)), false);
  assert.deepEqual(
    inventory.fingerprintedAssetPolicies.map((policy) => policy.extension).sort(),
    [".css", ".js"],
  );
});

test("Caddy 2.11 adapts the route graph and retains the error route", async (t) => {
  const available = spawnSync("docker", ["image", "inspect", "caddy:2.11"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (available.status !== 0) {
    t.skip("Docker or the local caddy:2.11 image is unavailable");
    return;
  }

  const caddyfile = await readFile(join(deployRoot, "commonswarm-site.caddy"), "utf8");
  const adapted = spawnSync(
    "docker",
    ["run", "--rm", "--network", "none", "-i", "caddy:2.11", "caddy", "adapt", "--config", "/dev/stdin", "--adapter", "caddyfile"],
    { encoding: "utf8", input: caddyfile, timeout: 20_000 },
  );
  assert.equal(adapted.status, 0, adapted.stderr);
  const config = JSON.parse(adapted.stdout) as {
    apps: { http: { servers: Record<string, { errors?: { routes?: unknown[] } }> } };
  };
  const serialized = JSON.stringify(config);
  const server = Object.values(config.apps.http.servers)[0];
  assert.ok(server?.errors?.routes && server.errors.routes.length > 0);
  assert.match(serialized, /The page could not be found/);
  assert.match(serialized, /try_files.*index\.html/);
  assert.match(serialized, /path_regexp.*dotfile/);
  assert.doesNotMatch(serialized, /@cleanUrl/);
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

test("deploy npm runs inside its site directory, independent of caller cwd", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "commonswarm-site-npm-cwd-"));
  try {
    const site = join(fixture, "project/site");
    const elsewhere = join(fixture, "elsewhere");
    await mkdir(site, { recursive: true });
    await mkdir(elsewhere);
    await writeFile(join(site, "package.json"), '{"name":"site-fixture","version":"1.0.0"}\n');
    await writeFile(
      join(site, "package-lock.json"),
      '{"name":"site-fixture","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"site-fixture","version":"1.0.0"}}}\n',
    );
    const result = await execFileAsync(
      "sh",
      [join(deployRoot, "deploy.sh"), "--dry-run", "--npm-ci", site],
      { cwd: elsewhere, encoding: "utf8", timeout: 20_000 },
    );
    assert.match(result.stdout, /up to date/);
    const script = await readFile(join(deployRoot, "deploy.sh"), "utf8");
    assert.match(script, /\(cd "\$site_dir" && npm "\$@" <\/dev\/null\)/);
    assert.doesNotMatch(script, /npm --prefix/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("release finalization keeps old assets, normalizes modes, prunes, and refuses collisions", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "commonswarm-site-release-"));
  try {
    const siteRoot = join(fixture, "site");
    const releases = join(siteRoot, "releases");
    await mkdir(releases, { recursive: true });
    const oldNames = Array.from({ length: 5 }, (_, index) =>
      `2026091${index + 1}T000000Z-111111111111-000000000000000${index}`,
    );
    for (const [index, name] of oldNames.entries()) {
      const path = join(releases, name);
      await mkdir(path);
      await writeFile(join(path, "old.txt"), name);
      const age = new Date(`2026-09-${10 + index}T00:00:00Z`);
      await utimes(path, age, age);
    }
    const previous = join(releases, oldNames[4]);
    await mkdir(join(previous, "_astro"));
    await writeFile(join(previous, "_astro/old.js"), "old");
    await writeFile(join(previous, "_astro/shared.js"), "old-shared");
    await symlink(`releases/${oldNames[4]}`, join(siteRoot, "current"));

    const finalName = "20260916T000000Z-222222222222-aaaaaaaaaaaaaaaa";
    const temporary = join(releases, `${finalName}.tmp`);
    const final = join(releases, finalName);
    await mkdir(join(temporary, "_astro"), { recursive: true });
    await writeFile(join(temporary, "_astro/new.js"), "new");
    await writeFile(join(temporary, "_astro/shared.js"), "new-shared");
    await chmod(temporary, 0o700);
    await chmod(join(temporary, "_astro/new.js"), 0o600);

    await execFileAsync("sh", [join(deployRoot, "finalize-release.sh"), temporary, final, siteRoot], {
      cwd: fixture,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(await readFile(join(final, "_astro/old.js"), "utf8"), "old");
    assert.equal(await readFile(join(final, "_astro/shared.js"), "utf8"), "new-shared");
    assert.equal((await stat(final)).mode & 0o777, 0o755);
    assert.equal((await stat(join(final, "_astro/new.js"))).mode & 0o777, 0o644);
    assert.equal(await readlink(join(siteRoot, "current")), `releases/${finalName}`);
    assert.equal((await readdir(releases)).filter((name) => !name.endsWith(".tmp")).length, 5);
    assert.equal((await readdir(releases)).includes(oldNames[0]), false);

    const collisionTemp = join(releases, "collision.tmp");
    await mkdir(collisionTemp);
    await assert.rejects(
      execFileAsync("sh", [join(deployRoot, "finalize-release.sh"), collisionTemp, final, siteRoot], {
        cwd: fixture,
        encoding: "utf8",
        timeout: 10_000,
      }),
      (error: unknown) => {
        assert.match((error as { stderr?: string }).stderr ?? "", /already exists/);
        return true;
      },
    );

    const deployScript = await readFile(join(deployRoot, "deploy.sh"), "utf8");
    // The upload runs on the operator's mac, whose openrsync rejects --chmod; modes are normalized on the box by
    // finalize-release.sh (proved by the 0700/0600 fixture above).
    assert.match(deployScript, /rsync -a --delete "\$checkout\/site\/dist\/"/);
    assert.doesNotMatch(deployScript.replace(/^\s*#.*$/gm, ""), /--chmod/);
    const names = await Promise.all([0, 1].map(async () =>
      (await execFileAsync("sh", [join(deployRoot, "deploy.sh"), "--dry-run", "--release-name"], {
        cwd: fixture,
        encoding: "utf8",
        timeout: 10_000,
      })).stdout.trim(),
    ));
    assert.notEqual(names[0], names[1]);
    assert.match(names[0], /^\d{8}T\d{6}Z-[0-9a-f]{12}-[0-9a-f]{16}$/);
    assert.notEqual(names[0].split("-").at(-1), names[1].split("-").at(-1));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("pre-cutover checks trust the public Cloudflare Origin CA explicitly", async () => {
  const runbook = await readFile(join(deployRoot, "RUNBOOK.md"), "utf8");
  const parity = await readFile(join(deployRoot, "parity-check.mjs"), "utf8");
  assert.match(runbook, /parity-check\.mjs https:\/\/BOX_ADDRESS --host commonswarm\.com --ca \.\/cloudflare-origin-ca-root\.pem/);
  assert.match(runbook, /curl -sS --cacert \.\/cloudflare-origin-ca-root\.pem --resolve commonswarm\.com:443:BOX_ADDRESS/);
  assert.doesNotMatch(runbook, /NODE_TLS_REJECT_UNAUTHORIZED|-k\b|--insecure\b/);
  assert.match(parity, /flag === "--ca"/);
  assert.match(parity, /caPath \? await readFile\(caPath\)/);
});

test("site env validator rejects a service-role JWT without printing it", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "commonswarm-site-env-"));
  const token = (role: string) => [
    Buffer.from('{"alg":"HS256"}').toString("base64url"),
    Buffer.from(JSON.stringify({ role })).toString("base64url"),
    "fixture-signature",
  ].join(".");
  try {
    const envPath = join(fixture, ".env");
    await writeFile(envPath, `PUBLIC_SUPABASE_URL=https://example.invalid\nPUBLIC_SUPABASE_ANON_KEY=${token("anon")}\n`);
    await execFileAsync(process.execPath, [join(deployRoot, "validate-site-env.mjs"), envPath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const serviceRole = token("service_role");
    await writeFile(envPath, `PUBLIC_SUPABASE_URL=https://example.invalid\nPUBLIC_SUPABASE_ANON_KEY=${serviceRole}\n`);
    await assert.rejects(
      execFileAsync(process.execPath, [join(deployRoot, "validate-site-env.mjs"), envPath], {
        encoding: "utf8",
        timeout: 10_000,
      }),
      (error: unknown) => {
        const result = error as { code?: number; stdout?: string; stderr?: string };
        assert.equal(result.code, 1);
        assert.match(result.stderr ?? "", /service_role role/);
        assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(serviceRole.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      },
    );
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
    await mkdir(join(fixture, "dist/_astro"), { recursive: true });
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
          "--dist",
          join(fixture, "dist"),
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

test("parity derives a fresh hashed asset path but uses Vercel's recorded policy", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "commonswarm-site-dynamic-asset-"));
  const server = createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/javascript; charset=utf-8");
    response.setHeader("cache-control", "public, max-age=1");
    response.end("asset");
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const dist = join(fixture, "dist");
    await mkdir(join(dist, "_astro"), { recursive: true });
    await writeFile(join(dist, "_astro/future.NEW123.js"), "asset");
    const referencePath = join(fixture, "reference.json");
    await writeFile(referencePath, JSON.stringify({
      recordedHeaders: ["cache-control"],
      routes: [],
      fingerprintedAssetPolicies: [{
        extension: ".js",
        status: 200,
        contentType: "application/javascript; charset=utf-8",
        headers: { "cache-control": "public, max-age=0, must-revalidate" },
      }],
    }));
    await assert.rejects(
      execFileAsync(process.execPath, [
        join(deployRoot, "parity-check.mjs"),
        `http://127.0.0.1:${address.port}`,
        "--reference",
        referencePath,
        "--dist",
        dist,
      ], { cwd: fixture, encoding: "utf8", timeout: 10_000 }),
      (error: unknown) => {
        const result = error as { code?: number; stderr?: string };
        assert.equal(result.code, 1);
        assert.match(result.stderr ?? "", /\/_astro\/future\.NEW123\.js: cache-control expected/);
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
