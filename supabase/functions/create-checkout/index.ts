// ════════════════════════════════════════════════════════════════
//  Housio — Create Checkout (Supabase Edge Function)
//  Starts a Stripe Checkout (subscription mode) for a pro's monthly
//  plan, and ENFORCES founding pricing server-side:
//
//    • A pro flagged founding (pros.founding_pro / plan='founding')
//      is ALWAYS checked out at their locked_price_cents ($79). The
//      price the browser asks for is ignored — the DB is the source
//      of truth, so the $79-for-life promise can't be tampered with.
//    • Standard pros check out at $149.
//
//  We create the price on the fly from locked_price_cents so a pro's
//  rate is whatever was permanently locked on their row — never a
//  hard-coded Price the marketing team could bump later.
//
//  Deploy:  supabase functions deploy create-checkout
//  Secrets: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//           STRIPE_PRODUCT_ID (the "Housio Pro" product), SITE_URL
// ════════════════════════════════════════════════════════════════
import Stripe from "https://esm.sh/stripe@14?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, { apiVersion: "2024-06-20" });
const productId = Deno.env.get("STRIPE_PRODUCT_ID")!; // "Housio Pro"
const siteUrl = Deno.env.get("SITE_URL") ?? "http://localhost:8000";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // Identify the caller from their Supabase JWT (anon-key client passes it).
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await userClient.auth.getUser(authHeader.replace("Bearer ", ""));
    if (!user) return json({ error: "Not authenticated" }, 401);

    // Service-role read of the pro's locked price (the trust anchor).
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: pro } = await admin
      .from("pros")
      .select("id, founding_pro, plan, locked_price_cents, stripe_customer_id, business_name")
      .eq("profile_id", user.id)
      .single();
    if (!pro) return json({ error: "Complete pro onboarding first" }, 400);

    // SERVER-SIDE PRICE: trust the DB, not the request body.
    const unitAmount = pro.founding_pro ? 7900 : (pro.locked_price_cents ?? 14900);

    // Reuse or create the Stripe customer, and stamp it on the pro row.
    let customerId = pro.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        name: pro.business_name ?? undefined,
        metadata: { pro_id: pro.id, supabase_uid: user.id },
      });
      customerId = customer.id;
      await admin.from("pros").update({ stripe_customer_id: customerId }).eq("id", pro.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          product: productId,
          recurring: { interval: "month" },
          unit_amount: unitAmount,
          // Tag the price so the webhook can verify the founding lock.
          // (price_data nicknames aren't supported; metadata lives on the sub.)
        },
      }],
      subscription_data: {
        metadata: {
          pro_id: pro.id,
          is_founding: String(!!pro.founding_pro),
          locked_price_cents: String(unitAmount),
        },
      },
      success_url: `${siteUrl}/index.html?sub=success`,
      cancel_url: `${siteUrl}/index.html?sub=cancel`,
    });

    return json({ url: session.url });
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
