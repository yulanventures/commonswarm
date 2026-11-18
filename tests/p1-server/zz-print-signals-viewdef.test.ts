/** Verify only, never merge: prints the rendered swarm_read.signals definition. */
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import postgres from "postgres";

test("print viewdef", async () => {
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8" })) as { DB_URL: string };
  const sql = postgres(status.DB_URL, { prepare: false, max: 1 });
  const [row] = await sql<{ d: string }[]>`SELECT pg_get_viewdef('swarm_read.signals'::regclass, true) AS d`;
  for (const line of row!.d.split("\n")) console.log(`VIEWDEF| ${line}`);
  const fns = await sql<{ d: string }[]>`SELECT pg_get_functiondef(p.oid) AS d FROM pg_proc p
    WHERE p.oid IN ('swarm.claims_can_access_channel(uuid,uuid)'::regprocedure)`;
  for (const f of fns) for (const line of f.d.split("\n")) console.log(`FUNCDEF| ${line}`);
  await sql.end();
});
