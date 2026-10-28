# High-visibility accents

The junction-C keeps its geometry and uses coral `#E45B36`. Primary actions use gold `#FFD84D` with deep-plum `#2C2C42` text and a visible boundary; hover uses `#F3C72F`. Purple remains the supporting accent for links and selection. Structural paper, plum and lavender stay in place. Vendor artwork is unchanged.

The app change is limited to the signed-out gateway primary; auth changes are presentation only. Generated icons and the social card have editable sources in `site/scripts/`. Focused build, asset, observer and auth tests plus local visual QA verify this change; local auth fixtures do not perform a real provider roundtrip.

Baseline test fixtures were corrected without changing product behavior: the social metadata expectation now matches the existing card and alt mechanism, and the interaction parser test response stub implements `setHeader` so its positive control reaches provider lookup. An obsolete exact homepage description pin was also replaced with a nonempty description check; route uniqueness, OG/Twitter equality, card/headline consistency and encoded-path security assertions remain.

Provider observers passed 32/32 against an intentional offline build (`PUBLIC_SUPABASE_URL='' PUBLIC_SUPABASE_ANON_KEY='' npm --prefix site run build`, then the provider and signed-out observers); the configured preview was rebuilt afterward. Logs: `/tmp/commonswarm-high-vis-20261028/offline-build.log`, `providers-offline.log`, `preview-restore.log`.

Lead QA inspected homepage widths 390, 768, 820, 1024 and 1440px with no overflow or broken assets. At 390 and 1440px, light and dark tab contrast checks passed; the signed-out gateway passed in both themes, with a visible 3px focus ring and gold hover with deep-plum text. Primary text contrast measured 9.82:1. Thirteen auth fixture contracts matched baseline `3c553e31`. Real provider roundtrip was not run.

The own-brand SVG and PNG icons and social card are reproducible from editable source and generators in `site/public/brand/`, `site/scripts/brand-icons.mjs` and `site/scripts/og-card.mjs`. No new raster artwork was generated; official vendor assets were unchanged.

Six auth states in light and dark passed actual body-text contrast and accessible-name checks. Auth source outside `CONSENT_STYLES` was byte-identical to baseline; own SVG and Wordmark geometry matched baseline, and no vendor paths changed.

Independent review identified a low-contrast admin consent button boundary. The shared auth styles now give the admin button a deep-plum border while preserving its markup and behavior. Lead verified both rendered admin buttons in light and dark: 1px solid `rgb(44, 44, 66)` borders, with gold background and plum text; before the fix the border was zero.
