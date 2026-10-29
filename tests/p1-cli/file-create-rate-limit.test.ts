/**
 * The acceptable-use page publishes FILE_CREATE_RATE_LIMIT_PER_HOUR as a typed sentence, and
 * AGENTS.md requires that a user-facing number come from the enforcement it describes. A direct
 * import is not available here: the constant lives in a Deno edge module that pulls postgres and
 * the generated protocol bundle, and `tsconfig.json` covers only `src/`. This gate reads both
 * files instead and fails when the published number and the enforced constant disagree.
 *
 * Compare-not-generate is the deliberate choice for the SITE, and only for the site: Astro
 * builds in Node and the constants live in a Deno module that imports postgres, so a build-time
 * import would drag the edge's dependency tree into the marketing site. Inside the edge, where
 * there is no such boundary, a user-facing enumeration IS generated from the enforcement — see
 * FILE_TYPE_REFUSED_MESSAGE in file-artifacts.ts and its gate at the end of this file.
 *
 * Gate: `npm run test:p1-cli` (globs tests/p1-cli/**\/*.test.ts).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, root)), "utf8");
}

/* Grok's checker arm, 2026-09-12: the two gates above still pass if the ENFORCEMENT stops reading
 * the constant and hardcodes a number, and they ignore the same figure in the page's own pointer
 * comment. Both are the drift this file exists to catch, so both get a control. */

/* Codex's checker arm, round two: the figure in the design document's enforcement table is typed
 * by hand and no gate reads it. It is the copy this repo has already let drift once. */

/* Codex's checker arm, round three: the comment claims a REFUSED create still spends from the
 * bucket. That is only true while the bucket increment precedes the create call, and no control
 * bound the ordering — moving validation above the bucket block left every other gate green. */

/* Item C: workspace file-create ceiling controls (docs/design/SWARM-CLOUD.md §2.8). */

/* Item C structural citation gates: cross-file pointers must cite the symbol, and the cited
 * file:line must resolve to that symbol so an edit breaks the gate loudly instead of rotting.
 *
 * SCOPE: these gates bind the pointers Item C wrote or touched — SWARM-CLOUD.md §2.8,
 * src/cloud/files.ts, the acceptable-use comments, and the file-artifacts design doc. They do
 * NOT bind every `file:line` in those documents. SWARM-CLOUD.md's board-v2 sections still cite
 * `index.ts` / `src/index.ts` in the separate local `swarm` CLI, which is not in this
 * repository and cannot be resolved from here. Do not read a green run as "every pointer in
 * these files resolves". */

/* The refusal a user reads must name exactly what the check accepts. AGENTS.md: "An
 * enumeration inside a message must be generated, not typed." This gate is deliberately NOT
 * written against ALLOWED_TYPE_GROUPS — reading the same array the message is built from
 * would be a circular control that passes whatever the array says. It parses the extensions
 * OUT OF THE SHIPPED SENTENCE and runs each one through fileContentAllowed, the function the
 * edge actually calls. Measured defect it exists to catch: the typed sentence it replaced
 * omitted .html, .htm and .yml, all of which the check accepts. */
test("every extension the refusal names is accepted, and named-absent ones are refused", async () => {
  /* The specifier is a variable on purpose. tsconfig.tests.json has
   * allowImportingTsExtensions off, so a literal ".ts" specifier is TS5097 at `check:tests`;
   * the edge module has no .js build to point at, because tsc covers only src/. Keeping the
   * real module under test matters more than a literal here: reading the file as text would
   * make this a control over the source of the message rather than over the function the
   * edge calls. */
  const edgeModule = "../../supabase/functions/command/file-artifacts.ts";
  const { ALLOWED_EXTENSION_RE, FILE_TYPE_REFUSED_MESSAGE, fileContentAllowed } =
    (await import(edgeModule)) as {
      ALLOWED_EXTENSION_RE: RegExp;
      FILE_TYPE_REFUSED_MESSAGE: string;
      fileContentAllowed: (name: string, contentType: string) => boolean;
    };

  const named = [...FILE_TYPE_REFUSED_MESSAGE.matchAll(/(?<![A-Za-z0-9])\.([A-Za-z0-9.]+)/g)]
    .map((match) => match[1]!.toLowerCase());
  /* A sanity floor only — it proves the sentence was parsed, not that the allowlist is intact.
   * This test compares two renderings that both come from ALLOWED_TYPE_GROUPS, so dropping an
   * extension from that array leaves them agreeing and keeps this green. What catches a silent
   * narrowing is the pair of gates at the end of this file, which bind the array to the
   * enumerations published in SWARM-CLOUD.md 2.8 and in the file-artifacts design doc. */
  assert.ok(named.length >= 10, `the refusal names only ${named.length} extensions: ${FILE_TYPE_REFUSED_MESSAGE}`);

  // The historical defect was a message naming a SUBSET of what the check accepts: .html, .htm
  // and .yml were accepted and unnamed, so the loop below — which only proves named ⊆ accepted —
  // would have passed it. Compare the two SETS, using the regex's own source as the second,
  // independently rendered view of the allowlist (escaped dots, `|` joined, anchored).
  const accepted = ALLOWED_EXTENSION_RE.source
    .replace(/^\\\.\(\?:/, "")
    .replace(/\)\$$/, "")
    .split("|")
    .map((alternative) => alternative.replace(/\\\./g, ".").toLowerCase());
  assert.ok(
    accepted.length >= 10,
    `could not parse the extension allowlist out of ALLOWED_EXTENSION_RE: ${ALLOWED_EXTENSION_RE.source}`,
  );
  assert.deepEqual(
    [...new Set(named)].sort(),
    [...new Set(accepted)].sort(),
    "the extensions the refusal names and the extensions ALLOWED_EXTENSION_RE accepts are not the same set",
  );

  for (const extension of named) {
    assert.equal(
      fileContentAllowed(`plan.${extension}`, "text/plain"),
      true,
      `the refusal names .${extension} as allowed, but fileContentAllowed refuses plan.${extension}`,
    );
  }

  // Negative control on the same invocation: an allowed content type with an extension the
  // sentence does NOT name must still be refused, so the loop above cannot pass vacuously.
  for (const extension of ["exe", "sh", "gz", "tar", "xml", "js", "mdx"]) {
    assert.ok(
      !named.includes(extension),
      `this negative control is stale: the refusal now names .${extension}`,
    );
    assert.equal(
      fileContentAllowed(`plan.${extension}`, "text/plain"),
      false,
      `.${extension} is not named in the refusal but fileContentAllowed accepts plan.${extension}`,
    );
  }
});

/* The refusal message must be built, not typed: a string literal at the refusal site is the
 * defect this lane removed, and it would pass the behavioural gate above only by luck. */

/* ★R15 depends on a property of a PINNED dependency, so the claim is bound to the installed
 * package rather than to a line number in it. The line citation this replaces (:345) was the
 * method summary; the two-hour sentence sat two lines lower, and nothing failed. */

/* The acceptable-use page publishes four more numbers that were bound only by a line citation,
 * so the pointer could stay correct while the number drifted. Bind the VALUES too. */

/* The quota sentence describes WHICH rows the byte cap counts. It counted "unpurged versions",
 * which is not what the SQL sums: a pending row older than the 3-hour window is still unpurged
 * and is NOT counted. */

/* The content-type half of the refusal, held to ALLOWED_CONTENT_TYPE_RE the same way the
 * extension half is: the named set is parsed out of the SHIPPED SENTENCE and checked against
 * the regex's own source and against fileContentAllowed. The first attempt at this sentence
 * said "an application type for those documents and archives", which is false —
 * application/json and the two YAML types are accepted and are neither. */
test("every content type the refusal names is accepted, and the set matches the regex", async () => {
  const edgeModule = "../../supabase/functions/command/file-artifacts.ts";
  const { FILE_TYPE_REFUSED_MESSAGE, fileContentAllowed } = (await import(edgeModule)) as {
    FILE_TYPE_REFUSED_MESSAGE: string;
    fileContentAllowed: (name: string, contentType: string) => boolean;
  };
  const edge = read("supabase/functions/command/file-artifacts.ts");

  /* Each group renders as `label: .ext .ext / type, type`. Anchor on that shape rather than
   * splitting the whole message on "; " — the header sentence contains "; charset=utf-8". */
  const named = [...FILE_TYPE_REFUSED_MESSAGE.matchAll(/[a-z]+: (?:\.[a-z0-9.]+ ?)+\/ ([^;]+)/g)]
    .flatMap((match) => match[1]!.split(",").map((entry) => entry.trim()))
    .filter((entry) => entry.length > 0);
  assert.ok(named.length >= 15, `the refusal names only ${named.length} content types`);

  /* Assert the wildcard on BOTH sides before setting it aside. Filtering it out of the
   * comparison is what let the shipped sentence lose the text class without any gate noticing:
   * a Grok arm measured 33 pass, 0 fail with that entry deleted from what the user is shown. */
  const textPattern = /const TEXT_SUBTYPE_PATTERN = "([^"]+)";/.exec(edge)?.[1];
  assert.ok(textPattern, "TEXT_SUBTYPE_PATTERN is no longer a string constant in file-artifacts.ts");
  assert.ok(
    named.includes(textPattern!),
    `the refusal no longer names ${textPattern}; a user reading it would not know any text subtype is allowed`,
  );
  assert.ok(
    FILE_TYPE_REFUSED_MESSAGE.includes(textPattern!),
    `the shipped sentence does not contain ${textPattern}`,
  );

  // Behavioural half: a named type on an allowed extension must be accepted. `.md` is in the
  // text group, so the extension never decides these cases.
  for (const contentType of named) {
    // The text entry is a CLASS, not a literal: probe a member of it. Everything else is literal.
    const probe = contentType.startsWith("text/[") ? "text/markdown" : contentType;
    assert.equal(
      fileContentAllowed("plan.md", probe),
      true,
      `the refusal names ${contentType} as allowed, but fileContentAllowed refuses it`,
    );
  }

  // Negative control on the same invocation: types the sentence does NOT name must be refused,
  // so the loop above cannot pass vacuously.
  for (const contentType of [
    "application/octet-stream",
    "application/x-sh",
    "application/xml",
    "image/tiff",
    "video/mp4",
    "application/vnd.openxmlformats-officedocument.drawingml.chart",
  ]) {
    assert.ok(!named.includes(contentType), `this negative control is stale: ${contentType} is now named`);
    assert.equal(
      fileContentAllowed("plan.md", contentType),
      false,
      `${contentType} is not named in the refusal but fileContentAllowed accepts it`,
    );
  }

  // Set half: everything the COMPILED regex accepts must be named. ALLOWED_CONTENT_TYPE_RE is
  // generated from the same list, so this direction is now structural rather than a comparison
  // of two hand-maintained sets — but it still catches an entry that compiles to something
  // wider than it reads.
  const { ALLOWED_CONTENT_TYPE_RE } = (await import(edgeModule)) as {
    ALLOWED_CONTENT_TYPE_RE: RegExp;
  };
  const source = /^\^\(\?:(.+)\)\$$/.exec(ALLOWED_CONTENT_TYPE_RE.source)?.[1];
  assert.ok(source, `ALLOWED_CONTENT_TYPE_RE is no longer the generated alternation: ${ALLOWED_CONTENT_TYPE_RE.source}`);
  const enumerated = source!
    .split("|")
    .map((alternative) => unescapeLiteral(alternative))
    .filter((entry) => entry !== textPattern);
  assert.ok(
    enumerated.length >= 12,
    `could not enumerate ALLOWED_CONTENT_TYPE_RE: parsed ${enumerated.length} from ${source}`,
  );
  assert.ok(
    source!.split("|").some((alternative) => unescapeLiteral(alternative) === textPattern),
    `ALLOWED_CONTENT_TYPE_RE no longer carries the ${textPattern} class it prints: ${source}`,
  );

  const namedLeaves = new Set(named.filter((entry) => entry !== textPattern));
  for (const contentType of enumerated) {
    assert.ok(
      namedLeaves.has(contentType),
      `ALLOWED_CONTENT_TYPE_RE accepts ${contentType} but the refusal does not name it`,
    );
  }
  assert.deepEqual(
    [...namedLeaves].sort(),
    [...new Set(enumerated)].sort(),
    "the content types the refusal names and the ones the regex accepts are not the same set",
  );
});

/* Returns the contents of the parenthesised group that OPENS at `open`, matching parentheses by
 * depth. Parsing a regex with a regex is what produced an unbalanced body on the first attempt. */

/* Unescapes the regex-literal escapes the allowlist uses, and refuses anything else so a future
 * metacharacter cannot be silently turned into a literal. */
function unescapeLiteral(part: string): string {
  const escapes = [...part.matchAll(/\\(.)/g)].map((match) => match[1]!);
  for (const escaped of escapes) {
    assert.ok(
      ".+/".includes(escaped),
      `ALLOWED_CONTENT_TYPE_RE now escapes \\${escaped}; this parser only understands \\. \\+ and \\/`,
    );
  }
  return part.replace(/\\([.+/])/g, "$1");
}

/* Expands a regex alternation body, including one level of nesting, into its leaf strings.
 * `(pdf|json|vnd\.x\.(a|b))` -> ["pdf", "json", "vnd.x.a", "vnd.x.b"]. */

/* The independent pin for the allowlist itself (Codex, round 2): the gates above compare two
 * renderings that both come from ALLOWED_TYPE_GROUPS, so dropping an extension from that array
 * keeps them green while silently narrowing what the service accepts. SWARM-CLOUD.md §2.8 is a
 * separate artifact, written by hand and reviewed as spec, so binding the code to IT means a
 * narrowing has to be made deliberately in both places. */

/* Same sweep, second surface. The design doc's 5 listed the extensions too and omitted .yml,
 * so its "Everything else ... is refused" sentence was false for a type the service accepts.
 * A copy fix must reach every surface in the claim family, not just the one that was reported. */

/* The refusal's own framing makes two claims beyond the lists: that the groups need not match,
 * and that case does not matter. Both are claims about behaviour, so both get a
 * control — a true sentence with nothing holding it is how this paragraph drifted before. */
test("the refusal's framing claims hold against fileContentAllowed", async () => {
  const edgeModule = "../../supabase/functions/command/file-artifacts.ts";
  const { FILE_TYPE_REFUSED_MESSAGE, fileContentAllowed, validateFileCommand } =
    (await import(edgeModule)) as {
      FILE_TYPE_REFUSED_MESSAGE: string;
      fileContentAllowed: (name: string, contentType: string) => boolean;
      validateFileCommand: (
        cmd: Record<string, unknown>,
      ) => { ok: true; command: unknown } | { ok: false };
    };

  assert.match(
    FILE_TYPE_REFUSED_MESSAGE,
    /they need not come from the same group/,
    "the refusal no longer says the groups need not match",
  );
  // An image extension with a text-group content type: accepted, because the two halves are
  // independent. If this ever became false, the sentence above would be a lie.
  assert.equal(fileContentAllowed("plan.png", "application/json"), true);
  assert.equal(fileContentAllowed("plan.md", "image/png"), true);

  /* The text entry is printed as the CLASS — `text/[a-z0-9.+-]+` — rather than as `text/*`,
   * because the glob reads as "any text subtype" and the class is narrower: anchored, no
   * underscore, no parameter. Case is NOT part of it; validateFileCommand lowercases
   * content_type first, so TEXT/PLAIN is accepted. An earlier wording claimed the parameter
   * case as "lowercase", which a Grok arm caught, and a Codex arm then caught this comment
   * still describing the retired `text/*` spelling. */
  assert.match(
    FILE_TYPE_REFUSED_MESSAGE,
    /Send the content type bare: a parameter such as "; charset=utf-8" is refused/,
    "the refusal no longer warns that a content-type parameter is refused",
  );
  assert.match(
    FILE_TYPE_REFUSED_MESSAGE,
    /Case does not matter\./,
    "the refusal no longer says case is normalised for the caller",
  );
  assert.ok(
    !/lowercase/.test(FILE_TYPE_REFUSED_MESSAGE),
    "the refusal claims lowercase again; validateFileCommand lowercases content_type for the caller",
  );
  /* These go through validateFileCommand FIRST. A control that calls fileContentAllowed on the
   * raw string does not reach the path a user's request takes: the validator lowercases
   * content_type, so the raw function refuses TEXT/PLAIN while the service accepts it —
   * measured on production. Probe what the user actually hits. */
  const accepts = (contentType: string): boolean => {
    const validated = validateFileCommand({
      kind: "file_version_create",
      file_id: "3f1d4c6a-0000-4000-8000-000000000001",
      version_id: "3f1d4c6a-0000-4000-8000-000000000002",
      name: "plan.md",
      declared_size_bytes: 16,
      content_type: contentType,
    });
    if (!validated.ok) return false;
    const command = validated.command as { name: string; content_type: string };
    return fileContentAllowed(command.name, command.content_type);
  };

  assert.equal(accepts("text/html"), true);
  assert.equal(accepts("text/vnd.curl"), true, "dots are in the subtype class");
  assert.equal(accepts("text/x-yaml"), true, "hyphens are in the subtype class");
  assert.equal(accepts("TEXT/PLAIN"), true, "the validator no longer lowercases content_type");
  assert.equal(accepts("text/x_custom"), false, "underscores are no longer refused");
  assert.equal(
    accepts("text/plain; charset=utf-8"),
    false,
    "a content-type parameter is no longer refused; the message still tells users to send it bare",
  );
  assert.equal(
    accepts("application/json; charset=utf-8"),
    false,
    "a parameter is refused on text/ but not on application/; the message speaks for both",
  );
  // The raw function is stricter than the path. Keeping this here so nobody re-derives the
  // control from fileContentAllowed and re-learns it the hard way.
  assert.equal(
    fileContentAllowed("plan.md", "TEXT/PLAIN"),
    false,
    "fileContentAllowed now accepts uppercase; the validator's lowercasing is no longer what carries it",
  );
});

/* The CLI is the last mile, and it TRUNCATES. `safeError` in src/cli.ts strips ANSI, maps the
 * C0 range (newlines included) to spaces, and slices to 1000 characters. A Grok arm measured the
 * multi-line version of this refusal at 1,148 characters: the user lost the tail of the images
 * group and the whole archives group, so the message that exists to name the allowlist did not
 * name all of it. Gate the STRING THE USER SEES, not the constant. */

/* ALLOWED_CONTENT_TYPE_RE stopped being a hand-written literal and is now compiled from
 * ALLOWED_TYPE_GROUPS, which removes the second hand-maintained set a review arm objected to.
 * A generated security control has to prove it did not move: this pins it against the exact
 * literal it replaced, kept here verbatim, over every accepted type and a set of near misses
 * chosen to catch an unescaped metacharacter (`svg+xml`, the dotted openxmlformats names, a
 * trailing newline, an empty string). */
const CONTENT_TYPE_RE_BEFORE_GENERATION =
  /^(text\/[a-z0-9.+-]+|application\/(pdf|json|x-yaml|yaml|zip|gzip|x-gzip|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation))|image\/(png|jpeg|gif|webp|svg\+xml))$/;

test("the generated content-type regex accepts and refuses exactly what the literal did", async () => {
  const edgeModule = "../../supabase/functions/command/file-artifacts.ts";
  const { ALLOWED_CONTENT_TYPE_RE } = (await import(edgeModule)) as {
    ALLOWED_CONTENT_TYPE_RE: RegExp;
  };

  const cases = [
    "text/plain", "text/markdown", "text/csv", "text/html", "text/x-yaml", "text/vnd.curl",
    "text/a", "text/0", "text/a.b+c-d", "text/x_custom", "TEXT/plain", "text/", "text",
    "text/plain; charset=utf-8", "text/plain;charset=utf-8", "text/plain ",
    "application/json", "application/yaml", "application/x-yaml", "application/pdf",
    "application/zip", "application/gzip", "application/x-gzip",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.drawingml.chart",
    "application/vnd.openxmlformats-officedocumentXwordprocessingml.document",
    "application/octet-stream", "application/xml", "application/x-sh", "application/",
    "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml",
    "image/svgWxml", "image/tiff", "image/", "video/mp4", "", "/", "x",
    "application/jsonX", "Xapplication/json", "\napplication/json", "application/json\n",
  ];

  for (const value of cases) {
    assert.equal(
      ALLOWED_CONTENT_TYPE_RE.test(value),
      CONTENT_TYPE_RE_BEFORE_GENERATION.test(value),
      `generating ALLOWED_CONTENT_TYPE_RE changed the ruling for ${JSON.stringify(value)}`,
    );
  }

  // Positive controls on the same invocation: the differential can discriminate.
  assert.equal(CONTENT_TYPE_RE_BEFORE_GENERATION.test("text/plain"), true);
  assert.equal(CONTENT_TYPE_RE_BEFORE_GENERATION.test("application/octet-stream"), false);
  assert.ok(cases.length >= 40, `the differential shrank to ${cases.length} cases`);
});

/* The refusal's machine-readable fields reach the terminal too. D-053 keeps us off
 * `error.message` for CLASSIFICATION; it does not make the other wire fields safe to PRINT.
 * `scope` and `resets_at` are strings the SERVER chooses, and this lane added a branch that
 * wrote them raw beside a sanitised message — the one unsanitised path in the pair. A Codex arm
 * caught it. Assert the CLI routes them through the same terminal sanitiser. */
test("the CLI sanitises the refusal's wire fields before they reach the terminal", { timeout: 1000 }, () => {
  const cli = read("src/cli.ts");

  assert.match(
    cli,
    /function sanitizeForTerminal\(value: string\): string \{[\s\S]*?u001b[\s\S]*?u0000-\\u001f/,
    "sanitizeForTerminal no longer strips ANSI escapes and the C0 range",
  );
  assert.match(
    cli,
    /const message = error instanceof Error \? error\.message : "unknown error";[\s\S]*?const safe = error instanceof WakeLeaseLostError[\s\S]*?message\.split\("\\n"\)\.map\(sanitizeForTerminal\)\.join\("\\n"\)[\s\S]*?: sanitizeForTerminal\(message\);[\s\S]*?return error instanceof WakeLeaseLostError \? safe : safe\.slice\(0, 1000\)/,
    "safeError no longer routes through sanitizeForTerminal",
  );
  assert.match(
    cli,
    /const extra = parts\.length > 0\s*\n?\s*\? ` \[\$\{sanitizeForTerminal\(parts\.join\(", "\)\)\.slice\(0, \d+\)\}\]`/,
    "the scope/limit/resets_at line no longer sanitises the values it prints",
  );

  /* The behaviour the assertions above stand for, exercised directly: a hostile scope value
   * must lose its escape sequence and its control characters. */
  const sanitize = (value: string): string =>
    value
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ");
  const hostile = "identity\u001b[2J\u001b[1;1Hcswarm: everything is fine\u0007";
  const cleaned = sanitize(hostile);
  assert.ok(!cleaned.includes("\u001b"), "the sanitiser left an escape character in place");
  assert.ok(!/[\u0000-\u001f]/.test(cleaned), "the sanitiser left a C0 control character in place");
  assert.ok(cleaned.startsWith("identity"), `the sanitiser mangled the legitimate prefix: ${JSON.stringify(cleaned)}`);
  // Positive control on the same invocation: an ordinary value passes through untouched.
  assert.equal(sanitize("workspace"), "workspace");
});

/* THE LIST MOST USERS SEE IS NOT THE SERVER'S. `cswarm file put` refuses a bad name LOCALLY,
 * before any request, with `the workspace accepts ${allowedExtensionList()}` — built from the
 * hand-typed CONTENT_TYPES map in src/cloud/files.ts. The web app carries a third copy in
 * site/src/lib/commonswarm.ts. A Grok arm found that the generated server refusal this lane
 * spent four rounds on is the surface a CLI user reaches LAST, and that nothing held the three
 * copies together: they agreed only by hand. The extension allowlist is a published product
 * commitment, so bind all three to each other. */

/* The gate above binds the extension KEYS and stops there. The maps are key→MIME, and the value
 * is what the client SENDS: a wrong value means `cswarm file put icon.svg` passes the local
 * check and is then refused by the server, while the local message still names `.svg`. A Grok
 * arm caught the half-bound gate — the same shape as the two it caught in the rounds before, in
 * my own new control. Bind the values to the enforcement that has to accept them. */

/* The printer, not the data. `allowedExtensionList()` is what a CLI user actually reads when a
 * name is refused locally, and nothing called it: replacing it with a shorter typed string left
 * the suite green while the first sentence a user sees was wrong. */

/* "Case does not matter" was probed only for content_type, which validateFileCommand lowercases.
 * The NAME is stored as typed; extension case-insensitivity rests entirely on the "i" flag of
 * ALLOWED_EXTENSION_RE. A Grok arm measured that deleting that flag left the whole suite green
 * while `cswarm file put Plan.MD` would be refused by a message promising case does not matter. */
test("an upper-case extension is accepted on the path a user actually takes", async () => {
  const edgeModule = "../../supabase/functions/command/file-artifacts.ts";
  const { fileContentAllowed, validateFileCommand, ALLOWED_EXTENSION_RE } =
    (await import(edgeModule)) as {
      fileContentAllowed: (name: string, contentType: string) => boolean;
      validateFileCommand: (
        cmd: Record<string, unknown>,
      ) => { ok: true; command: unknown } | { ok: false };
      ALLOWED_EXTENSION_RE: RegExp;
    };

  assert.ok(
    ALLOWED_EXTENSION_RE.flags.includes("i"),
    "ALLOWED_EXTENSION_RE lost its case-insensitive flag; the refusal still says case does not matter",
  );

  const accepts = (name: string, contentType: string): boolean => {
    const validated = validateFileCommand({
      kind: "file_version_create",
      file_id: "3f1d4c6a-0000-4000-8000-000000000003",
      version_id: "3f1d4c6a-0000-4000-8000-000000000004",
      name,
      declared_size_bytes: 16,
      content_type: contentType,
    });
    if (!validated.ok) return false;
    const command = validated.command as { name: string; content_type: string };
    // The name is stored AS TYPED — assert that, so a future lowercasing is noticed here.
    assert.equal(command.name, name, "validateFileCommand now rewrites the file name");
    return fileContentAllowed(command.name, command.content_type);
  };

  for (const name of ["Plan.MD", "PLAN.MD", "plan.Md", "Report.PDF", "IMAGE.PNG", "a.TAR.GZ"]) {
    assert.equal(accepts(name, "text/plain"), true, `${name} is refused though the refusal says case does not matter`);
  }
  // Negative control on the same invocation: case-insensitivity must not accept a bad extension.
  for (const name of ["Plan.EXE", "script.SH", "archive.TAR"]) {
    assert.equal(accepts(name, "text/plain"), false, `${name} is accepted; the extension allowlist is not being applied`);
  }
});

/* §5 used to end "Everything else — executables, scripts, dylibs, unknown binaries — is refused
 * with the list", which reads as content inspection. Nothing reads the bytes: an executable
 * named plan.md and declared text/plain is accepted, stored and served. A Codex arm called the
 * overclaim. The honest version is bound here, together with the warning that carries it to
 * every reader. */

/* A policy page that publishes a "last updated" date is making a claim about itself. This lane
 * changed the published caps and left the date at 12 September; a Codex arm caught it. Bind the
 * date to the file's own content: if the sections change, the date has to move with them. */

/* A 429 is a sentence about the caller's own request, and at the cap boundary two in-flight
 * requests sharing one command id could split 200/429 — the loser told "Upload refused" while
 * its twin succeeded. The pre-charge recheck settles the SEQUENTIAL replay only. A Codex arm
 * found the concurrent case. Both refusals now re-read the ledger first and replay a settled
 * twin instead of lying. */
