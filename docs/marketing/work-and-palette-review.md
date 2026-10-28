# Work examples and palette

Palette direction references RidgeHQ `apps/web/public/homepage.css:18` and `apps/web/src/hub.css:7259` at Ridge main `de973ffd`: paper, deep plum, purple, lilac and white, with restrained peach and sage. Dark colors are independently chosen for contrast. CommonSwarm’s junction-C geometry is unchanged; vendor assets are unchanged.

Kylon (https://kylon.io/, observed 2026-10-28) informed the direction toward concrete team workflows, a conversation alongside shared artifacts, and handoffs between people and their agents. Copy and examples are original. Client launch shows a discussion, a shared kickoff checklist, and a brief reviewed by a computer-connected agent; list items contain only text and checked state. Muse remains an illustrative preview.

Focused checks cover the site build, landing paths and CTAs, social metadata and generated icons, and auth/security behavior. Browser QA and independent review are recorded separately; no real provider roundtrip or hosted integration is implied by illustrations.

## Lead QA

Homepage captures were inspected at 390, 768, 820, 1024 and 1440px in light mode and 390 and 1440px in dark mode. Geometry checks found no overflow or broken assets. All 12 combinations of three preview tabs, two widths (390 and 1440px), and light/dark passed text contrast, accessible-name and local-link checks. ArrowRight tab navigation, Escape on the mobile menu, synchronized checkboxes and the `/app` CTA passed. Muse Preview was visible on phone; no robot avatars were requested. The new social card was inspected and is readable in the current palette.

An automated comparison found junction-C geometry unchanged in the SVG and Wordmark, and official vendor files untouched. Thirteen pure auth fixture contracts matched baseline `27f2a6f2`, including provider order, forms, routes, scripts and finish attributes. Eight representative auth fixtures were captured at 390 and 1440px: no overflow, unnamed controls or broken assets; light and dark views were inspected. An additional contrast audit passed all 16 combinations of sign-in, consent, unverified and connected screens at 390 and 1440px in light and forced authored-dark media: no low-contrast text or unnamed controls. Consent Tab focus was visible, and locked disabled controls retained their hidden selection, CSRF, home and workspace fields. Evidence: `/tmp/commonswarm-ridge-work-20261028/auth-qa.json`.

Dark checks forced the authored dark media rules rather than emulating an OS setting. These are local fixtures; no real provider roundtrip was run. The full suite remains CI-only.

Review repair: Pike appears in the decorative closing cast; the brief size, handoff times and open checklist context now agree across the client launch example. Auth avatar foreground adapts to its light and dark background for contrast.

Lead repair QA inspected the actual avatar glyph, including the aria-hidden instance omitted by the earlier audit: contrast was 1.784:1 before the fix and is 6.767:1 in light and 8.610:1 in dark after it (4.5:1 target). Runtime checks confirmed both brief sizes are 84 KB, the handoff follows the hero conversation, both right-side to-dos match unchecked checklist items, and Grok loads in the closing cast. Phone closing, desktop handoff and dark phone consent screenshots were inspected. Evidence: `/tmp/commonswarm-ridge-work-20261028/repair-qa.json` and screenshots in that folder.
