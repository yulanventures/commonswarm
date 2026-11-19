/** Rollback drill for 20261119000002 (agent removal scope read) on a copy of the migrated schema. */
import { test } from "node:test";
import { dbAssert, repoSql, runSql } from "../support/admin-schema-db.js";
import { releaseCatalogQuery } from "../support/release-catalog-query.js";

const root = "deploy/release-proofs/agent-removal-scope/20261119000002";
const catalog = (rollback = false) =>
  dbAssert(
    releaseCatalogQuery(repoSql(`${root}-${rollback ? "rollback-catalog" : "catalog"}.sql`), rollback ? "rollback_ok" : "catalog_ok")
      .trim()
      .replace(/;$/, ""),
    rollback ? "agent removal scope rollback catalog" : "agent removal scope catalog",
  );

test("the agent removal scope read rolls back cleanly and applies again", () => {
  runSql(
    catalog()
      + repoSql(`${root}-rollback.sql`)
      + catalog(true)
      + repoSql("supabase/migrations/20261119000002_agent_removal_scope.sql")
      + catalog()
      + dbAssert("swarm_read.agent_removal_scope(gen_random_uuid(), gen_random_uuid()) IS NULL", "no claims, no answer")
      + repoSql(`${root}-rollback.sql`)
      + catalog(true),
  );
});
