# CommonSwarm marketing site: shared brief

Every agent working on the site reads this first. It keeps the site consistent with
[the canonical product vision](../product/VISION.md), updated 5 October 2026.
That vision sets the audience and direction. [SWARM-CLOUD](../design/SWARM-CLOUD.md)
sets product behavior. Public copy describes only what works today.

## Two audiences, two surfaces

CommonSwarm is a shared workspace for people and their agents, at home and at work.
Households come first. Small teams and small businesses come next. Start with two
adults who each use agents. Household examples should show messages and shared files.

People read along, send messages and guide their agents in the browser. Agents use
an appropriate connection for their host. Keep setup instructions specific to that
connection. Do not ask a person to use a terminal when the browser can do the job.

| Surface | Audience | Operations |
|---|---|---|
| Web app at `/app` | People | Sign in, create or open a workspace, invite people, connect agents, read and send messages, and share files. |
| Hosted connector | Agents in a connected app | Use the hosted message tools in an approved workspace. This catalog has no file or admin tools. |
| `cswarm` CLI | Agents with access to a supported computer | Use the CLI commands for their workspace and access. |

A download button helps people install the CLI when their agent needs it. Opening
the web app and installing the CLI are separate steps. Prefer the existing install
routes. Do not invent a signed package or promise that every host can connect.

## Product direction

Make the experience simple, polished and useful beyond coding. The person should
understand what a workspace is and how to bring their agent into it.

The canonical principles guide the product and its copy:

1. Put consumers first. Put Google sign-in first when enabled. Generate sign-in
   choices from the provider code and deployment settings.
2. Aim for a generous free plan with no paywall on core features. State current
   limits only from the code that enforces them. Do not promise future pricing.
3. Treat agents as members. Explain status and access in plain words. Show people
   how to guide their agents and manage access through the actions available today.
4. Do not add a kids' reward layer.

Keep the experience quiet. Avoid a chat-first pitch, a full project-management
suite, required new hardware and visual overhauls without a clear user benefit.
These are direction rules, not claims that new screens or features have shipped.

The product name is CommonSwarm. The command people type is `cswarm`. The public
website is `https://commonswarm.com`. `/app` owns sign-up and the workspace. `/start`
is a compatibility handoff for old links.

## The bar

Use clear type, calm spacing and a short headline. Show what the product does with
an example workspace that is labelled as an example. Keep the primary action clear.

- Lead with people, their agents and a shared workspace for home and work.
- Show messages and files that the current product supports.
- Keep setup steps short and specific to the chosen connection.
- Keep limitations next to the relevant claim.
- Use motion only when it helps. Respect reduced-motion settings.

A demo must reflect real behavior. Do not imply a working connection, automatic
reply or household feature from decorative artwork.

## What CommonSwarm actually is: ground truth, do not embellish

CommonSwarm provides workspaces where people and connected agents share messages
and files. People can read and send messages in the web app. Agents can share
updates, ask questions and reply through the connection available to them.

Self-serve workspace creation exists in the repository. The repository describes
an open free tier. This brief is not a fresh production acceptance or billing check.
Keep published plan limits in sync with enforcement and measured release evidence.

The current surfaces have different capabilities:

- The browser client creates workspaces, supports invitations and messages, and
  provides shared file operations.
- The CLI supports workspace messages and files. Commands depend on the caller's
  credentials and access. Check command names and requirements against source.
- The hosted connector exposes the tools in `HOSTED_TOOL_TABLE`. It supports
  named seats, identity, messages, replies, inbox checks and member listing.
  It does not expose file, household-object or admin tools.
- The hosted workspace does not run agents. A connected agent checks and replies
  during a turn. The optional local listener wakes its own seat. It does not
  start a model or create a worker.

Household lists, chores, a calendar or calendar feed, a Today view and a display
link are roadmap items. Do not advertise them as available. Full agent account
administration and universal host support also need release and acceptance evidence.

### The differentiator: shared work at home and at work

The benefit is a common place for people and their agents to share context. Lead
with household use. Work examples can follow. Keep examples within messages and
files, such as sharing a school form or asking about a project handoff.

Public introduction:

> CommonSwarm is a shared workspace for you and your agents, at home and at work.
> Share messages, files and notes. Read along and guide your agents.

A note in this introduction means a workspace message or an existing shared file.
It does not promise an editable household document through the hosted connector.
A signal shares information. It never claims, blocks or closes a task.

#### Vocabulary: keep the public wording plain

| Avoid in introductions | Use instead |
|---|---|
| authority or enforcement | coordination and shared context |
| audit trail | shared messages |
| immutable signal | a message that cannot be edited or recalled |
| lease as a task claim | an update about what someone is doing |
| scoped token | explain access in the relevant setup or security guide |
| any agent just works | choose the connection guide for your agent |
| nothing to install | say when the agent needs the CLI |

Keep precise security terms in the contracts that need them. Do not replace an
actual refusal or access limit with a success-shaped message.

#### On the ethos line

Keep internal engineering principles out of the headline. Describe what a person
can do and what happens next. Do not put controls or friction at the centre of the
consumer story.

#### And it binds the product, not just the copy

Onboarding should ask for the minimum. Detect context when detection is reliable.
Do not guess. A success message must state what happened and identify unfinished
steps. Simplicity cannot hide missing setup or access requirements.

### The onboarding story: lead with the workspace

Open `/app`, sign in and create or open a workspace. Then choose the connection
guide for the agent. Read the messages and add your direction.

Public setup note:

> Choose the connection guide for your agent. Some agents connect through an app.
> Others need the cswarm CLI.

Do not make one generated prompt the universal route. A local agent needs the
computer capabilities described by its guide. A hosted connection needs OAuth
and approval for a workspace. A guide is not proof of fresh host acceptance.

### Settled quickstart rules: match the current connection

There is no universal two-line or three-line quickstart. The earlier terminal-only
rule is superseded. Human CLI commands resolve explicit settings, environment
settings and a saved target. A cold human install can discover the deployment.
Agent credentials use their own target and must not inherit a person's target.

A working command also needs the required sign-in, workspace and agent context.
Do not call a command block a quickstart unless the reader can complete every step
from the stated starting point. Keep flags and placeholders where required.

### The original draft: historical context

The July terminal-only draft predated target persistence and the current web app.
Its claim that every command always needs `--url` and `--anon-key` is obsolete.
Do not restore it. The source resolver in `src/cli.ts` and the current connection
guides govern command examples. Historical measurements remain in the dated
engineering records; they do not establish current availability.

## Hard rules: non-negotiable

1. No invented facts, testimonials, customer logos, user counts or benchmarks.
2. No fake social proof, including fabricated stars or endorsements.
3. No unsupported security certification or vendor compatibility claim.
4. State availability and plan limits from current code and release evidence.
5. Every displayed command must be real and usable from its stated starting point.
   Preserve credential, recipient, retention and lifecycle disclosures.
6. Accessibility is part of the product. Use sufficient contrast, visible keyboard
   focus, semantic landmarks, accurate alt text and reduced-motion support.
7. Use plain short sentences and a consumer tone. Do not use em dashes in new public
   text. Keep product comparisons from the internal vision out of public copy.
8. Do not claim unshipped household features, universal agent support or zero
   installation. Name the surface when capabilities differ.

## Stack

Astro 7, static output, hand-written CSS and vanilla browser JavaScript. Follow
`site/AGENTS.md`. Do not add Tailwind or runtime UI libraries.

The site is served by Caddy on the Hetzner server behind Cloudflare. Only the
release owners execute production releases. A copy edit or merge is not a release.
Check the layout at small screen sizes when browser testing is authorized.

---

## Load-bearing coupling: read before editing any heading

Review the heading, setup steps, command block and limitation together. They form
one promise. A friendly heading must not imply that an unfinished connection works.

| Heading or surface | Instructions | Honest result |
|---|---|---|
| Open a workspace | Browser sign-in and workspace creation | A workspace for the person to use. |
| Connect your agent | Guide for that agent's connection | Setup requirements are explicit. |
| Install the cswarm CLI | Supported system and install steps | CLI installation, followed by connection setup. |

Keep displayed commands and clipboard text in sync. Update pinned copy tests when
approved wording changes. Keep every assertion and verify the underlying claim.
The homepage, metadata, OG card and image alt must describe the same promise.

### The gate for command examples: verify the stated starting point

Check source for target resolution, credentials, workspace selection and access.
When a task permits execution, run the example with that exact starting state.
Retain the result and any limits. Do not use a source check to claim that a fresh
host install or an idle wake passed in production.

### Why this section exists at all

Individually true lines can form a false promise together. Review the complete
journey from the person's starting state to the result. A guide, a successful
install and an approved workspace are separate facts. State only what was verified.
