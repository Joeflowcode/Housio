// ════════════════════════════════════════════════════════════════
//  Housio — Stripe webhook (Supabase Edge Function)
//  This is the single most volume-critical piece. It keeps your DB
//  in sync with Stripe and MUST be idempotent (Stripe retries + can
//  send events out of order).
//
//  Deploy:  supabase functions deploy stripe-webhook --no-verify-jwt
//  Secrets: supabase secrets set STRIPE_SECRET_KEY=...  \
//                                STRIPE_WEBHOOK_SECRET=... \
//                                SUPABASE_SERVICE_ROLE_KEY=...
// ════════════════════════════════════════════════════════════════
import Stripe from "https://esm.sh/stripe@14?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2024-06-20", // match your Stripe dashboard's API version
});
const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

// Service-role client BYPASSES RLS. This is trusted server code, so
// it's the only thing allowed to write the subscriptions table.
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  const body = await req.text();

  // 1. Verify the signature — never trust an unsigned webhook.
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig!, webhookSecret);
  } catch (err) {
    return new Response(`Bad signature: ${(err as Error).message}`, { status: 400 });
  }

  // 2. Idempotency: insert the event id. If it already exists, this is
  //    a duplicate delivery — ack 200 so Stripe stops retrying.
  const { error: dupe } = await supabase
    .from("stripe_events")
    .insert({ id: event.id, type: event.type });
  if (dupe) return new Response("duplicate ignored", { status: 200 });

  // 3. Process. On error we return 500 so Stripe retries later — and we
  //    remove the log row so the retry can reprocess cleanly.
  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub =
          event.type === "checkout.session.completed"
            ? await stripe.subscriptions.retrieve(
                (event.data.object as Stripe.Checkout.Session).subscription as string,
              )
            : (event.data.object as Stripe.Subscription);

        const proId = await proIdForCustomer(sub.customer as string);

        // ── Founding-price enforcement (server-side, $79 for life) ──
        // The DB is the source of truth for who is founding + their
        // locked price. If Stripe ever reports a higher price for a
        // founding pro, we DOWN-CORRECT the subscription back to the
        // locked amount so the promise can never silently break.
        const founding = await foundingLockFor(proId);
        const currentItem = sub.items.data[0];
        const currentAmount = currentItem?.price.unit_amount ?? null;
        if (
          founding?.founding_pro &&
          currentAmount != null &&
          founding.locked_price_cents != null &&
          currentAmount > founding.locked_price_cents
        ) {
          // Mint a price at the locked amount and swap the item to it.
          const corrected = await stripe.prices.create({
            currency: currentItem.price.currency,
            product: currentItem.price.product as string,
            recurring: { interval: "month" },
            unit_amount: founding.locked_price_cents,
          });
          await stripe.subscriptions.update(sub.id, {
            items: [{ id: currentItem.id, price: corrected.id }],
            proration_behavior: "none",
          });
        }

        await supabase
          .from("subscriptions")
          .upsert(
            {
              stripe_subscription_id: sub.id,
              stripe_customer_id: sub.customer as string,
              status: sub.status,
              plan: founding?.founding_pro ? "founding" : (currentItem?.price.nickname ?? "standard"),
              is_founding: !!founding?.founding_pro,
              locked_price_cents: founding?.locked_price_cents ?? currentAmount,
              current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
              pro_id: proId,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "stripe_subscription_id" },
          );
        break;
      }

      // ── Stripe Connect: homeowner → pro payments ────────────────
      case "payment_intent.succeeded":
      case "payment_intent.payment_failed":
      case "payment_intent.canceled": {
        const pi = event.data.object as Stripe.PaymentIntent;
        const status =
          event.type === "payment_intent.succeeded" ? "succeeded"
          : event.type === "payment_intent.canceled" ? "canceled"
          : "failed";
        await supabase
          .from("payments")
          .update({ status })
          .eq("stripe_payment_intent_id", pi.id);
        if (status === "succeeded" && pi.metadata?.project_id) {
          // Mark the booked job as completed once payment clears.
          await supabase.from("projects").update({ status: "completed" }).eq("id", pi.metadata.project_id);
          await supabase.rpc("increment_pro_jobs", { _pro: pi.metadata.pro_id }).catch(() => {});
        }
        break;
      }

      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        if (charge.payment_intent) {
          await supabase.from("payments").update({ status: "refunded" })
            .eq("stripe_payment_intent_id", charge.payment_intent as string);
        }
        break;
      }

      case "invoice.payment_failed":
        // Stripe Smart Retries / dunning handles re-attempts automatically.
        // Optionally flag the pro's account here.
        break;
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    await supabase.from("stripe_events").delete().eq("id", event.id); // allow retry
    return new Response(`handler error: ${(err as Error).message}`, { status: 500 });
  }
});

async function proIdForCustomer(customerId: string): Promise<string | null> {
  const { data } = await supabase
    .from("pros")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .single();
  return data?.id ?? null;
}

// The founding lock that drives server-side $79-for-life enforcement.
async function foundingLockFor(
  proId: string | null,
): Promise<{ founding_pro: boolean; locked_price_cents: number | null } | null> {
  if (!proId) return null;
  const { data } = await supabase
    .from("pros")
    .select("founding_pro, locked_price_cents")
    .eq("id", proId)
    .single();
  return data ?? null;
}
