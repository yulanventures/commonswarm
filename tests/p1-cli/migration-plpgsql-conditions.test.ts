import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

type Token = { text: string; offset: number; kind: 'word' | 'symbol' | 'quoted' | 'body'; body?: string; bodyOffset?: number };

/** Lexical lint only, not a SQL parser. Quoted text never supplies control keywords. */
function tokens(sql: string): Token[] {
  const result: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    if (/\s/.test(sql[i]!)) { i++; continue; }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      assert.equal(depth, 0, 'unterminated SQL comment');
      continue;
    }
    const offset = i;
    const quote = sql[i];
    if (quote === "'" || quote === '"') {
      const escaped = quote === "'" && /(?:^|\W)[eE]$/.test(sql.slice(0, i));
      i++;
      let closed = false;
      while (i < sql.length) {
        if (escaped && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      assert.ok(closed, 'unterminated SQL quote');
      result.push({ text: sql.slice(offset + 1, i - 1).toUpperCase(), offset, kind: 'quoted' });
      continue;
    }
    const tag = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i))?.[0];
    if (tag) {
      const bodyOffset = i + tag.length;
      const end = sql.indexOf(tag, bodyOffset);
      assert.notEqual(end, -1, `unterminated dollar quote ${tag}`);
      result.push({ text: tag, offset, kind: 'body', body: sql.slice(bodyOffset, end), bodyOffset });
      i = end + tag.length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z_0-9$]*/.exec(sql.slice(i))?.[0];
    if (word) {
      result.push({ text: word.toUpperCase(), offset, kind: 'word' });
      i += word.length;
    } else {
      result.push({ text: sql[i]!, offset, kind: 'symbol' });
      i++;
    }
  }
  return result;
}

function isWord(token: Token | undefined, text: string): boolean {
  return token?.kind === 'word' && token.text === text;
}

function lintConditions(sql: string): { bodies: number; errors: string[] } {
  let bodies = 0;
  const errors: string[] = [];
  let statement: Token[] = [];
  function inspectStatement() {
    const language = statement.findIndex(token => isWord(token, 'LANGUAGE'));
    const isDo = isWord(statement[0], 'DO');
    const isFunction = isWord(statement[0], 'CREATE') && statement.slice(1, 4)
      .some(token => isWord(token, 'FUNCTION') || isWord(token, 'PROCEDURE'));
    if (!isDo && !isFunction) return;
    if (language === -1 ? !isDo : statement[language + 1]?.text !== 'PLPGSQL') return;
    const body = statement.find((token, index) => token.kind === 'body' &&
      (isDo || isWord(statement[index - 1], 'AS')));
    assert.ok(body, 'PL/pgSQL statement must have a dollar-quoted body');
    bodies++;
    const inner = tokens(body.body!);
    for (let i = 0; i < inner.length; i++) {
      const token = inner[i]!;
      let end: string;
      if ((isWord(token, 'IF') && !isWord(inner[i - 1], 'END')) || isWord(token, 'ELSIF')) end = 'THEN';
      else if (isWord(token, 'WHILE')) end = 'LOOP';
      else if (isWord(token, 'EXIT') || isWord(token, 'CONTINUE')) {
        // EXIT/CONTINUE may have a loop label before WHEN.
        const when = isWord(inner[i + 1], 'WHEN') ? i + 1 : i + 2;
        if (!isWord(inner[when], 'WHEN')) continue;
        i = when;
        end = ';';
      } else continue;
      let depth = 0;
      for (let j = i + 1; j < inner.length; j++) {
        const current = inner[j]!;
        if (current.kind === 'symbol') {
          if (current.text === '(' || current.text === '[') depth++;
          else if (current.text === ')' || current.text === ']') depth--;
          else if (current.text === ';' && depth === 0) break;
        }
        if (depth === 0 && isWord(current, end)) break;
        if (depth === 0 && isWord(current, 'CASE')) {
          const line = sql.slice(0, body.bodyOffset! + current.offset).split('\n').length;
          errors.push(`line ${line}: bare CASE in ${token.text} condition; parenthesize the CASE expression`);
          break;
        }
      }
    }
  }
  for (const token of tokens(sql)) {
    if (token.kind === 'symbol' && token.text === ';') { inspectStatement(); statement = []; }
    else statement.push(token);
  }
  inspectStatement();
  return { bodies, errors };
}

const issuanceCondition = "e->>'type' IS DISTINCT FROM CASE WHEN NEW.generation=0 THEN 'AdminCredentialIssued' ELSE 'AdminCredentialRotated' END";

test('migration PL/pgSQL condition lint rejects the issuance regression and accepts parentheses', () => {
  for (const [start, end] of [
    ['IF', 'THEN NULL; END IF'],
    ['IF false THEN NULL; ELSIF', 'THEN NULL; END IF'],
    ['WHILE', 'LOOP NULL; END LOOP'],
    ['EXIT WHEN', ''],
    ['CONTINUE retry_loop WHEN', ''],
  ]) {
    const fixture = (condition: string) => `DO $fixture$ BEGIN ${start} ${condition} ${end}; END $fixture$;`;
    const broken = lintConditions(fixture(issuanceCondition));
    assert.equal(broken.bodies, 1);
    assert.equal(broken.errors.length, 1, start);
    assert.match(broken.errors[0]!, /bare CASE/);
    const fixed = lintConditions(fixture(issuanceCondition.replace('CASE WHEN', '(CASE WHEN') + ')'));
    assert.equal(fixed.bodies, 1);
    assert.deepEqual(fixed.errors, [], start);
  }
});

test('migration PL/pgSQL condition lint respects bodies, comments, quotes and expression depth', () => {
  const safe = String.raw`
    -- DO $ignored$ BEGIN IF CASE WHEN true THEN true END THEN NULL; END $ignored$;
    CREATE FUNCTION sample() RETURNS void AS $body$
    BEGIN
      IF EXISTS (SELECT CASE WHEN true THEN 1 ELSE 0 END) /* ' $other$ CASE /* nested */ */ THEN
        PERFORM 'IF CASE WHEN ''THEN''', E'quoted \' IF CASE WHEN', $text$ IF CASE WHEN $text$;
        PERFORM "IF", "CASE";
      END IF;
      IF true THEN NULL; END IF;
      value := CASE WHEN true THEN 1 ELSE 0 END;
      CASE WHEN true THEN NULL; ELSE NULL; END CASE;
      IF ARRAY[CASE WHEN true THEN true ELSE false END][1] THEN NULL; END IF;
    END
    $body$ LANGUAGE plpgsql;
    CREATE FUNCTION sql_sample() RETURNS bool LANGUAGE sql AS $$
      SELECT CASE WHEN true THEN true ELSE false END;
    $$;
    DO LANGUAGE plpgsql $$ BEGIN IF true THEN NULL; END IF; END $$;
  `;
  assert.deepEqual(lintConditions(safe), { bodies: 2, errors: [] });
  const tagged = `CREATE OR REPLACE FUNCTION sample() RETURNS void LANGUAGE plpgsql AS $fn$\nBEGIN\nif ${issuanceCondition} then NULL; END IF;\nEND $fn$;`;
  assert.equal(lintConditions(tagged).errors.length, 1);
  assert.match(lintConditions(tagged).errors[0]!, /^line 3:/);
});

test('every migration parenthesizes CASE in PL/pgSQL control conditions', () => {
  const files = readdirSync('supabase/migrations').filter(file => file.endsWith('.sql')).sort();
  assert.ok(files.length > 0);
  let bodies = 0;
  const errors: string[] = [];
  for (const file of files) {
    const result = lintConditions(readFileSync(`supabase/migrations/${file}`, 'utf8'));
    bodies += result.bodies;
    errors.push(...result.errors.map(error => `${file}:${error}`));
  }
  assert.ok(bodies > 0, 'must inspect PL/pgSQL bodies, not just outer SQL');
  assert.deepEqual(errors, []);
  console.log(`PL/pgSQL condition lint: ${files.length} migrations; ${bodies} bodies checked`);
});
