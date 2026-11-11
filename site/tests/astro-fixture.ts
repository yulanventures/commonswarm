/** Render real Astro components, nested scripts and bundled CSS for CI browser observers. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { transform } from "@astrojs/compiler-rs";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import ts from "typescript";

export async function renderAstroFixture(url: URL) {
  const component = fileURLToPath(url);
  const scripts = new Map<string, string[]>(), styles: string[] = [];
  styles.push((await build({ entryPoints: [fileURLToPath(new URL("../src/styles/global.css", import.meta.url))],
    bundle: true, write: false, external: ["/fonts/*"] })).outputFiles[0]!.text);
  const compiler: Plugin = { name: "astro-browser-fixture", setup(builder) {
    builder.onLoad({ filter: /\.astro$/ }, async args => {
      const compiled = transform(await readFile(args.path, "utf8"), { filename: args.path,
        internalURL: "astro/compiler-runtime", resultScopedSlot: true, resolvePath: specifier => specifier });
      assert.deepEqual(compiled.diagnostics.filter(d => d.severity === "error"), []);
      scripts.set(args.path, compiled.scripts.map(s => s.code).filter((code): code is string => typeof code === "string"));
      styles.push(...compiled.css);
      return { contents: compiled.code.replace(/import "[^"\n]+\?astro&type=style[^"\n]+";\n/gu, ""), loader: "ts", resolveDir: dirname(args.path) };
    });
    // Inline @imports: returning raw CSS here silently omits the receipt/channel rules in a fixture server.
    builder.onLoad({ filter: /\.css$/ }, async args => {
      styles.push((await build({ entryPoints: [args.path], bundle: true, write: false, external: ["/fonts/*"] })).outputFiles[0]!.text);
      return { contents: "", loader: "js" };
    });
  } };
  const rendered = await build({ entryPoints: [component], bundle: true, write: false, format: "esm", platform: "node",
    plugins: [compiler], external: ["astro/compiler-runtime"], define: { "import.meta.env": "{}" } });
  const code = rendered.outputFiles[0]!.text.replaceAll('"astro/compiler-runtime"',
    JSON.stringify(new URL("../node_modules/astro/dist/runtime/compiler/index.js", import.meta.url).href));
  const module = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
  const container = await AstroContainer.create({ resolve: async () => "/app.js" });
  const markup = await container.renderToString(module.default);
  const bundled: string[] = [];
  for (const [path, contents] of scripts) for (const content of contents) {
    bundled.push((await build({ stdin: { contents: content, loader: "ts", resolveDir: dirname(path) }, bundle: true, write: false,
      format: "iife", platform: "browser", define: { "import.meta.env": JSON.stringify({ PUBLIC_H0_LINK_JOIN: "0" }) } })).outputFiles[0]!.text);
  }
  return { markup, styles, bundled };
}

export async function compileFixtureFunction(url: URL, name: string): Promise<string> {
  const ast = ts.createSourceFile("fixture.ts", await readFile(url, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(found, "test fixture function " + name);
  return (await build({ stdin: { contents: found.getText(ast) + "\nvoid " + name + "();", loader: "ts", resolveDir: dirname(fileURLToPath(url)) },
    bundle: true, write: false, platform: "browser", format: "iife" })).outputFiles[0]!.text;
}
