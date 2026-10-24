# Reusable content prompts

These are replacement templates, not a recovered verbatim transcript of the creator's original private prompts. Replace bracketed values before use. Keep account IDs, media, commercial terms and secrets in your own private configuration; do not commit personal data. Review [the executable workflow](content-workflow.md) first.

## Character reference

Use this template when you explicitly want to create a character sheet. Supplying a reference or browsing options alone does not authorize a paid generation.

> Create a consistent fictional spokesperson for [PRODUCT]. Use the supplied [AUTHORIZED_REFERENCE] as the visual reference. Preserve the specified identity, facial proportions, hair, clothing and color palette across the character sheet. Clothing should show [APPROVED_DOMAIN_OR_LOGO] clearly and accurately. Aim for [VISUAL_STYLE], with clean lighting and a neutral background suitable for motion transfer. Do not add claims about the product or use a real person's identity without authorization. First show the model, required references, output options and price. Use [CONFIRMED_CHARACTER_MEDIA_ID] for future videos rather than generating a new character each time. The maximum authorized generation cost is [BUDGET]; stop before spending beyond it.

## Configure the two daily agent tasks

This prompt asks the coding agent to create the scheduled tasks using its built-in scheduler. It does not add a campaign-health monitor. The Benion server continues publication and comment processing independently of an open agent session.

> Read AGENTS.md, docs/content-workflow.md and docs/prompts.md. Configure my private Benion series from [ABSOLUTE_PRIVATE_CONFIG_PATH], for account [VERIFIED_ACCOUNT_ID], at [BENION_ORIGIN], using the protected authentication file already available in the environment. Never print credentials or signed URLs. Use your own built-in scheduling tool to create two recurring tasks at [FIRST_GENERATION_TIME] and [SECOND_GENERATION_TIME] in [IANA_TIME_ZONE], 30 minutes before the configured publication slots. The working directory is [BENION_CHECKOUT]. Do not use n8n. Put the complete per-run prompt below into each task, with the correct publication slot. Generations are authorized only within [MAX_CREDITS_PER_RUN] and [MAX_CREDITS_PER_DAY]. Publishing and the attached comment-to-DM campaign are [AUTHORIZED_OR_REVIEW_REQUIRED]. Confirm the actual scheduler entries and local-time interpretation. If the scheduler requires my computer to remain awake, state that clearly. Do not replace a missing scheduler with an external campaign monitor.

## Per-run orchestration

> Read AGENTS.md and docs/content-workflow.md. Work on account [VERIFIED_ACCOUNT_ID], series [SERIES_UUID], product/character configuration [ABSOLUTE_PRIVATE_CONFIG_PATH], for the next [LOCAL_PUBLICATION_SLOT] in [IANA_TIME_ZONE]. Confirm the stored account identity and configuration. Keep the existing approved caption, DM and link unchanged unless I explicitly approved a replacement. Interpret product facts and trend suitability with the model; do not use keyword classifiers.
>
> First run `node scripts/content-workflow.mjs list`. If this slot already has a reservation, resume it. Otherwise read the current Higgsfield Genjutsu trending catalog with `get_presets`, source `genjutsu`, category `genjutsu-trending`. Choose the highest-listed compatible unused trend based on the actual returned catalog. Do not invent popularity data. Use each canonical provider preset only once in this account/series. If no compatible unused preset exists, stop and explain; do not repeat a video to fill the slot.
>
> Reserve the exact canonical trend and UTC publication instant using `reserve`. Honor the reservation returned by the server: `reused:true` means resume that existing job, never create another video. Inspect the selected preset's published requirements and price, map the confirmed character reference into its supported input schema, and verify readiness. Stay within [MAX_CREDITS_PER_RUN] and [MAX_CREDITS_PER_DAY]; do not change the model or resolution to bypass those limits. If generation or publishing is not authorized, present the concrete plan and stop before that action.
>
> Before any generation request, call `start` with the reservation ID. Call `execute_preset` exactly once, and only when this call returns `mayGenerate:true`. Persist all returned output IDs immediately using `generation`. If `mayGenerate:false`, use stored job IDs and resume the documented provider status/wait flow. If no job IDs are recorded, investigate the original attempt in provider history. A timeout, missing response or restarted process never authorizes another paid generation. Reconcile the original IDs or leave the reservation for attention.
>
> Verify the completed video for the requested character, continuity, legibility and suitability. Retain one output, upload it to durable Benion video storage or other approved durable hosting, and record its existing provider job ID and video URL with `asset`. Reuse a recorded asset after interruption. Do not generate a replacement automatically. Inspect the frozen caption, DM and link before publication. Once publishing is authorized and the configured slot is still in the future, call `schedule`; retries must use this same reservation and payload. Benion creates the comment campaign after confirmed publication, using its fixed public-reply game and the configured DM.
>
> Report the canonical trend, generation job IDs, expected local publication time, Benion publication ID, approved caption and DM text, and any unresolved problem. Distinguish scheduled from published and API acceptance from delivery. Do not expose authentication files, cookies, tokens, signed asset URLs or lead data. If a run misses the slot, preserve the asset and report it rather than publishing late or spending again.

## First-run rehearsal

> Run the per-run workflow now in review mode. Look up the actual trending catalog and show the chosen unused trend, confirmed character reference, price, proposed caption, exact DM text/link and intended local publication time. Do not call `start`, generate, publish, activate a campaign or send a DM until the corresponding authorization is clear. If I authorize a paid video test, create one durable reservation, generate once, retain the completed asset and show the result. Leave publishing unscheduled unless I also authorized publication. Use the same reservation to continue after approval.
