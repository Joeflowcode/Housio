-- ════════════════════════════════════════════════════════════════
--  Housio — Supabase schema, built to scale.
--  Paste into Supabase → SQL Editor → Run. Safe to re-run (idempotent).
-- ════════════════════════════════════════════════════════════════

-- ── Extensions ────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists postgis;   -- geo "pros near me" at scale
create extension if not exists pg_trgm;    -- fast fuzzy text search

-- ── Enums ─────────────────────────────────────────────────────────
do $$ begin create type user_role as enum ('homeowner','pro','admin');
exception when duplicate_object then null; end $$;
do $$ begin create type lead_status as enum ('sent','viewed','replied','won','lost','refunded');
exception when duplicate_object then null; end $$;
do $$ begin create type project_status as enum ('open','matching','quoted','booked','completed','cancelled');
exception when duplicate_object then null; end $$;
do $$ begin create type sub_status as enum ('trialing','active','past_due','canceled','incomplete');
exception when duplicate_object then null; end $$;

-- ── Profiles (1:1 with auth.users) ────────────────────────────────
create table if not exists profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  role       user_role not null default 'homeowner',
  full_name  text,
  email      text,
  phone      text,
  city       text default 'Bend',
  created_at timestamptz default now()
);

-- ── Trades (lookup) ───────────────────────────────────────────────
create table if not exists trades (
  id              serial primary key,
  name            text not null,
  slug            text unique not null,
  base_lead_price numeric(10,2) not null default 35
);

-- ── Pros ──────────────────────────────────────────────────────────
create table if not exists pros (
  id                 uuid primary key default uuid_generate_v4(),
  profile_id         uuid not null references profiles(id) on delete cascade,
  business_name      text,
  bio                text,
  zip                text,
  geo                geography(point,4326),  -- store as (lng,lat) for radius search
  radius_miles       int default 25,
  verified           boolean default false,
  background_check_status text default 'pending',  -- 'pending', 'passed', 'failed', 'expired'
  background_check_date timestamptz,
  founding_pro       boolean default false,
  rating             numeric(2,1) default 0,
  jobs_count         int default 0,
  stripe_customer_id text,                   -- optional paid tier / Stripe customer
  stripe_account_id  text,                   -- Stripe Connect payouts
  created_at         timestamptz default now()
);

-- pro <-> trade (many-to-many)
create table if not exists pro_trades (
  pro_id   uuid references pros(id) on delete cascade,
  trade_id int  references trades(id) on delete cascade,
  primary key (pro_id, trade_id)
);

-- ── Projects (homeowner requests) ─────────────────────────────────
create table if not exists projects (
  id           uuid primary key default uuid_generate_v4(),
  homeowner_id uuid not null references profiles(id) on delete cascade,
  trade_id     int references trades(id),
  details      text,
  zip          text,
  geo          geography(point,4326),
  status       project_status not null default 'matching',
  created_at   timestamptz default now()
);

-- ── Leads (a project matched to a pro; free to receive/respond) ───
create table if not exists leads (
  id         uuid primary key default uuid_generate_v4(),
  project_id uuid not null references projects(id) on delete cascade,
  pro_id     uuid not null references pros(id) on delete cascade,
  status     lead_status not null default 'sent',
  price      numeric(10,2),                  -- legacy/back-compat only
  charged    boolean default false,          -- legacy/back-compat only
  created_at timestamptz default now(),
  unique (project_id, pro_id)               -- a pro can't get the same lead twice
);

-- ── Reviews ───────────────────────────────────────────────────────
create table if not exists reviews (
  id           uuid primary key default uuid_generate_v4(),
  project_id   uuid references projects(id) on delete set null,
  pro_id       uuid not null references pros(id) on delete cascade,
  homeowner_id uuid not null references profiles(id) on delete cascade,
  rating       int not null check (rating between 1 and 5),
  body         text,
  created_at   timestamptz default now()
);

-- ── Optional paid-tier subscriptions (unused for free launch) ─────
create table if not exists subscriptions (
  id                     uuid primary key default uuid_generate_v4(),
  pro_id                 uuid references pros(id) on delete cascade,
  stripe_customer_id     text,
  stripe_subscription_id text unique,
  status                 sub_status not null default 'incomplete',
  plan                   text,
  current_period_end     timestamptz,
  updated_at             timestamptz default now()
);

-- ── Stripe event log (idempotency — dedupes webhook retries) ──────
create table if not exists stripe_events (
  id           text primary key,   -- Stripe event id
  type         text,
  processed_at timestamptz default now()
);

-- ════════════════════════════════════════════════════════════════
--  INDEXES — the #1 thing that lets you scale.
--  Postgres does NOT auto-index foreign keys. Index everything you
--  filter, sort, or join on.
-- ════════════════════════════════════════════════════════════════
create index if not exists idx_pros_profile     on pros(profile_id);
create index if not exists idx_pros_geo          on pros using gist(geo);
create index if not exists idx_pros_verified     on pros(verified);
create index if not exists idx_pro_trades_trade  on pro_trades(trade_id);
create index if not exists idx_pro_trades_pro    on pro_trades(pro_id);
create index if not exists idx_projects_owner    on projects(homeowner_id);
create index if not exists idx_projects_trade    on projects(trade_id);
create index if not exists idx_projects_status   on projects(status);
create index if not exists idx_projects_geo      on projects using gist(geo);
create index if not exists idx_projects_created  on projects(created_at desc);
create index if not exists idx_leads_pro_status  on leads(pro_id, status);
create index if not exists idx_leads_project     on leads(project_id);
create index if not exists idx_reviews_pro       on reviews(pro_id);
create index if not exists idx_subs_pro          on subscriptions(pro_id);

-- ════════════════════════════════════════════════════════════════
--  ROW LEVEL SECURITY — each user only touches their own data.
--  Note the (select auth.uid()) pattern: it's evaluated ONCE per
--  query instead of once per row — big perf win at volume.
-- ════════════════════════════════════════════════════════════════
alter table profiles      enable row level security;
alter table pros          enable row level security;
alter table pro_trades    enable row level security;
alter table projects      enable row level security;
alter table leads         enable row level security;
alter table reviews       enable row level security;
alter table subscriptions enable row level security;

-- profiles: read/update/insert your own row
create policy "own profile read"   on profiles for select using ( (select auth.uid()) = id );
create policy "own profile update" on profiles for update using ( (select auth.uid()) = id );
create policy "own profile insert" on profiles for insert with check ( (select auth.uid()) = id );

-- pros + their trades: PUBLIC read (marketplace listings); owner writes
create policy "pros public read" on pros for select using ( true );
create policy "pros owner write" on pros for all
  using ( profile_id = (select auth.uid()) )
  with check ( profile_id = (select auth.uid()) );
create policy "pro_trades read"  on pro_trades for select using ( true );
create policy "pro_trades owner" on pro_trades for all using (
  exists (select 1 from pros p where p.id = pro_id and p.profile_id = (select auth.uid())) );

-- projects: homeowner owns; matched pros can read theirs
create policy "projects homeowner" on projects for all
  using ( homeowner_id = (select auth.uid()) )
  with check ( homeowner_id = (select auth.uid()) );
create policy "projects matched pro read" on projects for select using (
  exists (select 1 from leads l join pros p on p.id = l.pro_id
          where l.project_id = projects.id and p.profile_id = (select auth.uid())) );

-- leads: pro sees own; homeowner sees leads on their projects
create policy "leads pro read" on leads for select using (
  exists (select 1 from pros p where p.id = pro_id and p.profile_id = (select auth.uid())) );
create policy "leads homeowner read" on leads for select using (
  exists (select 1 from projects pr where pr.id = project_id and pr.homeowner_id = (select auth.uid())) );

-- reviews: public read; homeowner writes their own
create policy "reviews public read"    on reviews for select using ( true );
create policy "reviews homeowner write" on reviews for insert with check ( homeowner_id = (select auth.uid()) );

-- optional paid-tier subscriptions: pro reads own. NO write policy on
-- purpose → only trusted server code can write here.
create policy "subs pro read" on subscriptions for select using (
  exists (select 1 from pros p where p.id = pro_id and p.profile_id = (select auth.uid())) );

-- ════════════════════════════════════════════════════════════════
--  Auto-create a profile row whenever someone signs up
-- ════════════════════════════════════════════════════════════════
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, email, role)
  values (
    new.id,
    new.raw_user_meta_data->>'full_name',
    new.email,
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'homeowner')
  );
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- ════════════════════════════════════════════════════════════════
--  Geo matching RPC — find up to 4 verified pros for a trade near a
--  point. Uses the GIST index, so it's fast even with 100k+ pros.
--  Caps at 4 = your fairness promise (no 8-way bidding wars).
-- ════════════════════════════════════════════════════════════════
create or replace function pros_near(_trade int, _lng float, _lat float, _miles int default 25)
returns setof pros language sql stable as $$
  select p.*
  from pros p
  join pro_trades pt on pt.pro_id = p.id
  where pt.trade_id = _trade
    and p.verified
    and st_dwithin(p.geo, st_makepoint(_lng,_lat)::geography, _miles * 1609.34)
  order by p.rating desc
  limit 4;
$$;

-- ── Seed the trades (Bend launch pricing) ─────────────────────────
insert into trades (name, slug, base_lead_price) values
  ('House Cleaning','house-cleaning',25),
  ('Vacation Rental Cleaning','vacation-rental-cleaning',30),
  ('Defensible Space & Fire Prep','defensible-space',45),
  ('Carpet Cleaning','carpet-cleaning',25),
  ('Power Washing','power-washing',25),
  ('Window Washing','window-washing',25),
  ('Gutter Cleaning','gutter-cleaning',25),
  ('Air Duct Cleaning','air-duct-cleaning',30),
  ('Junk Removal','junk-removal',25),
  ('Snow Removal','snow-removal',20),
  ('Plumbing','plumbing',35),
  ('HVAC','hvac',55),
  ('Electrical','electrical',45),
  ('Appliance Repair','appliance-repair',35),
  ('Handyman','handyman',35),
  ('Garage Door','garage-door',35),
  ('Locksmith','locksmith',30),
  ('Landscaping','landscaping',30),
  ('Lawn Care','lawn-care',25),
  ('Tree Service','tree-service',45),
  ('Irrigation & Sprinklers','irrigation',30),
  ('Fencing','fencing',40),
  ('Deck & Patio','deck-patio',45),
  ('Pool & Spa Service','pool-spa',35),
  ('Painting','painting',30),
  ('Roofing','roofing',75),
  ('Flooring','flooring',45),
  ('Drywall','drywall',35),
  ('Tile','tile',40),
  ('Siding','siding',55),
  ('Insulation','insulation',40),
  ('Concrete & Masonry','concrete-masonry',50),
  ('Cabinets & Countertops','cabinets-countertops',55),
  ('Windows & Doors','windows-doors',50),
  ('Solar','solar',75),
  ('Foundation & Waterproofing','foundation-waterproofing',65),
  ('Pest Control','pest-control',35),
  ('Home Inspection','home-inspection',35),
  ('Mold Remediation','mold-remediation',50),
  ('Security & Smart Home','security-smart-home',35),
  ('Movers','movers',40),
  ('Interior Design','interior-design',40),
  ('Chimney & Fireplace','chimney-fireplace',30)
on conflict (slug) do nothing;

-- ════════════════════════════════════════════════════════════════
-- ════════════════════════════════════════════════════════════════
--  MARKETPLACE ENGINE  (matching · messaging · quotes · payments)
--  Everything below is additive + idempotent — safe to re-run on top
--  of an already-deployed schema. It follows the same conventions:
--  serial/uuid PKs, indexed FKs, (select auth.uid()) RLS.
-- ════════════════════════════════════════════════════════════════

-- ── New enums ─────────────────────────────────────────────────────
do $$ begin create type quote_status as enum ('sent','accepted','declined','expired');
exception when duplicate_object then null; end $$;
do $$ begin create type pay_status as enum ('requires_payment','processing','succeeded','refunded','failed','canceled');
exception when duplicate_object then null; end $$;
do $$ begin create type pro_plan as enum ('founding','standard');
exception when duplicate_object then null; end $$;
do $$ begin create type verify_status as enum ('unverified','pending','verified','rejected');
exception when duplicate_object then null; end $$;

-- ── Pro onboarding + access columns (additive) ────────────────────
--  Housio access is free for pros. locked_price_cents remains for a
--  future optional paid tier, but the default and current enforced
--  value are 0 so joining, receiving leads, and messaging are free.
alter table pros add column if not exists plan               pro_plan      not null default 'founding';
alter table pros add column if not exists locked_price_cents int           not null default 0;
alter table pros add column if not exists phone              text;
alter table pros add column if not exists website            text;
alter table pros add column if not exists address            text;
alter table pros add column if not exists license_number     text;
alter table pros add column if not exists insured            boolean       not null default false;
alter table pros add column if not exists years_experience   int;
alter table pros add column if not exists verification       verify_status not null default 'unverified';
alter table pros add column if not exists reviews_count      int           not null default 0;
alter table pros add column if not exists onboarded_at       timestamptz;

-- One pro profile per user (lets onboarding upsert on profile_id).
do $$ begin
  alter table pros add constraint pros_profile_uniq unique (profile_id);
exception when duplicate_object then null; when duplicate_table then null; end $$;

-- ── Optional paid-tier columns (webhook-written if enabled later)
alter table subscriptions add column if not exists is_founding        boolean not null default false;
alter table subscriptions add column if not exists locked_price_cents int;

-- ── Lead pipeline columns. Leads/messages are free; these remain for
--     status history and compatibility with older deployed schemas.
alter table leads add column if not exists responded_at  timestamptz;
alter table leads add column if not exists refund_reason text;
alter table leads add column if not exists charged_at    timestamptz;

-- ── ZIP → lat/lng lookup (free geocoding for Central Oregon) ──────
--  The geocode Edge Function upserts unknown ZIPs here on demand, so
--  this stays the single source of truth the geo trigger reads from.
create table if not exists zip_geo (
  zip  text primary key,
  city text,
  lat  double precision,
  lng  double precision,
  geo  geography(point,4326)
);

-- ── Messages (threaded per lead = a homeowner⇄pro conversation) ───
create table if not exists messages (
  id         uuid primary key default uuid_generate_v4(),
  lead_id    uuid not null references leads(id) on delete cascade,
  sender_id  uuid not null references profiles(id) on delete cascade,
  body       text not null,
  read_at    timestamptz,
  created_at timestamptz default now()
);

-- ── Quotes (a pro's price + description on a project) ─────────────
create table if not exists quotes (
  id           uuid primary key default uuid_generate_v4(),
  lead_id      uuid references leads(id) on delete cascade,
  project_id   uuid not null references projects(id) on delete cascade,
  pro_id       uuid not null references pros(id) on delete cascade,
  amount_cents int  not null check (amount_cents >= 0),
  description  text,
  status       quote_status not null default 'sent',
  created_at   timestamptz default now(),
  unique (project_id, pro_id)              -- one live quote per pro per project
);

-- ── Payments (homeowner → pro via Stripe Connect; webhook-written) ─
create table if not exists payments (
  id                       uuid primary key default uuid_generate_v4(),
  project_id               uuid references projects(id) on delete set null,
  quote_id                 uuid references quotes(id) on delete set null,
  homeowner_id             uuid not null references profiles(id) on delete cascade,
  pro_id                   uuid not null references pros(id) on delete cascade,
  amount_cents             int  not null,
  platform_fee_cents       int  not null default 0,
  stripe_payment_intent_id text unique,
  status                   pay_status not null default 'requires_payment',
  created_at               timestamptz default now()
);

-- ════════════════════════════════════════════════════════════════
--  INDEXES for the new tables (same discipline as above)
-- ════════════════════════════════════════════════════════════════
create index if not exists idx_messages_lead     on messages(lead_id, created_at);
create index if not exists idx_messages_sender    on messages(sender_id);
create index if not exists idx_quotes_project     on quotes(project_id);
create index if not exists idx_quotes_pro          on quotes(pro_id);
create index if not exists idx_quotes_lead         on quotes(lead_id);
create index if not exists idx_payments_homeowner  on payments(homeowner_id);
create index if not exists idx_payments_pro        on payments(pro_id);
create index if not exists idx_payments_project    on payments(project_id);
create index if not exists idx_zip_geo_geo         on zip_geo using gist(geo);

-- ════════════════════════════════════════════════════════════════
--  ROW LEVEL SECURITY for the new tables
-- ════════════════════════════════════════════════════════════════
alter table messages enable row level security;
alter table quotes   enable row level security;
alter table payments enable row level security;
alter table zip_geo  enable row level security;

-- zip_geo: public read (geocoding lookups); writes only via service role
do $$ begin
  create policy "zip_geo public read" on zip_geo for select using ( true );
exception when duplicate_object then null; end $$;

-- messages: the two parties on a lead (project homeowner + matched pro)
-- can read the thread; either may post as themselves.
do $$ begin
  create policy "messages thread read" on messages for select using (
    exists (
      select 1 from leads l
      join projects pr on pr.id = l.project_id
      left join pros p on p.id = l.pro_id
      where l.id = messages.lead_id
        and ( pr.homeowner_id = (select auth.uid())
              or p.profile_id  = (select auth.uid()) )
    )
  );
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "messages thread write" on messages for insert with check (
    sender_id = (select auth.uid())
    and exists (
      select 1 from leads l
      join projects pr on pr.id = l.project_id
      left join pros p on p.id = l.pro_id
      where l.id = messages.lead_id
        and ( pr.homeowner_id = (select auth.uid())
              or p.profile_id  = (select auth.uid()) )
    )
  );
exception when duplicate_object then null; end $$;

-- quotes: public read (so homeowners compare); pro writes own; homeowner
-- of the project may update status (accept / decline).
do $$ begin
  create policy "quotes public read" on quotes for select using ( true );
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "quotes pro write" on quotes for insert with check (
    exists (select 1 from pros p where p.id = pro_id and p.profile_id = (select auth.uid())) );
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "quotes pro update" on quotes for update using (
    exists (select 1 from pros p where p.id = pro_id and p.profile_id = (select auth.uid())) );
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "quotes homeowner update" on quotes for update using (
    exists (select 1 from projects pr where pr.id = project_id and pr.homeowner_id = (select auth.uid())) );
exception when duplicate_object then null; end $$;

-- payments: each party reads its own. Writes are service-role only
-- (the Stripe Connect function / webhook) — no insert/update policy.
do $$ begin
  create policy "payments party read" on payments for select using (
    homeowner_id = (select auth.uid())
    or exists (select 1 from pros p where p.id = pro_id and p.profile_id = (select auth.uid())) );
exception when duplicate_object then null; end $$;

-- ════════════════════════════════════════════════════════════════
--  FREE ACCESS ENFORCEMENT (server-side)
--  • On insert: all pros get locked_price_cents = 0.
--  • On update: founding status cannot be revoked and the locked price
--    can never rise. Future paid tiers must be explicit and opt-in.
-- ════════════════════════════════════════════════════════════════
create or replace function enforce_pro_pricing()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.founding_pro or new.plan = 'founding' then
      new.founding_pro       := true;
      new.plan               := 'founding';
      new.locked_price_cents := 0;      -- free for life
    else
      new.plan               := 'standard';
      new.locked_price_cents := 0;      -- free access; paid tier is opt-in later
    end if;
  else -- UPDATE: founding status is irreversible + locked price can only go down
    if old.founding_pro then
      new.founding_pro       := true;
      new.plan               := 'founding';
      new.locked_price_cents := least(
        coalesce(new.locked_price_cents, old.locked_price_cents),
        old.locked_price_cents);
    end if;
  end if;
  return new;
end; $$;

drop trigger if exists trg_enforce_pro_pricing on pros;
create trigger trg_enforce_pro_pricing
  before insert or update on pros
  for each row execute function enforce_pro_pricing();

-- ════════════════════════════════════════════════════════════════
--  GEOCODING — set geo from the zip_geo lookup on insert/update.
--  Runs BEFORE the row is written, so pros_near() works immediately.
-- ════════════════════════════════════════════════════════════════
create or replace function set_geo_from_zip()
returns trigger language plpgsql set search_path = public as $$
declare g geography;
begin
  if new.zip is not null and new.geo is null then
    select geo into g from zip_geo where zip = left(new.zip, 5);
    if g is not null then new.geo := g; end if;
  end if;
  return new;
end; $$;

drop trigger if exists trg_projects_geo on projects;
create trigger trg_projects_geo
  before insert or update of zip on projects
  for each row execute function set_geo_from_zip();

drop trigger if exists trg_pros_geo on pros;
create trigger trg_pros_geo
  before insert or update of zip on pros
  for each row execute function set_geo_from_zip();

-- Helper the geocode Edge Function calls after caching a new ZIP, to
-- build the PostGIS geography point from the lat/lng it just stored
-- (PostgREST can't compute st_makepoint on its own).
create or replace function set_zip_geo_point(_zip text)
returns void language sql security definer set search_path = public as $$
  update zip_geo
     set geo = st_setsrid(st_makepoint(lng, lat), 4326)::geography
   where zip = _zip and lat is not null and lng is not null;
$$;

-- ════════════════════════════════════════════════════════════════
--  AUTOMATED MATCHING — when a project is posted, fan it out to up to
--  4 nearby verified pros (the fairness cap, enforced by pros_near).
--  Runs AFTER insert so the geo trigger has already populated geo.
-- ════════════════════════════════════════════════════════════════
create or replace function match_project()
returns trigger language plpgsql security definer set search_path = public as $$
declare r pros%rowtype; n int := 0;
begin
  if new.trade_id is null or new.geo is null then
    return new; -- nothing to match on yet (no trade or un-geocoded ZIP)
  end if;
  for r in
    select * from pros_near(
      new.trade_id,
      st_x(new.geo::geometry),
      st_y(new.geo::geometry),
      25)
  loop
    insert into leads(project_id, pro_id, status)
    values (new.id, r.id, 'sent')
    on conflict (project_id, pro_id) do nothing;
    n := n + 1;
  end loop;
  return new;
end; $$;

drop trigger if exists trg_match_project on projects;
create trigger trg_match_project
  after insert on projects
  for each row execute function match_project();

-- ════════════════════════════════════════════════════════════════
--  FREE LEAD MESSAGING.
--  A message from the project's homeowner moves the lead to 'replied'.
--  Leads and messages are free; Housio earns from completed
--  on-platform payments handled by Stripe Connect.
-- ════════════════════════════════════════════════════════════════
create or replace function handle_new_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_homeowner uuid;
begin
  select pr.homeowner_id
    into v_homeowner
  from leads l join projects pr on pr.id = l.project_id
  where l.id = new.lead_id;

  if new.sender_id = v_homeowner then
    update leads
       set status = 'replied',
           responded_at = coalesce(responded_at, now())
     where id = new.lead_id and status in ('sent','viewed');
  else
    -- pro (or other) replied first → just mark the lead viewed
    update leads set status = 'viewed'
     where id = new.lead_id and status = 'sent';
  end if;
  return new;
end; $$;

drop trigger if exists trg_handle_message on messages;
create trigger trg_handle_message
  after insert on messages
  for each row execute function handle_new_message();

-- ════════════════════════════════════════════════════════════════
--  QUOTES → project status transitions.
--  • New quote: project open/matching → 'quoted'.
--  • Accepted quote: project → 'booked', sibling quotes auto-declined,
--    and the winning lead is marked 'won'.
-- ════════════════════════════════════════════════════════════════
create or replace function handle_new_quote()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update projects set status = 'quoted'
   where id = new.project_id and status in ('open','matching');
  return new;
end; $$;

drop trigger if exists trg_handle_quote on quotes;
create trigger trg_handle_quote
  after insert on quotes
  for each row execute function handle_new_quote();

create or replace function handle_quote_accepted()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'accepted' and old.status <> 'accepted' then
    update projects set status = 'booked' where id = new.project_id;
    update quotes  set status = 'declined'
      where project_id = new.project_id and id <> new.id and status = 'sent';
    update leads set status = 'won'
      where project_id = new.project_id and pro_id = new.pro_id;
    update leads set status = 'lost'
      where project_id = new.project_id and pro_id <> new.pro_id
        and status not in ('refunded');
  end if;
  return new;
end; $$;

drop trigger if exists trg_quote_accepted on quotes;
create trigger trg_quote_accepted
  after update on quotes
  for each row execute function handle_quote_accepted();

-- ════════════════════════════════════════════════════════════════
--  Secure lead actions (RPC). A pro can decline a lead or report a
--  bad lead for refund WITHOUT a broad UPDATE policy that would let
--  them tamper with billing columns. Charging stays trigger-driven.
-- ════════════════════════════════════════════════════════════════
create or replace function pro_update_lead(_lead uuid, _status lead_status, _reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from leads l join pros p on p.id = l.pro_id
    where l.id = _lead and p.profile_id = (select auth.uid())
  ) then
    raise exception 'not your lead';
  end if;
  update leads
     set status        = _status,
         refund_reason = coalesce(_reason, refund_reason)
   where id = _lead;
end; $$;

-- ════════════════════════════════════════════════════════════════
--  REVIEWS → keep pros.rating + reviews_count denormalized & fast.
-- ════════════════════════════════════════════════════════════════
create or replace function refresh_pro_rating()
returns trigger language plpgsql security definer set search_path = public as $$
declare _pro uuid := coalesce(new.pro_id, old.pro_id);
begin
  update pros p set
    rating = coalesce((select round(avg(rating)::numeric,1) from reviews where pro_id = _pro), 0),
    reviews_count = (select count(*) from reviews where pro_id = _pro)
  where p.id = _pro;
  return coalesce(new, old);
end; $$;

drop trigger if exists trg_refresh_pro_rating on reviews;
create trigger trg_refresh_pro_rating
  after insert or update or delete on reviews
  for each row execute function refresh_pro_rating();

-- Bump a pro's completed-jobs counter (called by the webhook when a
-- Connect payment for a booked job succeeds).
create or replace function increment_pro_jobs(_pro uuid)
returns void language sql security definer set search_path = public as $$
  update pros set jobs_count = jobs_count + 1 where id = _pro;
$$;

-- ════════════════════════════════════════════════════════════════
--  Public pro-profile view — safe aggregate for profile pages, no
--  PII (no phone/address/stripe ids). Joins trades for display.
-- ════════════════════════════════════════════════════════════════
-- city_label is optional friendly display text (e.g. "Bend, OR").
alter table pros add column if not exists city_label text;

create or replace view pro_public as
  select p.id, p.business_name, p.bio, p.zip, p.city_label,
         p.radius_miles, p.verified, p.verification, p.founding_pro,
         p.rating, p.jobs_count, p.reviews_count, p.website,
         pr.full_name as owner_name, p.created_at
  from pros p
  join profiles pr on pr.id = p.profile_id;

-- ── Realtime: stream new messages to open conversations ───────────
do $$ begin
  alter publication supabase_realtime add table messages;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table leads;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table quotes;
exception when duplicate_object then null; when undefined_object then null; end $$;

-- ════════════════════════════════════════════════════════════════
--  Seed Central Oregon ZIP centroids (free, offline geocoding).
--  The geocode Edge Function adds any others on demand.
-- ════════════════════════════════════════════════════════════════
insert into zip_geo (zip, city, lat, lng) values
  ('97701','Bend',         44.0790, -121.2920),
  ('97702','Bend',         44.0021, -121.3389),
  ('97703','Bend',         44.1101, -121.3850),
  ('97707','Bend/Sunriver',43.8762, -121.5050),
  ('97708','Bend',         44.0582, -121.3153),
  ('97709','Bend',         44.0582, -121.3153),
  ('97756','Redmond',      44.2726, -121.1739),
  ('97759','Sisters',      44.2909, -121.5489),
  ('97739','La Pine',      43.6704, -121.5045),
  ('97754','Prineville',   44.2998, -120.8345),
  ('97760','Terrebonne',   44.3515, -121.1761),
  ('97753','Powell Butte', 44.2326, -120.9536),
  ('97741','Madras',       44.6334, -121.1295),
  ('97734','Culver',       44.5251, -121.2128),
  ('97730','Camp Sherman', 44.4593, -121.6403),
  ('97737','Crescent',     43.4632, -121.6850),
  ('97733','Crescent Lake',43.5260, -121.9870),
  ('97712','Brothers',     43.8052, -120.6020),
  ('97751','Post',         44.1110, -120.3300),
  ('97752','Powell Butte', 44.2326, -120.9536)
on conflict (zip) do nothing;

-- Backfill the geography column for any ZIP rows missing it.
update zip_geo
   set geo = st_setsrid(st_makepoint(lng, lat), 4326)::geography
 where geo is null and lat is not null and lng is not null;

-- ════════════════════════════════════════════════════════════════
-- ════════════════════════════════════════════════════════════════
--  MONETIZATION v2 — "free to join, pay only when you get paid"
--
--  The model, in one breath: launch/founding pros are free for life,
--  leads & messages are FREE for everyone (no pay-per-lead, ever), and
--  Housio's ONLY revenue is a take rate on jobs that are completed AND
--  paid on-platform (homeowner → pro via Stripe Connect). We take a
--  higher rate on the FIRST job with a new customer (that's the intro
--  we delivered) and a lower rate on repeat work (we already got paid
--  for the acquisition — this is what keeps pros from leaving).
--
--  Leakage control is NOT surveillance (no GPS, no mandatory photo).
--  It's structural, exactly like TaskRabbit / Airbnb:
--    • the homeowner's card is authorized at booking and held by us,
--    • the buyer guarantee + reviews + ranking only apply to on-platform
--      paid jobs (so the homeowner WANTS to pay through Housio),
--    • a completion photo is OPTIONAL dispute evidence, never a gate.
--
--  Everything below is additive + idempotent — safe to re-run on top
--  of the schema above. The function definitions restate the current
--  model so older deployed schemas are repaired when this file runs.
-- ════════════════════════════════════════════════════════════════

-- ── 1. Pros are FREE to join ──────────────────────────────────────
--  Founding/launch pros lock at $0, standard pros also lock at $0, and
--  any future paid tier must be opt-in rather than a gate to leads.
create or replace function enforce_pro_pricing()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.founding_pro or new.plan = 'founding' then
      new.founding_pro       := true;
      new.plan               := 'founding';
      new.locked_price_cents := 0;      -- free for life
    else
      new.plan               := 'standard';
      new.locked_price_cents := 0;      -- access is free; paid tier is opt-in later
    end if;
  else -- UPDATE: founding can never be revoked; locked price can only fall
    if old.founding_pro then
      new.founding_pro       := true;
      new.plan               := 'founding';
      new.locked_price_cents := least(
        coalesce(new.locked_price_cents, old.locked_price_cents),
        old.locked_price_cents);
    end if;
  end if;
  return new;
end; $$;

-- ── 2. Leads & messages are FREE ──────────────────────────────────
--  Keep lead status transitions (sent → viewed → replied), but never
--  charge the pro for a message. base_lead_price is kept only for
--  reporting/back-compat.
create or replace function handle_new_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_homeowner uuid;
begin
  select pr.homeowner_id into v_homeowner
  from leads l join projects pr on pr.id = l.project_id
  where l.id = new.lead_id;

  if new.sender_id = v_homeowner then
    -- homeowner engaged: advance the lead, but DO NOT charge the pro
    update leads set status = 'replied'
     where id = new.lead_id and status in ('sent','viewed');
  else
    update leads set status = 'viewed'
     where id = new.lead_id and status = 'sent';
  end if;
  return new;
end; $$;

-- ── 3. Platform take-rate configuration (single source of truth) ──
--  Basis points (bps): 1500 = 15.00%. We charge more on a new-customer
--  job than on repeat work, and founding pros get a permanent discount.
--  Stored in a 1-row table so you can tune rates without a deploy.
create table if not exists platform_fees (
  id                  int  primary key default 1 check (id = 1),
  first_job_bps       int  not null default 1500,  -- 15% on a NEW customer
  repeat_bps          int  not null default 500,   -- 5% on repeat work
  founding_first_bps  int  not null default 1000,  -- founding: 10% on new
  founding_repeat_bps int  not null default 0,     -- founding: free on repeat
  updated_at          timestamptz not null default now()
);
insert into platform_fees (id) values (1) on conflict (id) do nothing;

-- ── 4. Payment lifecycle columns (authorize → complete → release) ─
alter table payments add column if not exists is_first_job        boolean;
alter table payments add column if not exists take_rate_bps       int;
alter table payments add column if not exists authorized_at       timestamptz; -- card held at booking
alter table payments add column if not exists completed_at        timestamptz; -- pro marked done
alter table payments add column if not exists confirmed_at        timestamptz; -- homeowner approved
alter table payments add column if not exists released_at         timestamptz; -- payout sent to pro
alter table payments add column if not exists auto_release_at     timestamptz; -- release-by if no response
alter table payments add column if not exists completion_photo_url text;       -- OPTIONAL evidence only
alter table payments add column if not exists completion_note     text;

create index if not exists idx_payments_auto_release
  on payments(auto_release_at) where released_at is null and completed_at is not null;

-- ── 5. Fee + first-job computation ────────────────────────────────
--  "First job" = no prior SUCCEEDED on-platform payment between this
--  exact homeowner↔pro pair. Founding pros use the discounted rates.
create or replace function compute_platform_fee(
  _homeowner uuid, _pro uuid, _amount_cents int
) returns table(is_first boolean, bps int, fee_cents int)
language plpgsql stable security definer set search_path = public as $$
declare _founding boolean; _first boolean; _bps int; _cfg platform_fees%rowtype;
begin
  select * into _cfg from platform_fees where id = 1;
  select coalesce(founding_pro, false) into _founding from pros where id = _pro;

  _first := not exists (
    select 1 from payments
     where homeowner_id = _homeowner and pro_id = _pro and status = 'succeeded'
  );

  if _founding then
    _bps := case when _first then _cfg.founding_first_bps else _cfg.founding_repeat_bps end;
  else
    _bps := case when _first then _cfg.first_job_bps else _cfg.repeat_bps end;
  end if;

  return query select _first, _bps, floor(_amount_cents * _bps / 10000.0)::int;
end; $$;

-- ── 6. Quote accepted → create the HELD payment record ────────────
--  Extends (does not replace) the booking flow: when a quote is
--  accepted, we create a payment row in 'requires_payment' with the
--  fee already computed. The Connect Edge Function reads this row to
--  authorize/hold the homeowner's card; the webhook flips status as
--  Stripe confirms. We only insert if one doesn't already exist.
create or replace function create_payment_on_acceptance()
returns trigger language plpgsql security definer set search_path = public as $$
declare _homeowner uuid; _fee record;
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    select homeowner_id into _homeowner from projects where id = new.project_id;

    if not exists (select 1 from payments where quote_id = new.id) then
      select * into _fee from compute_platform_fee(_homeowner, new.pro_id, new.amount_cents);
      insert into payments (
        project_id, quote_id, homeowner_id, pro_id,
        amount_cents, platform_fee_cents, take_rate_bps, is_first_job, status
      ) values (
        new.project_id, new.id, _homeowner, new.pro_id,
        new.amount_cents, _fee.fee_cents, _fee.bps, _fee.is_first, 'requires_payment'
      );
    end if;
  end if;
  return new;
end; $$;

drop trigger if exists trg_payment_on_acceptance on quotes;
create trigger trg_payment_on_acceptance
  after update on quotes
  for each row execute function create_payment_on_acceptance();

-- ── 7. Completion → confirmation → release ────────────────────────
--  pro_mark_job_complete: pro taps "done" (photo OPTIONAL). Starts a
--  3-day auto-release window so the pro is never held hostage.
create or replace function pro_mark_job_complete(
  _payment uuid, _photo_url text default null, _note text default null
) returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from payments pay join pros p on p.id = pay.pro_id
    where pay.id = _payment and p.profile_id = (select auth.uid())
  ) then
    raise exception 'not your job';
  end if;

  update payments
     set completed_at         = coalesce(completed_at, now()),
         completion_photo_url  = coalesce(_photo_url, completion_photo_url),
         completion_note       = coalesce(_note, completion_note),
         auto_release_at       = coalesce(auto_release_at, now() + interval '3 days')
   where id = _payment and released_at is null;
end; $$;

--  homeowner_confirm_job: one-tap approval → marks ready for payout.
--  The Connect Edge Function / webhook performs the actual transfer
--  and flips status to 'succeeded'; here we record the confirmation
--  and stamp released_at so payouts can be captured.
create or replace function homeowner_confirm_job(_payment uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from payments where id = _payment and homeowner_id = (select auth.uid())
  ) then
    raise exception 'not your payment';
  end if;

  update payments
     set confirmed_at = coalesce(confirmed_at, now()),
         released_at  = coalesce(released_at, now())
   where id = _payment and completed_at is not null and released_at is null;
end; $$;

--  release_due_payments: read-only list for the release-payments Edge
--  Function (scheduled daily/hourly). Returns held payments past the
--  auto-release window; the function CAPTUREs each PI via Stripe, then
--  stamps released_at. Do NOT mark released here — capture must succeed
--  first (same order as stripe-connect "release").
create or replace function release_due_payments()
returns setof payments language sql stable security definer set search_path = public as $$
  select * from payments
   where released_at is null
     and completed_at is not null
     and auto_release_at is not null
     and auto_release_at <= now()
     and status not in ('refunded', 'failed', 'canceled');
$$;

--  mark_payment_auto_released: service-role only (Edge Function). Called
--  after a successful Stripe capture when the homeowner never confirmed.
create or replace function mark_payment_auto_released(_payment uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update payments
     set confirmed_at = coalesce(confirmed_at, now()),
         released_at  = coalesce(released_at, now())
   where id = _payment
     and completed_at is not null
     and released_at is null;
end; $$;

-- ════════════════════════════════════════════════════════════════
--  ANTI-CIRCUMVENTION — mask contact info in messages before booking.
--  While a project is still pre-booking (status not booked/completed),
--  phone numbers, emails, and off-platform payment handles are replaced
--  before the row is stored. After on-platform payment the thread can
--  show contact info freely.
-- ════════════════════════════════════════════════════════════════
create or replace function mask_contact_info(_text text)
returns text language plpgsql immutable set search_path = public as $$
declare _out text := coalesce(_text, '');
begin
  if _out = '' then return _out; end if;

  -- Email addresses
  _out := regexp_replace(_out,
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}',
    '[email hidden]', 'gi');

  -- US phone numbers: (555) 555-5555, 555-555-5555, +1 555 555 5555, etc.
  _out := regexp_replace(_out,
    '(\+?1[[:space:].-]?)?(\([0-9]{3}\)|[0-9]{3})[[:space:].-]?[0-9]{3}[[:space:].-]?[0-9]{4}',
    '[phone hidden]', 'g');

  -- Venmo / Cash App / Zelle / PayPal handles and links
  _out := regexp_replace(_out,
    '(venmo|cash[[:space:]]*app|cashapp|zelle|paypal)([[:space:]]*[:@]|[[:space:]]+(is|me|at))?[[:space:]]*[@$]?[\w.-]+',
    '[payment app hidden]', 'gi');
  _out := regexp_replace(_out,
    '(venmo\.com|paypal\.me)/[\w.-]+',
    '[payment app hidden]', 'gi');
  _out := regexp_replace(_out,
    '\$[a-z][\w.-]{2,}',
    '[payment app hidden]', 'gi');

  return _out;
end; $$;

create or replace function mask_message_contact_info()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_status project_status;
begin
  select pr.status into v_status
  from leads l join projects pr on pr.id = l.project_id
  where l.id = new.lead_id;

  if v_status is null or v_status not in ('booked', 'completed') then
    new.body := mask_contact_info(new.body);
  end if;
  return new;
end; $$;

drop trigger if exists trg_mask_message_contact on messages;
create trigger trg_mask_message_contact
  before insert on messages
  for each row execute function mask_message_contact_info();

-- ── 8. Reviews are earned, not free — gate to a real paid job ─────
--  A homeowner can only review a pro they actually paid on-platform.
--  This makes reviews trustworthy AND gives pros a concrete reason to
--  keep jobs on Housio: off-platform jobs build no reputation here.
drop policy if exists "reviews homeowner write" on reviews;
do $$ begin
  create policy "reviews homeowner write" on reviews for insert with check (
    homeowner_id = (select auth.uid())
    and exists (
      select 1 from payments pay
      where pay.homeowner_id = (select auth.uid())
        and pay.pro_id      = reviews.pro_id
        and pay.status      = 'succeeded'
    )
  );
exception when duplicate_object then null; end $$;

-- ── 9. Count a completed job when its payment succeeds ────────────
--  Keeps pros.jobs_count accurate off the real billable event.
create or replace function bump_jobs_on_payment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'succeeded' and old.status is distinct from 'succeeded' then
    update pros set jobs_count = jobs_count + 1 where id = new.pro_id;
  end if;
  return new;
end; $$;

drop trigger if exists trg_bump_jobs_on_payment on payments;
create trigger trg_bump_jobs_on_payment
  after update on payments
  for each row execute function bump_jobs_on_payment();
