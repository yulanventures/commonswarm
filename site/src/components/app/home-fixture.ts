import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

export interface HomeFixtureOptions {
  /** Site-relative module path, e.g. src/lib/home-primitives.ts. */
  entryPoint: string;
  /** Name under which esbuild exposes the module's exports. */
  globalName?: string;
  /** Trusted fixture JavaScript, not user content. Put hostile data into the VM. */
  script: string;
  body?: string;
  css?: string;
  theme?: "light" | "dark";
}
const siteRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scriptText = (text: string) => text.replace(/<\/script/giu, "<\\/script");

/** Build a fixture page with the real builder and all home styles, without an Astro build. */
export async function homeFixture(options: HomeFixtureOptions): Promise<string> {
  const globalName = options.globalName ?? "HomeView";
  assert.match(globalName, /^[A-Za-z_$][\w$]*$/u);
  const bundle = await build({ absWorkingDir: siteRoot, bundle: true, write: false,
    stdin: { contents: `export * from ${JSON.stringify(`./${options.entryPoint}`)}; import "./src/styles/tokens.css"; import "./src/styles/home/index.css";`,
      resolveDir: siteRoot, sourcefile: "home-fixture-entry.ts", loader: "ts" },
    outfile: "home-fixture.js", format: "iife", globalName, platform: "browser" });
  const js = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
  const css = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text;
  assert.ok(js && css, "the fixture bundles both the real builder and home styles");
  return `<!doctype html><html lang="en" data-theme="${options.theme ?? "light"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
    ${css}
    * { box-sizing: border-box; } body { margin: 0; padding: 12px; background: var(--bg); color: var(--text); font-family: var(--font-sans); }
    .hm-fixture { display: grid; gap: var(--s-4); min-width: 0; } .hm-fixture > ul { padding: 0; margin: 0; list-style: none; }
    ${options.css ?? ""}
    </style></head><body>${options.body ?? '<main class="hm-fixture" id="fixture"></main>'}<script>${scriptText(js)}</script><script>${scriptText(options.script)}</script></body></html>`;
}
