// ════════════════════════════════════════════════════════════════
//  Housio — Auto-release held payments (Supabase Edge Function)
//
//  MONETIZATION v2 — after a pro marks a job complete, the homeowner
//  has 3 days to confirm. If they never respond, this scheduled job
//  captures the held PaymentIntent and pays the pro (same outcome as
//  stripe-connect action "release", but without a logged-in homeowner).
//
//  Flow:
//    1. release_due_payments() — list payments past auto_release_at
//    2. stripe.paymentIntents.capture() for each held PI
//    3. mark_payment_auto_released() — stamp confirmed_at + released_at
//       (payment_intent.succeeded webhook flips status → succeeded)
//
//  Deploy:  supabase functions deploy release-payments --no-verify-jwt
//  Secrets: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//           Optional: CRON_SECRET (Bearer token for manual/cron invokes)
//
//  Schedule (Supabase Dashboard → Edge Functions → release-payments):
//    Cron: 0 * * * *   (hourly — catches due payments within ~1 hour)
//    Or:   0 6 * * *   (daily at 06:00 UTC)
//    Authorization header: Bearer <SUPABASE_SERVICE_ROLE_KEY>
//    or Bearer <CRON_SECRET> if you set that secret.
// ════════════════════════════════════════════════════════════════
import Stripe from "https://esm.sh/stripe@14?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-06-20" });

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const auth = req.headers.get("Authorization") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const cronSecret = Deno.env.get("CRON_SECRET");
  const authorized =
    auth === `Bearer ${serviceKey}` ||
    (cronSecret != null && cronSecret !== "" && auth === `Bearer ${cronSecret}`);
  if (!authorized) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const { data: due, error: listErr } = await admin.rpc("release_due_payments");
    if (listErr) throw listErr;

    const results: { id: string; captured: boolean; error?: string }[] = [];

    for (const pay of due ?? []) {
      if (!pay.stripe_payment_intent_id) {
        results.push({ id: pay.id, captured: false, error: "no payment intent" });
        continue;
      }
      try {
        await stripe.paymentIntents.capture(pay.stripe_payment_intent_id);
        const { error: markErr } = await admin.rpc("mark_payment_auto_released", {
          _payment: pay.id,
        });
        if (markErr) throw markErr;
        results.push({ id: pay.id, captured: true });
      } catch (err) {
        results.push({ id: pay.id, captured: false, error: (err as Error).message });
      }
    }

    return new Response(
      JSON.stringify({ due: due?.length ?? 0, results }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
