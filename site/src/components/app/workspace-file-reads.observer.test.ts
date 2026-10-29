import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserTest, findChrome, launchChrome } from "../../../tests/chrome.js";
import { readRecoveryFixture } from "./workspace-file-reads.fixture.js";

browserTest("real read owners recover Files and a timed-out Wiki version", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "commonswarm-read-recovery-"));
  try {
    const file = join(dir, "index.html");
    await writeFile(file, await readRecoveryFixture());
    const chrome = await findChrome();
    const { stdout } = await launchChrome(chrome, ["--single-process", "--no-zygote", "--allow-file-access-from-files", "--virtual-time-budget=17000", "--dump-dom", `file://${file}`], { timeout: 25_000, maxBuffer: 10 * 1024 * 1024, killSignal: "SIGKILL" });
    assert.doesNotMatch(stdout, /data-failure=/);
    assert.match(stdout, /data-result="pass"/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
