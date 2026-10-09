# Care Loop

A marketing site and interactive demo for **Care Loop**, built from the Care Loop PRD. Care Loop gives a family caregiver one shared patient profile that assisting caregivers and physicians can open too.

- `/` is the marketing page, with an early-access sign-up form.
- `/app` is the app: sign in, profiles, Schedule, Medical History, Doctor's notes, Logs, and Care team & history. It has a 7-day free trial with no sign-up, then needs a $20/month Whop subscription.

## The demo app

The demo runs entirely in the browser. It has no backend, and **it is not for real patient information**.

- **Sign-in** takes any name and email, with no password. Signing in as an email that was invited to a profile accepts the invitation. Invitations expire after 7 days.
- **Roles and permissions** follow the PRD's proposed permissions table: family caregiver (owner), assisting caregiver and physician. These are enforced only in the browser. The real release must enforce them on the server (P2).
- **Each entry** stores its author and time from the signed-in person. The owner can see a history of changes, export the profile as JSON, and delete it along with its uploaded files.
- **Log entries** with a future date or time are refused, and overdue follow-ups are flagged.
- **Uploads** accept PDFs and images up to 20 MB. They are stored in IndexedDB in that browser only.
- **Saving** always shows whether it worked. When the browser is offline, nothing is saved.

To try the other roles, use "Explore a sample profile", then sign out and sign in as `maria@example.com` (assisting caregiver) or `dr.okafor@example.com` (physician).

## Free trial and subscription

- The 7-day trial starts the first time a browser opens `/app`. No sign-up or card is needed.
- After 7 days the app locks and links to the Whop checkout ($20/month, plan `plan_dIPsSbDYnGhzG`). After paying, Whop sends people back to `/app?subscribed=1`.
- To unlock, the visitor enters the email they used at checkout. `api/verify-subscription.js` asks Whop whether that email has an active membership on the plan. Access is re-checked every 3 days, so a cancelled subscription locks again.
- **Required:** set `WHOP_API_KEY` in Vercel to a Whop company API key that can read members (including email) and memberships. Without it, nobody can unlock after their trial.
- Optional: `WHOP_COMPANY_ID` and `WHOP_PLAN_ID` override the defaults.
- Limits of this early version: the trial and unlock are stored in the browser, so clearing site data restarts the trial (and erases the data). Anyone who knows a subscriber's email could unlock. Real accounts (R1) or "Sign in with Whop" would close both gaps.

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
# or, static pages only:
npx serve public      # then open /app.html
```
