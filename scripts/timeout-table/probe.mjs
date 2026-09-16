// A small safe-read driver for endpoints that have no CLI verb. It reads the
// private profile copy and never prints its values.
import { readFile } from "node:fs/promises";

const [kind, profilePath] = process.argv.slice(2);
const profile = JSON.parse(await readFile(profilePath, "utf8"));
if (kind !== "auth-settings") throw new Error(`unknown probe: ${kind}`);
const response = await fetch(`${profile.url}/auth/v1/settings`, {
  headers: { apikey: profile.anon_key, authorization: `Bearer ${profile.anon_key}` },
});
await response.arrayBuffer();
if (!response.ok) throw new Error(`auth settings returned HTTP ${response.status}`);
