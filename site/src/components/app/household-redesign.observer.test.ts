import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/*
 * Source-level guards for the 2026-10-04 household redesign of /app (setup checklist, Add an
 * agent by app, Invite someone, Lists & docs access). Behaviour that needs a browser is covered
 * by the redesign's screenshot harness and the CI browser suites; these pin the contracts a
 * regex can honestly check.
 */
const dashboard = readFileSync(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
const markup = dashboard.slice(0, dashboard.indexOf("<script>")).replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");
const script = dashboard.slice(dashboard.indexOf("<script>"), dashboard.indexOf("</script>"));

const section = (source: string, start: string, end: string): string => {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing anchor ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing anchor ${end}`);
  return source.slice(from, to);
};

test("every function the script calls from commonswarm.ts is imported (the Shared objects crash)", () => {
  /* The household wiring called postCommand without importing it, so the built page threw
     ReferenceError on opening Shared objects. Pin the import beside every use. */
  const importList = section(script, "import {\n    ClientTooOld", '} from "../../lib/commonswarm";');
  assert.match(script, /postCommand\(/);
  assert.match(importList, /\bpostCommand,/);
});

test("the zero-agent state is the setup checklist, with exactly one agent door and one person door", () => {
  const checklist = section(markup, "data-setup-checklist", "</section>");
  assert.equal([...checklist.matchAll(/data-add-agent(?=[\s>])/g)].length, 1);
  assert.equal([...checklist.matchAll(/data-invite-collaborator(?=[\s>])/g)].length, 1);
  assert.match(checklist, /data-setup-access/);
  for (const step of ["access", "agent", "invite"]) {
    assert.match(checklist, new RegExp(`data-setup-step="${step}"`));
  }
  assert.match(script, /import \{ setupProgress, setupSteps \} from "\.\.\/\.\.\/lib\/setup-checklist";/);
  assert.match(script, /const steps = setupSteps\(\{/);
});

test("person-facing redesign markup uses plain words, not protocol words", () => {
  const surfaces = [
    section(markup, "data-setup-checklist", "</section>"),
    section(markup, 'data-channel-view="invite"', "</section>"),
    section(markup, 'data-channel-view="objects"', "<HouseholdObjects"),
    section(markup, 'data-channel-view="agent-choice"', "</section>"),
  ].join("\n");
  /* Visible text only: drop tags (with their attributes) and template expressions, which carry
     hook names such as data-household-purpose that a person never reads. */
  let visible = surfaces.replace(/<[^>]*>/g, " ");
  // Template expressions nest ({list.map(... => {label})}); strip from the inside out.
  for (let previous = ""; previous !== visible;) {
    previous = visible;
    visible = visible.replace(/\{[^{}]*\}/g, " ");
  }
  assert.match(visible, /Who can see this workspace\?/, "positive control: visible text survives the strip");
  assert.doesNotMatch(visible, /\b(seat|grant|claim|OAuth|MCP|signal|principal|purpose|content access)\b/i);
  // Control: the instrument fires on the retired sentence it replaced.
  assert.match("the workspace owner must choose Shared in content settings and confirm content access", /content access/i);
  assert.doesNotMatch(dashboard, /Before inviting someone to a household, the workspace owner must choose Shared/);
});

test("Lists & docs access is two described radio groups, generated from the enforced values", () => {
  const objects = section(markup, 'data-channel-view="objects"', "<HouseholdObjects");
  assert.doesNotMatch(objects, /<select\b/, "no bare select boxes");
  assert.match(objects, /\(\["shared", "personal"\] as const\)\.map\(\(purpose\) =>/);
  assert.match(objects, /PURPOSE_COPY\[purpose\]\.label/);
  assert.match(objects, /CONTENT_ROLES\.map\(\(role\) =>/);
  assert.match(objects, /CONTENT_ROLE_COPY\[role\]\.detail/);
  assert.match(script, /one<HTMLInputElement>\("\[data-household-purpose\]:checked"\)/);
  assert.match(script, /one<HTMLInputElement>\("\[data-household-role\]:checked"\)/);
  /* Only the owner chooses the purpose; the server refuses anyone else's first choice. */
  assert.match(script, /if \(purposeSet\) purposeSet\.hidden = viewerRole\(\) !== "owner";/);
});

test("approving an agent resends the person's own confirmed role and never sets the purpose by guess", () => {
  const approve = section(script, "const approveAgent = async (", "const confirmOwnAccess = async");
  assert.match(approve, /const role = householdAccess\.contentRole;/);
  assert.match(approve, /content_role: role,/);
  assert.doesNotMatch(approve, /content_role: "(?:editor|reader)"/);
  /* The mismatch retry is safe only because confirmed access implies the purpose exists. */
  assert.match(approve, /result\.body\.reason === "workspace_boundary_mismatch"/);
  assert.match(approve, /CONTENT_OPERATION_LABELS|approvalUntil\(/);
  /* Operations shown to the person come from the policy constant, in plain labels. */
  assert.match(script, /for \(const operation of CONTENT_OPERATIONS\)/);
  assert.match(script, /CONTENT_OPERATION_LABELS\[operation\]/);
});

test("the Add an agent poll runs only while a host page is open, and stops on any change", () => {
  const watch = section(script, "const startHostJoinWatch = (): void => {", "    };\n");
  assert.match(watch, /version !== requestVersion/);
  assert.match(watch, /workspaceId !== activeWorkspaceId/);
  assert.match(watch, /15 \* 60_000/);
  assert.match(watch, /app\.dataset\.channelView !== "agent-choice"/);
  assert.match(watch, /stopHostJoinWatch\(\);/);
  assert.match(script, /hostPicker\?\.addEventListener\("agent-host-selected", \(\) => startHostJoinWatch\(\)\);/);
  assert.match(script, /hostPicker\?\.addEventListener\("agent-host-back", \(\) => stopHostJoinWatch\(\)\);/);
});

test("a person and an agent have separate doors in the People & agents dialog", () => {
  const dialog = section(markup, 'id="dashboard-roster-dialog"', "</dialog>");
  assert.match(dialog, /data-add-agent-dialog[\s\S]*?Add an agent/);
  assert.match(dialog, /data-invite-dialog[\s\S]*?Invite someone/);
  assert.match(script, /\[data-invite-dialog\]"\)\?\.addEventListener\("click", \(\) => \{\s*closeRosterDialog\(\);\s*openInvite\("channel"\);/);
});
