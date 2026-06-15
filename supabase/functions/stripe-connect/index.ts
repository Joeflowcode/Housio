// ════════════════════════════════════════════════════════════════
//  Housio — Stripe Connect (Supabase Edge Function)
//
//  MONETIZATION v2 — "pay only when you get paid". Homeowner pays the
//  pro through Housio; we take a take rate (computed by the DB:
//  higher on a new customer, lower/zero on repeat, founding discount)
//  and the rest goes to the pro's Connect account.
//
//  The money is AUTHORIZED AND HELD at booking and only CAPTURED when
//  the job is done — that's our leakage control (no GPS, no required
//  photo). One function, five actions (POST { action, ... }):
//
//    "onboard"  → create/continue a pro's Express account + onboarding link.
//    "status"   → has the pro finished Connect onboarding? (charges_enabled)
//    "pay"      → homeowner authorizes (HOLDS) payment for an accepted
//                 quote, with the DB-computed application_fee + transfer
//                 to the pro. capture_method:'manual' — nothing is taken
//                 until the job is released. Returns the client_secret.
//    "complete" → pro marks the job done (optional photo). Starts the
//                 auto-release window. No money moves.
//    "release"  → homeowner confirms (or auto-release): CAPTURE the held
//                 PaymentIntent → pro gets paid, Housio keeps the fee.
//
//  The `payments` row is created by the DB trigger on quote acceptance
//  and kept in sync by stripe-webhook.ts via payment_intent.* events.
//
//  Deploy:  supabase functions deploy stripe-connect
//  Secrets: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//           SITE_URL, PLATFORM_FEE_BPS (fallback only; DB is source of truth)
// ════════════════════════════════════════════════════════════════
import Stripe from "https://esm.sh/stripe@14?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-06-20" });
const siteUrl = Deno.env.get("SITE_URL") ?? "http://localhost:8000";
const feeBps = parseInt(Deno.env.get("PLATFORM_FEE_BPS") ?? "1500", 10); // fallback only

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const { data: { user } } = await admin.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Not authenticated" }, 401);

    // User-context client: RPCs below (pro_mark_job_complete /
    // homeowner_confirm_job) read auth.uid() to authorize, so they must
    // be called with the caller's JWT, not the service role.
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { action, quote_id, payment_id, photo_url, note } = await req.json();

    // ── Pro: create/continue Connect Express onboarding ──────────
    if (action === "onboard" || action === "status") {
      const { data: pro } = await admin
        .from("pros").select("id, stripe_account_id").eq("profile_id", user.id).single();
      if (!pro) return json({ error: "Pro profile not found" }, 400);

      let acctId = pro.stripe_account_id;
      if (!acctId) {
        const acct = await stripe.accounts.create({
          type: "express",
          email: user.email ?? undefined,
          capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
          metadata: { pro_id: pro.id },
        });
        acctId = acct.id;
        await admin.from("pros").update({ stripe_account_id: acctId }).eq("id", pro.id);
      }

      if (action === "status") {
        const acct = await stripe.accounts.retrieve(acctId);
        return json({ charges_enabled: acct.charges_enabled, details_submitted: acct.details_submitted });
      }

      const link = await stripe.accountLinks.create({
        account: acctId,
        refresh_url: `${siteUrl}/index.html?connect=refresh`,
        return_url: `${siteUrl}/index.html?connect=done`,
        type: "account_onboarding",
      });
      return json({ url: link.url });
    }

    // ── Homeowner: AUTHORIZE & HOLD payment for an accepted quote ──
    //  Nothing is captured here — the card is held until the job is
    //  released. The fee comes from the DB (first-job vs repeat aware),
    //  falling back to PLATFORM_FEE_BPS only if the row/RPC is missing.
    if (action === "pay") {
      const { data: quote } = await admin
        .from("quotes")
        .select("id, project_id, pro_id, amount_cents, status, projects(homeowner_id)")
        .eq("id", quote_id)
        .single();
      if (!quote) return json({ error: "Quote not found" }, 404);
      if ((quote as any).projects?.homeowner_id !== user.id) return json({ error: "Not your project" }, 403);
      if (quote.status !== "accepted") return json({ error: "Accept the quote before paying" }, 400);

      const { data: pro } = await admin
        .from("pros").select("id, stripe_account_id").eq("id", quote.pro_id).single();
      if (!pro?.stripe_account_id) return json({ error: "This pro hasn't set up payouts yet" }, 400);

      // Prefer the fee already computed on the payment row at acceptance.
      const { data: existing } = await admin
        .from("payments")
        .select("id, platform_fee_cents")
        .eq("quote_id", quote.id)
        .maybeSingle();

      let fee = existing?.platform_fee_cents ?? null;
      if (fee == null) {
        const { data: f } = await admin.rpc("compute_platform_fee", {
          _homeowner: user.id, _pro: pro.id, _amount_cents: quote.amount_cents,
        });
        fee = f?.[0]?.fee_cents ?? Math.round((quote.amount_cents * feeBps) / 10000);
      }

      const intent = await stripe.paymentIntents.create({
        amount: quote.amount_cents,
        currency: "usd",
        capture_method: "manual", // HOLD now, capture on release
        application_fee_amount: fee,
        transfer_data: { destination: pro.stripe_account_id },
        metadata: { quote_id: quote.id, project_id: quote.project_id, pro_id: pro.id, homeowner_id: user.id },
      });

      if (existing?.id) {
        await admin.from("payments")
          .update({ stripe_payment_intent_id: intent.id, platform_fee_cents: fee })
          .eq("id", existing.id);
      } else {
        await admin.from("payments").upsert({
          project_id: quote.project_id,
          quote_id: quote.id,
          homeowner_id: user.id,
          pro_id: pro.id,
          amount_cents: quote.amount_cents,
          platform_fee_cents: fee,
          stripe_payment_intent_id: intent.id,
          status: "requires_payment",
        }, { onConflict: "stripe_payment_intent_id" });
      }

      return json({ client_secret: intent.client_secret, amount_cents: quote.amount_cents, fee_cents: fee });
    }

    // ── Pro: mark the job complete (photo OPTIONAL) ──────────────
    //  Starts the auto-release window. The RPC verifies the caller owns
    //  the job. No money moves until "release".
    if (action === "complete") {
      const { error } = await userClient.rpc("pro_mark_job_complete", {
        _payment: payment_id, _photo_url: photo_url ?? null, _note: note ?? null,
      });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // ── Homeowner: confirm done → CAPTURE the held payment ───────
    //  This is the moment the pro actually gets paid and Housio keeps
    //  its fee. Auto-release (release-payments Edge Function on a schedule)
    //  drives the same capture path if the homeowner never responds.
    if (action === "release") {
      const { data: pay } = await admin
        .from("payments")
        .select("id, homeowner_id, stripe_payment_intent_id, completed_at, released_at")
        .eq("id", payment_id)
        .single();
      if (!pay) return json({ error: "Payment not found" }, 404);
      if (pay.homeowner_id !== user.id) return json({ error: "Not your payment" }, 403);
      if (!pay.completed_at) return json({ error: "The pro hasn't marked this job complete yet" }, 400);
      if (pay.released_at) return json({ ok: true, already: true });

      if (pay.stripe_payment_intent_id) {
        await stripe.paymentIntents.capture(pay.stripe_payment_intent_id);
      }
      const { error } = await userClient.rpc("homeowner_confirm_job", { _payment: payment_id });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
