// ════════════════════════════════════════════════════════════════
//  Housio — Geocode (Supabase Edge Function)
//  Turns a ZIP into lat/lng so pros_near() / the matching trigger
//  have a point to search from. Strategy:
//    1. Look in the zip_geo table first (free, instant, our seeded
//       Central Oregon ZIPs live here).
//    2. On a miss, call the free zippopotam.us API (no key needed)
//       and CACHE the result back into zip_geo for next time.
//  The browser calls this BEFORE inserting a project for any ZIP it
//  doesn't already know, so the matching trigger always has geo.
//
//  Deploy:  supabase functions deploy geocode --no-verify-jwt
//  Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-set on Supabase)
// ════════════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Service role bypasses RLS so we can cache new ZIPs into zip_geo.
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { zip } = await req.json();
    const z = String(zip ?? "").trim().slice(0, 5);
    if (!/^\d{5}$/.test(z)) {
      return json({ error: "Provide a 5-digit US ZIP" }, 400);
    }

    // 1. Cache hit?
    const { data: hit } = await supabase
      .from("zip_geo")
      .select("zip, city, lat, lng")
      .eq("zip", z)
      .maybeSingle();
    if (hit?.lat != null) return json({ zip: hit.zip, city: hit.city, lat: hit.lat, lng: hit.lng, cached: true });

    // 2. Free lookup (no API key). zippopotam.us returns place + lat/lng.
    const res = await fetch(`https://api.zippopotam.us/us/${z}`);
    if (!res.ok) return json({ error: "ZIP not found" }, 404);
    const body = await res.json();
    const place = body.places?.[0];
    if (!place) return json({ error: "ZIP not found" }, 404);

    const lat = parseFloat(place.latitude);
    const lng = parseFloat(place.longitude);
    const city = `${place["place name"]}, ${place["state abbreviation"]}`;

    // 3. Cache it (geo is filled by the column default + an explicit RPC-less
    //    update; we set geo via PostGIS through a SQL function call below).
    await supabase.from("zip_geo").upsert({ zip: z, city, lat, lng }).select();
    // Populate the geography column (st_makepoint(lng,lat)).
    await supabase.rpc("set_zip_geo_point", { _zip: z }).catch(() => {});

    return json({ zip: z, city, lat, lng, cached: false });
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
