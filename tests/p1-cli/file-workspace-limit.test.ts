import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  FILE_VERSION_CREATE_KIND,
  FILE_WORKSPACE_MAX_NAMES,
  fileVersionCreate,
  type FileActor,
  type FileStorage,
  type FileVersionCreateCommand,
} from "../../supabase/functions/command/file-artifacts.ts";
import {
  FILE_WORKSPACE_MAX_NAMES as LIMIT_DEFAULT_MAX_NAMES,
  FILE_WORKSPACE_MAX_NAMES_CEILING,
  FILE_WORKSPACE_MIN_NAMES,
  SET_WORKSPACE_FILE_LIMIT_KIND,
  isValidWorkspaceFileMaxNames,
  resolveWorkspaceFileMaxNames,
  setWorkspaceFileLimit,
  validateSetWorkspaceFileLimitCommand,
  workspaceFileCountRefusalMessage,
  type WorkspaceFileLimitActor,
} from "../../supabase/functions/command/file-workspace-limit.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const FILE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VERSION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWNER: WorkspaceFileLimitActor = { kind: "user", id: "22222222-2222-4222-8222-222222222222", role: "owner" };

const CREATE_CMD: FileVersionCreateCommand = {
  kind: FILE_VERSION_CREATE_KIND,
  file_id: FILE_ID,
  version_id: VERSION_ID,
  name: "plan.md",
  declared_size_bytes: 7,
  content_type: "text/markdown",
  if_version: null,
};

const STORAGE: FileStorage = {
  async signUpload() { return { path: "/upload", token: "upload-token" }; },
  async objectSize() { return 7; },
  async signDownload() { return "/download"; },
  async removeObjects() {},
};

function makeLimitTx(opts: {
  workspaceExists?: boolean;
  archivedAt?: string | null;
  dbRole?: "owner" | "admin" | "member" | null;
} = {}) {
  let updatedMaxNames: number | null = null;
  const tx = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("$?").replace(/\s+/g, " ").trim();
    if (sql.includes("FROM swarm.workspaces AS w") && sql.includes("FOR UPDATE OF w")) {
      if (opts.workspaceExists === false) return [];
      return [{
        workspace_id: WORKSPACE_ID,
        archived_at: opts.archivedAt ?? null,
        role: opts.dbRole === undefined ? "owner" : opts.dbRole,
      }];
    }
    if (sql.startsWith("UPDATE swarm.workspaces SET file_max_names =")) {
      updatedMaxNames = Number(values[0]);
      return [{ workspace_id: WORKSPACE_ID, file_max_names: updatedMaxNames }];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }) as unknown as Parameters<typeof setWorkspaceFileLimit>[0];
  return { tx, get updatedMaxNames() { return updatedMaxNames; } };
}

function makeFileCreateDb(activeFileNames: number, workspaceFileMaxNames?: number) {
  const wsRow = workspaceFileMaxNames !== undefined
    ? { workspace_id: WORKSPACE_ID, file_max_names: workspaceFileMaxNames }
    : { workspace_id: WORKSPACE_ID };
  const rows: unknown[][] = [
    [wsRow], [{ total: "0" }], [], [{ total: String(activeFileNames) }],
    [{ n: "0" }], [{ n: "0" }], [{ n: "0" }], [], [],
  ];
  const queries: string[] = [];
  let idx = 0;
  const tx = (strings: TemplateStringsArray) => {
    queries.push(strings.join(" "));
    const page = rows[idx++];
    if (page === undefined) return Promise.reject(new Error("unexpected query"));
    return Promise.resolve(page);
  };
  return { tx: tx as unknown as Parameters<typeof fileVersionCreate>[0], queries };
}

describe("configurable workspace file limit", () => {
  it("keeps the default workspace file limit at 5,000 and resolves fallback values to 5,000", () => {
    assert.equal(FILE_WORKSPACE_MAX_NAMES, 5000);
    assert.equal(LIMIT_DEFAULT_MAX_NAMES, 5000);
    assert.equal(FILE_WORKSPACE_MIN_NAMES, 1);
    assert.equal(FILE_WORKSPACE_MAX_NAMES_CEILING, 1000000);

    for (const v of [undefined, null, {}, { file_max_names: null }, { file_max_names: 0 }]) {
      assert.equal(resolveWorkspaceFileMaxNames(v), 5000);
    }
    assert.equal(resolveWorkspaceFileMaxNames({ file_max_names: 250 }), 250);
    assert.equal(resolveWorkspaceFileMaxNames(12000), 12000);

    for (const v of [1, 5000, 1000000]) assert.equal(isValidWorkspaceFileMaxNames(v), true);
    for (const v of [0, -10, 1000001, 12.5, "5000", null]) assert.equal(isValidWorkspaceFileMaxNames(v), false);
  });

  it("defines the workspace file limit column and read view in the migration", () => {
    const sql = readFileSync(
      path.join(ROOT, "supabase/migrations/20261020000001_workspace_file_limit.sql"),
      "utf8",
    );
    assert.match(sql, /ADD COLUMN IF NOT EXISTS file_max_names integer NOT NULL DEFAULT 5000/);
    assert.match(sql, /CHECK \(file_max_names >= 1 AND file_max_names <= 1000000\)/);
    assert.match(sql, /CREATE OR REPLACE VIEW swarm_read\.workspaces/);
    assert.match(sql, /\bw\.file_max_names\b/);
  });

  it("validates set_workspace_file_limit command payloads including reset to default", () => {
    assert.deepEqual(
      validateSetWorkspaceFileLimitCommand({ kind: SET_WORKSPACE_FILE_LIMIT_KIND, file_max_names: 2500 }),
      { ok: true, command: { kind: "set_workspace_file_limit", file_max_names: 2500 } },
    );
    assert.deepEqual(
      validateSetWorkspaceFileLimitCommand({ kind: SET_WORKSPACE_FILE_LIMIT_KIND, reset: true }),
      { ok: true, command: { kind: "set_workspace_file_limit", file_max_names: 5000 } },
    );

    for (const bad of [
      { kind: SET_WORKSPACE_FILE_LIMIT_KIND, file_max_names: 0 },
      { kind: SET_WORKSPACE_FILE_LIMIT_KIND, file_max_names: -1 },
      { kind: SET_WORKSPACE_FILE_LIMIT_KIND, file_max_names: 1000001 },
      { kind: SET_WORKSPACE_FILE_LIMIT_KIND, file_max_names: 3.14 },
      { kind: SET_WORKSPACE_FILE_LIMIT_KIND, file_max_names: "5000" },
      { kind: SET_WORKSPACE_FILE_LIMIT_KIND, file_max_names: 100, extra: true },
      { kind: "other_kind", file_max_names: 100 },
    ]) {
      const res = validateSetWorkspaceFileLimitCommand(bad);
      assert.equal(res.ok, false);
      assert.equal(res.status, 400);
    }
  });

  it("allows workspace owner to configure file_max_names and rejects non-owners, agents, and archived workspaces", async () => {
    const ownerDb = makeLimitTx({ dbRole: "owner" });
    const updated = await setWorkspaceFileLimit(
      ownerDb.tx, WORKSPACE_ID, OWNER, { kind: SET_WORKSPACE_FILE_LIMIT_KIND, file_max_names: 10000 },
    );
    assert.deepEqual(updated, { ok: true, body: { workspace_id: WORKSPACE_ID, file_max_names: 10000 } });
    assert.equal(ownerDb.updatedMaxNames, 10000);

    for (const role of ["admin", "member"] as const) {
      const db = makeLimitTx({ dbRole: role });
      const res = await setWorkspaceFileLimit(
        db.tx, WORKSPACE_ID, { ...OWNER, role }, { kind: SET_WORKSPACE_FILE_LIMIT_KIND, file_max_names: 200 },
      );
      assert.equal(res.ok, false);
      assert.equal(res.refusal.status, 403);
      assert.equal(res.refusal.reason, "not_workspace_owner");
      assert.equal(db.updatedMaxNames, null);
    }

    const demotedDb = makeLimitTx({ dbRole: "admin" });
    const demoted = await setWorkspaceFileLimit(
      demotedDb.tx, WORKSPACE_ID, { kind: "user", id: OWNER.id }, { kind: SET_WORKSPACE_FILE_LIMIT_KIND, file_max_names: 200 },
    );
    assert.equal(demoted.ok, false);
    assert.equal(demoted.refusal.status, 403);
    assert.equal(demoted.refusal.reason, "not_workspace_owner");
    assert.equal(demotedDb.updatedMaxNames, null);

    const agentDb = makeLimitTx({ dbRole: "owner" });
    const agentRes = await setWorkspaceFileLimit(
      agentDb.tx, WORKSPACE_ID, { kind: "agent", id: OWNER.id, role: "owner" }, { kind: SET_WORKSPACE_FILE_LIMIT_KIND, file_max_names: 200 },
    );
    assert.equal(agentRes.ok, false);
    assert.equal(agentRes.refusal.status, 403);
    assert.equal(agentRes.refusal.reason, "credential_kind_forbidden");
    assert.equal(agentDb.updatedMaxNames, null);

    const archivedDb = makeLimitTx({ dbRole: "owner", archivedAt: "2026-10-20T00:00:00Z" });
    const archived = await setWorkspaceFileLimit(
      archivedDb.tx, WORKSPACE_ID, OWNER, { kind: SET_WORKSPACE_FILE_LIMIT_KIND, file_max_names: 200 },
    );
    assert.equal(archived.ok, false);
    assert.equal(archived.refusal.status, 409);
    assert.equal(archived.refusal.error, "workspace_already_archived");
    assert.equal(archivedDb.updatedMaxNames, null);
  });

  it("enforces default 5,000 and custom configured file_max_names during file creation", async () => {
    const noopLedger = async () => null;
    const cases: { count: number; limit?: number; expectedMax: number; ok: boolean }[] = [
      { count: 4999, expectedMax: 5000, ok: true },
      { count: 5000, expectedMax: 5000, ok: false },
      { count: 99, limit: 100, expectedMax: 100, ok: true },
      { count: 100, limit: 100, expectedMax: 100, ok: false },
      { count: 5000, limit: 10000, expectedMax: 10000, ok: true },
      { count: 9999, limit: 10000, expectedMax: 10000, ok: true },
      { count: 10000, limit: 10000, expectedMax: 10000, ok: false },
    ];

    for (const c of cases) {
      const db = makeFileCreateDb(c.count, c.limit);
      const res = await fileVersionCreate(db.tx, WORKSPACE_ID, OWNER, CREATE_CMD, STORAGE, noopLedger);
      if (c.ok) {
        assert.equal(res.ok, true);
        assert.equal(db.queries.length, 9);
      } else {
        assert.equal(res.ok, false);
        assert.equal(res.refusal.status, 409);
        assert.equal(res.refusal.error, "workspace_file_count");
        assert.equal(res.refusal.message, workspaceFileCountRefusalMessage(c.expectedMax));
        assert.equal(db.queries.length, 4);
      }
    }
  });
});
