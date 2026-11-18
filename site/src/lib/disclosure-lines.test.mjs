/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { HOUSEHOLD_JOIN_DISCLOSURE } from "../../../src/protocol/household-invitations.ts";
import { disclosureSentences, showDisclosure } from "./disclosure-lines.ts";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("the protocol's disclosure is four sentences, word for word and in order", () => {
  const sentences = disclosureSentences(HOUSEHOLD_JOIN_DISCLOSURE);
  assert.deepEqual(sentences, [
    "Members can read shared workspace content and retained history, except directed messages restricted to their audience.",
    "Your personal and business spaces stay separate.",
    "You choose and authorize your own agents separately.",
    "Copies already read cannot be recalled.",
  ]);
  assert.equal(sentences.join(" "), HOUSEHOLD_JOIN_DISCLOSURE, "nothing is added, dropped or reordered");
});

test("a text with no sentence break, or with odd spacing, is still shown whole", () => {
  assert.deepEqual(disclosureSentences("Shared history"), ["Shared history"]);
  assert.deepEqual(disclosureSentences("One.  Two?\nThree!"), ["One.", "Two?", "Three!"]);
  assert.deepEqual(disclosureSentences(""), []);
});

/** A paragraph stand-in with the few DOM members showDisclosure uses. */
function paragraph() {
  const make = () => ({ dataset: {}, textContent: "" });
  const node = { children: [], ownerDocument: { createElement: make },
    get childElementCount() { return this.children.filter((child) => typeof child !== "string").length; },
    get textContent() { return this.children.map((child) => typeof child === "string" ? child : child.textContent).join(""); },
    replaceChildren() { this.children = []; this.writes = (this.writes ?? 0) + 1; },
    append(child) { this.children.push(child); } };
  return node;
}

test("the paragraph holds one line element per sentence and its text is still the disclosure", () => {
  const target = paragraph();
  showDisclosure(target, HOUSEHOLD_JOIN_DISCLOSURE);
  assert.equal(target.childElementCount, 4);
  assert.equal(target.textContent, HOUSEHOLD_JOIN_DISCLOSURE);
  assert.equal(target.children.filter((child) => typeof child !== "string").every((line) => line.dataset.disclosureLine === ""), true);
  showDisclosure(target, HOUSEHOLD_JOIN_DISCLOSURE);
  assert.equal(target.writes, 1, "the same text is not drawn again");
  showDisclosure(target, "Shared history");
  assert.equal(target.textContent, "Shared history");
});

test("both reviews draw the server's text through the one helper and hold no copy of it", async () => {
  const inbox = await source("../components/invite/HumanInvitationInbox.astro");
  const onramp = await source("../components/invite/InviteOnramp.astro");
  assert.match(inbox, /showDisclosure\(one\('\[data-disclosure\]'\),view\.preview\.disclosure\)/u);
  assert.match(onramp, /showDisclosure\(one<HTMLElement>\('\[data-review-disclosure\]'\)!, value\.disclosure\)/u);
  for (const page of [inbox, onramp]) assert.doesNotMatch(page, /Copies already read|retained history/u);
  /* In the app's review the disclosure comes before the access choice and the confirmation. */
  assert.ok(inbox.indexOf("data-disclosure") < inbox.indexOf("human-invitations__choices"));
  assert.ok(inbox.indexOf("human-invitations__choices") < inbox.indexOf("data-consent"));
});
