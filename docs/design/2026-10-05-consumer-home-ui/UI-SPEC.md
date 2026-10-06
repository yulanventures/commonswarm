# UI-SPEC: CommonSwarm home (canvas build)

2026-10-05. Branch `lane/home-ui` (base 6b72cd6d). The binding inputs are DECISIONS.md, DOC-CONSTRAINTS.md, GAP-TABLE.md, the people-dialog brief and report, and VISION-CANONICAL. Where the canvas and a rule disagree, the rule wins and this spec says what the UI does instead.

**Reconciliation with "What not to copy: chat-first streams".** The app opens on Catch up, a Basecamp-style home. Each workspace's durable objects (to-dos, lists, files) stay visible in the right column. Objects also show up as cards inside the stream, so the stream is never the only way in.

---

## 1. Information architecture and navigation

### 1.1 Shell

| Width | Layout |
|---|---|
| ≥ 64rem (1024 px) | Three columns: **left rail** `17.5rem` · **centre** `minmax(0,1fr)` · **right column** `minmax(18rem,22rem)`. The right column holds the cards. When the existing profile panel (`aside[data-entity-panel]`) opens, it *replaces* the cards in that same column. Closing it brings the cards back. There is never a fourth column. |
| 52.01–63.99rem (tablet) | Rail and centre. The right-column cards become a tab row under the workspace header: **Chat · To-dos · Lists · Files**. |
| ≤ 52rem (390 px phone; existing breakpoint, kept) | One column. Catch up is home. A workspace has a top bar (44 px back chevron "Workspaces", H1 name, capsule stack that opens the People & agents sheet, ⋯ menu) and a bottom `nav` of four links: **Chat, To-dos, Lists, Files**. These are links with `aria-current="page"`, not ARIA tabs, because they change the URL. The composer shows only on Chat, above the bar. |

**Left rail, top to bottom**

1. Wordmark.
2. **Catch up**. It shows a needs-you count badge only when that count was measured.
3. **Workspaces**, a permanent list that replaces the dropdown. Each row is a link with `aria-current`. Show up to 6, then "Show N more". New workspace sits at the bottom.
4. **People & agents** for the current workspace. **You** come first with your agents nested under you. Then everyone else alphabetically, each with their agents. Then "Other agents" for agents whose owner left. On Catch up this section narrows to "You and your agents" (own agents only).
5. The existing account footer.

People rows have no presence dot. The rail has no management controls. The line "Every agent belongs to a person, who connects it." stays.

- A **person row** opens People & agents with that person selected.
- An **agent row** opens the Agent view.

**Existing features the canvas leaves out (kept):**

- **Channels.** These move out of the rail and into a stream-header menu, "All messages ▾", which lists channels and "New channel". The `data-channel-list`, `data-channel-new` and `data-channel-place` hooks are kept.
- **Wiki** (`data-workspace-view="brain"`). Reach it from the workspace ⋯ menu and from a link at the foot of the right column.
- **Workspace settings and Admin access and history.** Both move to the workspace ⋯ menu.

### 1.2 Views

| View | What it is |
|---|---|
| Catch up | Cross-workspace home: Needs you, Your workspaces, Latest. |
| Workspace | Stream and composer, with right-column cards (To-dos, Lists, Files, What's shared here). |
| To-dos, Lists, Files, Wiki | Full-pane lists. Lists, Files and Wiki are the existing `objects`, `files` and `brain` panes. |
| To-do | One to-do: assignee, start choice, comments. |
| Agent | One agent in one workspace: status, what to do, Doing now, Up next, Not yet, facts. |
| People & agents | The redesigned dialog, reused. Section 3 lists what it adds. |
| Add agent | The existing `agent-choice` pane, reshaped. |
| New workspace | The existing `[data-panel=create]`, reshaped. |
| Join / Connect | `/invite` (`InviteOnramp`), reshaped. |

### 1.3 Address scheme (query parameters on `/app`)

| Route | Query | History |
|---|---|---|
| Catch up | `?v=catchup` | push |
| Workspace chat | `?w=W`, plus optional `&c=C` (channel) and `&m=S` (open the thread of message S) | push when `w` changes. `c` keeps today's `syncChannelUrl` `replaceState`, unchanged. |
| Workspace pane | `?w=W&v=todos\|lists\|files\|wiki\|add-agent` | push |
| To-do | `?w=W&todo=T` | push |
| Agent | `?w=W&agent=A` (agent UUID) | push |
| New workspace | `?v=new` | push |
| Dialogs | Not addressed. Escape and the in-dialog Back close them, as today. | none |
| Join | `/invite`, unchanged. The capability stays in the fragment and never goes in a query or a log. | unchanged |

**Rules**

- **Precedence:** `todo` > `agent` > `v`. An unknown `v` opens chat.
- **Boot with no parameters:** open Catch up if the viewer has two or more workspaces. Otherwise open the only workspace, with `replaceState` to its address. The existing first-run panels (no workspace, setup checklist) are unchanged.
- **The address bar is a convenience, never an authorization.** This extends the existing `?w=` rule:
  - a `w` that is not in your memberships falls back to the boot default;
  - a `todo` or `agent` id that does not exist in `w` shows an honest not-found pane: "Nothing with this link in Home." plus a link to Home. It never shows a different object.
- **Back:** a `popstate` listener calls `parseRoute` and renders without pushing. An in-app Back control (the "← Home · To-dos" link, the phone "Workspaces" chevron) calls `history.back()` when `history.state?.home` marks the previous entry as ours. Otherwise it pushes `parentRoute(route)`:
  - To-do → `v=todos`
  - Agent → chat
  - phone workspace → Catch up
- **After every navigation:**
  - focus moves to the view's H1 (`tabindex=-1`);
  - `document.title` becomes "<View> · <Workspace> · CommonSwarm";
  - the stream's scroll position is kept per workspace in memory.

---

## 2. Shared components

All of these are pure DOM builders: `(doc, vm, callbacks) => HTMLElement`.

- User text goes in through `textContent` only.
- Sample mode (`sample: true`) renders no actions.
- Every interactive target is at least 44×44 px.
- Status is never colour alone: it is always a shape and a word.

### 2.1 View models (`site/src/lib/home-types.ts`, frozen by lane P)

```ts
export type Id = string; export type Tint = 0 | 1 | 2 | 3;
export interface PersonVM { id: Id; name: string; firstName: string; initials: string; you: boolean;
  role: "owner" | "admin" | "member"; dashed?: boolean /* invited, not joined */ }
export type AgentStateKind = "working" | "idle" | "disconnected";
export interface AgentStateVM { kind: AgentStateKind; word: "Working" | "Idle" | "Disconnected" | "Not picking up";
  detail: string /* what was measured, with when */; attention: boolean;
  fix: { action: "resume" | "new-key" | "guide-chat" | "guide-local" | null; allowed: boolean; askWho: string | null; sentence: string } }
export interface AgentVM { id: Id; name: string; label: string /* section 2.3 */; nestedLabel: string; ownerId: Id | null;
  ownerFirstName: string | null; ownerInitial: string; yours: boolean; tint: Tint; hosted: boolean; state: AgentStateVM; dashed?: boolean }
export interface CapsuleVM { person: PersonVM; agents: AgentVM[] }
export interface RailVM { sample: boolean; catchUp: { href: string; current: boolean; needsYou: number | null };
  workspaces: { id: Id; name: string; href: string; current: boolean; needsYou: number | null }[];
  people: { title: string; groups: CapsuleVM[]; other: AgentVM[] } | null }
export interface ObjectCardVM { kind: "todo" | "list" | "doc" | "file"; id: Id; title: string; href: string; meta: string;
  who: PersonVM | AgentVM | null; done?: boolean }
export interface NeedsYouVM { id: Id; kind: "ask" | "agent-fix" | "todo" | "request"; workspace: { id: Id; name: string; href: string };
  from: PersonVM | AgentVM; what: string; when: string; primary: { label: string; href?: string; action?: string };
  secondary?: { label: string; href?: string; action?: string } }
export interface ChoiceVM<V extends string> { name: string; legend: string; value: V | null;
  options: { value: V; label: string; hint?: string; disabled?: boolean }[] }
export interface SwitchRowVM { id: Id; label: string; detail: string; state: "on" | "off" | "always" | "never"; busy?: boolean; disabled?: boolean }
export type Assignee = { kind: "person"; person: PersonVM } | { kind: "agent"; agent: AgentVM } | null;
export type Gate = { kind: "todo"; todo: { id: Id; title: string; href: string; done: boolean } } | { kind: "time"; at: string } | { kind: "note"; note: string };
export interface TodoVM { id: Id; workspaceId: Id; title: string; notes: string; state: "open" | "doing" | "done";
  addedBy: PersonVM | AgentVM; addedAt: string; due: string | null; assignee: Assignee;
  start: { mode: "queue" | "now" | "gated" | "at"; position: number | null; gate: Gate | null; at: string | null } | null;
  request: { status: "pending" | "declined"; ownerFirstName: string } | null;
  doneBy: PersonVM | AgentVM | null; doneAt: string | null; receipt: string | null; sample: boolean;
  may: { edit: boolean; assign: boolean; start: boolean; reorder: boolean; complete: boolean; comment: boolean };
  comments: { id: Id; author: PersonVM | AgentVM; at: string; body: string; tags: { id: Id; label: string }[] }[]; tagDelivers: boolean }
export interface QueueRowVM { todoId: Id; position: number; title: string; href: string; meta: string;
  may: { up: boolean; down: boolean; startNow: boolean; notYet: boolean; release: boolean } }
export interface PickOptionVM { value: Id; kind: "person" | "agent"; label: string; caption: string; group: Id; disabled: boolean }
```

### 2.2 Builders (lane P, `home-primitives.ts`)

`personAvatar(doc,p,size)` · `agentOrb(doc,a,{size,badge})` · `capsule(doc,c,{compact})` · `statusLine(doc,s,{form:"word"|"line"|"pill"})` · `objectCard(doc,o)` · `needsYouCard(doc,n,onAction)` · `choiceChips(doc,c,onChange)` · `switchRow(doc,s,onToggle)` · `queueRow(doc,q,onAction)` · `notice(doc,text,tone)`.

Helpers in `home-names.ts`: `agentLabel`, `firstNames`, `initials`, `agentTint(id)` (a stable hash, so an agent has one tint everywhere), `ordinal`, `formatWhen(iso, now, locale)`, `greeting(now)`.

Routing in `home-route.ts`: `parseRoute(search)`, `routeHref(route)`, `parentRoute(route)`.

### 2.3 Possessive naming rules (`agentLabel`, tested)

| Where the agent appears | Viewer's own agent | Someone else's agent |
|---|---|---|
| Alone: stream author, card, picker, needs-you, page title | **Your Claude** | **Nikki’s Muse** |
| Nested under or inside its owner (rail, capsule, dialog group) | Claude | Muse |

- The possessive is always "’s" with a typographic apostrophe (so "Marcus’s").
- The owner's first name is used. If two members share a first name, use their full display names.
- Never double up. If the agent's name already starts with "<First>’s", no prefix is added.
- **Owner gone:** "Claude (owner left)". **Removed:** "Claude (removed)", per D3.
- **Duplicate names:** keep the existing `identityDisplayLabel` UUID suffix, after the possessive.
- **People:** "Tom" plus a "you" tag in the rail. "Tom (you)" in pickers. "You and Nikki" or "Just you" in summaries.
- **Accessible name:** "Muse, Nikki’s agent, Idle".

### 2.4 Component behaviour

**Owner badge on an agent orb**

- The orb is a pastel orb, as in the people dialog. The tint comes from `agentTint`.
- The badge is a 16 px ink circle carrying the owner's initial, ringed in the surface colour (24 px on the 60 px orb).
- The badge shows only when the agent is shown alone. It is `aria-hidden`, because the name already carries ownership.
- **Dashed** marks something not yet real: a key not used yet, or an app chosen but not connected.

**Person and agents capsule**

- A pill holding the person avatar and up to 3 orbs, then "+N".
- The compact form is avatars only, with `role="img"` and `aria-label="Tom with Claude and dot"`.
- An interactive capsule is a single button (it opens People & agents) and is at least 44 px tall.

**Status line** (shape, word and measured detail, from `homeAgentState`; section 3.1 has the copy)

- **Working:** filled dot.
- **Idle:** hollow ring.
- **Disconnected:** diamond.
- Forms:
  - `word`, for the rail;
  - `line`, the word plus detail (cards, pickers);
  - `pill`, for the Agent header.
- The detail is always in the accessible name, and in `title` for the `word` form.
- An attention state adds a `notice` with the fix, never colour alone.

**Object card**

- An `<a>` link, 56 px minimum: kind icon (with a text alternative: "To-do", "List", "File"), title (clamped to two lines, full title in `title`), meta, and an optional assignee orb or avatar.
- A done to-do has its title struck through and also reads "Done".
- Used in the right column, the To-dos pane and the stream. In the stream it appears only for **file attachments** today, plus to-do references once the server lane puts an object reference on a signal.

**Needs-you card**

- `<article aria-labelledby>`: from-orb, a "Needs you · <Workspace> · <time>" eyebrow, one sentence, a primary action and an optional secondary.
- What can appear:
  - **Ask:** "Claude asked you: ‘…’", with Reply.
  - **Agent fix:** "Your dot is disconnected: key turned off.", with Get a new key, Resume, or What to do.
  - **To-do:** "Nikki assigned you ‘Call the plumber’.", with Open.
  - **Request:** "Nikki asked your Claude to do ‘Book dinner’.", with Accept and Decline. This appears only if the server lane ships requests.
- No canvas-style booking actions (section 4).

**Choice chips**

- A real `<fieldset>` with `<legend>` and native `<input type=radio>` inside each chip label (REDESIGN:332). Arrow keys work natively.
- `null` means nothing is preselected. The checked chip also shows a check mark, so state is never colour alone.

**Assign picker** (`home-pickers.ts`, lane T)

- A popover listbox of `PickOptionVM`, grouped by person with a capsule header: you and your agents first, then each person with their agents.
- Captions:
  - person: "Person · no line order";
  - own agent: "<word> · N in line";
  - another person's agent: "Goes to Nikki as a request" (only when the server's request flag is set);
  - disconnected agent: "Disconnected · nothing moves until it reconnects".
- Keyboard: a combobox with `aria-activedescendant`; Up and Down move, Enter selects, Escape closes and returns focus to the trigger.

**Tag picker**

- The same listbox shell, opened by "@". Rows show orb or avatar, the possessive label, and a caption: the status word for agents, the role for people.
- **In the composer:** a tag adds to the To: set (`mention-address.ts`). Every agent in the set gets the message (`composer-address.ts:17`). People are not notified that way. The limit is 8 recipients (`SIGNAL_RECIPIENT_MAX`).
- **In a thread reply or a to-do comment:** when `tagDelivers=false`, the tag is a highlighted name only, and the picker footer says so: "A tag here highlights the name. To ask them directly, write in chat."

**Queue row**

- An `<li>` with: position ("1"), a title link, meta ("Added by Nikki · due Fri"), then 44 px buttons:
  - Move up and Move down (aria-label "Move ‘Book plumber’ up");
  - Start now;
  - Not yet (or Release, for gated rows).
- After a move, focus follows the same button on the moved row, and a polite live region says "Moved ‘Book plumber’ to 1st."
- With no `may.*` flags, the row shows no buttons and makes no permission claim.

**Switch row**

- `button role="switch" aria-checked`, with label and detail. `always` and `never` render as text ("Always"), not as a switch.
- Used only where a real action backs it: Lists & docs for **your own** agent on the Agent view. On opens the existing approval flow. Off opens the existing Withdraw confirm. Plus the locked "What it posts here · Always" row.

---

## 3. Views and states

### 3.1 Status and receipt copy (pure functions with tests; nothing else renders status)

**`homeAgentState(input)`** goes in `agent-status.ts` as an extension of `peopleAgentStatus`, not a second mapping. Inputs are the people-status inputs, plus:

- `workingOn`: the newest **unexpired** working-on signal *from this agent*. Integration reads it with a dedicated query (`kind=working-on`, `until > now`), not from the 50-row feed window.
- `doingTodo`: a to-do the agent moved to Doing (once the server lane exists).
- `ownerFirstName`, for the receive sentence.

| Measured fact (highest first) | Shape | Word | Detail (exact) |
|---|---|---|---|
| Key turned off / key ended / paused / suspended / removed | diamond | Disconnected | "Key turned off" · "Key ended" · "Paused: unused for 14 days" · "Needs reconnecting" |
| A directed message unread for 3+ min (`wakePathMark`) | diamond | **Not picking up** | "A message has waited since 10:05 am" |
| To-do in Doing | dot | Working | "Doing ‘Book plumber’ since 9:40 am" |
| Unexpired working-on signal | dot | Working | "Said it’s working on ‘Budget sheet’ · 12 minutes ago". Always says when, because `until` defaults to 24 h. |
| None of the above | ring | Idle | The existing chip: "Active 2 hours ago" · "Not active yet" · "Not active for 5 days" · "No activity reported yet" (no presence row) |

**Why "Not picking up" is a separate word:** for a chat-app agent this fires whenever someone wrote to it and nobody has opened the app since, so the agent may well be connected. Shape and colour still put it in the disconnected class, as Tom asked.

**Receive sentence for chat-app agents:** "Checks messages when you chat with it." for your own, and "…when Nikki chats with it." for someone else's. This fixes the hard-coded "you" in `agentStatus`.

**Never on screen:** "online", "offline", "All N working".

**To-do receipts and status lines** (`home-todo-copy.ts`):

| State | Line |
|---|---|
| Agent, in line | "2nd in line for your Claude." Under it: "Claude picks up work from its line itself." |
| Start now | "Moved to the front for your Claude and sent it a message." Then the delivery record, from the existing receipts ("Sent", "Seen", "Delivered"), and the receive sentence. |
| Not yet, gated on a to-do | "On hold until ‘Get quotes’ is done. It stays out of Claude’s line until then, or until someone releases it." |
| Not yet, gated on a time | "On hold until Fri, Oct 9, 9:00 am." |
| Not yet, gated on a note | "On hold: waiting on the landlord’s reply." |
| At a set time | "Joins your Claude’s line at 9:00 pm today." Never "starts at". |
| Person | "Assigned to Nikki. People have no line order or start time." |
| Someone else's agent, request pending | "Sent to Nikki as a request. It joins Muse’s line if she accepts." |
| Request declined | "Nikki declined. Choose someone else." |
| Disconnected assignee | "1st in line for your dot. dot is disconnected (key turned off), so nothing moves until it reconnects." Followed by the fix, or "Ask Tom to reconnect it." |
| Done | "Done by your Claude · 10:40 am" (from `done_by`) |
| Save failed | "Not saved. Check your connection and try again." |
| Result unknown | "The result is unknown. Reload to check." |

### 3.2 Catch up

**Layout**

- H1 "Good morning, Tom." (by the local clock).
- A measured subline:
  - "2 things need you across 4 workspaces.";
  - "Nothing needs you right now." (only when every check succeeded);
  - "Checked 3 of 4 workspaces." when any check failed.
- Sections in order:
  1. **Needs you**: up to 3 cards, then "Show N more".
  2. **Your workspaces**: a grid, `repeat(auto-fill,minmax(15rem,1fr))`.
  3. **Latest**: up to 8 newest messages across workspaces. Each row: author label, workspace pill link, excerpt, time.

**Workspace card**

- Name, "You and Nikki" / "Just you" / "You, Nikki and 3 others", compact capsules.
- A counts line built only from reads that succeeded: "4 open to-dos · 3 lists · 3 files". A number that failed to load is left out, never shown as 0.
- "1 agent needs attention" when true.
- The whole card is a link to the workspace.

**Data**

- Reads fan out per workspace with at most 3 in flight. Only the first 8 workspaces get detail; the rest show their name and "Open".
- Cards render at once from `myWorkspaces()` and fill in as reads return.

**States**

| State | What shows |
|---|---|
| Loading | Each card shows "Checking Home…" with `aria-busy`. |
| A card failed | "Couldn't load Home. Open it to try again." |
| Long names | Two-line clamp; full name in `title` and the accessible name. |
| Sample | No actions. |
| Phone | This is home. The cards are the workspace list. |

### 3.3 Workspace

**Centre**

- Header: H1 (wraps, never truncated), the capsule subline "You with Claude and dot · Nikki with Muse" (two people, then "+N"), the existing `[data-roster-open]` button "People & agents", and the ⋯ menu.
- Stream header: "All messages ▾" (channels).
- Stream: day dividers ("Yesterday", "Today") and the existing threads.
  - The author line uses `agentLabel` and the orb with badge.
  - An open ask addressed to you renders as a needs-you card in place.
  - Attachments render as object cards.
- Composer: placeholder "Write to everyone, or type @ to tag a person or an agent".

**Right column, in order**

1. **To-dos**: open to-dos, up to 6. Each row has a checkbox (`may.complete`), title, and a status subline from section 3.1 ("Your Claude · 2nd in line"). Then "+ Add a to-do" and "All to-dos".
2. **Lists** and **Files**: up to 5 each, plus "All". If the Lists & docs read is refused, show the same single door the Lists pane shows today.
3. **What’s shared here**: "Everyone in Home sees what is posted here, including what agents post." Then, for your own agents only (the read is owner-scoped): "Your Claude can use Lists & docs here, until you withdraw it."
4. A "Wiki" link.

**States**

| State | What shows |
|---|---|
| Feed loading, error, empty | The existing `feed-pending`, `feed-error` and `feed-empty` panes. |
| Zero agents | The existing setup checklist. |
| To-dos read absent (server not shipped) | Every To-dos surface hides: card, tab and pane. Nothing is faked. |
| Many people (3 people, 14 agents) | The rail people list fills the leftover height and scrolls. Workspaces stay visible. |
| Disconnected agent | Diamond in the rail. On your own agent, a needs-you fix card at the top of the stream. |
| Sample | No composer actions and no doors. |

### 3.4 To-do

**Layout** (a single column, max 45rem)

1. Back link "← Home · To-dos" and the meta line "Added by Nikki yesterday · Due Fri, Oct 9".
2. A "Mark done" checkbox and the title.
3. Notes.
4. An "Assigned to" panel: the assign picker trigger showing the current label.
5. For an agent assignee, the start choices: chips **When it’s free · Now · Not yet · At a set time**.
   - **Not yet** reveals "Waiting on": another to-do (a combobox of open to-dos), a date and time, or a note.
   - **At a set time** reveals native date and time inputs.
6. The status line (section 3.1).
7. Comments, with a comment box and the tag picker.

**State coverage:**

- in line Nth;
- start now, with its receipt;
- each of the three gate kinds;
- at a set time;
- person assignee (no chips);
- someone else's agent, pending and declined (no chips until accepted);
- disconnected assignee (a warning notice with the fix);
- no assignee ("Not assigned yet");
- done;
- read-only (`may.*` false: controls hidden, no claim why);
- loading;
- not found;
- save error;
- a 200-character title that wraps.

### 3.5 Agent

**Header**

- 60 px orb with badge.
- H1 "Your Claude" or "Nikki’s Muse".
- The line "Tom’s agent (you)" or "Nikki’s agent".
- The status pill and detail.
- The receive sentence.

**Body**

- **What to do**, if attention is set: the fix from `peopleAgentStatus`, reused, never a fake reconnect button.
- Left column:
  1. **Doing now**;
  2. **Up next** (queue rows);
  3. **Not yet** (gated rows, each with its gate and Release);
  4. **At a set time**;
  5. **Done recently** (5).
- Right column (20rem):
  - **Facts**: model, how it gets messages, last active, and Lists & docs (own agents only, as a switch row);
  - **Recent activity** (the existing `agentActivityFrames`);
  - "Manage in People & agents", which opens the dialog with this agent selected.
- Footer note: "This page shows Claude in Home."

**States**

| State | What shows |
|---|---|
| Own, working | Full controls per `may`. |
| Own, disconnected | A warning banner: "Disconnected: key turned off. Nothing in its line moves until it reconnects." plus "Get a new key". The line is still listed. |
| Someone else's agent | Read-only: no move, start or hold controls unless the server's `may` allows them, and no claim about who can. |
| Empty | "Nothing in Claude’s line. Assign it a to-do from any to-do page." |
| Not found | The not-found pane from section 1.3. |
| Hosted agent with no presence row | Idle, "No activity reported yet". |

### 3.6 People & agents: additions to the existing dialog

**Role change** (the existing `change_role` command)

- Where: the person detail gets a **Role** fact with a `<select>` (Owner / Admin / Member) and Save.
- Shown to the owner for anyone. Shown to an admin for non-owners, without the Owner option.
- Changing your own role asks to confirm first: "Make yourself a member? You will no longer manage people here."
- Receipt: "Nikki is now an admin."

| Server code | Copy |
|---|---|
| `last_owner` | "Home needs at least one owner. Make someone else an owner first." |
| `role_forbidden` | "Only an owner can change an owner’s role." |
| `member_not_found` | "Nikki is no longer a member. Reload to check." |
| `bad_state` | "Nikki already has that role." |
| `landing_authority_unresolved` | "Nikki approves code changes in this workspace. Hand that to someone else first." |

**Other additions**

- Entry points: the rail person row opens the dialog at that person, and Agent "Manage" opens it at that agent.
- Orb tint comes from `agentTint`, so an agent has the same tint in the dialog as everywhere else.
- Everything else is unchanged: Resume, keys, Lists & docs, remove, Invited, confirms.

### 3.7 Add agent

**Layout**

- Back link "← Home".
- H1 "Add one of your agents to Home".
- Line: "It joins as yours. People in Home see it as Tom’s <name>."
- Three steps:
  1. **Which app?** Chips from `AGENT_HOSTS`: the `joiner:"primary"` hosts, then "More apps".
  2. **Connect it.** The existing host steps, connector address, `joinSentence` and Copy.
     - While waiting: "Waiting for an agent from Claude to join Home. Checking every 5 seconds." (the measured `startHostJoinWatch` interval).
     - When joined: "Claude joined Home at 11:32 am.", taken from the `myAgents` poll. There is **no** claim that it receives messages automatically (SESSION-IDENTITY:96-98).
  3. **What it can use in Home.** The existing Lists & docs approval.
- Done opens that agent's Agent view.

### 3.8 New workspace

**Form card**

- Name.
- "Who is it for?": two radio cards from `PURPOSE_COPY` (shared, or just me).
- "Who's in it?": "You (Tom)", plus the note "After you create it, you get an invite link to send yourself, by text or email."
- "Agents": "Add agents after you create it, from the apps you use."

**Live preview panel** ("Who’ll be in <name>")

- Your avatar.
- A dashed "People you invite" slot (hidden for "just me").
- A dashed orb labelled "Agents you add".

**Create** goes to the workspace chat, which shows an "Invite someone" card on first open (the existing invite dialog). Errors use the existing create errors.

### 3.9 Join / Connect (`/invite`)

**Review**

- H1 "Tom invited you to Home."
- **Who is here**: people from the preview audience, with name and role.
- What you will see.
- "What stays private: your other workspaces."
- **Your access**: Editor or Reader, nothing preselected (D5).
- **Which assistant will you bring?**: a radio list from `AGENT_HOSTS` plus "Just me for now", nothing preselected. This choice only presets step 2.
- "I'm joining as myself."
- CTA "Join Home".

**Connect**

- "Step 2 of 2". A capsule of you with a dashed orb for the chosen app. H1 "Connect Muse."
- The host's three steps, "Open Muse" (if the host has an address), and "Copy the connect prompt instead".
- Footnote: "Only you can connect it: it signs in with your account. Its messages show its own name, with yours beside it. Everyone in Home sees what it posts here. Owners and admins can remove any agent from Home."

---

## 4. Not built, and what is built honestly instead

| Canvas element | Why not |
|---|---|
| Per-agent sharing switches (Phone-Sharing) | SECURITY.md: every member reads everything; there is no per-record permission. |
| Guest role | Roles are owner, admin and member only. A tool-limited role needs per-record permission. |
| Text-message invites, Resend | Nothing sends invites. Cancel and make a new link. |
| "Work around the clock" | It would start models. |
| "Only you see the whole queue", "can’t see or change what it shares" | Visibility claims the read path does not back. |
| Seats on screen, "takes the seat", a second seat per chat | Identity rules: a reconnect is a new identity, and the chats on one connection share it. |
| Pairing code, naming the agent up front | The agent names itself. No code exists. |
| Unread dots, "Since you last looked" | No per-viewer last-seen read (`signals_seen` is write-only). |
| "Book Thursday"-style card actions | No approval primitive. Replies only. |
| Per-person switches, space-wide agent rules, Mute here | No server support. |
| "Which of your agents come along" at creation | Agents connect per workspace, from their own app. |
| Home / Trip / Project presets | The server knows shared or just me. |
| "Shared: free or busy" chips, "Asks before it pays" | No calendar, and no enforcement to promise. |
| Tags that reach people in threads and comments | Thread replies carry no recipient. Highlight only, unless the server lane adds recipients. |
| Disconnect / Reconnect buttons | No such command. The fix guidance is shown instead. |
| Presence dots on people | Presence is shown only where data exists, and people have none. |
| "Posts under its own name, never as you" | SECURITY.md: agent content is the user's content. Rewritten as in 3.9. |

**Built honestly instead:**

- the "What’s shared here" line;
- per-agent Lists & docs on your own agents;
- "Copy invite link · One person can use it · Expires in 7 days";
- the fix guidance;
- role change;
- "Latest" in place of unread;
- delivery receipts on Start now;
- "Not picking up" kept separate from "Disconnected".

---

## 5. Visual direction (site tokens only; no raw hex; no `var(--d-*)`; no local colour variables)

- **Type:** headings use `--font-display` (Plus Jakarta Sans), `--weight-display`, `--track-head`. Body uses `--font-sans` (DM Sans). Sizes: Catch up H1 `--t-3xl`, workspace H1 `--t-2xl`, card titles `--t-lg`, rail `--t-sm`.
- **Shape and space:** cards are `--surface` with `--border`, `--shadow-card` and `--radius-lg`. Rows and inputs use `--radius`. Chips and capsules use `--radius-pill`. Spacing: `--s-*`, `--pad-card`, `--gap-grid`. The page is `--bg` (the ivory canvas).

**Ink rail**

| Item | Light | Dark |
|---|---|---|
| Rail | `background: var(--ink); color: var(--canvas)` | `--ink` flips to light text in dark, so override in **both** dark blocks (`@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) …}` and `[data-theme="dark"] …`, the pattern at LiveDashboard L15581–15583): `background: var(--elev-1); color: var(--text); border-inline-end: 1px solid var(--border)` |
| Muted text | `color-mix(in srgb, var(--canvas) 72%, var(--ink))` | `var(--text-muted)` |
| Active row | `background: var(--canvas); color: var(--ink)` (the canvas's filled active item) | `background: var(--elev-3); box-shadow: inset 3px 0 0 var(--accent)` |
| Person avatar in the rail | `background: var(--canvas); color: var(--ink)` | the default `.pd-initials` |

**Status and attention**

| Meaning | Tokens |
|---|---|
| Working | Opaque `--chip-active-bg` / `--chip-active-ink`, with a filled dot. Works on ink and on light surfaces. |
| Disconnected and Not picking up | `--chip-review-bg` / `--chip-review-ink` (warm amber), with a diamond. Agent-page banners use `--warning-dim` and `--warning`. |
| Idle | No fill. A ring in `currentColor` and muted text. |
| Needs you (the canvas's lime) | The action colour: `--accent-dim` fill, 1px `--accent` border, `--accent-bright` heading. The primary button is `--accent` with `--accent-ink`. The Catch up badge is `--accent` with `--accent-ink`. |
| Dashed (not yet real) | `1.5px dashed var(--border-interactive)` |
| Danger | `--danger`, plus the existing `.pd-danger-*` |
| Agent orbs | `--lavender`, `--peach`, `--sage`, `--sky` (the `.pd-orb` gradient). Owner badge: `--text` on `--canvas`, ringed in `--surface` (or the rail colour inside the rail). |

The translucent `-dim` tokens are never placed over ink.

**Contrast:** every pair is measured in the build by the method in tokens.css L33–50, composited over its real backdrop, in both themes, and recorded in the CSS comments. Nothing ships on an estimate.

**Motion:** colour transitions only (`--dur-2`, `--ease-standard`), and none under `prefers-reduced-motion`. Focus uses `--focus-ring` on `:focus-visible` only.

---

## 6. File plan and lanes

**Test gate:** `scripts.test` globs `src/lib/*.test.mjs`, and `matchesGlob` does not cross `/`. A `src/lib/home/` folder would fail `test-gate-coverage`. So all new modules use **flat names** (`site/src/lib/home-<name>.ts` with a sibling `home-<name>.test.mjs`), and nobody edits `package.json`.

**What tests can cover:**

- Node tests have no DOM library (devDependencies are sharp, tsx, typescript), so `*.test.mjs` covers pure functions only: view-model derivation, copy, gates, routing.
- DOM and geometry are proven the `agent-row-geometry.observer.test.ts` way: esbuild-bundle the builder with `tokens.css` and the lane's CSS into a fixture page, run as a CI-only `browserTest`. Each lane adds `src/components/app/home-<lane>-geometry.observer.test.ts` and uses P's `home-fixture.ts`. It checks 44 px targets, no overflow at 320 and 390, and hostile text rendering as text.

**CSS:**

- New files live in `site/src/styles/home/`. Lane P creates `index.css`, which `@import`s every lane file, and empty stub files for each lane, so no lane edits a shared file.
- Integration adds one line to the LiveDashboard front matter: `import "../../styles/home/index.css";`.
- The onboarding lane keeps its styles in the Astro components it owns. It adds no hex and may remove the 7 that exist in AgentHostPicker.

**Shared-file rules**

- Only the integration lane edits `LiveDashboard.astro`, `app.astro`, `commonswarm.ts` and existing observer tests.
- A lane that has to change a string or hook that an existing observer pins writes the pin into its handoff. Integration re-points the test to the same rule. Nothing is deleted or weakened.
- View lanes may start at once against the API frozen here (2.1, 2.2). They merge after P.

| Lane | Goal | Files owned | Tests | Acceptance | Size |
|---|---|---|---|---|---|
| **P · Primitives** (first) | Types, names, route, builders, status | `home-types.ts`, `home-names.ts`(+test), `home-route.ts`(+test), `home-primitives.ts`(+test for pure helpers), **edit** `agent-status.ts` (+`homeAgentState`, receive copy that knows the owner's name) and `agent-status.test.mjs`, `styles/home/index.css`, `primitives.css`, every lane's stub CSS, `components/app/home-fixture.ts`, `home-tokens.observer.test.ts` (no hex, no `--d-*`, no local colour variables, every `var(--x)` declared in tokens.css), `home-words.observer.test.ts` (string literals in `src/lib/home-*.ts` contain no online, offline, seat, grant, turn, wake, token, OAuth, principal), primitives geometry test | Naming table (2.3); status precedence (3.1, every row); route round-trip and precedence; ordinals; tint stability | Existing `agent-status` cases unchanged | M |
| **R · Shell and rail** | Rail, headers, phone and tablet nav | `home-rail.ts`(+test), `home-shell.ts` (workspace header, phone top bar, bottom nav, tablet tab row)(+test), **edit** `participant-rail.ts` (optional `{viewerId}` puts the viewer first; default stays alphabetical, so `owner-grouped-rail` stays green), `shell.css`, `rail.css`, geometry test | Viewer first; Other agents last; no presence dot; workspaces cap of 6; needs-you badge only when measured | Bounded list scrolls in leftover height; 50-agent fixture | M |
| **C · Catch up** | The home view | `home-catchup.ts`(+test), `catchup.css`, geometry test | Subline arithmetic incl. partial failure; card counts leave out unknowns; greeting | States in 3.2 | M |
| **W · Workspace pieces** | Cards and stream decorations | `home-side-cards.ts`(+test), `home-stream.ts` (author label, day dividers, ask to needs-you, attachment to object card)(+test), `workspace.css`, geometry test | The "What’s shared" lines; to-dos hidden when the read is absent | 3.3 | M |
| **T · To-dos** | To-do view, To-dos pane, pickers | `home-todo.ts`, `home-todo-list.ts`, `home-todo-copy.ts`(+test), `home-pickers.ts`(+test), `todo.css`, `pickers.css`, geometry test | Every row of the 3.1 receipt table; chips hidden for people and for pending requests; gate editors; picker keyboard model (pure state reducer) | 3.4 | L |
| **A · Agent** | Agent view | `home-agent.ts`, `home-agent-copy.ts`(+test), `agent.css`, geometry test | Sections empty or full; read-only when `may` is false; disconnected banner | 3.5 | M |
| **D · People additions** | Role change, entry points, tint | **edit** `people-dialog-view.ts` and `people-dialog-view.test.mjs`, `people.css` | Role-select gates (owner, admin, self); all 5 error strings | Keeps every string pinned by `household-redesign`, `header-roster` and `identity-names` | S |
| **O · Onboarding** | Add agent, New workspace, Join/Connect | **edit** `AgentHostPicker.astro`, `InviteOnramp.astro`, `agent-hosts.ts` (copy only) and `agent-hosts.test.mjs`, `member-invite.observer.test.ts` (it reads only InviteOnramp); new `home-new-workspace.ts`(+test), `onboarding.css` | Nothing preselected; footnote copy; waiting and joined lines | `joiner-copy` pins are kept, or listed for integration | M |
| **I · Integration** (last) | Wiring and mapping | `LiveDashboard.astro`, `app.astro`, `commonswarm.ts` (`changeWorkspaceRole`, `activeWorkingOn`, the per-workspace Catch up fan-out, to-do reads and commands from the server lane), new `home-map.ts` (server rows to view models)(+test), `participant-rail.fixture.ts`, every existing observer re-point; `pushState` and `popstate`; mount points; composer tag rows use `tagOptionRow` from `home-pickers.ts` and keep the existing listbox hooks | `home-map` cases: hosted agent with no key row; orphan agent; duplicate names; failed reads become null, never 0 | `npm test` and the CI site job green; screenshot set (section 7) | L |
| **H · Harness** (outside the repo; parallel) | Mock worlds and states | `people-dialog/harness/app/mocks.mjs` (copied into `home-ui/harness/`), `states-home.mjs` | n/a | Every state in section 7 renders with no unmocked call | M |

**Existing observers to re-point (integration only, same rule each time)**

- `slack-shape`:
  - rail inventory;
  - bounded list (moved to the new list, which keeps `data-sidebar-participant-list`);
  - the `renderSidebarParticipants(...)` call;
  - "one workspace control" becomes "one workspace list";
  - privacy reset;
  - presence dot is **inverted** (assert it is absent);
  - model glyph moves to the dialog and Agent view.
- `owner-grouped-rail`: add viewer-first.
- `workspace-switcher`: 7 dropdown tests become list tests.
- `chat-channels`: channel menu.
- `header-roster`.
- `mobile-feed-layout`: Chat replaces Messages, and To-dos is added.
- `entity-panel`: shared third column.
- `composer-to-field`.
- `household-redesign`.
- `brain-view`.
- `feed-composer-clearance`.
- `workspace-entry`.
- `update-notice`.
- `transcript-shape`.
- `joiner-copy`.

**Server contract the UI expects (the server lane owns it; not built here).**

- Read `todos(workspace)` returning: `todo_id, title, notes, state (open|doing|done), created_by, created_at, due_at, assignee {kind, id}, start {mode, position, gate {kind, todo_id|at|note}, at}, request {status, owner_user_id}, done_by, done_at, may {...}`.
- Commands: `create_todo`, `edit_todo`, `assign_todo`, `set_todo_start`, `move_todo`, `release_todo`, `complete_todo`, `reopen_todo`, `comment_todo {body, to[]}`, `answer_todo_request`.
- "Start now" also sends an ask to the agent, so the delivery record supplies the receipt.
- Gates clear when the server reads them. **Nothing starts a model.**
- If the read is unknown, the To-dos UI hides.

---

## 7. Screenshot acceptance

**How:** the people-dialog harness, using headless Playwright bundled Chromium (never installed Chrome), against `astro dev` with the mocked backend and `FIXED_NOW`. Every state is shot at **1440×900 and 390×844, light and dark**. Each run fails on horizontal overflow, console errors or unmocked calls.

| ID | State |
|---|---|
| H1 | Catch up: 3 workspaces, 1 ask to Tom, 1 own agent with key turned off |
| H2 | Catch up: nothing needs you, and 1 workspace failed to load |
| H3 | Workspace: nested rail (Tom first), right column with done, working, 2nd in line, person and gated to-dos, an ask card in the stream, a file card, an open thread |
| H4 | Workspace: 3 people and 14 agents, long names, rail scrolled |
| H5 | Workspace: feed error |
| H6 | Phone: workspace Chat, To-dos tab and Lists tab (390 only) |
| T1–T9 | To-do: 3rd in line · Start now receipt · gated on a to-do · at a set time · person assignee · request pending (Muse) · disconnected assignee · assign picker open · tag picker open in a comment |
| A1–A4 | Agent: own and working with a line of 3 and 1 not yet · own and disconnected · Nikki's Muse read-only · not found |
| P1–P2 | People & agents: role select (owner viewer) · `last_owner` error |
| N1–N3 | Add agent waiting · Add agent joined · New workspace |
| J1–J2 | `/invite` review with assistant choice · Connect step 2 |

**What the mock must add:**

- **Worlds:** at least 3 workspaces (Home, Summer trip, My paperwork), each with `member_profiles`, `agent_principals` (local and hosted), `agent_presence`, `agent_wake_path` and signals.
- **Signals:** working-on rows with `until` (one 20 hours old and unexpired, one expired), and asks addressed to the viewer.
- **Key rows:** for local agents only. Hosted agents get none.
- **Role change:** a `change_role` handler that can return each of the 5 reasons.
- **To-dos:** the to-do read and commands, mirroring whatever names the server lane ships.
- **Lists and files:** household object lists and files per workspace.
- **Invitations:** a preview with `audience`.
- **Joining:** a `myAgents` poll that returns the new agent from the 3rd call onward.
- **Faults:** `behavior.fail` for one workspace's feed (used by H2).

### Critical files for implementation
- /Users/yulanbot/work/wt/home-ui/site/src/components/app/LiveDashboard.astro
- /Users/yulanbot/work/wt/home-ui/site/src/lib/agent-status.ts
- /Users/yulanbot/work/wt/home-ui/site/src/lib/participant-rail.ts
- /Users/yulanbot/work/wt/home-ui/site/src/lib/people-dialog-view.ts
- /Users/yulanbot/work/wt/home-ui/site/src/styles/tokens.css