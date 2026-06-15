// ════════════════════════════════════════════════════════════════
//  Housio — Stripe Connect (Supabase Edge Function)
//  In-app payments: homeowner pays a pro through Housio, we take a
//  small transparent platform fee, the rest goes to the pro's Connect
//  account. One function, three actions (POST { action, ... }):
//
//    "onboard"  → create/continue a pro's Express account + return an
//                 onboarding link (pros.stripe_account_id is stored).
//    "status"   → has the pro finished Connect onboarding? (charges_enabled)
//    "pay"      → homeowner creates a PaymentIntent for an accepted quote,
//                 with application_fee + transfer to the pro. Returns the
//                 client_secret for Stripe.js / Payment Element.
//
//  The `payments` row is created here (service role) and kept in sync
//  by stripe-webhook.ts via payment_intent.* events.
//
//  Deploy:  supabase functions deploy stripe-connect
//  Secrets: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//           SITE_URL, PLATFORM_FEE_BPS (e.g. 500 = 5%)
// ════════════════════════════════════════════════════════════════
import Stripe from "https://esm.sh/stripe@14?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-06-20" });
const siteUrl = Deno.env.get("SITE_URL") ?? "http://localhost:8000";
const feeBps = parseInt(Deno.env.get("PLATFORM_FEE_BPS") ?? "500", 10); // 5% default

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

    const { action, quote_id } = await req.json();

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

    // ── Homeowner: pay an accepted quote (destination charge) ────
    if (action === "pay") {
      const { data: quote } = await admin
        .from("quotes")
        .select("id, project_id, pro_id, amount_cents, status, projects(homeowner_id)")
        .eq("id", quote_id)
        .single();
      if (!quote) return json({ error: "Quote not found" }, 404);
      // Only the project's homeowner may pay, and only an accepted quote.
      if ((quote as any).projects?.homeowner_id !== user.id) return json({ error: "Not your project" }, 403);
      if (quote.status !== "accepted") return json({ error: "Accept the quote before paying" }, 400);

      const { data: pro } = await admin
        .from("pros").select("id, stripe_account_id").eq("id", quote.pro_id).single();
      if (!pro?.stripe_account_id) return json({ error: "This pro hasn't set up payouts yet" }, 400);

      const fee = Math.round((quote.amount_cents * feeBps) / 10000);
      const intent = await stripe.paymentIntents.create({
        amount: quote.amount_cents,
        currency: "usd",
        application_fee_amount: fee,
        transfer_data: { destination: pro.stripe_account_id },
        metadata: { quote_id: quote.id, project_id: quote.project_id, pro_id: pro.id, homeowner_id: user.id },
      });

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

      return json({ client_secret: intent.client_secret, amount_cents: quote.amount_cents, fee_cents: fee });
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
