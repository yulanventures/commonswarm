# Dry run started real Chrome on Anvil's profile (2026-09-29)

Recorded by CSwarmDevLead. Status: fixed in harness lane H10 (see the end of this file).

## What happened

The HM37 whole-block dry run (`tests/box-dry-run.test.ts`) executes the real plan blocks on the Mac mini with
command stubs. Lane 8 step `site-03-browser-session-preflight` (`docs/evidence/2026-09-28-site-hm8/SITE-RELEASE.md`
lines 360-368) starts Chrome by its absolute path:

```text
'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --user-data-dir=/Users/yulanbot/.hermes/profiles/anvil/browser-profile/chrome
  --password-store=basic --remote-debugging-port=9335 --no-first-run --no-default-browser-check about:blank
```

Command stubs work only through `PATH`, so they cannot stop an absolute path. The `curl` stub answered the block's
port wait, so the block also reported success.

## Evidence

Files in Anvil's Chrome profile changed in these minutes (CDT), counted per minute with `find -newermt` and `stat`:

| Minute | Changed files | Matching run (gate log, UTC) |
|---|---|---|
| 10:57:40 | (overwritten) | P2 gate round, `0dba6a6e523b40d9-61041-20260929T155714Z` (10:57-11:01); HezLead saw a Chrome with this profile start at 10:57:40 |
| 12:10-12:11 | 75 | P2 gate, `0dba6a6e523b40d9-85729-20260929T170939Z` (12:09-12:14) |
| 12:54-12:56 | 10 | H9 gate round 0, `ffe89d15e057475d-39311-20260929T175414Z` (12:54-12:59) |
| 13:34-13:38 | 34 | H9 gate round 1, `ffe89d15e057475d-47626-20260929T183333Z` (13:33-13:38) |
| 14:04-14:09 | 83 | H9 gate round 2, `ffe89d15e057475d-5151-20260929T190354Z` (14:03-14:09) |

The changed files include `Local State`, `Variations`, `Default/*`, `Safe Browsing` and `BrowserMetrics`.
`DevToolsActivePort` did not change (last written 2026-09-26 06:35), so a check of that file alone reports no harm.
The 10:57 start was seen live by HezLead; its file changes were overwritten by later starts. Earlier runs cannot be
ruled out, because a newer modification time hides an older one.

At 14:24 CDT no Chrome process used that profile, nothing listened on port 9335, and the only other agent Chrome
(PID 91371) used `/Users/yulanbot/.chrome-agent-profile` on port 9223.

## Impact

- Chrome started on Anvil's signed-in profile (account label Ridgeio) at least five times and could show a window on
  Tom's screen.
- Tom reported a "Chrome Safe Storage" keychain prompt the same day. site-03 does pass `--password-store=basic`, but
  Chromium documents that switch as Linux-only; on macOS Chrome reads its Safe Storage key from the keychain. The
  gates ran with `HOME` set to a `mktemp` directory, so Chrome most likely looked for the login keychain there and
  prompted (medium confidence). Anvil's live runs use the real `HOME`.
- The changed files are Chrome's normal state files. No credential, cookie export, or sign-out was observed.
- The dry run's site-03 result was not a real result.

## How it was found

The Cursor Claude Opus 5.5 refuting review of harness lane H9 flagged the absolute-path risk. The antigravity review
of the same diff did not. The lead first checked processes and `DevToolsActivePort` only, and wrongly reported "no
harm" to HezLead; a per-minute file count then showed the starts.

## Actions

1. The P3 gate runs under `sandbox-exec` with a profile that denies exec of `/Applications/**`, writes to
   `~/.hermes`, `~/.config/cswarm`, `~/.chrome-agent-profile` and Google's Application Support, and reads of Anvil's
   browser profile. The wrapper fails if any file in Anvil's profile changes. Proof: a denied exec returned 71
   (Operation not permitted), a write into `~/.hermes` and a read of the profile were denied, and `/bin/echo` still ran.
2. Harness lane H10 runs every Mac-side block and every fixture remote script under `sandbox-exec`, makes browser
   surfaces non-substitutable (no browser emulation), and adds the control "a Mac block that starts an absolute-path
   application is denied and reported". Its gate fails on any change to Anvil's profile.
3. Rule: any gate that executes plan text on the Mac runs contained and checks Anvil's profile before and after.

## Status (2026-09-30)

Harness lane H10 landed on lane/hm37-integ at 8dc7df63 (tests only). Every Mac-side block and fixture remote script
runs under a per-block `sandbox-exec` jail; browser blocks are non-substitutable and are never executed; the control
"a Mac block that starts an absolute-path application is denied and reported" passes. The gate has no outer sandbox,
because macOS refuses a nested `sandbox-exec` with a different profile (exit 71); it snapshots Anvil's profile before
and after the run and fails on any change. Checkers: Composer 2.5 PASS, Gemini 3.1 Pro PASS. Anvil's profile has not
changed since 2026-09-29 14:09:11 CDT.
