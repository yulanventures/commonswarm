# Consumer home UI: decisions (CSwarm Lead, 2026-10-05 ~21:30Z)

Source: Tom, in the CSwarm Lead chat, ~20:45Z: "Please execute this UI update, it is quite large and comprehensive, try to
parallelize the work as much as possible". Board item ~/work/issues/20261005-18-consumer-home-ui.md.
Handoff: ./handoff/2026-10-05-CONSUMER-HOME-UI-CANVAS.md and ./handoff/2026-10-05-consumer-home-ui/*.dc.html (11 artboards).

## Tom's answers to the handoff's operator decisions (2026-10-05 ~21:25Z)
1. Rail: NESTED. The viewer first ("you"), with their agents under them; then each person with their agents under them.
   (Supersedes the 2026-08-04 flat-rail revision in docs/design/contracts/UI-PARTICIPANTS-REDESIGN-GOAL.md.)
2. Words: keep "workspace"; the new task object is a "to-do" (to-dos). "Seat" stays internal (never on screen).
3. Agent work: BOTH. Tom: "I think both should be an option right, like some tasks might need to be gated on something
   else, others maybe need to be worked asap in a queue or something." So:
   - an ORDERED, user-visible queue per agent (to-dos assigned to it, in order; move up/down; "Start now" = to the front
     and the agent is asked);
   - GATED to-dos: "Not yet" / waiting on something else (another to-do, a date/time, or a plain note), not in the
     active queue until the gate clears or a person releases it;
   - "At a set time": the to-do enters the queue at that time.
   Coordination language, not control: the queue is the agent's ordered list of what it was asked to do; the agent
   reads it and picks up work itself. CommonSwarm never starts a model.
4. Status of other people's agents: Tom: "if we CAN, do the working/idle for all". So show working / idle / disconnected
   for EVERY agent, but only from server-measured facts. Candidate measure: an unexpired `working-on` signal from that
   agent (it has `--until`), and/or a to-do of its in Doing with recent activity; disconnected from the existing
   agent-status.ts facts (key off, key ended, paused, not picking up messages). Wording must say what is measured.

## Lead defaults (stated to Tom, not objected to)
- Base: branch lane/home-ui from lane/people-dialog 6b72cd6d (newest unmerged /app: household lanes, app-redesign,
  redesign-followups, People & agents dialog). Branch work only. No merge, no release until after C1 and that stack.
- NOT built (conflict with SECURITY.md or a hard rule): per-agent sharing switches (Phone-Sharing), the Guest role,
  text-message invites, the "work around the clock" switch (a path that starts models), field-level visibility claims
  ("only you see the whole queue", "can't see what it shares") unless the read path backs them.
- To-dos need new server objects and a migration (none exists; HOUSEHOLD_OBJECT_TYPES = list, doc, file). Built on the
  branch; schema release is a production step after C1.
- Visual system: the canvas palette and fonts are illustrative. Use site/src/styles/tokens.css and the self-hosted
  fonts (site/AGENTS.md). Keep the canvas SHAPE: left rail, stream + composer in the middle, right rail of cards,
  ownership visible everywhere (possessive names, owner badge on a lone agent avatar, person+agents capsule).
- Tooling: `alloy execute` is blocked on the mini (repo cap, disk < 15 GiB, no eligible maker profile; board item
  20261005-15). Fallback approved by HezLead on 2026-10-05: Makers via ~/bin/codex-worker rw (Codex GPT-6.1 Sol) and
  Claude subagents (allowed the week of 10-03); checkers read-only via `alloy panel --mode review` from another family;
  CI decides. No two lanes edit the same files.

## Lead rulings that reconcile UI-SPEC.md and SERVER-PLAN.md (2026-10-05 ~22:30Z; binding for every lane)
R1. Agent status class follows SERVER-PLAN A10: working = not disconnected AND (a to-do in Doing OR an unexpired
    working-on signal) AND a server-recorded action within the last 30 minutes (WORK_RECENT_MS); disconnected =
    credential facts only (removed, key off, key ended, paused, needs reconnecting); idle = everything else.
    "Not picking up" (diamond) appears ONLY where peopleAgentStatus already flags stale messages for an agent that
    has a wake path (local agents). A chat-app (hosted, turn-only) agent with waiting messages is IDLE, detail
    "Messages waiting since 10:05 am" plus its receive sentence. When the server's AgentWorkStatus is present the UI
    uses its `work`; until then the UI applies the same rule to the facts it has. An old working-on claim with no
    recent action reads "Last active 3 hours ago; ‘X’ is still in Doing" (or the idle chip), never "Working".
R2. Consumer to-dos are a new household sibling object (SERVER-PLAN A1). This supersedes TASKS-AND-CALENDAR:46-49
    ("no consumer-task table") for consumer to-dos only; governed repository tasks are unchanged. Lead decision under
    Tom's 10-05 direction; recorded for HezLead and the SWARM-CLOUD amendment.
R3. "Who can give it work" (accepts_from) defaults to "owner": work from anyone else is a request the owner answers.
R4. "At a set time" sends no ping and starts nothing: "Joins Claude’s line at 9:00 pm. Claude sees it the next time
    it checks." Never "starts at".
R5. To-do states are open, doing, done, dropped. Dropped to-dos leave every open list; "All to-dos" shows them with
    the word "Dropped". (home-types.ts TodoVM.state includes "dropped".)
R6. Assigning to ANOTHER PERSON is a request that person answers (SERVER-PLAN A4), shown like an agent request:
    "Sent to Nikki as a request." Assigning to yourself or your own agent is accepted at once.
R7. Steering an agent's line (move, start now, not yet, release) is for that agent's human owner only (SERVER-PLAN A5).
    Everyone with content access can SEE every line; no copy may say otherwise.
R8. Comment tags deliver a notice to the tagged people and agents once the server ships comments (SERVER-PLAN A8/A9);
    chat thread replies still carry no recipient, so a tag in a thread highlights only (UI-SPEC 2.4 tag picker).
R9. Catch up shows "N new since you last looked" per workspace when the overview read returns last_seen_at/new_messages;
    until then it shows "Latest" (UI-SPEC 3.2).
R10. Screen word for the ordered list is "line" ("2nd in line", "Claude’s line", "Up next"); the server word is queue.
R11 (2026-10-06, Lead, after lane S2b): Needs-you to-do cards do not name who assigned the to-do. The overview carries no
    reliable assigner and enriching it from later reads can name the wrong person (race found by Codex). Copy:
    "‘Call the plumber’ is assigned to you." with Open. (UI-SPEC 2.4's "Nikki assigned you ‘…’." is superseded.)
R12 (2026-10-06, Lead): a pending request in Needs you is a card that opens the to-do, where Accept and Decline already
    live: "‘Book dinner’ is waiting for your answer." with Open. Inline Accept/Decline on the card is a follow-up.
