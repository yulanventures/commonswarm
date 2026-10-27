# Brand and OAuth presentation

The approved junction-C mark is shared across the wordmark, rail, icons, social card and OAuth pages. Icon and social card generators are in `site/scripts/`. OAuth uses system fonts and the existing security policy.

The homepage uses official Claude and ChatGPT assets, the existing Grok mark, and the official default Muse character crop. Sources and crop coordinates are recorded in `site/public/brand/works-with/SOURCES.md`. Muse is illustrative; ChatGPT and Muse hosted availability is not asserted. Gale and Pike use computer connections in the examples.

OAuth visual fixtures use harmless local data at `/tmp/commonswarm-agent-marks/auth-qa/`. The forms, security boundaries and continuation behavior remain unchanged.

Metadata review: at baseline the homepage title and heading changed while the metadata test pinned the previous title and description. The test now checks the rendered title against the heading and retains route uniqueness and Open Graph/Twitter consistency. The restored test checks that the card headline matches the homepage heading. The card generator, alt text and image now use that heading.

The provider fixture subprocess initially failed because the worktree's physical path contains a space and URL `.pathname` leaves it percent-encoded for `cwd` and script paths. The executable itself exists and launches. Running Node with symlink preservation and absolute symlinked test paths passed the observer suite without changing production or fixture path code.

## Local QA evidence

Lead inspected the homepage at 390, 768, 820, 1024 and 1440px in light mode and 390px in dark mode: no overflow, broken assets or robot avatar requests. Muse is visible on phone with an accessible preview label. Preview tabs respond to clicks and ArrowRight reaches Files; the mobile menu opens and closes with Escape; Start a workspace reaches `/app`. The signed-out app was inspected on phone and desktop with the new mark.

Eight representative auth cases were inspected at 390 and 1440px without overflow, broken images or unnamed controls. Sign-in, consent and connected screens passed text contrast and name checks with authored dark media rules forced after transitions settled; this was not OS dark-mode emulation. Consent checkbox mouse and Space interaction updated FormData, locked disabled controls retained hidden fields, and keyboard focus was visible. The paused finish view and admin selection on phone were inspected. Thirteen pure-renderer fixtures were compared against baseline: forms, routes, scripts and finish attributes matched, excluding style, nonce and time values.

These are static fixtures with no real submits. A real provider roundtrip, hosted integration verification and the full test suite remain pending.

Review repair: Muse is Jordan’s preview agent, including its owner badge. The metadata consistency check was run against the stale card first and failed as intended; after updating and regenerating the card it passed. Asset inventory notes now distinguish unchanged logos from the documented Muse character crop.
