import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

// Canonical OS temp root: under the run-test-list owner this is the run's
// private TMPDIR, so interrupted test processes leave allocations the owner
// can still collect after the child group quiesces.
const temporaryRoot = realpathSync(tmpdir());
const realHome = realpathSync(userInfo().homedir);

interface DirectoryIdentity {
  dev: number;
  ino: number;
  uid: number;
}

const createdHomes = new Map<string, DirectoryIdentity>();
const unownedHomes = new Map<string, DirectoryIdentity>();

function identityOf(path: string): DirectoryIdentity {
  const entry = lstatSync(path);
  return { dev: entry.dev, ino: entry.ino, uid: entry.uid };
}

function assertUsableTemporaryRoot(): void {
  const homeFromRoot = relative(temporaryRoot, realHome);
  const rootIsHomeOrAncestor = homeFromRoot === "" || (homeFromRoot !== ".." && !homeFromRoot.startsWith(`..${sep}`));
  if (temporaryRoot === "/" || rootIsHomeOrAncestor) {
    throw new Error("refusing an unsafe temporary root for lane homes");
  }
}

function createRegisteredHome(prefix: string, registry: Map<string, DirectoryIdentity>): string {
  assertUsableTemporaryRoot();
  const path = mkdtempSync(resolve(temporaryRoot, `lane-home-${prefix}`));
  registry.set(realpathSync(path), identityOf(path));
  return path;
}

function removeRegisteredHome(
  path: string,
  registry: Map<string, DirectoryIdentity>,
  laneNamed: boolean,
  refuseMessage: string,
): void {
  if (!path || !isAbsolute(path)) throw new Error("temporary home must be an absolute path");
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry || entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(refuseMessage);
  const actual = realpathSync(path);
  const inside = relative(temporaryRoot, actual);
  const recorded = registry.get(actual);
  if (actual === "/" || actual === realHome || !inside || inside === ".." || inside.startsWith(`..${sep}`) ||
      (laneNamed && !/^lane-home[-.]/.test(basename(actual))) || !recorded ||
      entry.dev !== recorded.dev || entry.ino !== recorded.ino || entry.uid !== recorded.uid) {
    throw new Error(refuseMessage);
  }
  rmSync(actual, { recursive: true, force: true });
  // The ownership record is dropped only after a successful removal, so a
  // failed removal can be retried and a replaced directory is never deleted.
  if (lstatSync(actual, { throwIfNoEntry: false })) {
    throw new Error("temporary home still exists after removal");
  }
  registry.delete(actual);
}

export function createLaneTempHome(prefix: string): string {
  return createRegisteredHome(prefix, createdHomes);
}

/** A guarded negative control: owned by this test helper, but not by removeLaneTempHome. */
export function createLaneUnownedTempHome(prefix: string): string {
  return createRegisteredHome(prefix, unownedHomes);
}

export function removeLaneUnownedTempHome(path: string): void {
  removeRegisteredHome(path, unownedHomes, false, "refusing to remove an unowned temporary home");
}

export function removeLaneTempHome(path: string): void {
  removeRegisteredHome(path, createdHomes, true, "refusing to remove a path outside the temporary root");
}
