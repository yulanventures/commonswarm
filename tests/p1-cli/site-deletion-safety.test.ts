import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const deployRoot = join(repoRoot, "deploy/site");

async function makeFunctionProbe(
  fixture: string,
  scriptName: "deploy.sh" | "finalize-release.sh",
): Promise<string> {
  const source = await readFile(join(deployRoot, scriptName), "utf8");
  const start = source.indexOf("resolve_delete_path() {");
  const endMarker = scriptName === "deploy.sh" ? "\nvalidate_dist() {" : "\n# END DELETE SAFETY HELPERS";
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `${scriptName} must define deletion safety helpers`);
  assert.notEqual(end, -1, `${scriptName} must delimit deletion safety helpers`);

  const probe = join(fixture, `${scriptName}.probe.sh`);
  await writeFile(probe, `#!/bin/sh\nset -eu\n${source.slice(start, end)}\nprobe_function=$1\nshift\n"$probe_function" "$@"\n`);
  await chmod(probe, 0o755);
  return probe;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function expectRefusal(
  probe: string,
  home: string,
  functionName: string,
  args: string[],
  message: RegExp,
): Promise<void> {
  await assert.rejects(
    execFileAsync("/bin/sh", [probe, functionName, ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
      timeout: 10_000,
    }),
    (error: unknown) => {
      const result = error as { code?: number; stderr?: string };
      assert.notEqual(result.code, 0);
      assert.match(result.stderr ?? "", message);
      return true;
    },
  );
}

test("all recursive site deletions are wired through the guards", async () => {
  const deploy = await readFile(join(deployRoot, "deploy.sh"), "utf8");
  const finalize = await readFile(join(deployRoot, "finalize-release.sh"), "utf8");
  assert.match(deploy, /guarded_delete "\$temp_root" "\$temp_root" root 'temporary deploy root'/);
  assert.match(deploy, /guarded_delete "\$checkout\/site\/dist" "\$temp_root" child 'stale site build output'/);
  assert.match(finalize, /guarded_delete "\$stale_temp" "\$releases" "\$site_root\/current"/);
  assert.match(finalize, /guarded_delete "\$old_release" "\$releases" "\$site_root\/current"/);
  assert.deepEqual(deploy.match(/rm -rf --[^\n]+/g), ['rm -rf -- "$resolved_target"']);
  assert.deepEqual(finalize.match(/rm -rf --[^\n]+/g), ['rm -rf -- "$resolved_target"']);
});

test("deploy deletion guard refuses unsafe targets and deletes valid temporary paths", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "commonswarm-deploy-delete-"));
  try {
    const probe = await makeFunctionProbe(fixture, "deploy.sh");
    const home = join(fixture, "fixture-home");
    const allowed = join(fixture, "allowed");
    const outside = join(fixture, "outside");
    const symlinkTarget = join(fixture, "symlink-target");
    const linked = join(allowed, "linked");
    await mkdir(home);
    await mkdir(allowed);
    await mkdir(outside);
    await mkdir(symlinkTarget);
    await writeFile(join(outside, "keep"), "outside");
    await writeFile(join(symlinkTarget, "keep"), "symlink target");
    await symlink(symlinkTarget, linked);

    await expectRefusal(probe, home, "guarded_delete", ["", allowed, "child", "fixture"], /target is empty/);
    await expectRefusal(probe, home, "guarded_delete", ["/", allowed, "child", "fixture"], /target is \/|resolved target is \//);
    await expectRefusal(probe, home, "guarded_delete", [home, fixture, "child", "fixture"], /equals or contains HOME/);
    await expectRefusal(probe, home, "guarded_delete", [fixture, dirname(fixture), "child", "fixture"], /equals or contains HOME/);
    await expectRefusal(probe, home, "guarded_delete", [linked, allowed, "child", "fixture"], /target is a symlink/);
    await expectRefusal(probe, home, "guarded_delete", [outside, allowed, "child", "fixture"], /outside allowed root/);
    assert.equal(await readFile(join(outside, "keep"), "utf8"), "outside");
    assert.equal(await readFile(join(symlinkTarget, "keep"), "utf8"), "symlink target");

    const validChild = join(allowed, "valid-child");
    await mkdir(validChild);
    await writeFile(join(validChild, "remove"), "remove");
    await execFileAsync("/bin/sh", [probe, "guarded_delete", validChild, allowed, "child", "fixture"], {
      env: { ...process.env, HOME: home },
      timeout: 10_000,
    });
    assert.equal(await exists(validChild), false);

    const validRoot = join(fixture, "commonswarm-site-deploy.abc123");
    await mkdir(validRoot);
    await execFileAsync("/bin/sh", [probe, "guarded_delete", validRoot, validRoot, "root", "fixture"], {
      env: { ...process.env, HOME: home },
      timeout: 10_000,
    });
    assert.equal(await exists(validRoot), false);

    const fallbackBin = join(fixture, "fallback-bin");
    const fallbackTarget = join(allowed, "fallback-child");
    await mkdir(fallbackBin);
    await mkdir(fallbackTarget);
    await symlink("/bin/rm", join(fallbackBin, "rm"));
    await execFileAsync("/bin/sh", [probe, "guarded_delete", fallbackTarget, allowed, "child", "fixture"], {
      env: { ...process.env, HOME: home, PATH: fallbackBin },
      timeout: 10_000,
    });
    assert.equal(await exists(fallbackTarget), false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("deploy validates the mktemp root template before installing its cleanup", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "commonswarm-deploy-temp-root-"));
  try {
    const probe = await makeFunctionProbe(fixture, "deploy.sh");
    const parent = join(fixture, "temp-parent");
    const home = join(fixture, "fixture-home");
    await mkdir(parent);
    await mkdir(home);

    const valid = join(parent, "commonswarm-site-deploy.a1B2c3");
    await mkdir(valid);
    const result = await execFileAsync("/bin/sh", [probe, "validate_temp_root", valid, parent], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
      timeout: 10_000,
    });
    assert.equal(result.stdout.trim(), await realpath(valid));

    const wrongTemplate = join(parent, "not-the-template");
    await mkdir(wrongTemplate);
    await expectRefusal(probe, home, "validate_temp_root", [wrongTemplate, parent], /does not match the mktemp template/);

    const outside = join(fixture, "commonswarm-site-deploy.out123");
    await mkdir(outside);
    await expectRefusal(probe, home, "validate_temp_root", [outside, parent], /outside its mktemp parent/);

    const target = join(fixture, "symlink-target");
    const linked = join(parent, "commonswarm-site-deploy.linked");
    await mkdir(target);
    await symlink(target, linked);
    await expectRefusal(probe, home, "validate_temp_root", [linked, parent], /temporary root is a symlink/);

    const homeContainingRoot = join(parent, "commonswarm-site-deploy.home12");
    const nestedHome = join(homeContainingRoot, "home");
    await mkdir(nestedHome, { recursive: true });
    await expectRefusal(
      probe,
      nestedHome,
      "validate_temp_root",
      [homeContainingRoot, parent],
      /equals or contains HOME/,
    );
    assert.equal(await exists(wrongTemplate), true);
    assert.equal(await exists(outside), true);
    assert.equal(await exists(target), true);
    assert.equal(await exists(homeContainingRoot), true);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("release deletion guard refuses unsafe and current targets, with a valid-delete control", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "commonswarm-release-delete-"));
  try {
    const probe = await makeFunctionProbe(fixture, "finalize-release.sh");
    const home = join(fixture, "fixture-home");
    const releases = join(fixture, "site/releases");
    const outside = join(fixture, "outside");
    const symlinkTarget = join(fixture, "symlink-target");
    const linked = join(releases, "linked.tmp");
    await mkdir(home);
    await mkdir(releases, { recursive: true });
    await mkdir(outside);
    await mkdir(symlinkTarget);
    await writeFile(join(outside, "keep"), "outside");
    await writeFile(join(symlinkTarget, "keep"), "symlink target");
    await symlink(symlinkTarget, linked);

    await expectRefusal(probe, home, "guarded_delete", ["", releases, "", "fixture"], /target is empty/);
    await expectRefusal(probe, home, "guarded_delete", ["/", releases, "", "fixture"], /target is \/|resolved target is \//);
    await expectRefusal(probe, home, "guarded_delete", [home, fixture, "", "fixture"], /equals or contains HOME/);
    await expectRefusal(probe, home, "guarded_delete", [fixture, dirname(fixture), "", "fixture"], /equals or contains HOME/);
    await expectRefusal(probe, home, "guarded_delete", [linked, releases, "", "fixture"], /target is a symlink/);
    await expectRefusal(probe, home, "guarded_delete", [outside, releases, "", "fixture"], /outside releases root/);

    const currentRelease = join(releases, "20260920T000000Z-111111111111-1111111111111111");
    const current = join(fixture, "site/current");
    await mkdir(currentRelease);
    await symlink(`releases/${currentRelease.split("/").at(-1)}`, current);
    await expectRefusal(
      probe,
      home,
      "guarded_delete",
      [currentRelease, releases, current, "fixture"],
      /target is the current release/,
    );

    const valid = join(releases, "20260919T000000Z-222222222222-2222222222222222");
    await mkdir(valid);
    await execFileAsync("/bin/sh", [probe, "guarded_delete", valid, releases, current, "fixture"], {
      env: { ...process.env, HOME: home },
      timeout: 10_000,
    });
    assert.equal(await exists(valid), false);
    assert.equal(await exists(currentRelease), true);
    assert.equal(await readFile(join(outside, "keep"), "utf8"), "outside");
    assert.equal(await readFile(join(symlinkTarget, "keep"), "utf8"), "symlink target");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("release finalization exits nonzero when pruning reaches a symlink", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "commonswarm-release-symlink-"));
  try {
    const siteRoot = join(fixture, "site");
    const releases = join(siteRoot, "releases");
    const temporary = join(releases, "20260928T000000Z-111111111111-1111111111111111.tmp");
    const final = temporary.slice(0, -4);
    const outside = join(fixture, "outside");
    const staleLink = join(releases, "20260927T000000Z-222222222222-2222222222222222.tmp");
    await mkdir(temporary, { recursive: true });
    await mkdir(outside);
    await writeFile(join(outside, "keep"), "outside");
    await symlink(outside, staleLink);

    await assert.rejects(
      execFileAsync("/bin/sh", [join(deployRoot, "finalize-release.sh"), temporary, final, siteRoot], {
        encoding: "utf8",
        env: { ...process.env, HOME: join(fixture, "fixture-home") },
        timeout: 10_000,
      }),
      (error: unknown) => {
        const result = error as { code?: number; stderr?: string };
        assert.equal(result.code, 64);
        assert.match(result.stderr ?? "", /target is a symlink/);
        return true;
      },
    );
    assert.equal(await readFile(join(outside, "keep"), "utf8"), "outside");
    assert.equal(await exists(staleLink), true);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
