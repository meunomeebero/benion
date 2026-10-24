# Security and private data

Benion is intended for one operator managing their own accounts. Treat access to its dashboard as access to those accounts. Production uses a password-protected session, same-origin checks, CSRF nonces and signed Meta webhooks. Local mode is loopback-only and should never be tunneled as an unauthenticated public dashboard.

The optional [MCP endpoint](mcp.md) requires a separate strong bearer token on every RPC request and rejects foreign browser origins. It grants owner-level control over all connected accounts. Treat the agent client and its credential configuration as privileged. Tool schemas forbid raw provider credentials and internal send-control fields. Native clients may omit Origin; dashboard cookies cannot authenticate MCP. Binary uploads use a separate account-bound, single-use ticket that expires after 15 minutes or a server restart.

Tokens, provider keys, sessions, account identities, message content, comment metadata, campaign state and send/publication ledgers live in the private data directory. File permissions restrict local access; they are not encryption at rest. Protect the host and backups accordingly. AI-enabled conversations send the selected account's relevant conversation/catalog context to the configured model provider.

Only allowlisted assets are served. Private recovery records are available through authenticated, account-scoped APIs, never as a public JSON asset. Scheduled video uploads have purpose-specific serving URLs so Meta can fetch them; treat those URLs as public while available and do not upload sensitive files.

## Before sharing source

- Exclude `.env*` except `.env.example`, private state, backups, tokens, operator configuration, account exports, lead records, screenshots, operational reports and one-off recovery scripts.
- Inspect the files being published and, if using Git, its entire history. A clean current tree does not remove a secret from previous commits.
- Use synthetic account IDs and `example.com` links in tests. Do not paste real provider responses into fixtures.
- Use the runtime packager's allowlist. Its credential-pattern check is a safeguard, not proof that arbitrary personal data is absent.
- Rotate/revoke any credential that was exposed in a shared source, log or conversation; deleting the text alone does not revoke it.

For account erasure, stop the corresponding worker before removing private records and revoke the Meta authorization. Removing ledgers discards duplicate-send protection; do not reconnect the same active campaigns without a deliberate new baseline. The operator is responsible for the retention and deletion policy published at `/privacy`.

When reporting a security problem, share only the affected module, reproduction using synthetic data, and impact. Never attach tokens, message content, cookies or an unredacted data directory to a public issue.
