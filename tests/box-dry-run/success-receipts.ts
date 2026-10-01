import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Ruling 12 (HM37 E2E-TASK.md). A declared whole-block producer whose SUCCESS output has no committed live evidence
// is seeded from that producer's OWN success writer, read from the plan text when the seed is made. The fields,
// their order and their format are whatever the writer prints; a fixture never types a second copy. A writer the
// plan changes, or one this reader cannot read exactly, stops the seed with a refusal instead of a guess.
export const SUCCESS_RECEIPT_LABEL = "plan-documented success shape; no live evidence yet; replaced by the live window receipt";

export type SuccessWriterKind = "printf-lines" | "python-literal-json" | "asserted-literal";

export interface SuccessReceipt {
  file: string;
  path: string;
  mode: string;
  owner: "root:root";
  label: string;
  writer: { kind: SuccessWriterKind; source_lines: string };
  // The executed block that reads the receipt, and whether it checks content or only that the member exists.
  consumer: { step: string; check: "content" | "presence" };
  // Historical aborted receipt of the same name. It stays an abort and refusal control input and is never seeded.
  abort_evidence?: string;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A variable has a plan-documented success value only when the block itself fixes it: a literal assignment, or a
// literal that one of the block's own tests pins on the success path. Two different literals leave it unbound.
export function documentedValues(source: string): Map<string, string> {
  const found = new Map<string, Set<string>>();
  const note = (name: string, value: string): void => {
    if (!found.has(name)) found.set(name, new Set());
    found.get(name)!.add(value);
  };
  for (const match of source.matchAll(/^[ \t]*([A-Z][A-Z0-9_]*)=([A-Za-z0-9_./:-]+)[ \t]*$/gm)) note(match[1]!, match[2]!);
  for (const match of source.matchAll(/^[ \t]*test "\$([A-Z][A-Z0-9_]*)" = ([A-Za-z0-9_./:-]+)[ \t]*$/gm)) note(match[1]!, match[2]!);
  return new Map([...found].flatMap(([name, values]): Array<[string, string]> => values.size === 1 ? [[name, [...values][0]!]] : []));
}

function expand(text: string, values: ReadonlyMap<string, string>, file: string): string {
  const result = text.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_match, braced?: string, bare?: string) => {
    const name = (braced ?? bare)!;
    const value = values.get(name);
    assert.ok(value !== undefined, `${file}: $${name} has no plan-documented success value`);
    return value;
  });
  assert.ok(!result.includes("$"), `${file}: the writer expands something this reader does not model: ${text}`);
  return result;
}

// `printf '%s\n' "a=$X" 'b=true' ... >"$PROOF_DIR/<file>"`: one line per word, in the writer's order.
function printfLines(source: string, file: string): string {
  const end = source.indexOf(`>"$PROOF_DIR/${file}"`);
  const start = source.lastIndexOf("printf '%s\\n'", end);
  assert.ok(end >= 0 && start >= 0, `${file}: the producer has no printf '%s\\n' writer for it`);
  const words = source.slice(start + "printf '%s\\n'".length, end);
  const values = documentedValues(source);
  const lines: string[] = [];
  const word = /[ \t]+|\\\n|"([^"\\`]*)"|'([^']*)'/y;
  for (let offset = 0; offset < words.length;) {
    word.lastIndex = offset;
    const match = word.exec(words);
    assert.ok(match, `${file}: its printf has a word this reader does not model: ${JSON.stringify(words.slice(offset, offset + 40))}`);
    offset = word.lastIndex;
    if (match[1] !== undefined) lines.push(expand(match[1], values, file));
    else if (match[2] !== undefined) lines.push(match[2]);
  }
  assert.ok(lines.length > 0, `${file}: its printf names no line`);
  return lines.map((line) => `${line}\n`).join("");
}

// A heredoc Python writer whose print(json.dumps({...}, indent=2)) holds only literals. Python reads its own
// literal and prints it with its own json.dumps(indent=2), so quoted text such as "Expected True", string
// quoting, key order and the escaping of non-ASCII characters are exactly what the writer prints. A name, a call
// or any other expression is not a literal: ast.literal_eval refuses it and the seed stops.
function pythonLiteralJson(source: string, file: string): string {
  const redirect = source.indexOf(`>"$PROOF_DIR/${file}" <<'PY'`);
  assert.ok(redirect >= 0, `${file}: the producer has no Python heredoc writer for it`);
  const bodyStart = source.indexOf("\n", redirect) + 1;
  const bodyEnd = source.indexOf("\nPY\n", bodyStart);
  assert.ok(bodyEnd > bodyStart, `${file}: its Python heredoc has no terminator`);
  const call = /print\(json\.dumps\(([\s\S]*), indent=2\)\)\s*$/.exec(source.slice(bodyStart, bodyEnd))?.[1];
  assert.ok(call, `${file}: its Python writer does not end in print(json.dumps(..., indent=2))`);
  const rendered = spawnSync("/usr/bin/python3", ["-c",
    "import ast, json, sys\nprint(json.dumps(ast.literal_eval(sys.stdin.read().strip()), indent=2))"],
  { input: call, encoding: "utf8" });
  // A Python that did not run to an exit status is a harness failure, not a statement about the plan's writer: say which.
  if (rendered.error || rendered.status === null) {
    const cause = rendered.error ? `${(rendered.error as NodeJS.ErrnoException).code ?? rendered.error.name}: ${rendered.error.message}` : `signal ${rendered.signal}`;
    assert.fail(`${file}: /usr/bin/python3 did not render the writer (${cause}); the writer was not read`);
  }
  assert.equal(rendered.status, 0,
    `${file}: its Python writer prints more than literals, so it has no plan-documented success value: ${rendered.stderr.trim().split("\n").at(-1) ?? ""}`);
  return rendered.stdout;
}

// A file the block fills from a database read and then pins with `test "$(cat "$PROOF_DIR/<file>")" = <literal>`.
function assertedLiteral(source: string, file: string): string {
  assert.ok(source.includes(`>"$PROOF_DIR/${file}"`), `${file}: the producer does not write it`);
  const pattern = new RegExp(`^[ \\t]*test "\\$\\(cat "\\$PROOF_DIR/${escapeRegExp(file)}"\\)" = ([A-Za-z0-9_.-]+)[ \\t]*$`, "gm");
  const literals = new Set([...source.matchAll(pattern)].map((match) => match[1]!));
  assert.equal(literals.size, 1, `${file}: the producer pins ${literals.size} different literals for it`);
  return `${[...literals][0]}\n`;
}

export function successReceiptBytes(receipt: SuccessReceipt, producerSource: string): Buffer {
  assert.equal(receipt.label, SUCCESS_RECEIPT_LABEL, `${receipt.file}: a success receipt carries the exact provenance label`);
  assert.ok(producerSource.includes(`>"$PROOF_DIR/${receipt.file}"`), `${receipt.file}: the producer does not write it`);
  switch (receipt.writer.kind) {
    case "printf-lines": return Buffer.from(printfLines(producerSource, receipt.file));
    case "python-literal-json": return Buffer.from(pythonLiteralJson(producerSource, receipt.file));
    case "asserted-literal": return Buffer.from(assertedLiteral(producerSource, receipt.file));
  }
}
