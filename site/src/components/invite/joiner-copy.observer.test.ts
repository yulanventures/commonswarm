/**
 * The joiner pages: what the second person in a household reads and chooses.
 *
 * SOURCE LEVEL, NO BROWSER. These read InviteOnramp.astro and HumanInvitationInbox.astro and pin
 * what a person sees (household words, the order of the sign-in choices, the review card, the
 * access cards, the connect step) and what must stay true under it (the data-* hooks, the
 * controller wiring, textContent for dynamic values, no protocol words). The site test script
 * globs *.observer.test.ts, so this file runs with the rest.
 *
 * ROLE TEXT IS NEVER TYPED HERE. The two access choices and their sentences come from
 * household-access.ts. These tests read the same constants and check the pages are built from
 * them, so a reworded sentence there cannot make a page and its test disagree.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { CONTENT_ROLES, CONTENT_ROLE_COPY } from "../../lib/household-access";

/** Words the product keeps out of every screen a household member reads. */
const PROTOCOL_WORDS = /\b(?:seat\w*|grant\w*|claim\w*|oauth|mcp|signal\w*|principal\w*)\b/i;

interface Parts {
  /** The whole file. */
  source: string;
  /** The template: no frontmatter, script, style or comments. Whitespace collapsed. */
  markup: string;
  /** What a person reads from the template: tags removed, whitespace collapsed. */
  text: string;
  /** The browser script without comments. */
  script: string;
  /** The stylesheet without comments. */
  style: string;
}

async function load(name: string): Promise<Parts> {
  const source = await readFile(new URL(`./${name}`, import.meta.url), "utf8");
  const script = (/<script>([\s\S]*?)<\/script>/.exec(source)?.[1] ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const style = (/<style>([\s\S]*?)<\/style>/.exec(source)?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
  const markup = source
    .replace(/^---[\s\S]*?\n---\n/, "")
    .replace(/<script>[\s\S]*?<\/script>/g, "")
    .replace(/<style>[\s\S]*?<\/style>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\s+/g, " ");
  const text = markup.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
  return { source, markup, text, script, style };
}

/** One `data-view` section of the /invite template, from its opening tag to its closing tag. */
function view(parts: Parts, name: string): string {
  const start = parts.markup.indexOf(`data-view="${name}"`);
  assert.ok(start >= 0, `/invite has no ${name} view`);
  const end = parts.markup.indexOf("</section>", start);
  assert.ok(end > start, `the ${name} view never closes`);
  return parts.markup.slice(start, end);
}

const textOf = (markup: string): string => markup.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

test("the access choices come from household-access.ts, and both pages build their cards from it", async () => {
  // The constants themselves: every enforced role has words (household-access.test.mjs pins the
  // same thing for the copy module; this keeps the pages honest about which set they render).
  assert.deepEqual([...CONTENT_ROLES].sort(), Object.keys(CONTENT_ROLE_COPY).sort());
  for (const name of ["InviteOnramp.astro", "HumanInvitationInbox.astro"]) {
    const page = await load(name);
    assert.match(page.source, /import \{ CONTENT_ROLES, CONTENT_ROLE_COPY \} from "\.\.\/\.\.\/lib\/household-access"/, name);
    assert.match(page.markup, /CONTENT_ROLES\.map\(/, `${name} must loop over the enforced roles`);
    assert.match(page.markup, /CONTENT_ROLE_COPY\[role\]\.label/, name);
    assert.match(page.markup, /CONTENT_ROLE_COPY\[role\]\.detail/, name);
    for (const role of CONTENT_ROLES) {
      const copy = CONTENT_ROLE_COPY[role];
      assert.ok(!page.source.includes(copy.detail), `${name} types the ${role} sentence instead of reading it`);
      assert.ok(!page.source.includes(`>${copy.label}<`), `${name} types the ${role} label instead of reading it`);
    }
    // Radio cards in a fieldset with a legend; no dropdown, nothing preselected.
    assert.match(page.markup, /<fieldset[^>]*>\s*<legend>Your access<\/legend>/, name);
    assert.match(page.markup, /<input type="radio" name="[^"]+" value=\{role\}/, name);
    assert.doesNotMatch(page.markup, /<select/, `${name} must not use a dropdown for access`);
    assert.doesNotMatch(page.markup, /<input type="radio"[^>]*\bchecked\b/, `${name} must not preselect a role`);
  }
});

test("/invite signed out: who invited her, a plain lead, three steps, then providers, 'or', email", async () => {
  const page = await load("InviteOnramp.astro");
  const auth = view(page, "auth");
  assert.match(
    auth,
    /<h1[^>]*><span data-inviter>A teammate<\/span> invited you to <span data-workspace>a workspace<\/span>\.<\/h1>/,
  );
  assert.match(
    textOf(auth),
    /Sign in as yourself to accept\. New to CommonSwarm\? Signing in creates your free account\./,
  );
  assert.match(
    textOf(auth),
    /1 ?Sign in as yourself 2 ?Choose what you share 3 ?Connect your own agents/,
  );
  // The order a person meets them: the provider buttons, then the "or" divider the component
  // renders after them, then the email form.
  const providers = auth.indexOf("<ProviderButtons");
  const divider = auth.indexOf('slot="after" class="invite-onramp__divider"');
  const email = auth.indexOf("data-email-form");
  assert.ok(providers >= 0 && divider > providers && email > divider, "providers, then the divider, then the email form");
  assert.match(auth, /<span>or<\/span>/);
  assert.match(auth, /<button class="invite-onramp__button" type="submit">Email me a sign-in link<\/button>/);
  // The owner-settings sentence is gone from this view.
  assert.doesNotMatch(page.text, /must confirm Shared settings/i);
  assert.doesNotMatch(page.text, /Private workspace invitation/);
});

test("/invite sender view uses household words and keeps its hooks", async () => {
  const page = await load("InviteOnramp.astro");
  const sender = view(page, "sender");
  assert.match(textOf(sender), /This link is for the person you invited\./);
  assert.match(textOf(sender), /Send it to them; don't open it yourself\./);
  assert.match(sender, /data-copy-sender/);
  assert.match(sender, /data-sender-status/);
  assert.match(sender, /href="\/app"/);
  assert.match(page.script, /Copied\. Send it to the person you invited\./);
});

test("/invite review: a 'Join {workspace}?' card with who is here, what she will see and what stays private", async () => {
  const page = await load("InviteOnramp.astro");
  const review = view(page, "review");
  assert.match(review, /<h1[^>]*>Join <span data-review-workspace>this workspace<\/span>\?<\/h1>/);
  assert.match(review, /<h2[^>]*>Who is here<\/h2> <p data-review-audience><\/p>/);
  assert.match(review, /<h2[^>]*>What you will see<\/h2> <p data-review-disclosure><\/p>/);
  assert.match(textOf(review), /What stays private: your other workspaces\./);
  assert.match(review, /data-review-expiry/);
  // The server's own disclosure sentence is shown as sent; no second typed disclosure beside it.
  assert.doesNotMatch(textOf(review), /retained history|accept the audience/i);
  // The tick, the button and the way out.
  assert.match(review, /<input type="checkbox" data-independent-consent \/> <span>I'm joining as myself\.<\/span>/);
  assert.match(
    review,
    /<button[^>]*data-confirm-join><span class="invite-onramp__label">Join <span data-review-workspace>this workspace<\/span><\/span><\/button>/,
  );
  assert.match(review, /<a [^>]*href="\/app">Not now<\/a>/);
  // One workspace-name slot is not enough now that the title and the button both carry it.
  assert.match(page.script, /querySelectorAll<HTMLElement>\('\[data-review-workspace\]'\)/);
});

test("/invite review reads the checked radio and still refuses until a role is chosen and the box is ticked", async () => {
  const page = await load("InviteOnramp.astro");
  assert.match(page.markup, /data-content-role/);
  assert.match(page.script, /querySelectorAll<HTMLInputElement>\("\[data-content-role\]"\)/);
  assert.match(page.script, /choice\.checked\)\?\.value/);
  // The original refusal, unchanged: no preview, no tick or a role that is not one of the two
  // returns to the review instead of sending anything.
  assert.match(
    page.script,
    /if \(!preview \|\| !consentBox\(\)\.checked \|\| \(role !== 'reader' && role !== 'editor'\)\) return show\('review'\);/,
  );
  // And the click says what is missing before the "Joining" screen can flash.
  assert.match(page.script, /if \(reviewReady\(\)\) \{[\s\S]*?void accept\(true\);[\s\S]*?return;/);
  assert.match(page.script, /Choose your access and tick the box to join\./);
  assert.match(page.markup, /data-review-hint role="alert" hidden/);
  // New preview, fresh choices: nothing carries over and nothing is preselected.
  assert.match(page.script, /const resetReview = \(\): void => \{[\s\S]*?choice\.checked = false;/);
  // The role locks while the join request is in flight, as the select did.
  assert.match(page.script, /lockReview\(true\);/);
});

test("/invite connect step: a receipt, the shared host picker for the joiner, then the way into the workspace", async () => {
  const page = await load("InviteOnramp.astro");
  const connect = view(page, "connect");
  assert.match(connect, /<h1[^>]*>You're in <span data-workspace>a workspace<\/span>\.<\/h1>/);
  // The receipt heading comes first, so focus lands there; the picker follows, then the link.
  const receipt = connect.indexOf("<h1");
  const picker = connect.indexOf('<AgentHostPicker audience="joiner" />');
  const open = connect.indexOf(">Open the workspace</a>");
  assert.ok(receipt >= 0 && picker > receipt && open > picker, "receipt, then the picker, then Open the workspace");
  assert.match(connect, /<a [^>]*href="\/app">Open the workspace<\/a>/);
  // The old protocol paragraphs and the one-time-key flow are not on this page.
  assert.doesNotMatch(page.source, /AgentConnect/);
  assert.doesNotMatch(page.text, /separate|connector|authorization|personal workspace|connected apps/i);
  assert.doesNotMatch(page.script, /agent-connect/);
});

test("/invite tells the picker the workspace and the sign-in email, with a fallback if it is not defined yet", async () => {
  const page = await load("InviteOnramp.astro");
  assert.match(page.script, /one<PickerElement>\("agent-host-picker"\)/);
  assert.match(page.script, /typeof picker\.setContext === "function"/);
  assert.match(page.script, /picker\.setContext\(authEmail \? \{ workspaceName, accountEmail: authEmail \} : \{ workspaceName \}\)/);
  // The fallback writes the picker's own attributes. They must be the ones it observes.
  const picker = await readFile(new URL("../connect/AgentHostPicker.astro", import.meta.url), "utf8");
  const observed = /static observedAttributes = \[([^\]]*)\]/.exec(picker)?.[1] ?? "";
  for (const attribute of ["workspace-name", "account-email"]) {
    assert.ok(observed.includes(`"${attribute}"`), `the picker no longer observes ${attribute}`);
    assert.ok(page.script.includes(`"${attribute}"`), `/invite no longer sets ${attribute}`);
  }
  // The email comes from the session the page already reads, in every place it reads one.
  assert.match(page.script, /authEmail = session\.user\.email \?\? null;/);
  assert.match(page.script, /authEmail = session\?\.user\.email \?\? null;/);
  // The receipt names the server's workspace, so it is right when she returns later too.
  assert.match(page.script, /'\[data-view="connect"\] \[data-workspace\]'\)\) \{\s*node\.textContent = workspaceName;/);
});

test("/invite keeps every view and the join state machine", async () => {
  const page = await load("InviteOnramp.astro");
  for (const name of ["loading", "unusable", "auth", "sender", "review", "joining", "join-error", "connect", "complete"]) {
    assert.match(page.markup, new RegExp(`data-view="${name}"`), `missing view ${name}`);
  }
  for (const hook of ["data-unusable-message", "data-email-form", "data-auth-status", "data-auth-error", "data-retry-join"]) {
    assert.ok(page.markup.includes(hook), `missing hook ${hook}`);
  }
  // A refused acceptance explains itself in household words and names who to ask.
  assert.match(page.script, /If you were just invited, ask \$\{sender\} to check who can see the workspace\./);
  assert.doesNotMatch(page.script, /recipient address|shared workspace settings/);
});

test("the invitation card is invisible unless there is something to show, and waits for the dashboard", async () => {
  const page = await load("HumanInvitationInbox.astro");
  assert.match(page.markup, /<human-invitation-inbox hidden data-placement="corner">/);
  // The old rule showed the box to every signed-in person.
  assert.doesNotMatch(page.script, /root\.hidden\s*=\s*view\.account\s*===\s*null\s*;/);
  assert.match(page.script, /const listing=!joined && view\.invitations\.length>0;/);
  /* R2 review: a failed check is not an empty inbox. It shows, with Check again and Not now,
     from the controller's explicit failed flag, never from the message text. */
  assert.match(
    page.script,
    /const failing=view\.failed && !view\.busy && !joined && !reviewing && !listing && !failureDismissed;/,
  );
  assert.match(
    page.script,
    /const shown=view\.account!==null && state!=='loading' && \(joined \|\| reviewing \|\| listing \|\| failing\);/,
  );
  assert.match(page.markup, /data-failure hidden/);
  assert.match(page.markup, /data-retry>Check again</);
  assert.doesNotMatch(page.script, /view\.message\s*===|message\.includes\(/, "visibility never branches on message text");
  assert.match(page.script, /root\.hidden=!shown;/);
  // A display rule on the element beats the browser's [hidden]; the stylesheet must say it back.
  assert.match(page.style, /human-invitation-inbox\[hidden\][\s\S]*?\{\s*display: none;/);
});

test("the card never covers the composer: raised above it, or in the page flow on the create screen", async () => {
  const page = await load("HumanInvitationInbox.astro");
  // A fixed, styled card at the bottom right, at most about 26rem wide.
  assert.match(page.style, /human-invitation-inbox \{[^}]*position: fixed;/);
  assert.match(page.style, /inline-size: min\(26rem, 100% - var\(--s-8\)\);/);
  assert.match(page.style, /border-radius: var\(--radius-lg\);/);
  assert.match(page.style, /box-shadow: var\(--shadow-lg\);/);
  assert.match(page.style, /background: var\(--surface\);/);
  // Raised above the composer, which is about 8rem tall (the composer observers measure 108px at
  // rest, 130px with two lines and 129px at 320px wide).
  const clearance = Number(/--human-invitations-clearance:\s*([\d.]+)rem;/.exec(page.style)?.[1]);
  assert.ok(clearance >= 8, `the card must sit at least 8rem above the bottom, not ${clearance}rem`);
  assert.match(
    page.style,
    /inset-block-end: calc\(var\(--human-invitations-clearance\) \+ env\(safe-area-inset-bottom, 0px\)\);/,
  );
  assert.match(page.style, /max-block-size: min\(60svh, 24rem\);/);
  // On the create screen it is part of the page, above the form, so it cannot cover the button.
  assert.match(
    page.style,
    /human-invitation-inbox\[data-placement="top"\] \{\s*position: static;[\s\S]*?margin: var\(--s-6\) auto 0;/,
  );
  // Phones: floats across the width, still above the composer.
  assert.match(page.style, /@media \(max-width: 34rem\) \{\s*human-invitation-inbox \{\s*inset-inline: var\(--s-3\);/);
});

test("on the create screen the card watches the dashboard, moves above the form and says to review first", async () => {
  const page = await load("HumanInvitationInbox.astro");
  assert.match(
    page.text,
    /Review this invitation first\. You can still create your own workspace later\./,
  );
  assert.match(page.script, /document\.querySelector<HTMLElement>\('live-dashboard'\)/);
  assert.match(page.script, /new MutationObserver\(\(\)=>paint\(\)\)\.observe\(dashboard,\{attributes:true,attributeFilter:\['data-state'\]\}\);/);
  assert.match(page.script, /const creating=state==='create';/);
  assert.match(page.script, /root\.dataset\.placement=creating\?'top':'corner';/);
  assert.match(page.script, /one\('\[data-first\]'\)\.hidden=!\(creating && listing\);/);
  // The state names are the dashboard's. If it renames "create" or "loading", this fails.
  const dashboard = await readFile(new URL("../app/LiveDashboard.astro", import.meta.url), "utf8");
  assert.match(dashboard, /name: "loading" \| "signed-out" \| "create" \| "workspace-error" \| "channel"/);
  assert.match(dashboard, /app\.dataset\.state = name;/);
  assert.match(dashboard, /<live-dashboard class="dashboard" data-state="loading">/);
  // The dashboard is read, never edited, from here.
  assert.doesNotMatch(page.source, /LiveDashboard/);
});

test("the review is a modal dialog: opens on its heading, Escape and Not now close it back to the card", async () => {
  const page = await load("HumanInvitationInbox.astro");
  assert.match(
    page.markup,
    /<dialog class="human-invitations__dialog" data-review-dialog aria-labelledby="human-invitations-review-title">/,
  );
  assert.match(page.markup, /<h2[^>]*id="human-invitations-review-title"[^>]*data-review-heading>Join <span data-title><\/span>\?<\/h2>/);
  // Open as a modal, with focus on the heading.
  assert.match(
    page.script,
    /if\(dialogWanted && !dialog\.open\)\{dialog\.showModal\(\);one\('\[data-review-heading\]'\)\.focus\(\{preventScroll:true\}\);\}/,
  );
  assert.match(page.script, /else if\(!dialogWanted && dialog\.open\)dialog\.close\(\);/);
  // Not now closes the dialog; Escape does the same natively; both land on the close event.
  assert.match(page.script, /one\('\[data-cancel\]'\)\.addEventListener\('click',\(\)=>\{dialog\.close\(\);\}\);/);
  assert.match(
    page.script,
    /dialog\.addEventListener\('close',\(\)=>\{\s*if\(!dialogWanted\)return;\s*dialogWanted=false;\s*if\(lastView\?\.busy\)return;\s*quiet=true;focusNext='list';void controller\.load\(\);/,
  );
  // And focus goes back to a Review button once the card is back.
  assert.match(page.script, /target==='list' && listing && !reviewing\)root\.querySelector<HTMLElement>\('\[data-row-review\]'\)\?\.focus/);
  // While the join request is in flight, Escape and Not now are refused.
  assert.match(page.script, /dialog\.addEventListener\('cancel',event=>\{if\(lastView\?\.busy\)event\.preventDefault\(\);\}\);/);
  assert.match(page.script, /one<HTMLButtonElement>\('\[data-cancel\]'\)\.disabled=view\.busy;/);
  // A result about the join shows INSIDE the dialog while it is open, where she can see it.
  assert.match(page.markup, /data-review-result role="status" aria-live="polite"/);
  assert.match(page.script, /one\('\[data-review-result\]'\)\.textContent=reviewing \? message : '';/);
  // Desktop: centered. Phones: a bottom sheet with its own scroll.
  assert.match(page.style, /\.human-invitations__dialog \{[^}]*margin: auto;[^}]*overflow-y: auto;/);
  assert.match(page.style, /\.human-invitations__dialog::backdrop \{\s*background: color-mix\(in oklab, var\(--text\) 32%, transparent\);/);
  assert.match(
    page.style,
    /\.human-invitations__dialog \{\s*inset: auto 0 0 0;[\s\S]*?max-block-size: min\(88svh, 100svh - var\(--s-8\)\);[\s\S]*?margin: 0;/,
  );
  // The disclosure is the server's consent text: shown as sent, never retyped or reworded.
  assert.match(page.script, /one\('\[data-disclosure\]'\)\.textContent=view\.preview\.disclosure;/);
});

test("the invitation card says who invited her, then reviews, then points to the next step", async () => {
  const page = await load("HumanInvitationInbox.astro");
  // Collapsed: "{inviter} invited you to {workspace}." and a Review button.
  assert.match(page.markup, /<template data-row-template>/);
  assert.match(
    page.markup,
    /<p><strong data-row-inviter><\/strong> invited you to <strong data-row-workspace><\/strong>\.<\/p> <button[^>]*data-row-review>Review<\/button>/,
  );
  assert.match(page.markup, /data-refresh>Check again<\/button>/);
  assert.doesNotMatch(page.text, /Check invitations|Your invitations|Close review|Join as myself|My content access/);
  // Review: the same card as /invite.
  assert.match(page.markup, /<h3[^>]*>Who is here<\/h3> <p data-audience><\/p>/);
  assert.match(page.markup, /<h3[^>]*>What you will see<\/h3> <p data-disclosure><\/p>/);
  assert.match(page.text, /What stays private: your other workspaces\./);
  assert.match(page.markup, /<input type="checkbox" data-consent \/> <span>I'm joining as myself\.<\/span>/);
  assert.match(
    page.markup,
    /data-accept><span class="human-invitations__label">Join <span data-join-name><\/span><\/span><\/button>/,
  );
  assert.match(page.markup, /data-cancel>Not now<\/button>/);
  assert.match(page.markup, /data-expiry/);
  // Joined: the receipt, the next step, and the way into the workspace.
  assert.match(page.markup, /data-joined-title><\/h2>/);
  assert.match(page.markup, /<p data-next>Next: connect your own agents\.<\/p>/);
  assert.match(page.markup, /<a [^>]*href="\/app" data-open>Open the workspace<\/a>/);
  assert.match(page.script, /if\(joined\)one\('\[data-joined-title\]'\)\.textContent=view\.message;/);
  // The protocol paragraph is gone.
  assert.doesNotMatch(page.text, /authorization|connector|grant|seats?\b|mcp\.commonswarm/i);
});

test("the invitation card keeps the controller wiring and the same refusal until a role is chosen", async () => {
  const page = await load("HumanInvitationInbox.astro");
  assert.match(page.script, /createHumanInviteController\(browserHumanInvitations\(\), view=>\{lastView=view;paint\(\);\}\)/);
  for (const call of ["controller.load()", "controller.review(row.invitation_id)", "controller.accept(role,consent)", "controller.setAccount("]) {
    assert.ok(page.script.includes(call), `the card no longer calls ${call}`);
  }
  assert.match(page.script, /input=>input\.checked\)\?\.value/);
  assert.match(page.script, /if\(!role \|\| !consent\)\{/);
  assert.match(page.script, /Choose your access and tick the box to join\./);
  // A new review starts with nothing chosen.
  assert.match(page.script, /for\(const input of roles\(\)\)input\.checked=false;/);
  assert.match(page.script, /const locked=view\.confirmed_role!==null\|\|view\.busy;/);
  // The account listener still clears private rows when the person changes.
  assert.match(page.script, /event==='SIGNED_OUT'\|\|account!==\(session\?\.user\.id\?\?null\)/);
});

test("a button or link-button never mixes loose text with an element (the flex-gap bug)", async () => {
  /*
   * These buttons are inline-flex. Text next to an element inside one becomes two flex items and
   * the space between them is dropped: "Join <span>Home</span>" rendered as "JoinHome", and with
   * overflow-wrap on, "Joi" and "n Home". The label goes in ONE element instead.
   */
  const mixes = (inner: string): boolean => {
    let reduced = inner;
    for (let pass = 0; pass < 10; pass++) {
      const next = reduced.replace(/<([a-z]+)\b[^<>]*>[^<>]*<\/\1>/gi, "§");
      if (next === reduced) break;
      reduced = next;
    }
    reduced = reduced.replace(/<[^>]+>/g, "").trim();
    return reduced.includes("§") && /[^§\s]/.test(reduced);
  };
  // Positive control: the check does see the bug.
  assert.equal(mixes('Join <span data-name>Home</span>'), true);
  assert.equal(mixes('<span class="label">Join <span data-name>Home</span></span>'), false);
  assert.equal(mixes("Not now"), false);
  for (const name of ["InviteOnramp.astro", "HumanInvitationInbox.astro"]) {
    const page = await load(name);
    const found = [
      ...page.markup.matchAll(/<button\b[^>]*>(.*?)<\/button>/g),
      ...page.markup.matchAll(/<a\b[^>]*class="[^"]*button[^"]*"[^>]*>(.*?)<\/a>/g),
    ];
    const minimum = name === "InviteOnramp.astro" ? 6 : 4;
    assert.ok(found.length >= minimum, `${name}: expected at least ${minimum} buttons, found ${found.length}`);
    for (const [, inner] of found) assert.equal(mixes(inner as string), false, `${name}: mixed button content: ${inner}`);
  }
  const onramp = await load("InviteOnramp.astro");
  assert.match(
    onramp.markup,
    /data-confirm-join><span class="invite-onramp__label">Join <span data-review-workspace>this workspace<\/span><\/span><\/button>/,
  );
});

test("neither joiner page shows a protocol word, writes HTML from data, or uses a raw colour", async () => {
  for (const name of ["InviteOnramp.astro", "HumanInvitationInbox.astro"]) {
    const page = await load(name);
    assert.doesNotMatch(page.markup, PROTOCOL_WORDS, `${name} markup`);
    assert.doesNotMatch(page.script, PROTOCOL_WORDS, `${name} script strings`);
    // textContent for every dynamic value.
    assert.doesNotMatch(page.source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, name);
    // Daylight Orbs tokens only: no hex, rgb or hsl literal in the stylesheet.
    assert.doesNotMatch(page.style, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/, `${name} style uses a raw colour`);
    // The focus ring, pill buttons and reduced motion are all there.
    assert.match(page.style, /var\(--focus-ring\)/, name);
    assert.match(page.style, /var\(--radius-pill\)/, name);
    assert.match(page.style, /accent-color: var\(--accent\)/, name);
  }
  const onramp = await load("InviteOnramp.astro");
  assert.match(onramp.style, /@media \(prefers-reduced-motion: reduce\) \{\s*\.invite-onramp__spinner \{\s*animation: none;/);
});

test("touch targets are at least 44px and the layout holds at 320px", async () => {
  const onramp = await load("InviteOnramp.astro");
  const inbox = await load("HumanInvitationInbox.astro");
  // Every button, link-button, role card and tick row has a block size of at least 2.75rem.
  assert.match(onramp.style, /\.invite-onramp :global\(\.invite-onramp__button\) \{\s*min-block-size: 3rem;/);
  assert.match(onramp.style, /\.invite-onramp__consent \{\s*min-block-size: 2\.75rem;/);
  assert.match(onramp.style, /\.invite-onramp__choice \{\s*min-block-size: 3\.5rem;/);
  assert.match(inbox.style, /\.human-invitations__button \{\s*min-block-size: 2\.75rem;/);
  assert.match(inbox.style, /\.human-invitations__text-button \{\s*min-block-size: 2\.75rem;/);
  assert.match(inbox.style, /\.human-invitations__consent \{\s*min-block-size: 2\.75rem;/);
  // Narrow screens: grid children can shrink, long names wrap, buttons fill the card.
  assert.match(onramp.style, /min-inline-size: 0;/);
  assert.match(onramp.style, /overflow-wrap: anywhere;/);
  assert.match(onramp.style, /@media \(max-width: 30rem\) \{[\s\S]*?inline-size: 100%;/);
  assert.match(inbox.style, /overflow-wrap: anywhere;/);
});

test("every hook a page script reads exists in its template", async () => {
  /*
   * The inbox render callback reads its elements with a non-null assertion, so one missing hook
   * throws inside the callback and the card stops drawing. This reads the hooks out of the
   * script and checks each against the template. data-signin-provider is the one hook that is
   * rendered by a child component (ProviderButtons), not written in InviteOnramp.astro.
   */
  const renderedByChildren = new Set(["data-signin-provider"]);
  const expected: Record<string, string[]> = {
    "InviteOnramp.astro": ["data-confirm-join", "data-content-role", "data-independent-consent", "data-review-hint"],
    "HumanInvitationInbox.astro": ["data-accept", "data-role", "data-consent", "data-row-template", "data-joined-title"],
  };
  for (const [name, known] of Object.entries(expected)) {
    const page = await load(name);
    const hooks = new Set([...page.script.matchAll(/\[(data-[a-z-]+)(?:=[^\]]*)?\]/g)].map((match) => match[1] as string));
    // Positive control: the extraction does reach the hooks this page is known to use.
    for (const hook of known) assert.ok(hooks.has(hook), `${name}: the script no longer reads ${hook}, or the extraction missed it`);
    for (const hook of hooks) {
      if (renderedByChildren.has(hook)) continue;
      assert.match(page.markup, new RegExp(`\\b${hook}\\b`), `${name} reads [${hook}] but the template has no such element`);
    }
  }
});
