# Homepage implementation and review

Branch: `design/marketing-shared-context-20261027`, based on `17c98aea`.
Preview: http://127.0.0.1:4327/ (Astro's production preview, port 4327).

## Narrative and visual decisions

“Put your agents on the same page” leads into one shared record. A household plans dinner, an agent makes the list, and the person takes the next step. A second example shows a team sharing a file and handing a review to another person. Connection details follow the workflows. Workspace creation is the dominant action and always goes to `/app`.

The warm cream canvas, ink typography, vermilion action color, sage sections and restrained paper compositions extend the product's existing Bricolage type and person/agent avatar convention. There is no entrance animation. Previews reflow into a single readable column on phones. Messages/Lists/Files tabs support arrows, Home and End; checklist changes synchronize between the two views. Without JavaScript all preview panels remain readable and list links are normal anchors.

These are editable UI illustrations of current concepts, not screenshots of a newly implemented application interface. Captions identify fictional sample content. No backend, auth, consent or onboarding code changes. Agent capabilities are scoped to the connection: only claude.ai is presented as a tested hosted route; list access must be enabled; computer connections cover the broader file, to-do and knowledge workflows. No untested host badges, testimonials, customer logos or metrics.

## Sources and provenance

| Asset | Source | Treatment |
| --- | --- | --- |
| Workspace, shopping and handoff illustrations | `site/src/components/landing/WorkspacePreview.astro` and `ConsumerStory.astro` | Original HTML/CSS; fictional sample content authored for this page. All text remains editable. |
| Product behavior and audience | `docs/product/VISION.md`, repository/site `AGENTS.md`, current engineering status, `site/src/lib/agent-hosts.ts`, server tool registry | Current code/status takes precedence over older marketing copy and stale `llms.txt`. |
| Brand mark | Existing `site/src/components/Wordmark.astro` | Reused unchanged; homepage tokens set its accent. |
| Person/agent avatars | Existing `site/public/landing/avatars/*.webp`, from commit `843a65ad`; rendered through existing `LandingAvatar.astro` | Reused unchanged. Previous source describes photos and generated agent artwork. Original photo URLs and generation prompts are not recorded in this checkout; provenance is incomplete. These are fictional examples, not customers. |
| Type | Existing self-hosted Bricolage Grotesque and DM Sans; Instrument Sans in the shared header/footer | Existing OFL licenses in `site/public/fonts/`. No external font requests. |
| Connection symbols | Text glyphs in the editable markup | Generic decorative symbols, not vendor marks or endorsement badges. |

No new AI raster imagery was generated, so there are no new image-generation prompts. Existing screenshot artifacts and their generator remain available; the redesigned page does not download them. Existing shared social-card artwork is retained.

## Reproduce

From the repository root, install the documented dependencies if needed, then:

```sh
npm --prefix site run build
npm --prefix site run preview -- --host 127.0.0.1 --port 4327
```

In another terminal, from `site/`, with gstack browse already installed:

```sh
bash scripts/marketing-captures.sh http://127.0.0.1:4327 /tmp/commonswarm-homepage-captures
```

`BROWSE_BIN` can select an existing browse installation. The script captures 390, 768, 820, 1024 and 1440px layouts and explicit dark phone/desktop views, plus geometry and image-load results. This run's evidence is in `/tmp/commonswarm-marketing-review/final/`.

The untracked local `site/.env` contains only the public API URL/anon configuration copied from the live page and H0=1. It enables the existing sign-in screen in the preview. No secret credentials or signed-in session were copied. Production builds continue to use their explicit deployment configuration.

## Test updates

The old consumer observer pinned the full old marketing script, including future hosts and unavailable admin actions. It now retains the offer and example disclosure as public contracts, with existing destination and prohibited-claim checks. The image observer keeps file/dimension checks without requiring the former nine screenshot panels. The geometry fixture measures rendered headings, excluding hidden tab panels. No production hooks or new test-only exports were added. These updates allow a real redesign without treating editorial wording or an image count as behavior.

## Verification

- The Astro production build succeeds (17 routes).
- Six focused CTA/asset tests pass; two Chrome observer cases skip under the repository's CI-only policy. The rendered consumer observer passes all 158 checks.
- Inspected screenshots at 390, 768, 820, 1024 and 1440px; zero horizontal overflow or failed images. Visible headings fit two lines at all five sizes. Dark phone/desktop screenshots inspected too.
- Exercised Messages/Lists/Files, left/right arrows, Home/End, the list attachment, synchronized checkboxes and Space activation. Mobile menu opens, closes on Escape with focus restored, and closes after anchor navigation.
- All 19 distinct local link/anchor destinations pass. The primary CTA reaches `/app`; Google/GitHub/email choices render. Invalid email is rejected by native validation; no email sent.
- A custom DOM text-contrast/name audit passes all three preview panels at 390/1440px in both light and dark (12 combinations). This is a focused check, not a full WCAG/axe certification. Explicit theme changes were measured after transitions settled.
- No application JavaScript exceptions observed during the final page flow. The shared layout still emits existing unused font-preload warnings; no layout changes were made to other routes.
- `git diff --check` passes. Independent Anthropic source review completed, including the actual test changes. Fixed dark menu/hover contrast, the connection focus ring and the file-reading agent’s connection attribution. The follow-up found a focus-selector specificity conflict; the final `.lp-home .lp-connections a:focus-visible` rule was then verified by actual keyboard focus and computed white outline color. Menu CTA text measures 6.68:1, header hover 8.39:1 and connection focus 13.11:1.

The CI-only Chrome observer cases and full suite are intentionally not run on the shared Mac mini. Manual browser inspection uses the already installed browse session. Authenticated workspace actions, OAuth consent completion, email delivery, provider-side connection acceptance and production integration remain outside this local marketing check.
