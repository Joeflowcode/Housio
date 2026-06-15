import {
  BarChart,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Divider,
  Grid,
  H1,
  H2,
  LineChart,
  Pill,
  Row,
  Spacer,
  Stack,
  Stat,
  Table,
  Text,
  TextInput,
  useCanvasState,
  useHostTheme,
} from "cursor/canvas";

// ---------------------------------------------------------------------------
// Housio — 12-month Gross Transaction Volume (GTV) & revenue projection.
//
// GTV  = dollar value of home-service jobs paid through the platform's
//        in-app payment rails (homeowner -> pro payments processed).
// Revenue = pro subscription revenue ($79 founding / $149 regular) +
//           the platform take rate (default 5%) applied to GTV.
//
// Every driver below is an editable assumption. Numbers are estimates for a
// brand-new single-metro marketplace (Bend / Central Oregon), not guarantees.
// ---------------------------------------------------------------------------

const MONTHS = 12; // 12-month projection horizon

type Scenario = {
  startPros: number; // founding cohort size at month 1
  growthPct: number; // net monthly pro growth, %
  jobsPerPro: number; // completed jobs per active pro per month
  avgJobValue: number; // avg $ per job
  pctPaid: number; // % of job value paid through the platform
  feePct: number; // platform take rate, %
  foundingPct: number; // % of pros on the $79 founding plan
  foundingPrice: number; // $/mo
  regularPrice: number; // $/mo
};

const PRESETS: Record<string, Scenario> = {
  Conservative: {
    startPros: 12,
    growthPct: 3,
    jobsPerPro: 4,
    avgJobValue: 300,
    pctPaid: 35,
    feePct: 5,
    foundingPct: 85,
    foundingPrice: 79,
    regularPrice: 149,
  },
  Base: {
    startPros: 15,
    growthPct: 8,
    jobsPerPro: 6,
    avgJobValue: 350,
    pctPaid: 50,
    feePct: 5,
    foundingPct: 80,
    foundingPrice: 79,
    regularPrice: 149,
  },
  Aggressive: {
    startPros: 20,
    growthPct: 15,
    jobsPerPro: 8,
    avgJobValue: 450,
    pctPaid: 65,
    feePct: 5,
    foundingPct: 70,
    foundingPrice: 79,
    regularPrice: 149,
  },
};

// Compact currency: $1.36M / $298K / $1,250
function fmtUSD(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function fmtFull(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function Driver({
  label,
  value,
  onChange,
  min,
  max,
  step,
  display,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  display: string;
  hint?: string;
}) {
  const theme = useHostTheme();
  return (
    <Stack gap={4}>
      <Row justify="space-between" align="center">
        <Text size="small" weight="medium">
          {label}
        </Text>
        <Text size="small" tone="secondary" weight="semibold">
          {display}
        </Text>
      </Row>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e: { target: { value: string } }) => onChange(Number(e.target.value))}
        style={{ width: "100%", accentColor: theme.accent.primary, cursor: "pointer" }}
      />
      {hint ? (
        <Text size="small" tone="tertiary">
          {hint}
        </Text>
      ) : null}
    </Stack>
  );
}

export default function HousioGTVProjection() {
  const theme = useHostTheme();

  const [startPros, setStartPros] = useCanvasState("startPros", PRESETS.Base.startPros);
  const [growthPct, setGrowthPct] = useCanvasState("growthPct", PRESETS.Base.growthPct);
  const [jobsPerPro, setJobsPerPro] = useCanvasState("jobsPerPro", PRESETS.Base.jobsPerPro);
  const [avgJobValue, setAvgJobValue] = useCanvasState("avgJobValue", PRESETS.Base.avgJobValue);
  const [pctPaid, setPctPaid] = useCanvasState("pctPaid", PRESETS.Base.pctPaid);
  const [feePct, setFeePct] = useCanvasState("feePct", PRESETS.Base.feePct);
  const [foundingPct, setFoundingPct] = useCanvasState("foundingPct", PRESETS.Base.foundingPct);
  const [foundingPrice, setFoundingPrice] = useCanvasState("foundingPrice", PRESETS.Base.foundingPrice);
  const [regularPrice, setRegularPrice] = useCanvasState("regularPrice", PRESETS.Base.regularPrice);

  function applyScenario(s: Scenario) {
    setStartPros(s.startPros);
    setGrowthPct(s.growthPct);
    setJobsPerPro(s.jobsPerPro);
    setAvgJobValue(s.avgJobValue);
    setPctPaid(s.pctPaid);
    setFeePct(s.feePct);
    setFoundingPct(s.foundingPct);
    setFoundingPrice(s.foundingPrice);
    setRegularPrice(s.regularPrice);
  }

  const current: Scenario = {
    startPros,
    growthPct,
    jobsPerPro,
    avgJobValue,
    pctPaid,
    feePct,
    foundingPct,
    foundingPrice,
    regularPrice,
  };

  const activeScenario =
    Object.keys(PRESETS).find(
      (k) => JSON.stringify(PRESETS[k]) === JSON.stringify(current),
    ) ?? "Custom";

  // --- Monthly projection -------------------------------------------------
  const labels: string[] = [];
  const prosSeries: number[] = [];
  const gtvMonthly: number[] = [];
  const gtvCumulative: number[] = [];
  const totalMarketMonthly: number[] = [];
  const subRevMonthly: number[] = [];
  const takeRevMonthly: number[] = [];
  const revTotalMonthly: number[] = [];

  const growth = growthPct / 100;
  const paidShare = pctPaid / 100;
  const fee = feePct / 100;
  const foundingShare = foundingPct / 100;
  const blendedPrice = foundingShare * foundingPrice + (1 - foundingShare) * regularPrice;

  let cumGTV = 0;
  for (let m = 0; m < MONTHS; m++) {
    const pros = startPros * Math.pow(1 + growth, m);
    const totalMarketValue = pros * jobsPerPro * avgJobValue; // all booked jobs
    const gtv = totalMarketValue * paidShare; // value paid through the platform
    const takeRev = gtv * fee;
    const subRev = pros * blendedPrice;

    cumGTV += gtv;
    labels.push(`M${m + 1}`);
    prosSeries.push(pros);
    totalMarketMonthly.push(totalMarketValue);
    gtvMonthly.push(gtv);
    gtvCumulative.push(cumGTV);
    subRevMonthly.push(subRev);
    takeRevMonthly.push(takeRev);
    revTotalMonthly.push(subRev + takeRev);
  }

  const annualGTV = gtvMonthly.reduce((a, b) => a + b, 0);
  const annualTotalMarket = totalMarketMonthly.reduce((a, b) => a + b, 0);
  const annualSubRev = subRevMonthly.reduce((a, b) => a + b, 0);
  const annualTakeRev = takeRevMonthly.reduce((a, b) => a + b, 0);
  const annualRevenue = annualSubRev + annualTakeRev;
  const endingPros = prosSeries[MONTHS - 1];
  const exitMRR = endingPros * blendedPrice + gtvMonthly[MONTHS - 1] * fee;
  const takeRate = annualGTV > 0 ? annualRevenue / annualGTV : 0;

  return (
    <Stack gap={20} style={{ padding: 24, maxWidth: 1040, margin: "0 auto" }}>
      {/* Header */}
      <Stack gap={4}>
        <Row align="center" gap={10}>
          <H1>Housio — 12-Month GTV Projection</H1>
          <Pill size="sm">{activeScenario}</Pill>
        </Row>
        <Text tone="secondary">
          Home-services marketplace · Bend / Central Oregon launch · 41 trades · founding pros locked at
          $79/mo, regular pros $149/mo, {feePct}% platform fee on in-app payments.
        </Text>
      </Stack>

      {/* Scenario presets */}
      <Row gap={8} align="center" wrap>
        <Text size="small" tone="secondary">
          Scenario presets:
        </Text>
        {Object.keys(PRESETS).map((name) => (
          <span key={name} style={{ display: "inline-flex" }}>
            <Pill active={activeScenario === name} onClick={() => applyScenario(PRESETS[name])}>
              {name}
            </Pill>
          </span>
        ))}
        <Spacer />
        {activeScenario === "Custom" ? (
          <Button variant="secondary" onClick={() => applyScenario(PRESETS.Base)}>
            Reset to Base
          </Button>
        ) : null}
      </Row>

      {/* Headline */}
      <Card>
        <CardBody style={{ padding: 20 }}>
          <Row align="end" justify="space-between" wrap>
            <Stack gap={2} style={{ minWidth: 240 }}>
              <Text size="small" tone="secondary" weight="medium">
                Projected annual GTV ({activeScenario}) — value paid through the platform
              </Text>
              <div style={{ fontSize: 24, lineHeight: "30px", fontWeight: 590, color: theme.accent.primary }}>
                {fmtUSD(annualGTV)}
              </div>
              <Text size="small" tone="tertiary">
                {fmtFull(annualGTV)} across 12 months · {fmtUSD(annualTotalMarket)} total marketplace job
                value booked (incl. jobs paid offline)
              </Text>
            </Stack>
            <Row gap={28} align="end" wrap>
              <Stat value={fmtUSD(annualRevenue)} label="Housio revenue (yr)" tone="success" />
              <Stat value={fmtUSD(exitMRR)} label="Exit-month MRR" />
              <Stat value={Math.round(endingPros).toString()} label="Active pros · M12" />
              <Stat value={`${(takeRate * 100).toFixed(1)}%`} label="Revenue / GTV" />
            </Row>
          </Row>
        </CardBody>
      </Card>

      <Callout tone="neutral" title="GTV vs. what Housio actually earns">
        <Text size="small">
          <Text size="small" weight="semibold">
            GTV
          </Text>{" "}
          is the gross dollar volume homeowners pay pros through the platform — money that flows
          through Housio's Stripe Connect rails, not money Housio keeps. Housio's own{" "}
          <Text size="small" weight="semibold">
            revenue
          </Text>{" "}
          is recurring pro subscriptions plus the {feePct}% platform fee on that GTV. These are
          assumption-based estimates for a year-one single-metro launch, not guarantees — adjust the
          drivers below to pressure-test them.
        </Text>
      </Callout>

      {/* Controls + revenue split */}
      <Grid columns="3fr 2fr" gap={16} align="start">
        <Card>
          <CardHeader>Assumptions — drag to model your own scenario</CardHeader>
          <CardBody>
            <Grid columns={2} gap={18}>
              <Driver
                label="Starting active pros (M1)"
                value={startPros}
                onChange={setStartPros}
                min={5}
                max={60}
                step={1}
                display={`${startPros} pros`}
                hint="Founding cohort. Launch target: ~15–20 in first 90 days."
              />
              <Driver
                label="Monthly net pro growth"
                value={growthPct}
                onChange={setGrowthPct}
                min={0}
                max={25}
                step={1}
                display={`+${growthPct}%/mo`}
                hint={`Compounds to ~${Math.round(endingPros)} pros by month 12.`}
              />
              <Driver
                label="Jobs per pro / month"
                value={jobsPerPro}
                onChange={setJobsPerPro}
                min={1}
                max={20}
                step={1}
                display={`${jobsPerPro} jobs`}
                hint="Completed & booked through Housio."
              />
              <Driver
                label="Average job value"
                value={avgJobValue}
                onChange={setAvgJobValue}
                min={120}
                max={3000}
                step={10}
                display={fmtFull(avgJobValue)}
                hint="$120 cleaning → multi-thousand remodels."
              />
              <Driver
                label="% of job value paid in-app"
                value={pctPaid}
                onChange={setPctPaid}
                min={10}
                max={100}
                step={5}
                display={`${pctPaid}%`}
                hint="Stripe Connect adoption. Some pay offline early on."
              />
              <Driver
                label="Platform fee (take rate)"
                value={feePct}
                onChange={setFeePct}
                min={0}
                max={15}
                step={0.5}
                display={`${feePct}%`}
                hint="Default 5% (PLATFORM_FEE_BPS = 500)."
              />
              <Driver
                label="Founding-plan pro mix"
                value={foundingPct}
                onChange={setFoundingPct}
                min={0}
                max={100}
                step={5}
                display={`${foundingPct}% @ $79`}
                hint={`Blended subscription ≈ ${fmtFull(blendedPrice)}/pro/mo.`}
              />
              <Stack gap={6}>
                <Text size="small" weight="medium">
                  Subscription prices ($/mo)
                </Text>
                <Row gap={8} align="center">
                  <Stack gap={2} style={{ flex: 1 }}>
                    <Text size="small" tone="tertiary">
                      Founding
                    </Text>
                    <TextInput
                      type="number"
                      value={String(foundingPrice)}
                      onChange={(v) => setFoundingPrice(Number(v) || 0)}
                    />
                  </Stack>
                  <Stack gap={2} style={{ flex: 1 }}>
                    <Text size="small" tone="tertiary">
                      Regular
                    </Text>
                    <TextInput
                      type="number"
                      value={String(regularPrice)}
                      onChange={(v) => setRegularPrice(Number(v) || 0)}
                    />
                  </Stack>
                </Row>
              </Stack>
            </Grid>
          </CardBody>
        </Card>

        <Stack gap={16}>
          <Card>
            <CardHeader>Where annual GTV comes from</CardHeader>
            <CardBody>
              <Stack gap={10}>
                <Row justify="space-between">
                  <Text size="small" tone="secondary">
                    Total marketplace job value
                  </Text>
                  <Text size="small" weight="semibold">
                    {fmtFull(annualTotalMarket)}
                  </Text>
                </Row>
                <Row justify="space-between">
                  <Text size="small" tone="secondary">
                    × {pctPaid}% paid in-app = GTV
                  </Text>
                  <Text size="small" weight="semibold" style={{ color: theme.accent.primary }}>
                    {fmtFull(annualGTV)}
                  </Text>
                </Row>
                <Divider />
                <Row justify="space-between">
                  <Text size="small" tone="secondary">
                    Subscription revenue
                  </Text>
                  <Text size="small" weight="semibold">
                    {fmtFull(annualSubRev)}
                  </Text>
                </Row>
                <Row justify="space-between">
                  <Text size="small" tone="secondary">
                    Take-rate revenue ({feePct}% of GTV)
                  </Text>
                  <Text size="small" weight="semibold">
                    {fmtFull(annualTakeRev)}
                  </Text>
                </Row>
                <Divider />
                <Row justify="space-between">
                  <Text weight="semibold">Housio revenue (year 1)</Text>
                  <Text weight="semibold" style={{ color: theme.accent.primary }}>
                    {fmtFull(annualRevenue)}
                  </Text>
                </Row>
              </Stack>
            </CardBody>
          </Card>
        </Stack>
      </Grid>

      {/* Charts */}
      <Stack gap={6}>
        <H2>Monthly GTV across the launch year</H2>
        <BarChart
          categories={labels}
          series={[{ name: "GTV (paid in-app)", data: gtvMonthly.map((v) => Math.round(v)) }]}
          valuePrefix="$"
          height={240}
        />
        <Text size="small" tone="tertiary">
          Monthly gross transaction volume · X: launch month (M1–M12) · Y: GTV in USD · Source: Housio
          projection model ({activeScenario} assumptions)
        </Text>
      </Stack>

      <Grid columns={2} gap={16} align="start">
        <Stack gap={6}>
          <H2>Cumulative GTV</H2>
          <LineChart
            categories={labels}
            series={[{ name: "Cumulative GTV", data: gtvCumulative.map((v) => Math.round(v)) }]}
            valuePrefix="$"
            fill
            height={220}
          />
          <Text size="small" tone="tertiary">
            Running total of in-app GTV · X: month · Y: cumulative USD · ends at {fmtFull(annualGTV)}
          </Text>
        </Stack>

        <Stack gap={6}>
          <H2>Monthly Housio revenue split</H2>
          <BarChart
            categories={labels}
            series={[
              { name: "Subscriptions", data: subRevMonthly.map((v) => Math.round(v)), tone: "info" },
              { name: `Take rate (${feePct}%)`, data: takeRevMonthly.map((v) => Math.round(v)), tone: "success" },
            ]}
            stacked
            valuePrefix="$"
            height={220}
          />
          <Text size="small" tone="tertiary">
            Housio earnings by source · X: month · Y: revenue USD · subscription vs. platform take rate
          </Text>
        </Stack>
      </Grid>

      {/* Monthly table */}
      <Stack gap={6}>
        <H2>Month-by-month breakdown</H2>
        <Table
          headers={[
            "Month",
            "Active pros",
            "Jobs",
            "GTV",
            "Subscriptions",
            "Take rate",
            "Housio revenue",
          ]}
          columnAlign={["left", "right", "right", "right", "right", "right", "right"]}
          rows={labels.map((label, i) => [
            label,
            Math.round(prosSeries[i]).toString(),
            Math.round(prosSeries[i] * jobsPerPro).toString(),
            fmtFull(gtvMonthly[i]),
            fmtFull(subRevMonthly[i]),
            fmtFull(takeRevMonthly[i]),
            fmtFull(revTotalMonthly[i]),
          ])}
        />
        <Text size="small" tone="tertiary">
          All figures are model estimates for a single-metro year-one launch and exclude churn, refunds,
          and Stripe processing costs. Adjust the assumptions above to test other outcomes.
        </Text>
      </Stack>
    </Stack>
  );
}
