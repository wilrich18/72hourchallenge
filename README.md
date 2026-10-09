# Care Loop

A marketing site and web app for **Care Loop**, built from the Care Loop PRD. Care Loop gives a family caregiver one shared patient profile that assisting caregivers and physicians can open too.

- `/` is the marketing page, with an early-access sign-up form.
- `/app` is the app: sign in, profiles, Schedule, Medical History, Doctor's notes, Logs, and Care team & history. People sign up for a 7-day free trial (no card), then need a $20/month Whop subscription.

## The app

Everything is stored on the server: accounts, care profiles and uploaded files. **It is not ready for real patient information yet** (see the privacy requirements in the PRD).

- **Roles and permissions** follow the PRD's permissions table (family caregiver/owner, assisting caregiver, physician). The browser checks them for friendly messages, and the server enforces them on every save (`api/_profiles.js`): each part of a profile can only be changed by a role allowed to change it, new entries must be signed by the person saving them, logs can't be edited once saved, and the change history is append-only.
- **Invitations:** the owner invites people by email. They get an email and accept by creating an account (or logging in) with that address. Accepting requires a confirmed email, so nobody can claim someone else's invitation. Invitations expire after 7 days.
- **Doctor links:** the owner can create a link (Care team tab, then Share with a doctor). A doctor who opens it and logs in with a confirmed email joins the profile as its physician. Links expire after 14 days, can be revoked, and only a hash of each link is stored.
- **Uploads:** PDFs and images up to 20 MB go straight from the browser to private Blob storage (`api/files.js` checks the uploader's role first). Downloads are only served to people on that profile. Deleting an upload or a profile deletes the stored files.
- **Saving** shows "Saving…", then "Saved" or a plain "Not saved" message. If someone else changed the profile in the meantime, the change is refused and the latest version is loaded. Offline, nothing is saved.

## AI features (Claude)

`api/ai.js` calls Claude (`claude-opus-5-5`) through the official Anthropic SDK, with server-side refusal fallbacks turned on (`fallbacks: "default"`), so a declined request is retried on Anthropic's recommended fallback model.

- **AI assistant tab** (after Care team & history), for everyone on the profile:
  - **Overview and next steps:** a summary of the last 7, 14 or 30 days, things to keep an eye on, suggested next steps (each can be turned into a follow-up), and questions for the doctor. Uses structured output.
  - **Ask Care Loop:** a chat that answers questions using the care profile, e.g. "Can she take ibuprofen with lisinopril?". It gives general information, never tells people to start, stop or change a dose, points them to the doctor or pharmacist, and tells them to call 911 for anything urgent. Chats stay in the browser tab (sessionStorage) and aren't saved to the profile.
- **Scan a prescription receipt** (Medical History, for family caregivers and physicians): a photo is shrunk in the browser, read by Claude, and shown as an editable list. Unclear lines are flagged and left unticked. Nothing is added until the person checks and confirms it. The photo isn't stored.
- **Language picker** (header of both pages, 31 languages, right-to-left for Arabic, Hebrew, Persian and Urdu): interface text is translated by Claude on demand, cached per language in Blob (`i18n/`) and in the browser. Text people typed (names, medications, notes, logs) is marked `translate="no"` and stays as written. The assistant answers in the chosen language.
- Each account can make 80 overview, chat and scan requests a day. Translation is cached, so each string is translated once per language.

## Accounts, free trial and subscription

- People create a Care Loop account (name, email, password of at least 10 characters). No credit card is needed. A confirmation email is sent, and a banner reminds them until they confirm.
- **Forgot password** emails a reset link that works for 1 hour. Setting a new password logs out every other device.
- **Login limit:** 5 wrong passwords within 15 minutes locks the account for 15 minutes.
- The 7-day free trial starts at sign-up. After it ends, the family caregiver needs an active $20/month Whop subscription (plan `plan_dIPsSbDYnGhzG`) to keep using Care Loop and to create profiles. People invited onto someone's care team (aides, nurses, doctors) use it free.
- "Continue to payment" calls `api/checkout.js`, which creates a Whop checkout tagged with the account's email, so the payment is matched to the account even if a different email is used at Whop. After paying, Whop sends people back to `/app?subscribed=1`. Subscription status is cached for 6 hours and can be re-checked on demand.

Server functions (6, within the Vercel Hobby limit of 12): `api/ai.js`, `api/auth.js` (`?action=signup|login|logout|me|verify|resend-verification|forgot|reset`), `api/profiles.js`, `api/files.js`, `api/checkout.js`, `api/early-access.js`. Shared code is in `api/_lib.js`, `api/_profiles.js` and `api/_sample.js`.

Storage: the private `careloop-accounts` Vercel Blob store holds `users/` (one JSON per account, passwords hashed with scrypt), `profiles/`, `access/` (which profiles each email can open) and `files/`. Sessions are signed, HttpOnly cookies that last 14 days.

`public/vendor/blob-upload.js` is the `upload()` function from `@vercel/blob/client`, bundled for the browser with esbuild (`--bundle --minify --format=iife --global-name=BlobClient --platform=browser`) from an entry file containing `export { upload } from "@vercel/blob/client";`.

Environment variables (Vercel, then Settings, then Environment Variables):

| Name | Required | What it's for |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | yes | Set automatically by the Blob store |
| `SESSION_SECRET` | yes | Signs login cookies |
| `RESEND_API_KEY` | yes, for email | Sends confirmation, password reset and invitation emails through [Resend](https://resend.com). Without it no emails go out, so nobody can confirm their email, reset a password, or accept an invitation or doctor link. |
| `EMAIL_FROM` | recommended | Sender, e.g. `Care Loop <hello@yourdomain.com>` on a domain verified in Resend. Defaults to Resend's test sender, which only delivers to your own Resend account email. |
| `WHOP_API_KEY` | yes, for payments | Whop company API key that can read members (including email) and memberships and create checkout configurations. Without it, nobody can get back in after their trial. |
| `WHOP_COMPANY_ID`, `WHOP_PLAN_ID` | no | Override the default business and plan |
| `ANTHROPIC_API_KEY` | yes, for AI | Claude API key from console.anthropic.com. Without it the AI tab, receipt scan and translations show "isn't set up yet" and the site stays in English. |

Not built yet: two-step sign-in, an audit log of who viewed what (P3), and a data-exposure plan (P9).

## Early-access sign-ups

`api/early-access.js` is a Vercel serverless function. It sends each sign-up as JSON (`{ email, role, submittedAt, source }`) to the URL in the **`EARLY_ACCESS_WEBHOOK_URL`** environment variable. That can be a Zapier, Make, Slack or Google Apps Script webhook. If the variable isn't set, the form tells the visitor the sign-up wasn't saved.

## Deploying to Vercel

1. Go to <https://vercel.com/new> and import this GitHub repository.
2. Leave the framework preset as **Other**. `vercel.json` already sets the output directory to `public` and needs no build step.
3. Optional: add `EARLY_ACCESS_WEBHOOK_URL` under Settings → Environment Variables, then redeploy.

Or deploy from the command line with `npx vercel` (preview) and `npx vercel --prod` (production).

## Running locally

```sh
npx vercel dev        # site + API function at http://localhost:3000
# needs `vercel link` and `vercel env pull` first, plus SESSION_SECRET in your shell
```
