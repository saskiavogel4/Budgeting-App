# CampusCash 🎓💸

A budgeting app built for college students. Connect your bank through [Plaid](https://plaid.com), set simple monthly budgets, and see how much you can **safely spend today**.

- **Overview**: safe-to-spend per day, money left this month, cash available, credit card balance, top spending categories, recent activity, and accounts
- **Activity**: searchable, filterable transaction history. Tap any transaction to recategorize it, or add cash/Venmo expenses by hand
- **Budgets**: student-friendly starter budgets (rent, groceries, eating out, books, subscriptions, fun…) that you can edit
- **Themes**: Light, Dark, and System (follows your device)
- **Responsive**: sidebar on desktop, icon rail on tablets, bottom tab bar on phones. Installable as a home-screen app
- **Demo mode**: try everything with realistic sample data, no bank or keys needed
- **Email + password sign-in**: create an account, sign in, and reset a forgotten password (Supabase Auth). Each user's data is kept separate

## How it works

```
public/                  Static site (HTML/CSS/JS, no build step)
netlify/functions/       Serverless API that talks to Plaid
  link-token.mjs         POST /api/link-token  → starts Plaid Link
  exchange.mjs           POST /api/exchange    → swaps public_token for an (encrypted) access token
  sync.mjs               POST /api/sync        → live balances + transactions
  remove.mjs             POST /api/remove      → disconnects a bank
  status.mjs             GET  /api/status      → is Plaid configured?
netlify/lib/plaid.mjs    Shared Plaid client + token encryption
netlify.toml             Netlify build, functions, and security headers
```

Your Plaid **secret never reaches the browser**. Plaid access tokens are encrypted (AES-256-GCM) by the functions before they're stored in the browser, so no database is needed. Budgets and cash expenses are saved in the browser's localStorage.

## Sign-in (Supabase)

Sign-in uses the Supabase project **CampusCash** (`uprmyehyzlyhqmlushok`). Its URL and publishable key are in `public/js/config.js`. The publishable key is meant to be public. The Supabase client library is bundled in `public/vendor/`, so nothing loads from a CDN.

- The Netlify Functions only work for signed-in users. They verify the Supabase session on every request.
- Each encrypted bank token is tied to the user who connected it.

**One-time setup in the Supabase dashboard** (Authentication → URL Configuration):

- **Site URL**: your Netlify URL, e.g. `https://your-site.netlify.app`
- **Redirect URLs**: add `https://your-site.netlify.app/**` (and `http://localhost:8888/**` for local dev)

The URL settings make sure links in confirmation and password-reset emails open your site.

**Email delivery:** New accounts must confirm their email, and password resets are sent by email. Supabase's built-in email sender only delivers to members of your Supabase organization's team, and only a few emails per hour. That's fine for personal use. To let anyone sign up, either:
- add a custom SMTP provider (e.g. Resend) under Authentication → Emails → SMTP Settings, or
- turn off **Confirm email** under Authentication → Sign In / Providers → Email, so new accounts can sign in right away. Password resets still need email.

## Plaid keys (required for real bank data)

Plaid is free to start, but it **does** require API keys:

1. Sign up at <https://dashboard.plaid.com/signup>.
2. Go to **Developers → Keys** and copy your `client_id` and **Sandbox** secret.
3. Choose an environment:
   - **`sandbox`**: free, fake test banks. Log in with `user_good` / `pass_good`. Use this first.
   - **`production`**: real banks and live data. You'll need to request production access in the Plaid Dashboard, and Plaid bills per connected account after its free tier.

Without keys the app still works in **demo mode**.

## Deploy to Netlify

1. In Netlify, choose **Add new site → Import an existing project** and pick this GitHub repo (branch `main`).
2. Netlify reads `netlify.toml` automatically. There's no build command; the publish directory is `public`.
3. Go to **Site configuration → Environment variables** and add:

   | Variable | Value |
   |---|---|
   | `PLAID_CLIENT_ID` | your Plaid client ID |
   | `PLAID_SECRET` | your Plaid secret (Sandbox or Production, matching `PLAID_ENV`) |
   | `PLAID_ENV` | `sandbox` or `production` |
   | `TOKEN_ENCRYPTION_KEY` | *(optional)* a long random string |

4. Trigger a redeploy (**Deploys → Trigger deploy**) so the functions pick up the variables.
5. Open the site → **Connect your bank**.

> If you change `TOKEN_ENCRYPTION_KEY` (or `PLAID_SECRET` when no key is set), previously connected banks will need to be reconnected.

## Run locally

```bash
npm install -g netlify-cli
cp .env.example .env        # fill in your Plaid keys
netlify dev                 # http://localhost:8888
```

Only want to see the UI? Serve the `public/` folder with any static server and use demo mode.

## Notes

- US banks only (`country_codes: ["US"]`).
- Anyone with your site's URL can use it to link *their own* bank with your Plaid keys. That's fine for personal use, but keep it in mind before sharing widely on a production plan.
- Data refreshes automatically when it's more than 15 minutes old, or tap the refresh button.
