import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

const temporaryRoot = realpathSync("/tmp");
const realHome = realpathSync(userInfo().homedir);
const createdHomes = new Set<string>();
const unownedHomes = new Set<string>();

export function createLaneTempHome(prefix: string): string {
  const path = mkdtempSync(resolve(temporaryRoot, `lane-home-${prefix}`));
  createdHomes.add(realpathSync(path));
  return path;
}

/** A guarded negative control: owned by this test helper, but not by removeLaneTempHome. */
export function createLaneUnownedTempHome(prefix: string): string {
  const path = mkdtempSync(resolve(temporaryRoot, `lane-home-${prefix}`));
  unownedHomes.add(realpathSync(path));
  return path;
}

export function removeLaneUnownedTempHome(path: string): void {
  const actual = realpathSync(path);
  const inside = relative(temporaryRoot, actual);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || !unownedHomes.has(actual)) {
    throw new Error("refusing to remove an unowned temporary home");
  }
  unownedHomes.delete(actual);
  rmSync(actual, { recursive: true, force: true });
}

export function removeLaneTempHome(path: string): void {
  if (!path || !isAbsolute(path)) throw new Error("temporary home must be an absolute path");
  const actual = realpathSync(path);
  const inside = relative(temporaryRoot, actual);
  if (actual === "/" || actual === realHome || !inside || inside === ".." || inside.startsWith(`..${sep}`) ||
      !/^lane-home[-.]/.test(basename(actual)) || !createdHomes.has(actual)) {
    throw new Error("refusing to remove a path outside the temporary root");
  }
  createdHomes.delete(actual);
  rmSync(actual, { recursive: true, force: true });
}
