// Child-process entrypoint tests keep startup provider verification offline.
import { parseGoTrueProviders } from "../../src/config.js";

globalThis.fetch = async (url) => {
  const root = process.env.MCP_OAUTH_GOTRUE_URL.replace(/\/?$/u, "/");
  if (String(url) !== new URL("settings", root).href) throw new Error("unexpected child HTTP request");
  return Response.json({ external: Object.fromEntries(parseGoTrueProviders(process.env).map((id) => [id, true])) });
};
