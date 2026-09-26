# Legal address constant lane

Base: `79ade46a` (`lane/legal-address`). The approved company line is
`Yulan Ventures, LLC, 1211 W 6th St, Ste #600-188, Austin, TX 78703`.

## Change

- Added `site/src/lib/company.ts` with one exported address-parts constant and one exported line composed from those parts.
- Privacy and Terms now interpolate the module values in all five former literal address lines, including the copyright agent notice. The street text occurs in `site/src` only in the constant and in the exact-line test.
- `site/package.json` names `src/lib/*.test.mjs` in its `test` script, so it reaches `site/src/lib/company.test.mjs`.

## Test and negative controls

Only the new test file was run locally, with a fresh temporary home each time:
`cd site && env HOME="$T" node --import tsx --test src/lib/company.test.mjs`, where
`T=$(mktemp -d /tmp/lane-home.XXXXXX) || exit 1`.

| Source state | Address-line assertion | Old-street scan | Process exit |
|---|---:|---:|---:|
| Final source | pass | pass | 0 |
| New constant's street temporarily reverted to `1200 W 6th St` | fail: actual line used 1200 | fail: found `lib/company.ts` | 1 |
| Constant restored; temporary `site/src/lib/legal-address-negative-probe.txt` contained `1200 W 6th` | pass | fail: found the temporary file | 1 |
| Temporary file removed | pass | pass | 0 |

The negative-control edits were restored before committing. The scanner constructs the old-street search string from parts so the test source does not itself match.

## Rendered HTML

Ran `env HOME="$T" ASTRO_TELEMETRY_DISABLED=1 npm --prefix site run build` before and after the source change, with a fresh temporary home for each build and neither public Supabase build variable set. The lane's original `site/node_modules` lacked a locked dependency, so the baseline build first failed before rendering; I copied the installed dependencies from the main checkout into the lane's ignored `site/node_modules`, then both builds succeeded. No production host was contacted.

Compared the two generated pages with `diff -u` against the baseline copies:

| Page | Baseline and final SHA-256 | `diff -u` exit | Diff output |
|---|---|---:|---|
| `privacy/index.html` | `98502f44a7190db52a9362e9fd6889ebfe46e33231d82833968021a31d241e12` | 0 | empty |
| `terms/index.html` | `0db8ba4211fecb5d6a10421a56dc3fb215f6e0409fa60bf61eb3d9bf8f49bd88` | 0 | empty |

The final legal-page HTML is byte-identical to the build from `79ade46a` in the same lane environment.
