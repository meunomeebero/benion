# Run continuously

Use a Node.js 20+ host with public HTTPS, a persistent private filesystem and exactly one Benion server process per data directory. Background workers start with the app and recover enabled campaigns. The browser can close; an external Codex schedule is unnecessary.

## Configuration

Use `.env.example` as a variable reference. Store actual production values in your host's private environment settings:

| Variable | Purpose |
|---|---|
| `BENION_MODE=production` | Enable authenticated hosting |
| `PORT` | Internal HTTP port; default 80 in production |
| `BENION_PUBLIC_ORIGIN` | Exact external HTTPS origin, without trailing slash |
| `BENION_ADMIN_PASSWORD` | Random password, at least 20 characters |
| `BENION_SESSION_SECRET` | Distinct random secret, at least 32 characters |
| `BENION_DATA_DIR` | Absolute persistent private directory outside the served assets |
| `BENION_META_APP_SECRET`, `BENION_META_VERIFY_TOKEN` | Signed webhooks and callback verification |
| `BENION_OPERATOR_NAME`, `BENION_PRIVACY_EMAIL` | Your identity/contact on `/privacy` |
| `BENION_LLM_MODEL` | Model ID supported by your configured provider |

Set the privacy identity/contact to your own details before connecting a live account. Keep the admin password and session secret stable across normal restarts. The browser cookie persists until logout or browser expiry; server-side revocation and credential changes can invalidate it.

Default state location: `~/.local/share/benion` locally, `.benion-private` beside the server in production. Keep its permissions private (directories 0700, files 0600). For local isolated development, set `BENION_DATA_DIR` to a fresh absolute path and `BENION_PORT` to a free port. Never point a test at operational state.

## Package and host

```sh
node scripts/package-shard.mjs /tmp/benion.zip
```

This creates an allowlisted runtime archive with browser assets under `public/`. It excludes account data, credentials, histories and documentation. Upload it to your Node host (including Shard Cloud), select a unique application/subdomain, set private environment variables and start `node server.mjs`. Set persistent storage before connecting accounts. Check `/health` for the running source revision, then log in and follow [Meta setup](meta-setup.md).

The source checkout can also be used locally with `node server.mjs`. Production expects the packaged `public/` layout; do not expose the source directory with a generic static file server.

## Upgrade and verify

1. Preserve a private backup of the data directory and current runtime archive. Do not include that backup in a source release.
2. Record account IDs, campaign enabled/paused flags, activation cutoffs and publication claims privately. Pause only if the upgrade requires it; a manual pause is a persistent owner choice.
3. Deploy the new runtime, preserving the data directory and secret values. Restart one server process.
4. Verify `/health`, account isolation, campaign states and a subsequent worker check. Compare cutoffs and ledger counts; do not send synthetic live DMs.
5. If rollback is required, restore code while keeping the newest private state. Unknown external operations must be reconciled before retrying.

Older root-layout installations use private `owner.json` (schema version 1, primary identity and optional legacy recovery settings) and `legacy-recovery.json`. These are migration inputs, not starter templates. Missing required compatibility config fails with `OWNER_CONFIG_REQUIRED`; supply the existing installation's private config instead of deleting state or reconnecting from scratch. New installations do not need either file.
