# H0 lane 4a — landing record

The paste a human copies to invite an agent. A pure function, not yet wired into the app.

## The pair
- antigravity FAILED 815c422a. Its findings: the credential was glued to a semicolon, and the URL
  guard was narrow.
- antigravity then PASSED dc9446bb (the rework, originally 08fd67f6 before rebase). It judged the
  threat model sound: the URL is built by our app from a random locator, so the guard defends against
  a coding mistake, not an attacker who chooses the URL. No production finding.
- grok PASSED cebefa05, which contains that rework plus the prose and overclaim fixes. No production
  finding.
Both passes found only rigour issues, fixed in place under the sprint's pacing rule (0bf6d51d,
f72d574f).

## Rendered paste
    First fetch this agent document; reading it requires no login or key:
    <url>
    Then call register once as that document describes, using this single-purpose join credential:
    <credential>
The verb comes from H0_PREAUTH_VERBS; no verb name is typed in the source.

## Stated limits (in the source, pinned by tests)
- Refuses 12 or more CONSECUTIVE characters of the secret body, after case folding, tab/CR/LF
  stripping, and up to three layers of percent-decoding. Pieces shorter than 12 are allowed by design;
  a test pins that 11-character chunks pass. Four or more nested layers are refused.
- Does not check the public `swm_join_` prefix, and cannot detect a transformed secret.
- Refuses a plaintext document URL, but cannot stop a server redirecting HTTPS to HTTP.
- The verb-literal check catches a typed name, not one assembled at runtime.

## Corrections to landed commit messages (immutable; corrected here)
- dc9446bb (originally 08fd67f6) says the window "covers a partial secret and one split across
  segments". It covers them only when a piece keeps 12 contiguous characters. Corrected in the source
  and tests by 0bf6d51d.
- The first evidence copy of the v1 antigravity review carried trailing whitespace, stripped in
  cebefa05; the content is unchanged.

## Flake, still not this lane
grok hit tests/support/host-stderr-exit-parity.ts three more times while reviewing this lane (OpenCode
1342 ms, Codex 1380 ms, Grok 1319 ms, against a 1300 ms ceiling); a third run passed 874/874. That is
six occurrences across three providers in two days. It is filed as its own task.

## Not established
Not wired into the site or app. No join credential is minted here. The wording has not been tried
on a live Claude Code, Codex, or Grok session.
