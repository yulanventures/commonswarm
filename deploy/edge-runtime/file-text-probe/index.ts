/** Sandbox probe for the PDF parser worker (MCP parity 1b). Installed in place of
 * supabase/functions/file-text/index.ts ONLY in a throwaway container: by the CI runtime test
 * and by the release gate (deploy/edge-runtime/file-text-probe.sh). Main creates it with the
 * parser's exact worker options. It reports outcome labels only, never a value it read. */
const attempt = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return "allowed";
  } catch (error) {
    const name = (error as { name?: string })?.name ?? "unknown";
    return name === "NotCapable" || name === "PermissionDenied" ? "denied" : `error:${name}`;
  }
};

/** Paths a hostile PDF would want: the container environment (service keys), the other
 * functions' and main's sources, the mounted repository source and the module cache. */
export const SECRET_PATHS = {
  read_proc_self_environ: "/proc/self/environ",
  read_proc_1_environ: "/proc/1/environ",
  read_staged_mcp: "/var/tmp/commonswarm-functions/mcp/index.ts",
  read_source_mcp: "/home/deno/functions-source/mcp/index.ts",
  read_main: "/home/deno/main/index.ts",
  read_repo_src: "/var/src/cli.ts",
  read_bootstrap: "/home/deno/deploy/bootstrap.sh",
} as const;

Deno.serve(async (request) => {
  await request.arrayBuffer();
  const results: Record<string, string> = {
    net: await attempt(() => fetch("http://1.1.1.1/", { signal: AbortSignal.timeout(3000) })),
    env: await attempt(async () => Deno.env.get("PATH")),
    write: await attempt(() => Deno.writeTextFile("/tmp/file-text-probe", "x")),
    run: await attempt(() => new Deno.Command("true").output()),
    read_own_source: await attempt(() => Deno.readTextFile(new URL(import.meta.url))),
  };
  for (const [key, path] of Object.entries(SECRET_PATHS)) {
    results[key] = await attempt(() => Deno.readTextFile(path));
  }
  return new Response(JSON.stringify({ text: JSON.stringify(results), truncated: false, pages_read: 0, page_count: 0 }),
    { status: 200, headers: { "content-type": "application/json" } });
});
