# Benion

A self-hosted Instagram automation dashboard for your own professional accounts. MIT licensed; plain Node.js and browser modules, with no runtime dependencies or build step.

- Control accounts, campaigns, scheduled Reels and conversations through the hosted [MCP server](docs/mcp.md).
- Send a configured DM for comments on one Reel or all Reels, with optional public replies.
- Schedule Reels, attach their DM/link during scheduling, and compare API-accepted sends by campaign.
- Keep accounts, catalogs and conversations separate; take over a conversation from the assistant.
- Resume enabled campaigns after restart. Manually paused campaigns stay paused. Uncertain sends and publications require reconciliation before retrying.
- Renew eligible Instagram tokens in the hosted worker, with identity verification before replacing credentials.
- Prepare agent-generated videos with durable trend reservations and resume interrupted jobs: [workflow](docs/content-workflow.md) and [reusable prompts](docs/prompts.md).
- Attribute confirmed purchases and refunds to campaigns through a signed backend callback: [conversion integration](docs/conversions.md).

## Start

Use Node.js 20 or newer. No `npm install` is needed.

```sh
node server.mjs
```

Open **http://127.0.0.1:5197**. A fresh installation starts empty. Choose **Conectar Instagram** and follow [Meta setup](docs/meta-setup.md), or ask your coding agent:

> Read AGENTS.md and docs/meta-setup.md. Help me configure my own Meta app and connect my professional Instagram account to this Benion installation. Use the browser where I am logged in. Keep credentials out of chat. Verify the connection, then help me review my first paused campaign.

Local mode binds to loopback. For continuous operation and incoming DMs, deploy an authenticated HTTPS instance with persistent storage: [deployment](docs/deployment.md). The server runs its own workers; no Codex task or external monitor is required.

## Meta access

Use your own Meta app and a Business or Creator Instagram account. Standard Access supports owned/managed accounts with the required app role; serving unrelated customer accounts requires a different access/review path. Some features remain subject to Meta eligibility and limits. See the [official overview](https://developers.facebook.com/documentation/instagram-platform/overview) and the setup guide. Open source does not remove provider restrictions.

A comment permits one initial private reply within seven days. Follow-up messaging requires a recipient response and the applicable 24-hour window. An API success confirms acceptance, not delivery or reading. [Meta private replies](https://developers.facebook.com/documentation/instagram-platform/private-replies).

## Code map

| Module | Responsibility |
|---|---|
| `mcp.mjs`, `mcp-tools.mjs` | Authenticated Streamable HTTP MCP transport and account-scoped service tools |
| `server.mjs`, `runtime.mjs` | HTTP routes, session/CSRF security, startup and worker lifecycle |
| `accounts.mjs`, `connection.mjs`, `owner-config.mjs` | Account registry, token identity checks, private compatibility configuration |
| `integrations/meta.mjs` | Official Meta HTTP transport and normalized provider outcomes |
| `automation.mjs`, `campaigns.mjs` | Comment polling, durable deduplication, campaign activation/recovery |
| `publishing.mjs` | Scheduled publication and campaign creation |
| `content-workflow.mjs`, `scripts/content-workflow.mjs` | Private trend/slot reservations, generation receipts and agent scheduling CLI |
| `conversions.mjs` | Authenticated purchase/refund receipts and campaign attribution |
| `inbox.mjs`, `sales.mjs`, `llm-provider.mjs` | Inbound events, human takeover, catalog-grounded model decisions |
| `app.mjs`, `ui/api.mjs`, `index.html`, CSS | Dashboard controllers, account-scoped API client and UI |
| `simulator.mjs` | Isolated legacy demo; never sends Instagram messages |
| `tests/` | Synthetic core-flow, auth and data-safety checks |

The dashboard currently uses Portuguese, and scheduling uses São Paulo time. Agent content series can use a configured IANA time zone. Follower greetings and automatic comment likes remain unavailable; see the current [Meta eligibility evidence](docs/meta-setup.md). Comment campaigns poll on the server; incoming conversations use signed webhooks.

Private state is outside the served directory. New accounts live under `accounts/<id>/`; older installations may retain root-level state via private compatibility configuration. Never delete ledgers to fix a campaign: that can remove duplicate-send protection. See [security and data handling](docs/security.md).

## Capabilities and costs

Benion is a personal Instagram alternative to a subset of ManyChat, not a promise of every ManyChat feature or provider exemption. MIT makes this source free to use and modify; hosting, storage, model inference and Higgsfield generation can cost money. Your Codex subscription is not an OpenRouter/API credential, and Higgsfield access/credits must be configured separately. Never paste secrets into prompts or source files.

| Capability | Runs where | Boundary |
|---|---|---|
| Comment DM, fixed public replies, scheduled Reels | Benion server | Owned professional account, relevant permissions and provider limits; API acceptance is not delivery |
| Contextual FAQ/sales and Story replies | Benion server + configured model API | Signed inbound event, verified recipient, open 24-hour reply window; model grounding review may escalate to a human |
| Natural sales conversation | Configured model API + catalog | Uses conversation history and verified catalog facts. The model drafts and reviews the reply; this reduces unsupported claims but cannot guarantee model accuracy. You can take over at any time |
| Two daily content runs | Your coding agent's scheduler + Higgsfield | Optional owner-configured tasks, local computer availability if required by that scheduler, approved generation costs and publication authority |
| Token renewal | Benion server | Eligible long-lived, unexpired tokens only; revoked or expired credentials require owner reconnection |
| Coupon attribution | Product backend → Benion | The product implements eligibility, checkout and payment verification; an accepted DM is never counted as a purchase |
| New-follower welcome DM, automatic comment likes | Unavailable | No confirmed supported trigger/operation for this app; the UI cannot enable it |
| X/Twitter messages | External to Benion | No X connector is included |

The server recovers enabled campaigns and checks scheduled publications without Codex. The agent only prepares new content; it is not a second campaign monitor. Unknown send, generation or publishing outcomes stay blocked until reconciled with the provider. Open items and provider-blocked capabilities remain visible on the [project board](https://github.com/users/meunomeebero/projects/1).

## Contributing

Read [AGENTS.md](AGENTS.md). Keep changes small, use English identifiers/comments/docs, and preserve existing UI language. Run the relevant core-domain tests once after the change, for example `node --test tests/accounts.test.mjs tests/connection.test.mjs`. `npm test` runs the full suite before a release. Tests use synthetic transports; they do not prove delivery by Meta.

No automatic CI, external monitor or production credentials are included. The included Nunito fonts retain their OFL license. All other original project code is under [MIT](LICENSE).
