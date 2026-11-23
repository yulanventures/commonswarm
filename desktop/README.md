# CommonSwarm Desktop (macOS)

This build is unsigned (ad-hoc signed only, not signed by a registered Apple developer) and is for the owner's own machines.

## Development

```bash
cd desktop && npm install && npm start
```

Set `COMMONSWARM_DESKTOP_URL` (e.g. `http://localhost:4321/app`) to point an unpackaged run at a local server.

## Build the `.dmg`

```bash
cd desktop && npm run dist
```

Packages are written to `desktop/release/`.

## Install and open

1. Open the `.dmg` and drag **CommonSwarm** to **Applications**.
2. Open **CommonSwarm**; macOS shows a warning that Apple could not verify it.
3. Open **System Settings > Privacy & Security** and click **Open Anyway**.

## Sign-in

Email and password and GitHub work inside the window; Google sign-in is expected to be refused by Google inside an app window and will be handled through the system browser in a later version.
