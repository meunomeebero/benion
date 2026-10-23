# Working on Benion

Benion is a personal, self-hosted Instagram automation app. Start with README.md and the module map. No framework, bundler, database or dependency installation is needed.

## Help an owner set up Meta

Follow [docs/meta-setup.md](docs/meta-setup.md) in order. Inspect the current browser state; Meta labels change. Prefer Instagram Login and the owner's own professional account/app-role path. Do not assume a consumer Instagram account is eligible or promise unrestricted access without review.

Use the browser/profile the owner chooses. The owner handles passwords, 2FA and account verification directly. Respect existing authorization for account setup and terms; ask only when a new action actually needs it. Never request credentials in chat. Put tokens directly into Benion's masked account form; use the hosting secret settings for App Secret, verify token and admin secrets. Never print them, capture them in screenshots, or commit them. Verify the authorized username before saving. Connection checks do not authorize test messages or campaign activation.

Finish by reporting what was verified: identity, read access, webhook setup, publication permission, campaign state. Distinguish API acceptance from delivery/read. If blocked, report the exact safe error code and the next owner action; do not keep retrying authorization failures.

## Change code

- Keep modules organized by the responsibilities in README.md. Prefer the smallest change that fixes the actual problem.
- Preserve unrelated local work and deployed state. Never reset, publish source, deploy, change credentials or enable sends without task authorization.
- Code comments and docs are English. Comment only invariants and non-obvious reasons. Preserve the product's existing UI language.
- Let the model interpret language. Enforce IDs, enums, byte limits and exact configured templates structurally; do not add regex/keyword intent classifiers.
- Account identity and canonical recipient/comment IDs are authority. Keep cross-account isolation, durable write claims and pre-send records intact.
- An unknown/inflight external result is not a failed send. Reconcile it before retrying. Public replies follow persisted private-send acceptance.
- Enabled campaigns recover inside the hosted app. Manual pauses stay paused. Do not add an external agent monitor.
- Back up private state before a deployment. Roll back code without restoring stale ledgers, publication claims or account state.

## Validate efficiently

Test only core flows, authentication/security, money or data loss. No tests for copy, layout, getters or obvious mappings. Run the changed domain once after implementation; fix failures and rerun only affected cases. A full suite runs once before release, with no other heavy machine work. Never send real test DMs or publish media as a substitute for synthetic tests.

Before implementation and before delivery, run the critic checklist yourself: overengineering, duplicated checks, scope drift, language regexes, a non-converging fix loop, low-value resource use, or the wrong objective. Stop and simplify when any applies. Report the final verdict briefly.

Private archives, tokens, account history, screenshots and one-off operator scripts do not belong in this source tree. Read [docs/security.md](docs/security.md) before preparing a public archive. Keep source publication separate from deployment.
