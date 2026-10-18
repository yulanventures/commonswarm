# Site artifact evidence — 2026-10-18

The first actual-build results below are transcribed from HezLead's supplied
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

That build run did not deploy production or prove backend invite creation or
revocation. HezLead subsequently supplied a read-only live probe at
2026-10-18 15:03Z using `CommonSwarmReleaseCheck/1.0`: `/` returned 200 with
SHA256 `0336298521e78515ce4c905a65352c15c20de6233e715e1b35bec6621169af4c`;
`/app` returned 200 with SHA256
`4c093141aa114cc6c1dc030dc2d0f736288a9f6b4145aa38e36e9a96c61ca35b`.
Both matched the expected live HTML hashes. No raw access logs are retained here.

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
checked independently. The current Linux-root test defines 18 runtime scenarios, retaining all 17
from `7d031e35`, including actual HUP delivery, and adding already-old unhealthy
rollback. This repair worker did not execute the Linux-root test.

Against the original validator bytes from `a76c4427`, the two selected regression
tests both failed with missing expected rejection: the otherwise valid trailing
slash archive was admitted, and a changed preparation validator was admitted.
The repaired owner passes both. Bash syntax, validator syntax and diff whitespace
checks pass. No full suite, build, production operation, commit or push ran here.

The optional **REAL builder artifact** lane remains available through
`COMMONSWARM_SITE_TEST_ARTIFACT`. Rerun it on the repaired, reviewed revision
with freshly built matching source/validator bytes; the prior receipt above is
historical proof and does not validate the repaired revision.

## Supplied Linux-root proof at 71caa4b9 and HUP proof at 7d031e35

HezLead's `SITE-RUNTIME-R3-INNER.md` records an actual build of
`71caa4b94bda12b9a79eec1a61789b9004d8dc02` with explicit H0=1 on the same
Linux-root Node 22.23.3 runtime. Its retained workspace is
`/var/tmp/cswarm-followup-20261018/site-runtime-r3.6Z4zNN`, with `checkout`
and `artifact` subdirectories. The build exited 0 with 17 Astro pages.

| Output | Bytes | SHA256 |
|---|---:|---|
| source.tar | 119777280 | `f1a38113c567cf3808bc6c547bc7401f334be6ba1bb3f2405aed643033099ac2` |
| site.tar | 4331520 | `db704edc3769707b8e467fcbdfc2daeb8b4a0e8020e4fcb53ba4edb953813c23` |
| BUILD.json | 1037 | `2d1e579392c6f4431fec2d7725e04e0654b23118e5a4cdca806028a86a5ddf93` |

`node --import tsx --test tests/p1-cli/site-artifact.test.ts` passed **6/6**
in SYNTHETIC mode, and with `COMMONSWARM_SITE_TEST_ARTIFACT` pointing to that
fresh artifact passed **6/6** in REAL mode. Each executed all 16 then-defined
runtime scenarios without Linux-root skips. Historical inventory passed **1/1**;
focused site/deletion checks passed **6**, with **1 skip** for unavailable Docker
or cached `caddy:2.11`. Total: **20 tests, 19 passed, 0 failed, 1 skipped**.
Packet preparation passed; four manifest members verified, all mode 0444.
Its manifest SHA256 is
`fa5436e48b87ae504a54e67470008e1199163394f996601c7e649d9e61ea8a37`.
The static-tools ban list is supplementary: the rendered production code was
also executed by both Linux-root runtime lanes.

HezLead subsequently observed `HUP_BOTH_LANES_PASS` with test source
`7d031e35`: SYNTHETIC **6/6**, REAL **6/6**, all **17 scenarios per lane**,
including actual post-switch HUP. Production tooling was unchanged from
`71caa4b9`, so that existing real artifact remained applicable to that test-only
change. These supplied results do not validate the later template repair below.

CI finding 2 has a separately owned fix at `cbd46e8c`: the standalone box suite
now wires the site-artifact test under Linux root. That commit is not present in
this branch until integration; merging that CI change is required for ongoing
runtime coverage. This worker did not change workflow or CI checkout files.

## Bounded delta repair after 7d031e35

Rollback now probes both old routes before PASS even when the pointer is already
old. The wrapper runs SITE-DIRECT directly, saves its status, tails the private
host log after completion, and exits with the saved status. PIPE ignoring and
regular-file logging remain in place. The runbook requires host-side log review
after any nonzero exit, including transport failure.

The added `unchanged-unhealthy` runtime case first deploys and rolls back
successfully, then returns old `/`=200 and old `/app`=503. Repeating rollback must
exit 1, log the rollback HTTP assertion, preserve the old pointer and omit PASS;
a restored healthy response permits the final positive rollback control. This
protects an observable release result at the rendered-script boundary; the
previous early return would wrongly resolve that rejection. No production test
seam was added. This new runtime case and its pre-fix failure remain for HezLead
to execute on Linux root; the local native gate has the expected runtime skip.

This repair changes the production template pin. HezLead must build a fresh
artifact from the newly reviewed SHA and rerun both Linux-root lanes with all
18 scenarios; the previous artifact cannot prove this repair. Independent
cross-family review is owned by HezLead. No build, remote access, production
write, full suite, workflow dispatch, commit or push was performed by this worker.
