import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WORKSPACE_SKILLS_CAP,
  SKILL_TTL_MS,
  SKILL_UNUSED_ARCHIVE_MS,
  emptyWorkspaceSkillsState,
  saveWorkspaceSkill,
  useWorkspaceSkill,
  deleteWorkspaceSkill,
  tidyWorkspaceSkills,
  proposeTodoFailureSkill,
  keepWorkspaceSkillSuggestion,
  dismissWorkspaceSkillSuggestion,
  formatWorkspaceSkillSuggestion,
  formatWorkspaceSkillSummary,
  formatWorkspaceSkillView,
  WORKSPACE_SKILL_TRUST_WARNING,
} from '../src/protocol/workspace-skills.js';
import { STDIO_MCP_TOOLS, validateSkillMcpArguments, withSkillTrustWarning } from '../src/mcp/tools.js';

const T0 = Date.UTC(2026, 9, 28, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

test('workspace skills enforce small caps, general wording, and replace least-used at cap (20)', () => {
  let state = emptyWorkspaceSkillsState();

  // Rejects @handles and email addresses (general wording rule)
  const withHandle = saveWorkspaceSkill(state, {
    new_id: 'skill-bad-1',
    title: 'Ask @owner before deploy',
    when_to_use: 'When deploying',
    body: 'Check with team first.',
    now: T0,
  });
  assert.deepEqual(withHandle, { status: 'refused', reason: 'skill_wording_not_general' });

  const withEmail = saveWorkspaceSkill(state, {
    new_id: 'skill-bad-2',
    title: 'Deploy checklist',
    when_to_use: 'When deploying',
    body: 'Email ops@example.com before release.',
    now: T0,
  });
  assert.deepEqual(withEmail, { status: 'refused', reason: 'skill_wording_not_general' });

  // Fill up to WORKSPACE_SKILLS_CAP (20)
  for (let i = 1; i <= WORKSPACE_SKILLS_CAP; i++) {
    const res = saveWorkspaceSkill(state, {
      new_id: `skill-${i}`,
      title: `Procedure ${i}`,
      when_to_use: `When running step ${i}`,
      body: `Verify output of step ${i} before proceeding.`,
      now: T0 + i * 1000,
    });
    assert.equal(res.status, 'committed');
    if (res.status === 'committed') {
      assert.equal(res.replaced_skill_id, null);
      state = res.state;
    }
  }
  assert.equal(state.entries.length, WORKSPACE_SKILLS_CAP);

  // Use skill-1 so skill-2 becomes the least-used oldest entry
  const used1 = useWorkspaceSkill(state, { skill_id: 'skill-1' }, T0 + 60_000, true);
  assert.equal(used1.skill?.use_count, 1);
  state = used1.state;

  // Adding a 21st skill replaces skill-2 (least used) rather than growing the pile
  const overCap = saveWorkspaceSkill(state, {
    new_id: 'skill-21',
    title: 'Procedure 21',
    when_to_use: 'When running step 21',
    body: 'Always verify the final status.',
    now: T0 + 120_000,
  });
  assert.equal(overCap.status, 'committed');
  if (overCap.status === 'committed') {
    assert.equal(overCap.replaced_skill_id, 'skill-2');
    assert.equal(overCap.state.entries.length, WORKSPACE_SKILLS_CAP);
    assert.equal(overCap.state.entries.some((e) => e.skill_id === 'skill-2'), false);
    assert.equal(overCap.state.entries.some((e) => e.skill_id === 'skill-21'), true);
  }
});

test('forgetting is the default: unused entries archive after 14d, used entries renew 60d TTL, one-click delete', () => {
  let state = emptyWorkspaceSkillsState();
  const s1 = saveWorkspaceSkill(state, {
    new_id: 's1',
    title: 'Never touched skill',
    when_to_use: 'When testing archive',
    body: 'Short procedure.',
    now: T0,
  });
  assert.equal(s1.status, 'committed');
  if (s1.status === 'committed') state = s1.state;

  const s2 = saveWorkspaceSkill(state, {
    new_id: 's2',
    title: 'Actively used skill',
    when_to_use: 'When testing renewal',
    body: 'Short active procedure.',
    now: T0,
  });
  assert.equal(s2.status, 'committed');
  if (s2.status === 'committed') state = s2.state;

  // Read s2 on day 10 -> increments use_count and renews expires_at to day 10 + 60d
  const used = useWorkspaceSkill(state, { title: 'Actively used skill' }, T0 + 10 * DAY_MS, true);
  assert.equal(used.skill?.use_count, 1);
  assert.equal(used.skill?.expires_at, T0 + 10 * DAY_MS + SKILL_TTL_MS);
  state = used.state;

  // At day 15: s1 (use_count=0, age 15d >= 14d) archives automatically; s2 remains
  const after15d = tidyWorkspaceSkills(state, T0 + SKILL_UNUSED_ARCHIVE_MS + DAY_MS);
  assert.deepEqual(after15d.entries.map((e) => e.skill_id), ['s2']);

  // Summary formatting shows "used N times", "unused for N days", and tidy removal candidate
  const summaryAtDay25 = formatWorkspaceSkillSummary(after15d.entries[0]!, T0 + 25 * DAY_MS);
  assert.equal(summaryAtDay25.used_label, 'used 1 time');
  assert.equal(summaryAtDay25.unused_label, 'unused for 15 days');
  assert.equal(summaryAtDay25.stale_removal_candidate, true);

  // At day 71 (61 days after last use on day 10): s2 expires automatically
  const after71d = tidyWorkspaceSkills(after15d, T0 + 71 * DAY_MS);
  assert.equal(after71d.entries.length, 0);

  // One-click delete removes entry immediately
  const deleted = deleteWorkspaceSkill(after15d, 's2', T0 + 16 * DAY_MS);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.state.entries.length, 0);
});

test('suggestions from reopened or failed todos support owner Keep and Dismiss without re-proposing dismissed items', () => {
  let state = emptyWorkspaceSkillsState();
  state = proposeTodoFailureSkill(state, {
    suggestion_id: 'sug-1',
    todo_id: 'todo-101',
    todo_title: 'Update OAuth callback with @alice',
    failure_note: 'Callback failed for user@example.com due to redirect mismatch.',
    reason: 'todo_reopened',
    now: T0,
  });
  assert.equal(state.suggestions.length, 1);
  // Scrubbed handles/emails
  assert.equal(state.suggestions[0]!.title.includes('@alice'), false);
  assert.equal(state.suggestions[0]!.body.includes('user@example.com'), false);

  // Dismissing removes the suggestion and records source_key
  const dismissed = dismissWorkspaceSkillSuggestion(state, 'sug-1');
  assert.equal(dismissed.status, 'committed');
  if (dismissed.status === 'committed') state = dismissed.state;
  assert.equal(state.suggestions.length, 0);

  // Re-proposing the same reopened todo is skipped
  const reproposed = proposeTodoFailureSkill(state, {
    suggestion_id: 'sug-2',
    todo_id: 'todo-101',
    todo_title: 'Update OAuth callback with @alice',
    failure_note: 'Callback failed again.',
    reason: 'todo_reopened',
    now: T0 + 1000,
  });
  assert.equal(reproposed.suggestions.length, 0);

  // Proposing a different failed todo and keeping it promotes it to entries
  state = proposeTodoFailureSkill(state, {
    suggestion_id: 'sug-3',
    todo_id: 'todo-202',
    todo_title: 'Verify migration checksums',
    failure_note: 'Ensure reserve SQL matches deploy proof.',
    reason: 'todo_failed',
    now: T0 + 2000,
  });
  assert.equal(state.suggestions.length, 1);
  const kept = keepWorkspaceSkillSuggestion(state, 'sug-3', 'skill-from-sug-3', T0 + 3000);
  assert.equal(kept.status, 'committed');
  if (kept.status === 'committed') {
    assert.equal(kept.state.suggestions.length, 0);
    assert.equal(kept.state.entries.length, 1);
    const view = formatWorkspaceSkillView(kept.skill, T0 + 3000);
    assert.equal(view.skill_id, 'skill-from-sug-3');
    assert.match(view.title, /Checklist: Verify migration checksums/);
    assert.equal(view.trust_warning, WORKSPACE_SKILL_TRUST_WARNING);
  }
});

test('MCP stdio tools advertise skills_list and skills_read with untrusted-content warnings and validate arguments strictly', () => {
  const listTool = STDIO_MCP_TOOLS.find((t) => t.name === 'skills_list');
  const readTool = STDIO_MCP_TOOLS.find((t) => t.name === 'skills_read');
  assert.ok(listTool);
  assert.ok(readTool);
  assert.ok(listTool.description.includes(WORKSPACE_SKILL_TRUST_WARNING));
  assert.ok(readTool.description.includes(WORKSPACE_SKILL_TRUST_WARNING));
  assert.deepEqual(validateSkillMcpArguments('skills_list', {}), {});
  assert.throws(() => validateSkillMcpArguments('skills_list', { extra: 'no' }), /Unknown argument/);
  assert.throws(() => validateSkillMcpArguments('skills_read', {}), /Missing argument/);
  assert.deepEqual(
    validateSkillMcpArguments('skills_read', { title: '  Deploy checklist  ' }),
    { title: 'Deploy checklist' },
  );

  const state = proposeTodoFailureSkill(emptyWorkspaceSkillsState(), {
    suggestion_id: 'sug-warn',
    todo_id: 'todo-999',
    todo_title: 'Check edge deployment',
    failure_note: 'Verify health endpoint.',
    reason: 'todo_failed',
    now: T0,
  });
  const formattedSug = formatWorkspaceSkillSuggestion(state.suggestions[0]!);
  assert.equal(formattedSug.trust_warning, WORKSPACE_SKILL_TRUST_WARNING);

  const wrappedList = withSkillTrustWarning({
    status: 'ok',
    skills: [{ skill_id: 's1', title: 'Skill 1' }],
    suggestions: [{ suggestion_id: 'sug-1', title: 'Suggestion 1' }],
  });
  assert.equal(wrappedList.trust_warning, WORKSPACE_SKILL_TRUST_WARNING);
  assert.equal((wrappedList.skills as Array<Record<string, unknown>>)[0]!.trust_warning, WORKSPACE_SKILL_TRUST_WARNING);
  assert.equal((wrappedList.suggestions as Array<Record<string, unknown>>)[0]!.trust_warning, WORKSPACE_SKILL_TRUST_WARNING);

  const wrappedRead = withSkillTrustWarning({
    status: 'ok',
    skill: { skill_id: 's1', title: 'Skill 1', body: 'Body' },
  });
  assert.equal(wrappedRead.trust_warning, WORKSPACE_SKILL_TRUST_WARNING);
  assert.equal((wrappedRead.skill as Record<string, unknown>).trust_warning, WORKSPACE_SKILL_TRUST_WARNING);
});
