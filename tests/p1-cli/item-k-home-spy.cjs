const fs = require("node:fs");
const os = require("node:os");
const { syncBuiltinESMExports } = require("node:module");

const original = os.homedir;
os.homedir = () => {
  const path = original();
  fs.appendFileSync(process.env.CSWARM_HOME_SPY_LOG, `${JSON.stringify({ path, stack: new Error().stack })}\n`);
  return path;
};
syncBuiltinESMExports();
