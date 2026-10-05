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
