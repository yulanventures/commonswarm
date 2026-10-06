import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// swarm_read.signals is recreated by splicing columns onto the live view.
// The column list is that replay through the newest view-defining migration,
// which is independent of BROWSER_SIGNAL_COLUMNS.
const migrationsDir = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));
const clientSource = readFileSync(new URL("./commonswarm.ts", import.meta.url), "utf8");
const FILTER_METHODS = new Set(["eq", "in", "gt", "lt", "order", "select"]);
const OLD_IN = '.in("signal_id", ids.slice(offset, offset + 50))';
const NEW_IN = '.in("id", ids.slice(offset, offset + 50))';
const OLD_ORDER = '.order("signal_id", { ascending: false }).range(offset, offset + pageSize - 1)';
const NEW_ORDER = '.order("id", { ascending: false }).range(offset, offset + pageSize - 1)';

function walkSql(sql, onTopLevel) {
  let i = 0;
  let depth = 0;
  while (i < sql.length) {
    if (sql.startsWith("--", i)) {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    const ch = sql[i];
    if (ch === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue; }
        if (sql[i] === '"') { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === "$") {
      const tag = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/u);
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? sql.length : end + tag[0].length;
        continue;
      }
    }
    if (ch === "(") { depth += 1; i += 1; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); i += 1; continue; }
    if (depth === 0) {
      const consumed = onTopLevel(sql, i);
      if (consumed > 0) { i += consumed; continue; }
    }
    i += 1;
  }
}

function splitTopLevelCommas(sql) {
  const parts = [];
  let start = 0;
  walkSql(sql, (text, i) => {
    if (text[i] !== ",") return 0;
    parts.push(text.slice(start, i));
    start = i + 1;
    return 1;
  });
  parts.push(sql.slice(start));
  return parts;
}

function indexOfTopLevelFromSignals(sql) {
  let at = null;
  walkSql(sql, (text, i) => {
    if (at === null && /^FROM\s+swarm\.signals\b/iu.test(text.slice(i))) at = i;
    return 0;
  });
  return at;
}

function outputColumn(item) {
  const alias = item.match(/\bAS\s+(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))\s*$/iu);
  if (alias) return alias[1] || alias[2];
  const bare = item.match(/^(?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]*)$/u);
  if (bare) return bare[1];
  throw new Error(`cannot name an output column from: ${item.slice(0, 180)}`);
}

function columnsFromSelectList(list) {
  const columns = [];
  for (const item of splitTopLevelCommas(list)) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const column = outputColumn(trimmed);
    if (columns.includes(column)) throw new Error(`duplicate output column ${column}`);
    columns.push(column);
  }
  if (!columns.length) throw new Error("empty swarm_read.signals select list");
  return columns;
}

function staticSelectList(sql) {
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+swarm_read\.signals\b/giu;
  let list = null;
  for (const match of sql.matchAll(re)) {
    const after = sql.slice(match.index);
    const asMatch = after.match(/^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+swarm_read\.signals\b[\s\S]{0,600}?\bAS\b/iu);
    if (!asMatch) continue;
    const rest = after.slice(asMatch[0].length);
    const select = rest.match(/^\s*SELECT\b/iu);
    if (!select) continue;
    const body = rest.slice(select[0].length);
    const cut = indexOfTopLevelFromSignals(body);
    if (cut === null) throw new Error("view select list has no top-level FROM swarm.signals");
    list = body.slice(0, cut);
  }
  return list;
}

function decodeSqlLiteral(token) {
  if (/^E'/iu.test(token) && token.endsWith("'")) {
    const body = token.slice(2, -1);
    let out = "";
    for (let i = 0; i < body.length; i += 1) {
      if (body[i] === "'" && body[i + 1] === "'") { out += "'"; i += 1; continue; }
      if (body[i] !== "\\" || i + 1 === body.length) { out += body[i]; continue; }
      const next = body[i + 1];
      i += 1;
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === "\\" || next === "'") out += next;
      else out += next;
    }
    return out;
  }
  const dollar = token.match(/^(\$[A-Za-z0-9_]*\$)([\s\S]*)\1$/u);
  if (dollar) return dollar[2];
  if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
  return null;
}

function callArguments(sql, openParen) {
  const args = [];
  let start = openParen;
  let i = openParen;
  let depth = 1;
  while (i < sql.length && depth > 0) {
    if (sql.startsWith("--", i)) {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    const ch = sql[i];
    if (ch === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue; }
        if (sql[i] === '"') { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === "$") {
      const tag = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/u);
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? sql.length : end + tag[0].length;
        continue;
      }
    }
    if (ch === "(") { depth += 1; i += 1; continue; }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        args.push(sql.slice(start, i));
        return args;
      }
      i += 1;
      continue;
    }
    if (ch === "," && depth === 1) {
      args.push(sql.slice(start, i));
      i += 1;
      start = i;
      continue;
    }
    i += 1;
  }
  throw new Error("unclosed regexp_replace call");
}

function splicedColumns(sql) {
  const added = [];
  const re = /\bregexp_replace\s*\(/gu;
  for (const match of sql.matchAll(re)) {
    const args = callArguments(sql, match.index + match[0].length);
    if (args.length < 3) continue;
    const pattern = decodeSqlLiteral(args[1].trim()) ?? args[1];
    if (!/FROM/iu.test(pattern) || !/signals/iu.test(pattern)) continue;
    const replacement = decodeSqlLiteral(args[2].trim());
    if (replacement === null) continue;
    const fragment = replacement.replace(/(?:\\[0-9]+)+\s*$/u, "").trim();
    if (!fragment.startsWith(",")) continue;
    const items = splitTopLevelCommas(fragment.slice(1)).map((item) => item.trim()).filter(Boolean);
    if (!items.length) throw new Error("column splice produced no output columns");
    for (const item of items) {
      const column = outputColumn(item);
      if (added.includes(column)) throw new Error(`splice repeats column ${column}`);
      added.push(column);
    }
  }
  return added;
}

function definesSignalsView(sql) {
  return /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+swarm_read\.signals\b/iu.test(sql);
}

function signalViewVersions() {
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
  const versions = [];
  let columns = null;
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    if (!definesSignalsView(sql)) continue;
    const list = staticSelectList(sql);
    if (list !== null) {
      columns = columnsFromSelectList(list);
    } else if (columns === null) {
      throw new Error(`${file} splices swarm_read.signals before a parsed select list`);
    } else {
      const added = splicedColumns(sql);
      if (!added.length) throw new Error(`${file} defines swarm_read.signals but no columns were parsed`);
      columns = columns.slice();
      for (const column of added) {
        if (columns.includes(column)) throw new Error(`${file} repeats column ${column}`);
        columns.push(column);
      }
    }
    versions.push({ file, columns });
  }
  if (!versions.length) throw new Error("no migration defines swarm_read.signals");
  return versions;
}

function literalText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function foldString(node) {
  if (!node) return null;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return foldString(node.expression);
  }
  const direct = literalText(node);
  if (direct !== null) return direct;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = foldString(node.left);
    const right = foldString(node.right);
    if (left === null || right === null) return null;
    return left + right;
  }
  return null;
}

function resolveString(node, file) {
  const folded = foldString(node);
  if (folded !== null) return folded;
  if (!ts.isIdentifier(node)) return null;
  let value = null;
  let seen = 0;
  const visit = (current) => {
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.name.text === node.text) {
      seen += 1;
      value = foldString(current.initializer);
    }
    ts.forEachChild(current, visit);
  };
  visit(file);
  if (seen !== 1 || value === null) return null;
  return value;
}

function isFromSignals(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  if (node.expression.name.text !== "from") return false;
  return literalText(node.arguments[0]) === "signals";
}

function chainAfter(call) {
  const steps = [];
  let current = call;
  while (current.parent && ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current) {
    const access = current.parent;
    const parent = access.parent;
    if (!parent || !ts.isCallExpression(parent) || parent.expression !== access) break;
    steps.push({ name: access.name.text, args: parent.arguments });
    current = parent;
  }
  return steps;
}

function signalReadColumns(source) {
  const file = ts.createSourceFile("commonswarm.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const columns = [];
  let reads = 0;
  const visit = (node) => {
    if (isFromSignals(node)) {
      reads += 1;
      for (const step of chainAfter(node)) {
        if (!FILTER_METHODS.has(step.name)) continue;
        const arg = step.args[0];
        if (!arg) throw new Error(`${step.name}() on signals has no column`);
        const text = resolveString(arg, file);
        if (text === null) throw new Error(`${step.name}() column is not a string constant near ${arg.getText(file)}`);
        const names = step.name === "select" ? text.split(",").map((part) => part.trim()) : [text];
        for (const name of names) {
          if (!name) throw new Error("empty signals select column");
          columns.push(name);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const textual = [...source.matchAll(/\.from\(\s*["']signals["']\s*\)/gu)].length;
  if (reads !== textual) throw new Error(`parsed ${reads} signals reads but the source shows ${textual}`);
  return { columns, reads };
}

function unknownColumns(source, view) {
  const viewNames = new Set(view);
  const unknown = [];
  for (const column of signalReadColumns(source).columns) {
    if (!viewNames.has(column) && !unknown.includes(column)) unknown.push(column);
  }
  return unknown;
}

function oldSignalIdSource(source) {
  const hasOld = source.includes(OLD_IN) && source.includes(OLD_ORDER);
  const hasNew = source.includes(NEW_IN) && source.includes(NEW_ORDER);
  if (hasOld && !hasNew) return source;
  if (hasNew && !source.includes(OLD_IN) && !source.includes(OLD_ORDER)) {
    return source.replace(NEW_IN, OLD_IN).replace(NEW_ORDER, OLD_ORDER);
  }
  throw new Error("signals id filters are neither the old signal_id pair nor the id pair");
}

const versions = signalViewVersions();
const viewColumns = versions.at(-1).columns;
const previousColumns = versions.at(-2).columns;

test("swarm_read.signals columns come from the newest view migration", () => {
  assert.ok(versions.length >= 2);
  assert.equal(previousColumns.includes("chain_hop"), false);
  assert.equal(viewColumns.includes("chain_hop"), true);
  assert.equal(previousColumns.includes("reply_status"), true);
  assert.ok(versions.at(-1).file > versions.at(-2).file);
  for (const column of ["id", "workspace_id", "from", "to", "to_agent", "attachments", "channel_id", "thread_root_id", "broadcast_to_channel", "in_reply_to", "recipients", "reply_status", "chain_hop"]) {
    assert.ok(viewColumns.includes(column), column);
  }
  for (const column of ["signal_id", "parent_signal_id", "chain_root_id", "chain_participants", "file_id"]) {
    assert.equal(viewColumns.includes(column), false, column);
  }
});

test("signals reads only use columns the view exposes; signal_id is reported on the old code", () => {
  const parsed = signalReadColumns(clientSource);
  assert.ok(parsed.reads >= 3);
  const used = parsed.columns;
  for (const column of ["id", "workspace_id", "kind", "until", "created_at", "from", "to_agent", "broadcast_to_channel", "in_reply_to"]) {
    assert.ok(used.includes(column), `parser missed ${column}`);
  }
  const old = oldSignalIdSource(clientSource);
  const oldHits = signalReadColumns(old).columns.filter((column) => column === "signal_id");
  assert.deepEqual(oldHits, ["signal_id", "signal_id"]);
  assert.deepEqual(unknownColumns(old, viewColumns), ["signal_id"]);
  const probe = [
    'api.schema("swarm_read").from("signals").select("id")',
    '.eq("missing_eq", 1).in("missing_in", []).gt("missing_gt", 1)',
    '.lt("missing_lt", 1).order("missing_order")',
  ].join("");
  assert.deepEqual(unknownColumns(probe, viewColumns), ["missing_eq", "missing_in", "missing_gt", "missing_lt", "missing_order"]);
  assert.equal(used.includes("signal_id"), false);
  assert.deepEqual(unknownColumns(clientSource, viewColumns), []);
});
