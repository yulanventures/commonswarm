import fs from "node:fs";
import path from "node:path";

const cwd = process.cwd();
const siteRoot = fs.existsSync(path.join(cwd, "dist", "index.html"))
  ? cwd
  : path.join(cwd, "site");
const dist = path.join(siteRoot, "dist");

/* This observer reads BUILT output, and `npm --prefix site test` does not build. A stale dist
 * therefore passes checks against source that no longer says what dist says — measured
 * 2026-09-13, when an acceptable-use rewrite left this observer green on the previous build and
 * red the moment the site was rebuilt for release. Refuse to report on output older than the
 * pages it claims to describe: a loud "rebuild first" beats a silent false green. */
const assertDistIsCurrent = () => {
  const builtAt = Math.min(
    ...["index.html", path.join("start", "index.html"), path.join("acceptable-use", "index.html")]
      .map((relative) => fs.statSync(path.join(dist, relative)).mtimeMs),
  );
  /* A page's text can come from a layout or a component it imports, so scanning only
   * src/pages leaves the same stale-output hole one directory over. Walk the whole source
   * tree instead; a review arm caught the narrower version. */
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /\.(astro|ts|mjs|js|md)$/.test(entry.name) ? [full] : [];
    });
  const sources = walk(path.join(siteRoot, "src"))
    .filter((file) => !/\.(observer|test)\.(mjs|ts)$/.test(file));
  const stale = sources.filter((file) => fs.statSync(file).mtimeMs > builtAt);
  if (stale.length > 0) {
    throw new Error(
      `site/dist is older than ${stale.length} source file(s) — ${stale
        .map((file) => path.basename(file))
        .join(", ")}. This observer reads built output, so it would report on the previous ` +
        "build. Run: cd site && rm -rf dist && npm run build",
    );
  }
};
assertDistIsCurrent();

const decode = (value) =>
  value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&rsquo;", "'")
    .replaceAll("&lsquo;", "'")
    .replaceAll("\u2019", "'")
    .replaceAll("\u2018", "'")
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)));

const renderedMainText = (file) => {
  const html = fs.readFileSync(file, "utf8");
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (!main) throw new Error(`${file}: built page has no <main>`);
  return decode(
    main
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
};

const pages = {
  home: renderedMainText(path.join(dist, "index.html")),
  start: renderedMainText(path.join(dist, "start", "index.html")),
  acceptableUse: renderedMainText(path.join(dist, "acceptable-use", "index.html")),
};

const required = {
  home: [
    // Hero (Daylight Orbs, 2026-10-01): one pin per load-bearing claim.
    "Your people. Your agents. One shared workspace.",
    "Share messages, files and notes",
    "about home and work.",
    "Start a workspace",
    "See how it works",
    "Free for 10 workspaces. No card required.",
    "Example workspace",
    "Home base",
    "Wren · Claude",
    "Gale · Grok",
    "School forms are ready.",
    // Works with: Claude only, with a link to its guide. The wording must not claim
    // universal host support, partnership or endorsement.
    "Bring the agents you already use",
    "Claude",
    "Connect Claude",
    // How it works; #how-it-works and #life-and-work are header and footer anchors.
    "A common place. A simple start.",
    "Open a workspace",
    "Connect your agents",
    "Choose how to connect each agent.",
    "Read along and steer",
    // Life and work.
    "For the kitchen table. And everything after.",
    "A little less life admin",
    "Keep the handoff moving",
    // Boundary claims.
    "Your agents stay yours.",
    "Your agents run on their own computers.",
    "CommonSwarm never runs your agents or holds their provider keys.",
    "CommonSwarm stores workspace messages and shared files.",
    "Treat every shared file as untrusted input and review it before use.",
    // Future capabilities must stay visibly marked as not live.
    "Coming soon Let your agents handle the setup.",
    "Agent admin tokens for workspace setup and onboarding. Not live yet.",
    // Close.
    "Bring everyone into the loop.",
    "Log in",
    "Open source under the MIT License.",
  ],
  start: [
    "Opening your workspace",
    "CommonSwarm starts in the dashboard.",
    "Sign in, create your workspace, and add your first agent in one place.",
    "Continue to CommonSwarm",
  ],
  acceptableUse: [
    "Workspace file artifacts are part of the product.",
    "Members and agents may share files for the workspace's work within the published caps below.",
    "general-purpose bulk storage",
    "content delivery network",
    "Workspace file artifacts: 25 MB per version, 1 GB per workspace counting live and retired versions plus uploads begun in the last 3 hours",
    "Ten live workspaces per verified identity, free, no card.",
  ],
};

const forbidden = {
  home: [
    "One workspace for teams and the agents they run",
    "Drawn from a real session",
    "The agents divide a trip plan and reply in one workspace.",
    "Tom and Nikki can read the same updates and steer the plan.",
    "repo",
    "repository",
    "terminal",
    "CLI",
    "PR",
    "pull request",
    "code",
    // Works with shows Claude only; the old routing note went with the other hosts (2026-10-10).
    "Choose the connection guide for your agent.",
    // The 2026-08-22 reference-derived copy is retired in full. None of these
    // headings or sentence fragments may survive a later homepage edit.
    "Where people and agents work together.",
    "Come test the early stages with us.",
    "A new shared workspace for human + agent teams",
    "Chat with teammates and specialized agents in one shared space",
    "Connect the agents you already run",
    "keep the work that used to be scattered across chat, trackers, and dev tools in one place",
    "Your people, your agents, your project",
    "Free for up to 10 workspaces. No card.",
    "No card.",
    "Communicate with your team",
    "Keep people, context, decisions, and next steps in one shared room",
    "no more chasing threads, docs, and status updates",
    "Bring in your agents",
    "Invite specialized agents into the conversation",
    "compare notes, divide work, and build on the same context as your team",
    "Manage your git projects",
    "Turn the discussion into plans, code, reviews, and PRs",
    "without hopping between your tracker, chat app, and dev tools",
    "One paste connects an agent",
    "Your workspace generates a prompt.",
    "Paste it into an agent you already run",
    "it carries the workspace, the connection details, and one credential",
    "That agent is now part of the team.",
    "Any account, any machine, any AI vendor.",
    "Teammates bring their own agents",
    "Send an invite link.",
    "They join with their own account and connect their own agents.",
    "They never need your keys or your machine.",
    "Agents can share files with each other inside the workspace",
    "shared files are untrusted input, so review before use",
    "Your agents stay on your machines",
    "CommonSwarm coordinates. It does not control.",
    "It does not control.",
    "We do not run your agents",
    "provider keys stay with the agent",
    "Workspace messages and shared files live in the hosted database",
    "the work itself stays where you run it.",
    "Want CommonSwarm for your team?",
    "Try the open source app today.",
    "Stop building alone.",
    // Operator rule 2026-08-22: NO comparisons to other products on this page.
    "Slack is a room for people.",
    "GitHub records commits, reviews, and issues after the work.",
    "A shared repo holds files.",
    "An agent framework puts work inside one runtime.",
    "Slack cannot wake an agent",
    "GitHub is after the fact",
    "Sample workspace",
    "Launch room",
    "not switched on for everyone",
    "the flow is a preview",
    "There is no signup",
    "Accelerate teamwork with agent-to-agent chat.",
    "Create your free workspace",
    "For technical teams:",
    'cswarm working-on "wiring the payments webhook"',
    "Your workspace is ready. Open the dashboard.",
    "Your agents stop working blind.",
    "one shared feed",
    "One feed, and nobody starts blind.",
    "Every agent starts informed",
    "Working with a friend usually slows you down.",
    "The fix everyone suggests is a standup",
    "Workspace settings",
    "No process",
    "You don't have to manage it.",
    "Signals are posted once, never edited.",
    "The second agent finds out too late.",
    "close the workspace",
    "Close workspace",
    "doesn't help",
    "Joining is simple",
    "Two easy ways into the workspace.",
    "More agents can duplicate the work.",
    "collision found too late",
    "A detached listener can wake an agent",
    "Build together from anywhere.",
    "Paste it into each agent you use.",
  ],
  start: [
    "SWARM_CLOUD_URL",
    "SWARM_CLOUD_ANON_KEY",
    "PUBLIC_SUPABASE_URL",
    "PUBLIC_SUPABASE_ANON_KEY",
    "commonswarm:url",
    "commonswarm:anon-key",
    "meta tags",
    "Workspace id",
    "Workspace ID",
    "verified identity",
    "This step isn't on the page yet",
    "This step isn't on the page yet",
    "<host>",
    "Agent identity",
    "agent identity",
    "credential",
    "deployment",
    "backend",
    "Connect your AI assistant",
    "Connect an agent",
    "Create a temporary key",
    "Getting started",
    "Email me a sign-in link",
    "Sign in with GitHub",
    "Before you paste it",
    "Joining a teammate's workspace",
    "Accept your invite",
    "Your ten workspaces are ready to use",
  ],
  acceptableUse: [
    "a cache, a file store, a chat transport",
  ],
};

let checks = 0;
const failures = [];

for (const [page, needles] of Object.entries(required)) {
  for (const needle of needles) {
    checks += 1;
    if (!pages[page].includes(needle)) {
      failures.push(`${page}: rendered text is missing ${JSON.stringify(needle)}`);
    }
  }
}

for (const [page, needles] of Object.entries(forbidden)) {
  for (const needle of needles) {
    checks += 1;
    if (pages[page].includes(needle)) {
      failures.push(`${page}: rendered text still contains ${JSON.stringify(needle)}`);
    }
  }
}

// No public page may describe GitHub as the account CommonSwarm uses. It is one sign-in
// method.
const publicHtmlFiles = [];
const collectHtml = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectHtml(full);
    else if (entry.name.endsWith(".html")) publicHtmlFiles.push(full);
  }
};
collectHtml(dist);
for (const file of publicHtmlFiles) {
  checks += 1;
  if (/GitHub account/i.test(fs.readFileSync(file, "utf8"))) {
    failures.push(`${path.relative(dist, file)}: public page contains "GitHub account"`);
  }
}

// Primary consumer workspace CTAs must land on /app, not the legacy /start detour.
const primaryCtaFiles = [
  path.join(siteRoot, "src/components/SiteHeader.astro"),
  path.join(siteRoot, "src/components/SiteFooter.astro"),
  path.join(siteRoot, "src/components/landing/ConsumerHero.astro"),
  path.join(siteRoot, "src/components/landing/ConsumerStory.astro"),
  path.join(siteRoot, "src/components/download/AfterInstall.astro"),
];
for (const file of primaryCtaFiles) {
  checks += 1;
  const source = fs.readFileSync(file, "utf8");
  if (/href:\s*"\/start"|href="\/start"/.test(source)) {
    failures.push(`${file}: primary source still routes /start`);
  }
  if (!/href:\s*"\/app"|href="\/app"/.test(source)) {
    failures.push(`${file}: missing /app primary CTA`);
  }
}

// Built home must not expose primary create doors to /start.
checks += 1;
const homeHtml = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const startCreateHrefs = [
  ...homeHtml.matchAll(/href="(\/start[^"]*)"[^>]*>([^<]*(?:Create|workspace)[^<]*)</gi),
];
if (startCreateHrefs.length > 0) {
  failures.push(`home: built primary create still points at /start: ${startCreateHrefs.map((m) => m[0]).join("; ")}`);
}
// The shared header carries "Sign up" and "Log in"; the homepage body carries
// "Start a workspace" and "Log in". Every one of them must land on /app.
for (const label of ["Sign up", "Log in", "Start a workspace"]) {
  checks += 1;
  if (!new RegExp(`href="/app"[^>]*>${label}<`).test(homeHtml)) {
    failures.push(`home: built auth CTA must be /app ${label}`);
  }
}

// /start remains a real route for backward compatibility.
checks += 1;
if (!fs.existsSync(path.join(dist, "start", "index.html"))) {
  failures.push("start: route missing from build");
}

if (failures.length > 0) {
  console.error(`consumer-copy observer: ${failures.length} of ${checks} checks failed`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`consumer-copy observer: ${checks} checks across built /, /start, and /acceptable-use passed`);
  console.log("primary workspace CTAs: /app (header, footer, consumer hero/story, install)");
  console.log("legacy signup checklist is absent from the compatibility handoff");
}
