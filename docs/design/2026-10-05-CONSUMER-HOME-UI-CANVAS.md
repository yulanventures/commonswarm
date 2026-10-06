# Consumer home UI: canvas handoff

2026-10-05. Operator direction captured from a design session. Documentation only. Not a spec
and not a /goal. A lead should reconcile it with the documents named below and cut goals from it.

Source inspected for the comparison: `a5cb825` (`main`, shallow clone). **Measured** below means
source reading at that commit. No tests ran and no service was contacted. I did not read
`docs/design/SWARM-CLOUD.md`, which stays canonical; anything here that disagrees with it loses.
The canvas was never rendered by its author, so spacing and overflow in it are unchecked.

## What is being handed over

- The canvas "CommonSwarm Home" (11 artboards). It is private to the operator on claude.ai, so an
  agent on another account cannot open the link. Ask the operator for an exported PDF or PNG if you
  need to see it rendered.
- The artboard sources, in `docs/design/2026-10-05-consumer-home-ui/` beside this file. They are
  HTML with inline styles and literal copy. They load a canvas runtime (`./support.js`) that is not
  in this repository, so they do not render on their own. Read them as markup.

## Operator direction from the session

Quoted from the operator, typos corrected, in the order given:

1. "A shared home for people and their personal AI agents. You bring the assistants you already
   use ... into a common space." Couples, families and small teams share spaces. "Personal
   information stays private unless shared." "Joining should feel simple."
2. "The UI needs to be more of a hybrid of Basecamp and Slack. Like if the Slack UI had a baby with
   the Basecamp UI."
3. "The agents have owners, so it's important to know whose agent is whose."
4. On the rail: "there's a 'Your Agents' section, then there are people and their agents. Seems
   like you should be one of the people, right?" And: "for your own agents, you can see working or
   idle, why shouldn't you see other people's agent statuses?"
5. "You should be able to tag an agent in a comment or in a chat thread, or in any of the other
   items, like a to-do or a list. I also think to-dos should be assignable." "Agents can do things
   24/7. They also have a queue. ... you might assign something to an agent, but it might not be
   working on it yet. You may want to make it work on it, or you might want to assign it, but maybe
   you don't want it to work on it yet."
6. "You should also design the agent and people management interface ... invite people, control
   their permissions to things, and remove people. ... Agents have special needs, like they can get
   disconnected. How do you add an agent?"
7. On identity: "More likely, it's just a seat that I can add a Claude session to operate under."

Items 5 to 7 were framed as things to think through, not as settled requirements.

## How to read the canvas

The shape is the direction. The details are illustrative.

Direction:

- A left rail, a message stream with a composer in the middle, and the durable objects (tasks,
  lists, files) in a right rail of cards. An object created in the stream also appears as a card
  inside the stream.
- Ownership is visible everywhere an agent appears: possessive naming ("your Claude",
  "<person>'s Muse"), an owner badge on a lone agent avatar, and a shared capsule where a person
  and their agents appear together.
- The viewer is listed as a person, first, with their own agents under them.
- An agent that has lost its connection is shown as such, with what is waiting for it and one
  action to reconnect.
- Assigning to an agent is distinct from the agent starting.
- A person connects their own agents. Nobody connects an agent on someone else's behalf.

Illustrative only:

- The palette, the two Google fonts, radii and spacing. `site/` has frozen tokens and self-hosted
  fonts (`site/src/styles/tokens.css`, `site/AGENTS.md`). Use those.
- All sample people, tasks, times and counts. The pairing code. Every line of copy.
- The words "space", "to-do", "seat", "queue", "catch up", "guest". See conflict 1.

## Artboards

| File | Shows |
|---|---|
| `Main.dc.html` | Cross-workspace overview: one item waiting on the viewer, workspace cards, recent activity. |
| `Space.dc.html` | One shared workspace: stream with a threaded agent-to-agent handoff, composer, right rail of tasks, lists, files. |
| `New-Space.dc.html` | Create a workspace: name, people, which of the viewer's agents join. |
| `Members.dc.html` | People and agents in one workspace: roles, per-person switches, remove, pending invite, a disconnected agent, workspace-wide agent rules. |
| `Add-Agent.dc.html` | Add one of the viewer's own agents: pick the assistant, name it, connect, set what it may do. |
| `Agent.dc.html` | One agent: what it is doing, what is waiting, where it is connected, who may give it work. Has a disconnected state. |
| `Todo.dc.html` | One task: assign to a person or an agent, start choices for an agent, comments with a tag picker. |
| `Phone-Join.dc.html` | An invitee accepts and picks an assistant to bring. |
| `Phone-Connect.dc.html` | The invitee connects that assistant themselves. |
| `Phone-Space.dc.html` | The shared workspace on a phone. |
| `Phone-Sharing.dc.html` | Per-agent, per-workspace sharing switches. |

## Where the canvas conflicts with checked-in direction

Each of these is a place where building the canvas literally would break a rule or reverse a
decision already written down here. Reconcile; do not build around them.

1. **Vocabulary.** `docs/design/2026-09-11-PRODUCT-SHAPE-AND-VOCABULARY.md` (operator-set) keeps
   "workspace", makes "seat" internal, and names five nouns with one screen each: Messages, Files,
   Wiki, Tasks, Calendar. The canvas says "space", "to-do", shows "Seats" to the user, and has no
   Wiki or Calendar. The same document rules out a permissions matrix and settings pages in v1;
   `Members.dc.html` draws both.
2. **Tasks.** `docs/design/2026-10-01-TASKS-AND-CALENDAR.md` (proposal) has Open, Doing, Done,
   Dropped. Assignment alone leaves a task Open, and assignment to someone else is an offer until
   accepted. The canvas's "Not yet" maps to Open with an owner. "At a set time" maps to a calendar
   event with the agent on it. "Now", "Hold", queue position and reordering have no counterpart:
   there is no ordered queue object, and the root `AGENTS.md` asks for coordination language, not
   control.
3. **Agent identity and sessions.** `docs/design/2026-09-06-AGENT-SESSION-IDENTITY.md`
   (adjudicated) allows one execution session per workspace and principal, and an active session
   cannot be displaced by a competing acquire. The canvas says the next session to connect "takes"
   the seat. `docs/design/2026-10-03-HOUSEHOLD-HUB-V1.md` section 3 says a reconnect claims a seat
   again with a new grant-bound handle and must not adopt old access by name.
4. **Second seat for a second chat.** `docs/design/2026-10-01-HOUSEHOLD-PRIVACY-BOUNDARIES.md`
   notes that all chats on one connector account share its grant and can select its seats, so
   separate seat names do not isolate them. `Agent.dc.html` implies they do.
5. **Status claims.** The canvas shows "working", "idle" and "offline" for every agent, including
   other people's. Hub v1 section 3 says hosted seats are turn-only today. The root `AGENTS.md`
   ties status wording to measured delivery state, and
   `docs/design/contracts/UI-PARTICIPANTS-REDESIGN-GOAL.md` already removed presence dots that
   asserted something untracked.
6. **Around the clock.** `Agent.dc.html` has a switch that starts a background session hourly. The
   root `AGENTS.md` forbids a path that starts models. The sanctioned route to timed work is the
   calendar wake, and the vocabulary document expects it to say plainly when a host is not running.
7. **Sharing switches.** `Phone-Sharing.dc.html` and several lines of copy imply field-level grants
   from private data (free or busy, email, files). `SECURITY.md` states that every member of a
   workspace can read everything in it, with no private area and no per-record permission. The
   privacy document proposes separate workspaces and an explicit, previewed snapshot into a
   destination workspace, and says selected record grants do not exist.
8. **Visibility claims.** The canvas states who can and cannot see things inside one workspace
   ("only you see the whole queue", "can't see or change what it shares"). `SECURITY.md` says the
   only exception to full visibility is a signal addressed to one person.
   `docs/design/contracts/UI-SLACK-SHAPE-GOAL.md` also prohibits rendering visibility claims the
   read path does not back. None of this copy is safe as drawn.
9. **Rail nesting.** The canvas nests agents under their owner. The operator revision inside
   `UI-PARTICIPANTS-REDESIGN-GOAL.md` (2026-08-04) flattened the rail: "the nesting was the wrong
   idea." Today's direction is newer and from the same operator, but it was given without that
   history in view. Also unresolved against the canvas: the bounded rail and the header roster
   dialog from `UI-RAIL-GROUP-BY-OWNER-GOAL.md`.
10. **Invites.** The canvas says an invite goes out by text message. Hub v1 section 2 measures a
    private invite link that the inviter copies and delivers; nothing sends it.
11. **Roles.** The canvas adds a Guest role limited to chosen tools. `src/protocol/workspace-commands.ts`
    names owner, admin and member only, and a tool-limited role would need the per-record
    permission that `SECURITY.md` says does not exist.

## Decisions for the operator

- Nested rail (today) or flat rail with an owner indicator (2026-08-04)?
- Does "space" replace "workspace" for consumers, and "to-do" replace "task"? Or does the canvas
  adopt the 2026-09-11 nouns?
- Is an ordered, user-visible queue wanted, or do Open and Doing plus the calendar cover it?
- Should other people's agent status be shown at all while hosted seats are turn-only?
- Do per-agent sharing switches survive, given the separate-workspace privacy model?

## Suggested order, smallest first

Site-only slices that need no decision: owner badge and possessive naming wherever a lone agent is
rendered; the disconnected-agent row with a reconnect action; the task card inside the stream.
Everything touching the rail waits on the first decision above. Queue controls, the around-the-clock
switch, sharing switches, the Guest role and text invites should not be built from this canvas.

## Not established

Whether any of the above has moved since `a5cb825`. What `SWARM-CLOUD.md` says on each point.
Whether `site/` already implements parts of this; only file names were checked
(`HouseholdObjects.astro`, `AgentConnect.astro`, `InviteOnramp.astro`, and the member-admin,
agent-presence and chat-thread observers exist). `2026-08-04-COMPOSER-AND-MENTIONS.md` was read by
heading only, so tagging is not compared here.
