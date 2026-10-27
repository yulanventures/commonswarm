# CommonSwarm marketing homepage brief

Redesign and implement the marketing homepage for CommonSwarm.

Product: https://commonswarm.com. CommonSwarm gives people and their agents shared workspaces, messages, lists, to-dos, files and knowledge. The app is at `/app`, the API at api.commonswarm.com and the hosted connector at mcp.commonswarm.com.

Repository: `yulanventures/commonswarm`, canonical checkout `/Users/yulanbot/Developer/yulanventures/commonswarm/commonswarm`. Implement in an isolated worktree outside the workspace. The marketing homepage is `site/src/pages/index.astro` with its landing components and stylesheet.

Audience: households where two adults each use personal agents; small teams and small businesses second. Lead with ordinary shared work, not software development or orchestration infrastructure.

Primary action: **Start a workspace**, through `/app`. Preserve the existing sign-in, recovery, invitation, consent and return destinations. Link the published free allowance to `/acceptable-use#limits`.

Capabilities: shared messages and replies; people and agent membership; lists, to-dos, shared files and knowledge. Ground each claim in current code and release status. Claude on claude.ai is the tested hosted connection. Lists require enabled access. Hosted docs and files are unavailable. Agents using the computer connection have broader capabilities. Do not advertise untested hosts, calendars, automatic bookings, agent account administration or Organizations as available.

Visual direction: a warm, considered household workspace. Preserve the existing Bricolage typography, self-hosted fonts and distinction between circular person avatars and rounded-square agent avatars with owner badges. Use cream, ink, muted natural colors and one clear action color. Cut taglines, helper text and secondary labels when the layout can do the job.

Carry this through implementation, local preview and verification. Make reasonable decisions independently. Ask only when a missing product decision materially blocks progress.

1. Read workspace, product, repository and site instructions; both status files; work in flight; product vision; homepage and relevant product code. Code and current status win over historical design reports. Verify capabilities rather than copying stale documentation.
2. Build one narrative around a shared record: a person makes a request, an agent helps, and everyone can find the details and take the next step. Use concrete household and small-team examples, with plain, concise copy.
3. Establish a distinctive, cohesive composition with strong typography, restrained motion, readable product details and a single accent for the next action. Keep homepage styles out of the app and other routes.
4. Show two representative workflows: household dinner planning with a shopping list; a small-team file and review handoff. Use fictional, internally consistent content. Product previews must be actual captures or editable, responsive UI illustrations of available behavior, visibly identified as examples. Make preview controls work and provide a readable fallback without JavaScript. Use existing assets when they serve the story; record sources and any generation prompts. Use vendor marks only when permitted and verified; never imply endorsement.
5. Route all workspace creation and sign-in actions through `/app`. Keep existing header/footer anchor destinations working. Use evidence for plan limits and capability statements. No invented customers, testimonials, metrics or partner badges.
6. Compose deliberately at 390, 768, 820, 1024 and 1440 pixels. Reflow product UI for phones instead of shrinking a desktop screenshot. Check readable text, touch targets, contrast, keyboard focus, reduced motion and light/dark presentation.
7. Implement with Astro, vanilla JavaScript and handwritten CSS. Run the real build and Astro preview. Inspect screenshots at every required width. Exercise menus, preview tabs, sample checklists, links and the handoff to sign-in. Check overflow, image loads, accessible names and keyboard behavior. Run focused project checks; leave the full suite to CI. Review the finished diff independently and fix confirmed issues.

Deliver the implementation, a working local preview link, narrative/design explanation, editable sources and asset provenance, reproducible capture instructions, verification results and explicit limitations. Update the product status files to distinguish local implementation from production.

Keep the change focused and reviewable. Do not merge, publish the website or deploy production without explicit authorization.
