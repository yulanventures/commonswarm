/** Server-owned activation only. Consent/boundary rows and client fields never
 * enable unfinished integration paths. Read once when the worker starts; only
 * the exact value "1" opts in. Keep every gate unset until its Lead checklist
 * prerequisites and independent review are complete. */
const runtime = (globalThis as typeof globalThis & {
  Deno?: { env: { get(name: string): string | undefined } };
}).Deno;

export const HOUSEHOLD_FEATURE_GATES = Object.freeze({
  legacyFileRedirect: runtime?.env.get('SWARM_HOUSEHOLD_LEGACY_FILE_REDIRECT') === '1',
  legacyCommand: runtime?.env.get('SWARM_HOUSEHOLD_LEGACY_COMMAND') === '1',
  hostedFileTransport: runtime?.env.get('SWARM_HOUSEHOLD_HOSTED_FILE_TRANSPORT') === '1',
});
