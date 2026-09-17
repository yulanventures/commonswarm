import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePrivateProfileCopy } from "../../scripts/timeout-table/core.mjs";
import { installRunResourceCleanup, sourceRootForRef } from "../../scripts/timeout-table/run.mjs";

const [mode, marker, profile, gitRepo] = process.argv.slice(2);
if ((mode !== "exit13" && mode !== "sigterm" && mode !== "sighup" && mode !== "sigint") || !marker || !profile || !gitRepo) {
  process.stderr.write("usage: timeout-table-exit-fixture.mjs exit13|sigterm|sighup|sigint MARKER PROFILE REPO\n");
  process.exit(2);
}

const resources = { repo: gitRepo, tempRoot: null, worktreePath: null };
installRunResourceCleanup(resources);
resources.tempRoot = await mkdtemp(join(tmpdir(), "cswarm-timeout-run-"));
await chmod(resources.tempRoot, 0o700);
const copy = await makePrivateProfileCopy(profile, { tempParent: resources.tempRoot });
const source = await sourceRootForRef(gitRepo, "HEAD", resources.tempRoot, resources);
await writeFile(marker, JSON.stringify({
  tempRoot: resources.tempRoot,
  worktreePath: resources.worktreePath,
  copyRoot: copy.root,
  profilePath: copy.profilePath,
  credentialFile: copy.profile.credential_file,
  sourceRoot: source.root,
}), { mode: 0o600 });

if (mode === "sigterm" || mode === "sighup" || mode === "sigint") {
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}

const go = `${marker}.go`;
while (true) {
  try {
    await stat(go);
    break;
  } catch {
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}
const timer = setTimeout(() => {}, 1_000_000);
timer.unref();
await new Promise(() => {});
