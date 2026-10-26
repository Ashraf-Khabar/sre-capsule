/**
 * FinOps metrics theory - Documentation (detailed)
 */
import { formulaBlock } from './about-formula.js';

export const FINOPS_METRICS_DOC_HTML = `
<article class="about-doc about-doc-wide">
  <h2>FinOps &amp; SRE metrics - theory and implementation</h2>
  <p class="about-lead">
    SRE Capsule models quality engineering as a <strong>stochastic cost process</strong>: every CI failure consumes runner minutes,
    every triage event consumes engineer attention (loaded hourly rate), and flaky tests amplify both through
    <em>re-execution entropy</em>. The control plane materializes these signals into operational KPIs
    (<code>/api/metrics</code>) and managerial FinOps aggregates (<code>/api/finops</code>, <code>/api/finops/evolution</code>).
  </p>

  <div class="about-callout">
    <strong>Design principle</strong> - Metrics are <em>conservative estimates</em>: we assume each recorded incident triggers
    one full pipeline duration (<em>T<sub>pipe</sub></em>) and one investigation window (<em>T<sub>inv</sub></em>), even when
    partial reruns occur. Tune baselines in <strong>FinOps Intelligence</strong> to match your organization.
  </div>

  <h3>1. Baseline configuration variables</h3>
  <p>
    Managers persist organizational assumptions in <code>finops_settings</code>. These scalars linearly scale all downstream
    financial projections; they do not alter incident ingestion or deduplication logic.
  </p>
  <table class="about-table">
    <thead><tr><th>Symbol</th><th>API field</th><th>Unit</th><th>Semantic definition</th></tr></thead>
    <tbody>
      <tr><td><em>R<sub>dev</sub></em></td><td><code>dev_hourly_rate</code></td><td>currency / hour</td><td>Fully loaded cost of one QA/SRE engineer (salary + overhead + tooling amortization).</td></tr>
      <tr><td><em>C<sub>ci</sub></em></td><td><code>ci_minute_cost</code></td><td>currency / minute</td><td>Marginal cloud/runner minute (compute + egress + orchestration fee).</td></tr>
      <tr><td><em>T<sub>pipe</sub></em></td><td><code>avg_pipeline_duration</code></td><td>minutes</td><td>Expected wall-clock duration attributed to each failed pipeline execution.</td></tr>
      <tr><td><em>T<sub>inv</sub></em></td><td><code>avg_investigation_time</code></td><td>minutes</td><td>Human diagnosis + context switching before mark-resolved.</td></tr>
    </tbody>
  </table>

  <h3>2. Incident population &amp; derived cardinalities</h3>
  <p>Let the incident table at evaluation time contain:</p>
  <ul class="about-detail-list">
    <li><strong>N</strong> = <code>total_incidents</code> - cardinality of all ingested failure records.</li>
    <li><strong>N<sub>f</sub></strong> = <code>flaky_tests</code> - subset where <code>name LIKE '[FLAKY]%'</code> (re-failure within 48h of prior resolution).</li>
    <li><strong>N<sub>s</sub></strong> = <code>stable_failures</code> = N − N<sub>f</sub> - non-flaky structural regressions.</li>
    <li><strong>N<sub>r</sub></strong> = <code>resolved_incidents</code> - <code>is_resolved = 1</code>.</li>
    <li><strong>N<sub>a</sub></strong> = active backlog = N − N<sub>r</sub>.</li>
  </ul>
  ${formulaBlock('N_s = N - N_f')}
  ${formulaBlock('ResolutionRate (%) = (N_r / N) × 100   when N > 0')}
  ${formulaBlock('FlakyRatio (%) = (N_f / N) × 100   when N > 0')}

  <h3>3. Investigation cost per incident (human capital)</h3>
  <p>
    Investigation cost converts engineer time into currency using a linear rate model. Partial minutes are not modeled;
    sub-minute resolutions floor to 1 minute in MTTR aggregation (see §7).
  </p>
  ${formulaBlock('C_invest = (R_dev / 60) × T_inv')}
  <p><strong>Worked example:</strong> R<sub>dev</sub> = 50 USD/h, T<sub>inv</sub> = 30 min → C<sub>invest</sub> = 25.00 USD per incident.</p>
  <p>
    For a cohort of size N, aggregate investigation spend is <em>N × C<sub>invest</sub></em>. Flaky incidents are charged
    the same investigation coefficient unless you filter them in post-processing exports.
  </p>

  <h3>4. CI minutes lost (compute waste)</h3>
  <p>
    Runner waste assumes each incident maps to one pipeline execution of nominal length T<sub>pipe</sub>.
    This is independent of parallelization factor inside the CI graph.
  </p>
  ${formulaBlock('M_total = N × T_pipe')}
  ${formulaBlock('M_flaky = N_f × T_pipe')}
  ${formulaBlock('M_stable = N_s × T_pipe')}
  <p>
    CI spend in currency: <em>M × C<sub>ci</sub></em>. Example: N = 120, T<sub>pipe</sub> = 15 min, C<sub>ci</sub> = 0.008 USD/min
    → M<sub>total</sub> = 1,800 min → 14.40 USD CI component alone.
  </p>

  <h3>5. Total financial impact (composite SRE cost)</h3>
  <p>
    Total impact is the sum of <strong>compute leakage</strong> and <strong>human triage leakage</strong> across all incidents.
    This is exposed to Managers as <code>sre_impact.estimated_cost_usd</code> on the dashboard metrics API.
  </p>
  ${formulaBlock('Impact_total = (M_total × C_ci) + (N × C_invest)')}
  ${formulaBlock('Impact_total = N × (T_pipe × C_ci + C_invest)')}
  <p>
    Per-incident fully loaded cost (used in dashboard FinOps analytics):
  </p>
  ${formulaBlock('C_incident = (T_pipe × C_ci) + C_invest')}

  <h3>6. Flaky waste (quality tax)</h3>
  <p>
    Flaky waste isolates the subset of cost attributable to non-deterministic tests. It answers:
    <em>“How much money did intermittency burn this period?”</em>
  </p>
  ${formulaBlock('Impact_flaky = (M_flaky × C_ci) + (N_f × C_invest)')}
  ${formulaBlock('WastePct = (Impact_flaky / Impact_total) × 100   when Impact_total > 0')}
  <p>
    A rising WastePct with flat N indicates deteriorating test hygiene rather than organic traffic growth.
    Pair with <code>flaky_ratio</code> in dashboard analytics for gateway-level attribution.
  </p>

  <h3>7. MTTR - Mean Time To Resolution</h3>
  <p>
    MTTR is the arithmetic mean of resolution latency for resolved incidents, expressed in minutes:
  </p>
  ${formulaBlock('MTTR = AVG( (resolved_at - created_at) in minutes )  for is_resolved = 1')}
  <p>
    SQL implementation filters null timestamps and enforces a <strong>minimum 1 minute</strong> when resolved &gt; 0 but
    computed latency rounds to zero (instant auto-resolve). This prevents divide-by-zero artifacts in weekly rollups.
  </p>
  <p>
    MTTR is a <em>lagging</em> indicator: it rises when backlog grows or when complex failures require multi-team
    investigation. Compare week-over-week on the 5-week evolution chart alongside incident volume.
  </p>

  <h3>8. MTTF - Mean Time To Failure</h3>
  <p>
    MTTF approximates mean inter-arrival time between consecutive incident timestamps:
  </p>
  ${formulaBlock('MTTF = (t_max - t_min) / (N - 1)   in minutes, when N > 1')}
  <p>
    Low MTTF with high N<sub>f</sub> suggests unstable CI or environment churn. Displayed as N/A when N ≤ 1.
  </p>

  <h3>9. Weekly FinOps evolution API</h3>
  <p>
    <code>GET /api/finops/evolution?weeks=12</code> returns a time series where each bucket is ISO week start
    (<code>date(created_at, 'weekday 0', '-6 days')</code>). Per bucket fields include:
  </p>
  <ul class="about-detail-list">
    <li><code>incidents</code> - failure volume</li>
    <li><code>flaky_count</code> - flaky-tagged volume</li>
    <li><code>mttr</code> - mean resolution latency (minutes)</li>
    <li><code>estimated_cost_usd</code> - Σ Impact_total for incidents in bucket</li>
    <li><code>flaky_waste_cost_usd</code> - Σ Impact_flaky for incidents in bucket</li>
    <li><code>ci_minutes</code> - runner minutes attributed to bucket</li>
  </ul>

  <h3>10. Gateway export reports</h3>
  <p>
    <code>GET /api/finops/export?period=week|month|year&amp;project=&lt;gateway&gt;</code> emits CSV rows per CI gateway
    with failure counts, resolution stats, flaky counts, and USD estimates using the same baseline coefficients.
    Use this for chargeback conversations with service owners.
  </p>

  <h3>11. Dashboard analytics - FinOps metric IDs</h3>
  <p>When customizing Operations analytics tiles (Documentation → Dashboard analytics), these metric IDs map to the formulas above:</p>
  <table class="about-table">
    <thead><tr><th>METRIC</th><th>Aggregation</th></tr></thead>
    <tbody>
      <tr><td><code>finops_cost</code></td><td>Σ (incidents × C_incident) per bucket</td></tr>
      <tr><td><code>finops_flaky_cost</code></td><td>Σ (flaky × C_incident) per bucket</td></tr>
      <tr><td><code>ci_minutes</code></td><td>Σ (incidents × T_pipe) per bucket</td></tr>
      <tr><td><code>ci_cost</code></td><td>Σ (incidents × T_pipe × C_ci) - CI slice only</td></tr>
      <tr><td><code>invest_cost</code></td><td>Σ (incidents × C_invest) - human slice only</td></tr>
      <tr><td><code>stable</code></td><td>Count of non-flaky failures</td></tr>
      <tr><td><code>active</code></td><td>Unresolved incident count</td></tr>
      <tr><td><code>resolution_rate</code></td><td>(resolved / total) × 100 per bucket</td></tr>
      <tr><td><code>flaky_ratio</code></td><td>(flaky / total) × 100 per bucket</td></tr>
    </tbody>
  </table>

  <div class="about-callout">
    <strong>Sensitivity analysis</strong> - Doubling T<sub>inv</sub> scales human cost linearly but does not affect CI minutes.
    Doubling T<sub>pipe</sub> affects both Impact_total and MTTR-adjacent capacity planning. Use exports to justify
    investment in deflaking programs when WastePct exceeds your organizational threshold (commonly 15–25%).
  </div>
</article>
`;
