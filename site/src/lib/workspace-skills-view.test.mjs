/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderWorkspaceSkillsHtml } from "./workspace-skills-view.ts";

const base = { cap: 20, ttl_days: 60, can_edit: true, skills: [], suggestions: [], opened_skill: null, notice: "" };
const skill = (id) => ({ skill_id: id, title: `Skill ${id}`, when_to_use: "When booking a service", used_label: "used twice",
  unused_label: "unused for 3 days", stale_removal_candidate: false });

test("the Skills heading stands alone when there are no skills", () => {
  const html = renderWorkspaceSkillsHtml(base);
  assert.match(html, /<header>\s*<h3>Skills<\/h3>\s*<\/header>/);
  assert.match(html, /No shared skills yet\./);
  assert.doesNotMatch(html, /data-skills-count/);
});

test("with skills, the count is said in plain words under the heading", () => {
  const html = renderWorkspaceSkillsHtml({ ...base, skills: [skill("a"), skill("b"), skill("c")] });
  assert.match(html, /<h3>Skills<\/h3>\s*<p class="hh-skills-count" data-skills-count>3 of 20<\/p>/);
});

test("the rule that removes a skill is said in full beside Add skill, only to someone who can add one", () => {
  const rule = "Use a new skill within 14 days to keep it. After its first use, it expires 60 days after its last use or edit.";
  const html = renderWorkspaceSkillsHtml(base);
  assert.match(html, new RegExp(`<textarea[^>]*data-skill-input-body></textarea>\\s*<p class="hh-skills-rule" data-skills-rule>${rule.replaceAll(".", "\\.")}</p>\\s*<div>\\s*<button type="submit"`));
  assert.doesNotMatch(html.slice(0, html.indexOf("<form")), /expires|14 days/, "the heading stays clear of it");
  assert.doesNotMatch(renderWorkspaceSkillsHtml({ ...base, can_edit: false }), /data-skills-rule/);
  // The sixty comes from the server's answer, so the sentence stays true if that number changes.
  assert.match(renderWorkspaceSkillsHtml({ ...base, ttl_days: 45 }), /it expires 45 days after its last use or edit\./);
});

test("the builders' shorthand is gone in every state", () => {
  for (const data of [base, { ...base, skills: [skill("a")] }, { ...base, can_edit: false }]) {
    assert.doesNotMatch(renderWorkspaceSkillsHtml(data), /Hints, never gates|hh-eyebrow|d expiry|\d+\/20/);
  }
});
