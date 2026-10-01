import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export interface EvidenceProduct {
  file: string;
  path: string;
  mode: string;
  evidence?: string;
}

// Select bytes for actual later reads. A declaration of a file's expected shape
// cannot supply its contents, and an unused output is never pre-seeded.
export function consumedEvidenceProducts(outputs: EvidenceProduct[], reads: ReadonlySet<string>): Array<EvidenceProduct & { evidence: string; bytes: Buffer }> {
  return outputs.flatMap((output) => {
    if (!reads.has(output.path) || !output.evidence) return [];
    assert.match(output.mode, /^0[0-7]{3}$/);
    const evidence = resolve(output.evidence);
    assert.ok(evidence.startsWith(resolve("docs/evidence") + sep), `not committed evidence: ${output.evidence}`);
    const stat = lstatSync(evidence);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `not regular evidence: ${output.evidence}`);
    assert.ok(realpathSync(evidence).startsWith(realpathSync("docs/evidence") + sep), `evidence escapes its root: ${output.evidence}`);
    const bytes = readFileSync(evidence);
    const tracked = spawnSync("git", ["show", `HEAD:${relative(process.cwd(), evidence).split(sep).join("/")}`], {
      env: { PATH: process.env.PATH, LANG: "C" },
    });
    assert.equal(tracked.status, 0, `no committed output: ${output.evidence}`);
    assert.ok(bytes.equals(tracked.stdout), `output differs from committed evidence: ${output.evidence}`);
    return [{ ...output, evidence: output.evidence, bytes }];
  });
}
