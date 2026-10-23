# Connect your own Instagram account

This guide uses **Instagram Login** with your own Meta app. It was checked against Meta's official documentation on 2026-10-22. It avoids a shared developer app or a custom OAuth implementation.

## Eligibility

Use an Instagram **Business or Creator** account, not a consumer account. For accounts you own/manage and that have the required app role, Meta documents Standard Access. Connecting unrelated customers requires Advanced Access, App Review and Business Verification. Some features may still be restricted under Standard Access. Instagram Login does not require a linked Facebook Page. [Official overview](https://developers.facebook.com/documentation/instagram-platform/overview).

## Set up and connect

1. Run Benion locally, or deploy it over HTTPS using [deployment.md](deployment.md). Keep its dashboard open. Hosted incoming DMs require a publicly reachable webhook.
2. Open [Meta My Apps](https://developers.facebook.com/apps/) in your signed-in browser. Register as a developer if needed, then create an app with the Instagram messaging/content use case. Older dashboards may show **Other → Business** followed by adding the Instagram product. Follow the current screen; do not create a consumer-login integration by mistake.
3. Open **Instagram → API setup with Instagram Login**. Add your professional account. Where requested, add it as an Instagram tester/app role and accept the invitation while signed in as that exact Instagram account. The person administering the app and the authorized Instagram identity may be different accounts; verify both.
4. Select only the permissions needed below. Generate a token through the Instagram account row and complete the Instagram authorization. Passwords and 2FA stay in the provider's UI. The guide is based on [Meta's app setup](https://developers.facebook.com/documentation/instagram-platform/create-an-instagram-app).
5. In Benion choose **Conectar Instagram → Adicionar uma conta**. Enter the exact Instagram username and paste the token into the masked field. Click **Validar e adicionar conta**. Do not paste tokens into chat or a repository. The server verifies identity and stores the token privately; adding an account sends nothing and starts no campaign.
6. Choose **Verificar esta conta → Verificar acessos**. Inspect the per-operation results. An empty conversation sample is not evidence of missing permission. An authorization error needs the relevant permission/role/token corrected, not repeated send attempts.

| Feature | Instagram Login permissions |
|---|---|
| Identity/media and account setup | `instagram_business_basic` |
| Comment reads, public replies, initial comment-to-DM | `instagram_business_manage_comments` |
| Inbox and subsequent DM conversations | `instagram_business_manage_messages` |
| Publish scheduled Reels | `instagram_business_content_publish` |

Benion uses `graph.instagram.com`. Keep the Graph version shown in its account form unless the installed transport and current Meta docs require a different version. A token from another login product is not interchangeable.

## Receive DMs and Story interactions

Configure `BENION_META_APP_SECRET` and a random `BENION_META_VERIFY_TOKEN` in the host's private environment settings. In Meta, set the callback to `https://YOUR_HOST/webhooks/instagram` and enter the same verify token. Subscribe to the relevant Instagram message/comment events and the authorized account as required by the dashboard. Benion checks webhook signatures. Keep secrets out of screenshots, logs and messages.

After setup, use an owner-approved test account to send an inbound DM and confirm it appears under the correct account in **Conversas**. Do not enable the assistant before its catalog, provider and reply rules are reviewed. A successful webhook verification alone does not prove events are arriving.

## First campaign and renewal

Create a paused automation, choose an owned Reel (or all Reels), write the DM and optional public reply, then review and explicitly activate it. The activation baseline protects earlier comments. Test one new, consented comment and inspect the recorded result. Meta allows one initial private reply per comment within seven days; further messages require a recipient reply and the 24-hour window. Nonfollowers may receive it in Requests. [Private replies](https://developers.facebook.com/documentation/instagram-platform/private-replies).

Long-lived Instagram tokens normally last 60 days. Benion currently does not schedule token refresh. Before expiry, generate/refresh a token using Meta's supported process, then use **Renovar a conexão** for the same account and verify access. Preserve the account registry, campaign cutoffs and ledgers. A replacement token must not mean a new account or a replay of historical comments.

If permissions for your intended audience remain unavailable, confirm the account's app role and the exact access tier in Meta. Do not assume that publishing the code or switching app mode grants Advanced Access.
