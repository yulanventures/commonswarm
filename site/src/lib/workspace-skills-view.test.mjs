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

const suggestion = (id) => ({ suggestion_id: id, title: `Checklist ${id}`, when_to_use: "When handling a boiler visit", body: "Verify the quote before marking it done." });

test("saved skills and Add skill come first; suggestions follow as titles with their instructions on demand", () => {
  const html = renderWorkspaceSkillsHtml({ ...base, skills: [skill("a")], suggestions: [suggestion("s1"), suggestion("s2")] });
  const at = (needle) => { const index = html.indexOf(needle); assert.ok(index >= 0, needle); return index; };
  assert.ok(at("data-skills-list") < at("data-skills-add") && at("data-skills-add") < at("data-skills-suggestions"), "list, then Add skill, then suggestions");
  // Add skill is closed until asked for; its three fields are inside it, each with a name for assistive technology.
  assert.match(html, /<details class="hh-skills-add" data-skills-add>\s*<summary>Add skill<\/summary>\s*<form class="hh-editor" data-skill-form>/);
  for (const label of ['aria-label="Title"', 'aria-label="When to use"', 'aria-label="Procedure or pitfall"']) assert.ok(html.includes(label), label);
  // One title per suggestion; its instructions are inside a closed disclosure, and Keep and Dismiss stay in view.
  assert.match(html, /<details data-suggestion-more="s1">\s*<summary><strong>Checklist s1<\/strong><\/summary>\s*<div><small>When handling a boiler visit<\/small><\/div>\s*<p>Verify the quote before marking it done\.<\/p>\s*<\/details>\s*<div>\s*<button type="button" data-skill-action="keep"/);
  assert.equal((html.match(/data-suggestion-more=/g) ?? []).length, 2);
  // What the person opened stays open across a redraw.
  const reopened = renderWorkspaceSkillsHtml({ ...base, suggestions: [suggestion("s1"), suggestion("s2")], add_open: true, open_suggestions: ["s2"] });
  assert.match(reopened, /data-skills-add open>/); assert.match(reopened, /data-suggestion-more="s2" open>/); assert.match(reopened, /data-suggestion-more="s1">/);
});

test("only a read that answered may say there are no skills; a failed read offers Retry", () => {
  const failed = renderWorkspaceSkillsHtml({ ...base, load: "failed" });
  assert.match(failed, /role="alert" data-skills-failed>Could not load workspace skills\.<\/p>\s*<div><button type="button" data-skill-action="retry">Retry<\/button>/);
  for (const absent of ["data-skills-empty", "data-skill-form", "data-skills-suggestions"]) assert.ok(!failed.includes(absent), absent);
  const loading = renderWorkspaceSkillsHtml({ ...base, load: "loading" });
  assert.match(loading, /data-skills-loading>Loading skills…/); assert.ok(!loading.includes("data-skills-empty") && !loading.includes("data-skill-form"));
  // No access to Lists & docs here: the notice alone, with no empty claim and no form that cannot save.
  const none = renderWorkspaceSkillsHtml({ ...base, load: "unavailable", notice: "Choose Lists & docs access in this workspace to view and edit shared skills." });
  assert.match(none, /data-skills-notice>Choose Lists &amp; docs access/); assert.ok(!none.includes("data-skills-empty") && !none.includes("data-skill-form"));
  // A read that answered, and an older caller that passes no load state, do say it.
  assert.match(renderWorkspaceSkillsHtml({ ...base, load: "ready" }), /data-skills-empty>No shared skills yet\./);
  assert.match(renderWorkspaceSkillsHtml(base), /data-skills-empty>No shared skills yet\./);
});
