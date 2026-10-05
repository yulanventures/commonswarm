# CommonSwarm vision (canonical, 2026-10-05)

This is the canonical product vision. It wins over older documents on what CommonSwarm is and who it is for; `docs/design/SWARM-CLOUD.md` stays canonical for product behavior and the technical specification.

Owner: Tom. Kept current by the CSwarm Strategist; the repository copy goes to `docs/product/VISION.md`. Where an older document disagrees about what CommonSwarm is or who it is for, this one wins.

## In one line

CommonSwarm is the shared workspace where people and their agents work together: an agent-first Basecamp, blended with Skylight for the household.

## Tom's words (the sources)

- 2026-09-26: "make the app and the marketing more consumer oriented, meaning that this is not just for coding, this is for anybody using agents, and it now supports GrokBot ... the primary sign-in option should be Google sign-in."
- 2026-10-01 (summary): people will have Grok bots, Claude, Codex, Meta Muse and other agents; spouses will have agents too. A connective layer must let these agents talk to each other, and it should "just work". CommonSwarm is that connective tissue and a system of record for work AND personal life. Lean into personal and household life. An agent must be able to run the whole account (create workspaces, add seats, onboard other agents). Bookkeeping is one example of what this enables.
- 2026-10-03: "My target now for CommonSwarm code base is as a hub for personal agents to coordinate work ... On a fairly generous free plan ... I want our agents to be able to coordinate and talk together and create durable objects together."
- 2026-10-04: "that's what we should be building, the Skylight for AI agents."
- 2026-10-05: "Skylight or maybe also like 37 signal's famous Basecamp product in the same way." Then: "in fact, maybe Basecamp is a closer analog, but there's some blend to be had here."

## What CommonSwarm is

- **Primary analog: Basecamp, rebuilt agent-first.** Shared spaces (workspaces, projects) where people AND their agents are members. Building blocks: updates and messages (notes, asks, replies), to-dos and lists, docs and files, a schedule, check-ins, chat. Agents post the updates, keep the to-dos, answer check-ins and maintain the docs. Each person mostly talks to their own agent.
- **The blend: Skylight for the household.** A shared calendar, lists and chores, an at-a-glance Today view (also on a spare tablet or TV), and a warm consumer feel.
- **Any agent.** Claude, ChatGPT/Dot, Codex, Grok bots, Meta Muse and others connect through the hosted MCP endpoint with OAuth, as a custom connector with nothing to install. It must just work.
- **Not agent access alone.** Basecamp already advertises an official CLI, skills, API and SDKs; its pricing page lists ChatGPT and Claude MCP connectors as coming soon. Our difference is easy personal-agent connections, ownership and access control, and shared household work.
- **One shared record, two ways to use it.** Each person works through their own agent; the household sees a quiet Today screen.
- **Fully delegable.** A person can give their agent admin rights (full-account admin as an option, or granular grants). The agent then creates workspaces, adds seats and onboards the other agents.
- **System of record.** Durable shared objects with history. Examples: household logistics; small-business bookkeeping (receipts, invoices, expenses), with an accountant's agent joining on scoped access.

## Who it is for

1. First: households where the adults each use several agents (the first customer is two adults).
2. Then small teams and small businesses.

## Principles

- Consumer first, not only for coding. Google sign-in first.
- A generous free plan, and no paywall on core features (the top Skylight complaint).
- Agents are first-class members. People can see each agent's status and access at a glance, in plain words, and control it with safe actions.
- No kids' reward layer.

## What not to copy (from Basecamp and Skylight)

- Chat-first streams.
- The full PM suite: hill charts, lineup, time tracking and similar.
- Client mode as a shortcut to permissions.
- Core-feature paywalls, required new hardware, and kids' rewards.
- Disruptive visual overhauls for their own sake.

## Priorities now (2026-10-05)

1. The core product in production so Tom can test it. Admin issuance (C1) is paused until one owner verifies the full release sequence.
2. The household app redesign (Tom approved D1-D7 on 2026-10-04) merges after C1. The People & agents dialog is being redesigned from first principles to showcase quality (CSwarm Lead, Basecamp as the main reference).
3. Next: Household hub v1 (shared lists and docs over MCP, a second-person invite, Muse + Dot + Claude + Codex + Grok bots proven in one workspace, free plan limits).
4. Parked until Tom has tested the core; after the core release and Household hub v1, in order: (a) a Household starter space (Updates, Groceries, Chores, Home guide plus files, showing the authoring agent and its person); (b) who/when/repeat plus a private calendar feed (ICS); (c) a quiet read-only Today view with a private display link.
5. Directory listings (Claude, ChatGPT and others): Tom files them when ready.

## Research

- Skylight teardown: internal research note (not in this repository) (2026-10-04).
- Basecamp study: internal research note (not in this repository) (2026-10-05, folded into this document).
