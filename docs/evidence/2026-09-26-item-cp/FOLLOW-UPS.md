# Item CP follow-ups (2026-09-26)

Under the landing bar these did not block. Each goes to brain app-backlog.

1. **`cswarm accept` still signs in with GitHub by default** (`src/cloud/auth.ts:449-452`). Brain v2 makes Google the
   default for `cswarm login`; `accept` should follow, with the same `--provider` flag.
2. **Actions site suite, 15 tests red on main and on CP0** (`CP0-LANDING.md`): 7 Brain view ("headless Chrome must
   return the live brain-view snapshot"), 3 viewport and table wrap in `markdown-wordwrap-qa`, 5 phone header and
   account menu (the app bar wraps to two rows on the ubuntu runner).
