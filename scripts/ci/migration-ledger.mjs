// CLI 2.118.0 records trimmed statements without their terminating semicolons.
// Split only for metadata: psql executes the original file, without rewriting it.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export function migrationStatements(sql) {
  const statements = [];
  let start = 0, quote = '', dollar = '', blockDepth = 0, parens = 0;
  let lineComment = false;
  const append = end => {
    const statement = sql.slice(start, end).replace(/;+$/, '').trim();
    if (statement) statements.push(statement);
    start = end;
  };
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i], next = sql[i + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
    } else if (blockDepth) {
      if (char === '/' && next === '*') { blockDepth++; i++; }
      else if (char === '*' && next === '/') { blockDepth--; i++; }
    } else if (quote) {
      if (char === quote) {
        if (next === quote) i++;
        else quote = '';
      }
    } else if (dollar) {
      if (sql.startsWith(dollar, i)) { i += dollar.length - 1; dollar = ''; }
    } else if (char === '-' && next === '-') {
      lineComment = true; i++;
    } else if (char === '/' && next === '*') {
      blockDepth = 1; i++;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '$' && !/[\w$\u0080-\uffff]/u.test(sql[i - 1] ?? '')) {
      const tag = /^\$(?:[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/u.exec(sql.slice(i));
      if (tag) { dollar = tag[0]; i += dollar.length - 1; }
    } else if (char === '\\') {
      i++;
    } else if (char === '(') {
      parens++;
    } else if (char === ')') {
      parens--;
    } else if (char === ';' && parens === 0) {
      append(i + 1);
    }
  }
  append(sql.length);
  return statements;
}

// Escape strings independently of any settings changed by the migration.
const literal = value => `E'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
const file = process.argv[2];
if (file) {
  const match = /^(\d{14})_(.+)\.sql$/.exec(basename(file));
  if (!match) throw new Error(`Invalid migration filename: ${file}`);
  const statements = migrationStatements(readFileSync(file, 'utf8'));
  process.stdout.write('INSERT INTO supabase_migrations.schema_migrations(version, name, statements) VALUES ('
    + `${literal(match[1])}, ${literal(match[2])}, ARRAY[${statements.map(literal).join(',')}]::text[]);\n`);
}
