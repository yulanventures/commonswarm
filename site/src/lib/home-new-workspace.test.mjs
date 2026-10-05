import assert from "node:assert/strict";
import { test } from "node:test";

import { PURPOSE_COPY } from "./household-access.ts";
import {
  newWorkspaceCanCreate,
  newWorkspacePeopleHint,
  newWorkspacePreviewTitle,
  newWorkspacePurposeChoices,
  newWorkspaceShowsInviteSlot,
} from "./home-new-workspace.ts";

const purposes = Object.entries(PURPOSE_COPY).map(([value, copy]) => ({
  value,
  label: copy.label,
  detail: copy.detail,
}));

test("preview title names the workspace or falls back honestly", () => {
  assert.equal(newWorkspacePreviewTitle("Home"), "Who'll be in Home");
  assert.equal(newWorkspacePreviewTitle("  "), "Who'll be in your workspace");
});

test("the invite slot hides only for a personal workspace", () => {
  assert.equal(newWorkspaceShowsInviteSlot(null), true);
  assert.equal(newWorkspaceShowsInviteSlot("shared"), true);
  assert.equal(newWorkspaceShowsInviteSlot("personal"), false);
});

test("create needs a name and a purpose, with nothing assumed", () => {
  assert.equal(newWorkspaceCanCreate("", null), false);
  assert.equal(newWorkspaceCanCreate("Home", null), false);
  assert.equal(newWorkspaceCanCreate("", "shared"), false);
  assert.equal(newWorkspaceCanCreate("Home", "shared"), true);
  assert.equal(newWorkspaceCanCreate("  Trip  ", "personal"), true);
});

test("the people note promises an invite link only for a shared workspace", () => {
  assert.match(newWorkspacePeopleHint(null), /invite link/u);
  assert.match(newWorkspacePeopleHint("shared"), /invite link/u);
  assert.match(newWorkspacePeopleHint("personal"), /Nobody else can be invited/u);
  assert.doesNotMatch(newWorkspacePeopleHint("personal"), /invite link/i);
});

test("the form view model offers shared and personal choices, with nothing preselected", () => {
  const vm = { viewerName: "Tom", viewerInitials: "T", name: "Home", purpose: null, purposes };
  const choices = newWorkspacePurposeChoices(vm);
  assert.equal(choices.legend, "Who is it for?");
  assert.equal(choices.name, "create-purpose");
  assert.equal(choices.value, null);
  assert.deepEqual(choices.options.map(({ value, label, disabled }) => ({ value, label, disabled })), [
    { value: "shared", label: "Me and people I invite", disabled: false },
    { value: "personal", label: "Just me", disabled: false },
  ]);
  const personal = newWorkspacePurposeChoices({ ...vm, purpose: "personal", busy: true });
  assert.equal(personal.value, "personal");
  assert.deepEqual(personal.options.map((option) => option.disabled), [true, true]);
});
