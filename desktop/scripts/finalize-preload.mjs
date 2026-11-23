import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(currentDir, "..", "dist");
const jsPath = path.join(distDir, "preload.js");
const cjsPath = path.join(distDir, "preload.cjs");
const jsMapPath = path.join(distDir, "preload.js.map");
const cjsMapPath = path.join(distDir, "preload.cjs.map");

if (!fs.existsSync(jsPath)) {
  throw new Error(`Expected compiled preload at ${jsPath}`);
}

const source = fs
  .readFileSync(jsPath, "utf8")
  .replace(/\/\/# sourceMappingURL=preload\.js\.map\s*$/, "//# sourceMappingURL=preload.cjs.map");

fs.writeFileSync(cjsPath, source, "utf8");
fs.unlinkSync(jsPath);

if (fs.existsSync(jsMapPath)) {
  const mapRaw = fs.readFileSync(jsMapPath, "utf8");
  const parsed = JSON.parse(mapRaw);
  parsed.file = "preload.cjs";
  fs.writeFileSync(cjsMapPath, `${JSON.stringify(parsed)}\n`, "utf8");
  fs.unlinkSync(jsMapPath);
}
