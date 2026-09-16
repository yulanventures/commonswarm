import { createClient } from "/Users/yulanbot/Developer/Ridge.io/cloud-swarm/node_modules/@supabase/supabase-js/dist/index.mjs";
import { readFileSync } from "node:fs";
import os from "node:os";
const prof = JSON.parse(readFileSync(`${os.homedir()}/.cswarm/connect-4989ea3b-af59-4c74-a9a6-eeaf51154b5d/profile.json`, "utf8"));
const base = process.argv[2];
const sb = createClient(base, prof.anon_key, { realtime: { params: { eventsPerSecond: 5 } } });
const name = `n-edge-probe-${Math.random().toString(36).slice(2, 10)}`;
const t0 = Date.now();
const ch = sb.channel(name, { config: { broadcast: { self: true } } });
const got = new Promise((resolve) => ch.on("broadcast", { event: "ping" }, (m) => resolve(Date.now() - t0)));
const status = await new Promise((resolve) => { ch.subscribe((s) => { if (s !== "CLOSED") resolve(s); }); setTimeout(() => resolve("TIMEOUT"), 15000); });
console.log(base, "subscribe:", status, "after", Date.now() - t0, "ms");
if (status === "SUBSCRIBED") {
  await ch.send({ type: "broadcast", event: "ping", payload: { at: Date.now() } });
  const r = await Promise.race([got, new Promise((res) => setTimeout(() => res("NO BROADCAST in 10s"), 10000))]);
  console.log(base, "broadcast round trip:", r);
}
await sb.removeAllChannels(); process.exit(0);
