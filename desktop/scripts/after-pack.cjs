"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");

/**
 * electron-builder afterPack hook.
 * Runs after each .app bundle is assembled and before the .dmg is built so the
 * ad-hoc signed .app is what gets packaged into the disk image.
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const scriptPath = path.join(__dirname, "adhoc-sign.sh");
  execFileSync("bash", [scriptPath, appPath], { stdio: "inherit" });
};
