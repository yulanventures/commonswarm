import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";

/** The real postCommand with only HTTP and build config replaced: a lost answer is described as the
 * change the command was making. Only create_workspace may say a workspace might have been created. */
async function browserLib(fetcher: typeof fetch) {
  const bundle = await build({ entryPoints: [new URL("../src/lib/commonswarm.ts", import.meta.url).pathname],
    bundle: true, write: false, platform: "browser", format: "cjs", define: {
      "import.meta.env": JSON.stringify({ PUBLIC_SUPABASE_URL: "https://api.test.invalid", PUBLIC_SUPABASE_ANON_KEY: "synthetic-public-key" }),
    } });
  const context = createContext({ module: { exports: {} }, fetch: fetcher, AbortSignal, AbortController, setTimeout, clearTimeout,
    console, Error, URL, Headers, Request, Response, TextEncoder, TextDecoder, crypto, localStorage: undefined,
    window: undefined, document: { querySelector: () => null } });
  runInContext(bundle.outputFiles[0]!.text, context);
  return context.module.exports as typeof import("../src/lib/commonswarm.js");
}

test("a lost answer names the change being made; only create_workspace mentions creating a workspace", async () => {
  const lib = await browserLib((async () => { throw new TypeError("network down"); }) as typeof fetch);
  const session = { access_token: "synthetic-human", user: { id: "11111111-1111-4111-8111-111111111111" } } as never;
  const rows: Array<[kind: string, error: string, mentionsWorkspaceCreation: boolean]> = [
    ["create_workspace", "WorkspaceOutcomeUnknown", true],
    ["rename_workspace", "CommandOutcomeUnknown", false],
    ["remove_member", "CommandOutcomeUnknown", false],
    ["channel_create", "CommandOutcomeUnknown", false],
  ];
  for (const [kind, name, creation] of rows) {
    const error = await lib.postCommand(session, "command-1", { kind }).then(() => null, (caught: unknown) => caught as Error);
    assert.equal(error?.name, name, kind);
    assert.equal(/workspace was created/.test(error!.message), creation, `${kind}: ${error!.message}`);
    if (!creation) assert.match(error!.message, /can't tell whether that change was saved\. Reload/, kind);
  }
  const named = await lib.postCommand(session, "command-2", { kind: "rename_workspace" }, {}, "The rename may not have saved.")
    .then(() => null, (caught: unknown) => caught as Error);
  assert.equal(named?.message, "The rename may not have saved.", "a caller's own copy still wins");
});
