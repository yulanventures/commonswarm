# Site artifact evidence — 2026-10-18

The actual-build results below are transcribed from HezLead's supplied
`SITE-RUNTIME-R2-INNER.md`, not rerun by the repair worker. They describe revision
`a76c4427c1bde0b9c3d35b6fc4ad67b3cc1c79c0` before the follow-up repair.
The retained build host workspace is
`/var/tmp/cswarm-followup-20261018/site-runtime-r2.sHDjzj` (`$R`); its `checkout` and
`artifact` subdirectories are referred to as `$C` and `$A` below. Public input
was supplied privately in a mode-0600 JSON file; no JWT or config value is copied
here. The source archive came from the exact public branch revision, not an
operator's untracked input directory.

## Actual builder and runtime proof (prior revision)

The authorized worker ran on pe-ci-1, Linux root through `sudo -n`, with Node
22.23.3. Its Node binary SHA256 was
`fde6a4bf8d0562f7751d1a2d6cb9b417c4cfe107bbcb0aa3e9a24e125e348f48`.

The command was `bash deploy/site/build-artifact.sh
 a76c4427c1bde0b9c3d35b6fc4ad67b3cc1c79c0 "$R/public.json" 1 "$A"`
from `$C`. It exited 0 and built 17 Astro pages. The receipt binds explicit H0=1.

| Output | Bytes | SHA256 |
|---|---:|---|
| source.tar | 119767040 | `4c64b7e0f1375aaa4026649a1fce31ab2c72d80bd0becd16fd66e8ad7305c4ad` |
| site.tar | 4331520 | `649cdb9f3fdba806bdebb7594650722a777629b33340c2ee085941f2cbdb6682` |
| BUILD.json | 1037 | `b4b3fa40333bb6e863c64c8ff733d295caea996cf73c8c5f2f9489b9ea589364` |

`COMMONSWARM_SITE_TEST_ARTIFACT="$A" node --import tsx --test
 tests/p1-cli/site-artifact.test.ts` exited 0: **5 passed, 0 failed, 0 skipped**.
This exercised real-artifact provenance, H0 controls and their removal, H0=0
controls absent/present, swap, manual/automatic rollback, status/body/curl
failures, pointer/asset drift, packet pins, and old asset/reserve retention.

The pinned historical inventory gate passed (1/1). Focused site/deletion checks
had 6 passes and one Caddy runtime skip: Docker or the local `caddy:2.11` image
was unavailable. Across those three invocations: **13 tests, 12 passed, 0 failed,
1 skipped**. Packet preparation passed, all four manifest members verified, and
packet files were mode 0444. The packet manifest SHA256 was
`8a07ecc65750f846b3059daea9c33a188b88cc27781ae52994916a67ec87b4ea`.

There was no production deployment, production health measurement, or backend
invite creation/revocation proof. The named release user-agent's Cloudflare path
remains a separate read-only verification owned by HezLead.

## Follow-up semantic fixture (current tooling)

The current `site-artifact.test.ts` defaults to a clearly named **SYNTHETIC CI
artifact**. It supplies small HTML/assets and a source archive with current
script bytes, then invokes the production receipt generator. This protects
release-tool semantics; it is not an Astro build or proof of committed-source
provenance. No production configuration is used.

On the Mac, Node 26.7.0's native TypeScript runner executed
`node --test tests/p1-cli/site-artifact.test.ts`: **6 tests, 5 passed, 0 failed,
1 skipped**. Only the rendered-release test skips: it requires Linux root.
Configuration has 8 cases, provenance has 11 receipt-field mutations, unsafe tar
has 5 cases, H0 has 6 variants plus positive controls, and validator drift is
checked independently. The Linux-root test defines 16 runtime scenarios; these
were not executed by this repair worker. The CI wiring is assigned separately.

Against the original validator bytes from `a76c4427`, the two selected regression
tests both failed with missing expected rejection: the otherwise valid trailing
slash archive was admitted, and a changed preparation validator was admitted.
The repaired owner passes both. Bash syntax, validator syntax and diff whitespace
checks pass. No full suite, build, production operation, commit or push ran here.

The optional **REAL builder artifact** lane remains available through
`COMMONSWARM_SITE_TEST_ARTIFACT`. Rerun it on the repaired, reviewed revision
with freshly built matching source/validator bytes; the prior receipt above is
historical proof and does not validate the repaired revision.
