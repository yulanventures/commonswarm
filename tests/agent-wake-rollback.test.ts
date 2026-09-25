import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../supabase/migrations/20260926000001_agent_wake_leases.sql", import.meta.url), "utf8");
const rollback = readFileSync(new URL("../deploy/release-proofs/item-g2b/20260926000001-rollback.sql", import.meta.url), "utf8");
const catalog = readFileSync(new URL("../deploy/release-proofs/item-g2b/20260926000001-rollback-catalog.sql", import.meta.url), "utf8");

type Created = { name: string; drop: string; catalogName: string };

function createdObjects(sql: string): Created[] {
  const objects: Created[] = [];
  const create = /^CREATE (?:UNIQUE )?(TABLE|VIEW|FUNCTION|INDEX|POLICY|TRIGGER)\s+([\w.]+)(?:\s*\(([\s\S]*?)\))?(?:\s+ON\s+([\w.]+))?/gm;
  for (const match of sql.matchAll(create)) {
    const [, kind, name, args, on] = match;
    assert.ok(kind && name);
    if (kind === "FUNCTION") {
      assert.ok(args, `missing argument list for ${name}`);
      const types = args.trim() ? args.split(",").map((arg) => {
        const parts = arg.trim().split(/\s+/);
        assert.equal(parts.length, 2, `unexpected function argument in ${name}: ${arg}`);
        return parts[1];
      }).join(", ") : "";
      objects.push({ name, drop: `DROP FUNCTION ${name}(${types});`, catalogName: `${name}(${types.replaceAll(" ", "")})` });
    } else if (kind === "POLICY" || kind === "TRIGGER") {
      assert.ok(on, `missing table for ${kind} ${name}`);
      objects.push({ name, drop: `DROP ${kind} ${name} ON ${on};`, catalogName: name });
    } else {
      objects.push({ name, drop: `DROP ${kind} ${name};`, catalogName: name });
    }
  }
  const allCreates = [...sql.matchAll(/^CREATE\s+([^\n]+)/gm)];
  assert.equal(objects.length, allCreates.length, "new CREATE form needs rollback coverage");
  assert.ok(objects.length > 0, "migration must yield objects");
  assert.doesNotMatch(sql, /^CREATE OR REPLACE\b/m, "a replacement needs its prior definition restored");
  return objects;
}

function assertRollbackCoverage(objects: Created[], down: string, proof: string): void {
  const statements = down.split("\n").map((line) => line.trim()).filter((line) => !line.startsWith("--"));
  for (const object of objects) {
    assert.ok(statements.includes(object.drop), `rollback does not drop ${object.name}`);
    assert.ok(proof.includes(object.catalogName), `catalog does not check ${object.name}`);
  }
  for (const table of objects.filter((object) => object.drop.startsWith("DROP TABLE "))) {
    if (/\bPRIMARY KEY\s*\(/.test(migration)) {
      const implicitIndex = `${table.name.split(".").at(-1)}_pkey`;
      assert.ok(proof.includes(implicitIndex), `catalog does not check ${implicitIndex}`);
    }
  }
  assert.match(down, /DELETE FROM supabase_migrations\.schema_migrations WHERE version = '20260926000001';/);
  assert.match(proof, /NOT EXISTS \(SELECT 1 FROM supabase_migrations\.schema_migrations WHERE version = '20260926000001'\)/);
}

test("wake-lease rollback names every migration-created object and proves its absence", { timeout: 5_000 }, () => {
  const objects = createdObjects(migration);
  assertRollbackCoverage(objects, rollback, catalog);
  for (const object of objects) {
    const missingDrop = rollback.replace(object.drop, "");
    assert.notEqual(missingDrop, rollback, `positive control missed ${object.name}`);
    assert.throws(() => assertRollbackCoverage(objects, missingDrop, catalog), /rollback does not drop/);
  }
});
