# Housio — Supabase + Stripe setup (built for volume)

This folder gets your backend production-ready and able to scale. Files:

- **schema.sql** — paste into Supabase → SQL Editor → Run. Tables, indexes, RLS, geo matching, automated lead creation, messaging/quotes/payments, founding-price enforcement, auto-profile trigger, seeded trades + Central Oregon ZIPs.
- **SETUP.md** — this file.

The Edge Functions now live in a proper Supabase project at the **repo root** (so the Supabase CLI can find them), not in this `backend/` folder:

- **`../supabase/config.toml`** — Supabase project config. Sets `project_id` and the per-function `verify_jwt` flags (see Step 4).
- **`../supabase/functions/stripe-webhook/index.ts`** — keeps your DB in sync with Stripe. Idempotent. Also enforces the founding $79 price and tracks Connect payments.
- **`../supabase/functions/geocode/index.ts`** — ZIP → lat/lng (free, no key) so matching works.
- **`../supabase/functions/create-checkout/index.ts`** — starts the pro's subscription checkout and locks the founding price server-side.
- **`../supabase/functions/stripe-connect/index.ts`** — pro payout onboarding + homeowner→pro in-app payments (Stripe Connect).

> The frontend stays no-build vanilla JS + the Supabase CDN. No bundler/npm is required for the website. The Edge Functions are Deno/TypeScript and are deployed with the Supabase CLI (no local build either).

---

## How the pieces fit

```
  Your site / app  ──►  Supabase Auth        (login, who you are)
        │                Supabase Postgres    (users, pros, projects, leads, reviews)
        │                Supabase Storage      (job photos, on a CDN)
        │
        └──► Stripe Checkout  ──► pro pays the monthly subscription
                   │
                   ▼
            Stripe Webhook  ──►  stripe-webhook.ts  ──►  writes `subscriptions` table
```

**Golden rule:** Stripe is the source of truth for billing. Your `subscriptions` table is just a fast local mirror that the webhook keeps updated. Never mark someone "paid" from the browser — only the webhook does that.

---

## Step 1 — Run the schema
Supabase dashboard → **SQL Editor** → paste all of `schema.sql` → **Run**. Re-running is safe.

## Step 2 — Configure Supabase for volume
1. **Upgrade to the Pro plan ($25/mo).** The free tier *pauses* your project after inactivity and caps connections — not viable for a live launch. Pro gives no pausing, daily backups, and more headroom.
2. **Use the connection pooler for any serverless/edge code.** In Project Settings → Database, use the **Transaction pooler** string (port **6543**), *not* the direct connection (5432). Direct connections run out fast under load; the pooler handles thousands.
3. **Turn on the Index Advisor** (Database → Advisors) and add anything it flags as you grow.
4. **Enable Point-in-Time Recovery** once you have real data you can't lose.

## Step 3 — Stripe: create the pro subscription
1. Stripe → **Product catalog** → add product **"Housio Pro"** with a **recurring monthly price** (e.g. $149/mo). Add a 90-day free trial for founding pros (Checkout supports `trial_period_days`).
2. Use **Stripe Checkout (subscription mode)** to collect payment — it's hosted, PCI-compliant, and scales for you. Don't build your own card form.
3. Turn on the **Customer Portal** (Settings → Billing → Customer portal) so pros manage/cancel their own subscription. Zero code for you.
4. Settings → Billing → **Smart Retries / dunning** ON, so failed payments auto-recover.
5. When a pro first checks out, save their `stripe_customer_id` onto their `pros` row.

## Step 4 — Deploy the Edge Functions
The CLI is not installed globally — use `npx supabase` (no install needed). Run everything from the **repo root** (where `supabase/` lives), not from `backend/`. Docker is **not** required for cloud deploy.

**JWT verification is configured in `supabase/config.toml`**, so you do **not** pass `--no-verify-jwt` on the command line — config is the single source of truth:
- `stripe-webhook`, `geocode` → `verify_jwt = false` (called by Stripe / the browser pre-auth)
- `create-checkout`, `stripe-connect` → `verify_jwt = true` (they verify the caller's Supabase JWT)

```powershell
# 1. Authenticate the CLI (interactive — opens a browser, run once per machine)
npx supabase login

# 2. Link this repo to the cloud project
npx supabase link --project-ref tsyibysbdhvftlayejad

# 3. Deploy each function (verify_jwt comes from supabase/config.toml)
npx supabase functions deploy stripe-webhook
npx supabase functions deploy geocode
npx supabase functions deploy create-checkout
npx supabase functions deploy stripe-connect
# (or deploy all at once: npx supabase functions deploy)

# 4. Shared secrets (set once; SUPABASE_URL/SERVICE_ROLE are auto-injected on Supabase).
#    STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are SECRET — paste your real values.
npx supabase secrets set `
  STRIPE_SECRET_KEY=sk_live_... `
  STRIPE_WEBHOOK_SECRET=whsec_... `
  STRIPE_PRODUCT_ID=prod_UhtcjMeCY4ScGY `
  SITE_URL=https://housioapp.com `
  PLATFORM_FEE_BPS=500
```
Then in Stripe → **Developers → Webhooks** add an endpoint pointing at the `stripe-webhook` URL, subscribed to:
`checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.payment_failed`,
and (for Connect) `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded`.
Test locally first with `stripe listen --forward-to <url>` and the Stripe CLI.

> **Flag vs config:** if you ever pass `--no-verify-jwt` on the CLI it overrides config for that one deploy, but mixing the two is what causes "why is my webhook 401-ing" surprises. Keep it all in `supabase/config.toml` and deploy with no JWT flags.

## Step 5 — Geocoding
The matching trigger needs a lat/lng for each project (and pro) ZIP. Two layers, no paid API:
1. **Seeded Central Oregon ZIPs** live in the `zip_geo` table (loaded by `schema.sql`) — these work offline/immediately.
2. **Anything else** is resolved on demand by the `geocode` function via the free [zippopotam.us](https://api.zippopotam.us) API, then cached back into `zip_geo`. The website calls `geocode` right before inserting a project, so the `match_project` trigger always has a point.

No API key is required. To swap in a commercial geocoder (Google/Mapbox) later, change the `fetch(...)` URL in `geocode.ts` and add its key to `supabase secrets`.

## Step 6 — How matching, billing, and founding pricing work
- **Matching (auto):** posting a project fires the `match_project` trigger → calls `pros_near()` → inserts up to **4** `leads` (the fairness cap). Pros must be `verified` and offer the trade. Onboarding auto-verifies for the demo; gate this on real verification in production.
- **Pay only when the customer replies:** the lead fee is **not** charged when a pro is matched or even when the pro messages first. The billable event is the **homeowner sending a message** on that lead — the `handle_new_message` trigger then sets `leads.charged = true` and `leads.price = trades.base_lead_price` exactly once. Pros can **Report bad lead** (`pro_update_lead` RPC) to flip the lead to `refunded` and un-charge it.
- **Founding $79 for life (enforced):** `enforce_pro_pricing` (DB trigger) locks `locked_price_cents = 7900` and `plan = 'founding'` on the pro row and makes it **impossible to raise** on any later update. `create-checkout` reads that locked price (ignoring the browser) to build the Stripe price, and `stripe-webhook` **down-corrects** the Stripe subscription back to the locked amount if Stripe ever reports a higher price for a founding pro.

## Step 7 — In-app payments (Stripe Connect)
1. Pros click **Set up payouts** in their dashboard → `stripe-connect { action:"onboard" }` creates an **Express** account and returns an onboarding link; the account id is stored on `pros.stripe_account_id`.
2. After a homeowner **accepts a quote** (project → `booked`), they click **Pay** → `stripe-connect { action:"pay" }` creates a **destination-charge PaymentIntent** with an `application_fee_amount` (your platform cut) and `transfer_data.destination` = the pro's account. A `payments` row is created and kept in sync by the webhook.
3. **Completing the card flow:** `stripe-connect` returns a `client_secret`. Mount Stripe.js **Payment Element** with it to actually collect the card (this is the one PCI-facing step). The current UI surfaces the `client_secret` and confirms the intent is ready; wiring the Payment Element widget is the remaining front-end step (kept as a documented stub so no card data ever touches your code paths). Homeowners are **never** charged platform/posting fees — only the agreed job price flows through.

---

## The volume checklist (the part you asked about)

### Supabase
- ✅ **Index every foreign key + filter/sort column.** Already in schema.sql. This is the single biggest scale lever — an un-indexed `WHERE` on a big table is what falls over first.
- ✅ **Pooler (6543) for serverless.** Avoids connection exhaustion.
- ✅ **Efficient RLS** using `(select auth.uid())` so it evaluates once per query, not once per row.
- ✅ **PostGIS + GIST index** for "pros near me" — stays fast at 100k+ pros (see `pros_near()`).
- ✅ **Paginate everything.** Always `LIMIT`; use keyset/cursor pagination (`where created_at < $cursor`), never large `OFFSET`.
- ✅ **Pro plan** so the project never pauses and you have connection headroom.
- ▢ **Read replicas** later if you get read-heavy (paid add-on).
- ▢ **Cache hot/static data** (trade list, pro profiles) instead of hitting the DB every request.

### Stripe
- ✅ **Idempotent webhook** (dedupes via the `stripe_events` table) — handles Stripe's retries safely.
- ✅ **Verify the webhook signature** every time.
- ✅ **Return 200 fast; 500 to request a retry.** Don't do slow work inline.
- ✅ **Checkout + Customer Portal** — let Stripe handle PCI, retries, scaling, and UI.
- ▢ **Idempotency keys** on any create-charge/customer calls you add later.
- ▢ **Treat Stripe as source of truth**; reconcile your DB from it, never the reverse.

## Never do this
- ❌ Put the **service-role key** or **Stripe secret key** in the website/app front-end. Server-side only.
- ❌ Trust the browser to set subscription status — only the webhook writes `subscriptions`.
- ❌ Ship a query without an index behind it once a table is large.

---

### In-app payments (homeowner → pro) — now scaffolded
Homeowner→pro payments run on **Stripe Connect** (Express accounts + destination charges + application fees) via `stripe-connect.ts`, synced by `stripe-webhook.ts`. See **Step 7**. The only remaining piece for a full PCI flow is mounting the Stripe.js Payment Element with the returned `client_secret`.

---

## What the website talks to
The single-file frontend (`index.html`, plus `pro.html` for public profiles) calls:
- **PostgREST tables/RPCs** directly with the anon key + RLS: `projects`, `leads`, `messages`, `quotes`, `reviews`, `pros`, `pro_trades`, and RPCs `pro_update_lead`.
- **Edge Functions** for anything privileged or external: `geocode`, `create-checkout`, `stripe-connect`.
- **Supabase Realtime** on `messages` for live chat (with a 4s polling fallback if Realtime is off).

Everything degrades gracefully: with placeholder keys the site is fully browsable and every action shows a friendly "add your keys" toast instead of erroring.
