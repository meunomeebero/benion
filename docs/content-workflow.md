# Agent content workflow

Benion publishes and runs comment campaigns on its server. Content generation runs in your authorized coding agent with the Higgsfield connector. This is an optional workflow: configuring it does not generate media, start a Codex task, spend credits, publish, or send DMs. Use [the reusable prompts](prompts.md) after reviewing your account, budget and publishing authorization.

## Configure one series per account

Connect your professional account and verify publication access using [Meta setup](meta-setup.md). Enable the Higgsfield connector in the agent and supply a confirmed character-sheet media ID. Keep configuration and credentials outside this repository. Create a private JSON configuration file with these fields, replacing the examples with your own approved content:

```json
{
  "seriesId": "e85c7a20-7bdc-430b-ae95-ec236ed77c0d",
  "product": {
    "name": "Example App",
    "facts": "Describe only verified product features and offers here.",
    "url": "https://example.com"
  },
  "character": { "id": "YOUR_CONFIRMED_MEDIA_ID", "type": "image_job" },
  "timeZone": "America/Sao_Paulo",
  "slots": ["12:00", "18:00"],
  "group": { "id": "0324bfbc-ecce-4d15-a45b-ae883db4d44b", "name": "Product Reels" },
  "caption": "Your approved caption, including the comment call to action.",
  "dmText": "Your approved message, without the link appended twice.",
  "dmLink": "https://example.com/trial"
}
```

Generate your own `seriesId` and `group.id` once with `node -e 'console.log(crypto.randomUUID())'`; preserve them across scheduled runs. An uploaded character uses `type: "media_input"`. The product facts guide the agent; the approved caption, message and link are stored verbatim. Coupons are offers only after your product backend actually implements them. No user-specific brand, email, affiliate or token is built into this workflow.

Set `BENION_ACCOUNT_ID` to the verified numeric account ID and `BENION_ORIGIN` for local mode (default `http://127.0.0.1:5197`). For a hosted server, `BENION_WORKFLOW_AUTH_FILE` must point to an absolute, owner-readable-only JSON file containing `origin` and `password`; create it directly in your secret manager or private editor, with permissions `0600`. Do not put its contents in shell arguments or chat. The CLI logs in privately, obtains CSRF protection, and scopes each request to the configured account. It prints only IDs, slots and status; it omits passwords, cookies, signed asset URLs and product text.

```sh
node scripts/content-workflow.mjs configure < /absolute/private/series.json
node scripts/content-workflow.mjs list
```

## One slot, from trend to scheduled Reel

The agent reads the current official Higgsfield tool instructions. Begin with `get_presets` using `source="genjutsu"` and `category="genjutsu-trending"`; never invent a trend or infer that browsing authorizes generation. Select an unused compatible preset from the returned order, using its exact canonical ID. Inspect the selected preset's readiness, required inputs and price. Generation requires confirmed character media and the owner's approved credit budget.

Every CLI command below reads JSON from stdin, preferably redirected from a private file. All requests are authenticated; the HTTP equivalents are under `/api/content-workflow`.

| CLI command | JSON input | Result |
|---|---|---|
| `reserve` | `{"trend":{"provider":"higgsfield-genjutsu","id":"genjutsu:CATALOG_ID"},"scheduledAt":"2026-11-01T15:00:00Z","title":"Approved Reel title"}` | Durable trend and local-time slot reservation; returns a stable `id`. Use the actual preset ID, not this example. |
| `start` | `{"id":"RESERVATION_UUID"}` | `mayGenerate:true` is the only permission to make one generation request. All later calls return false. |
| `generation` | `{"id":"RESERVATION_UUID","jobIds":["PROVIDER_JOB_ID"]}` | Persist all returned output job IDs immediately. |
| `asset` | `{"id":"RESERVATION_UUID","jobId":"PROVIDER_JOB_ID","videoUrl":"https://YOUR_DURABLE_VIDEO_URL"}` | Persist one verified completed output. |
| `schedule` | `{"id":"RESERVATION_UUID"}` | Schedule the Reel with its frozen caption/DM/link and campaign group. This enables future publication and its comment campaign. |
| `list` | None | Inspect reservations, unknown outcomes and publishing IDs. |

After `start` returns true, call the official `execute_preset` once with the selected preset and confirmed `character_sheet` input. Save `job_ids`, then resume those jobs with the connector's documented display/wait tools. Verify the output, copy/upload the completed MP4 to durable hosting through Benion's authenticated `/api/publishing/video` endpoint or the dashboard, then record that durable URL. Do not depend on an expiring provider URL for a future publication. If a preset produces multiple outputs, choose one and retain all job IDs; do not submit the preset again.

`scheduledAt` must be an ISO instant matching a configured local slot in the configured IANA time zone, at least a minute in the future. The agent schedules generation tasks 30 minutes before publication (for the example: 11:30 and 17:30 local time). Daylight-saving changes require converting the intended local time to the correct UTC instant. Repeated local-time slots on a clock-change day count once. Missed slots are not published late automatically: retain the known asset and report the missed slot for a deliberate new schedule.

## Recovery and boundaries

The account's private `content-workflow/` directory retains trend/slot reservations and immutable generation receipts. Concurrent runs claim the same canonical trend only once per account/series; editing a title or caption does not create a new identity. Do not change the series ID or delete reservations to force retries. Series IDs intentionally separate independent series; accounts remain isolated.

A restart with known job IDs resumes status polling. `generation_unknown` means the durable start claim exists but no job receipt was saved: inspect provider history and reconcile the original job IDs before continuing. A timeout or interrupted tool call is not evidence that generation failed. Never generate again or remove the claim merely because a run stalled. If there is no way to prove the result, leave it for attention. A known asset is reused without charging again.

Scheduling persists an immutable request before calling Benion publishing. Repeating `schedule` recovers a lost HTTP response using the same publication UUID and payload. `scheduled` confirms acceptance by Benion, not a live Instagram Reel, DM delivery or a sale. Check the existing publishing dashboard for publication and campaign state. Existing uncertain-publication protection still applies. The content workflow does not impersonate a provider queue, create coupons, bypass Meta eligibility or provide free provider credits.

Validation is synthetic: `node --test tests/content-workflow.test.mjs`. No live generation, spending, publication or DM is part of the test.
