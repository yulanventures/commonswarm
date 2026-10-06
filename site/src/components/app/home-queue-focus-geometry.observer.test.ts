import assert from "node:assert/strict";
// CI regression: two visible lines can contain the same to-do; a move keeps focus in its own line.
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";
import { homeFixture } from "./home-fixture.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
test("queue moves retain focus in their own list when the entire section is replaced", async () => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-queue-scope-"));
  const file = join(directory, "index.html");
  const script = String.raw`
    const p = HomeView, root = document.querySelector('#fixture');
    const other = document.createElement('ul'), host = document.createElement('section'); let own = document.createElement('ol'); host.append(own); root.append(other, host);
    const q = { todoId: 'same', position: 2, title: 'Book plumber', href: '/app?w=W&todo=T', meta: '',
      may: { up: true, down: true, startNow: false, notYet: false, release: false } };
    other.append(p.queueRow(document, {...q,position:1},()=>{}));
    const action = () => { own = document.createElement('ol'); own.append(p.queueRow(document,{...q,position:1},action)); host.replaceChildren(own); };
    own.append(p.queueRow(document,q,action)); own.querySelector('[data-queue-action="up"]').click();
    document.documentElement.dataset.scope = JSON.stringify({ ownFocus: own.contains(document.activeElement),
      ownReceipt: own.querySelector('[data-queue-receipt]').textContent,
      otherReceipt: other.querySelector('[data-queue-receipt]').textContent });
  `;
  await writeFile(file, await homeFixture({ entryPoint: "src/lib/home-primitives.ts", script, theme: "light" }));
  const chrome = await findChrome();
  const { stdout } = await launchChrome(chrome, ["--allow-file-access-from-files", "--dump-dom", `file://${file}`], { timeout: 15000 });
  const encoded = stdout.match(/data-scope="([^"]*)"/)?.[1]; assert.ok(encoded);
  const state = JSON.parse(encoded.replaceAll("&quot;", '"'));
  assert.deepEqual(state, { ownFocus: true, ownReceipt: "Moved ‘Book plumber’ to 1st.", otherReceipt: "" });
  // Retain CI fixtures for inspection; no variable-directory deletion in this test.
});
