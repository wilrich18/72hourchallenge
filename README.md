# Care Loop

A marketing site and web app for **Care Loop**, built from the Care Loop PRD. Care Loop gives a family caregiver one shared patient profile that assisting caregivers and physicians can open too.

- `/` is the marketing page, with an early-access sign-up form.
- `/app` is the app: sign in, profiles, Schedule, Medical History, Doctor's notes, Logs, and Care team & history. People sign up for a 7-day free trial (no card), then need a $20/month Whop subscription.

## The app

Accounts and access are handled on the server (see below), but profile data is still saved in the browser. **It is not ready for real patient information.**

- **Invitations:** an account whose email was invited to a profile accepts the invitation on sign-in, on the same browser. Invitations expire after 7 days.
- **Roles and permissions** follow the PRD's proposed permissions table: family caregiver (owner), assisting caregiver and physician. These are enforced only in the browser. The real release must enforce them on the server (P2).
- **Each entry** stores its author and time from the signed-in person. The owner can see a history of changes, export the profile as JSON, and delete it along with its uploaded files.
- **Log entries** with a future date or time are refused, and overdue follow-ups are flagged.
- **Uploads** accept PDFs and images up to 20 MB. They are stored in IndexedDB in that browser only.
- **Saving** always shows whether it worked. When the browser is offline, nothing is saved.

To look around, use "Load a sample profile" on the profiles page.

## Accounts, free trial and subscription

- People create a Care Loop account (name, email, password of at least 10 characters) to use `/app`. No credit card is needed.
- The 7-day free trial starts when the account is created. After it ends, the server stops granting access until the account has an active $20/month Whop subscription (plan `plan_dIPsSbDYnGhzG`).
- "Continue to payment" calls `api/checkout.js`, which creates a Whop checkout tagged with the account's email, so the payment is matched to the account even if a different email is used at Whop. After paying, Whop sends people back to `/app?subscribed=1`.
- Subscription status is checked with Whop once the trial is over, cached for 6 hours, and re-checked on demand ("Check my subscription again").

API routes: `api/auth/signup.js`, `api/auth/login.js`, `api/auth/logout.js`, `api/auth/me.js`, `api/checkout.js`. Shared code is in `api/_lib.js`.

Accounts are stored as private JSON files in the `careloop-accounts` Vercel Blob store, one per account, with passwords hashed using scrypt. Sessions are signed, HttpOnly cookies that last 14 days.

Environment variables (Vercel → Settings → Environment Variables):

| Name | Required | What it's for |
|---|---|---|
| `BLOB_READ_WRITE_TOKEN` | yes | Set automatically by the Blob store |
| `SESSION_SECRET` | yes | Signs login cookies |
| `WHOP_API_KEY` | yes, for payments | Whop company API key that can read members (including email) and memberships and create checkout configurations. Without it, nobody can get back in after their trial. |
| `WHOP_COMPANY_ID`, `WHOP_PLAN_ID` | no | Override the default business and plan |

Not built yet: password reset by email, email verification, two-step sign-in, and login rate limiting. Profile data is still saved in each browser, so it doesn't follow an account to another device.

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
