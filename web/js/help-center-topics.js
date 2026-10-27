/**
 * Extended Documentation topics (workflows, Super-App, operations).
 * Imported by about.js - replaces legacy QCL v1.0 topic.
 */

export const EXTENDED_HELP_TOPICS = {
    workflow: {
        title: 'Visual Workflows',
        breadcrumb: 'Documentation / Visual Workflows',
        html: `
        <article class="about-doc about-doc-wide">
          <h2>Visual Workflow Builder</h2>
          <p class="about-lead">
            Open <strong>Workflow</strong> in the sidebar, pick a CI/CD gateway, and draw its remediation DAG.
            Everyone can open the graph and run a simulation. Lead and Manager can edit, enable, and save it.
            When <em>Enable workflow</em> is saved, the graph replaces legacy keyword AUTO-RUN for that gateway only.
          </p>
          <h3>Node types</h3>
          <table class="about-table">
            <thead><tr><th>Node</th><th>Role</th></tr></thead>
            <tbody>
              <tr><td><strong>Trigger</strong></td><td>Single entry when an alert is ingested (one per graph).</td></tr>
              <tr><td><strong>Condition</strong></td><td><strong>Incident name</strong> is the stored title (Starts with, Contains, Equals). <strong>Tag</strong> is only FLAKY or PERF. Status, error text, and console logs are separate. <em>Top</em> output = true, <em>bottom</em> = false.</td></tr>
              <tr><td><strong>Action</strong></td><td>Runs one native plugin (Slack, Jira, webhook, …). The output continues the graph, so actions and conditions can be chained. Kubernetes restart is not available.</td></tr>
            </tbody>
          </table>
          <h3>Typical setup (Lead+)</h3>
          <ol class="about-detail-list">
            <li><strong>Plugin Engine</strong> - Manager enables routing on integrations.</li>
            <li><strong>CI/CD Gateways</strong> - Add configuration (channels, Jira key, …).</li>
            <li><strong>Workflow</strong> - Open the Workflow section, filter the gateway list, and click a row. Lead and Manager can edit. The status mark shows Active, Draft, or Legacy. Show tester opens the simulation when you need it.</li>
            <li><strong>Simulate</strong> - Dry-run with sample incident (no external calls).</li>
            <li><strong>Enable workflow</strong> + <strong>Save</strong> - Activates DAG.</li>
          </ol>
          <h3>Toolbar</h3>
          <ul class="about-detail-list">
            <li><strong>Example</strong> - Flaky → Slack (true) / Jira (false).</li>
            <li><strong>Simulate / Run simulation</strong> - Dry-run only. Shows the path, the plugins that would run, and why a node was skipped. It does not call Slack, Jira, or any other vendor.</li>
            <li><strong>Draft</strong> - Save without Enable keeps legacy AUTO-RUN.</li>
            <li><strong>Reset</strong> - Deletes DAG; returns to Legacy mode.</li>
          </ul>
          <div class="about-callout">
            <strong>Allowed plugins</strong> - Only integrations listed in the gateway routing matrix run.
            An empty routing list blocks all workflow actions (by design).
          </div>
        </article>`
    },
    operations: {
        title: 'Operations dashboard',
        breadcrumb: 'Documentation / Operations',
        html: `
        <article class="about-doc about-doc-wide">
          <h2>Telemetry Stream (Operations)</h2>
          <p class="about-lead">Live view of CI failures grouped by <strong>pipeline execution</strong> (<code>X-Run-Id</code>).</p>
          <h3>Toolbar</h3>
          <ul class="about-detail-list">
            <li><strong>Time range</strong> - Filters KPIs and list; auto-refresh adapts to window.</li>
            <li><strong>Search</strong> - Client filter on test name, project, error.</li>
            <li><strong>Project filter</strong> - Limits API fetch to one gateway.</li>
            <li><strong>Status</strong> - All / Active / Resolved.</li>
            <li><strong>Analytics</strong> - Charts panel; <strong>Customize layout</strong> saves your tiles (per user).</li>
          </ul>
          <h3>Pipeline card actions</h3>
          <table class="about-table">
            <thead><tr><th>Action</th><th>Who</th></tr></thead>
            <tbody>
              <tr><td>Resolve execution</td><td>Lead or Manager. Platform Admin does not open this view.</td></tr>
              <tr><td>Delete or archive</td><td>Lead or Manager. Archive hides the row. Delete removes it.</td></tr>
              <tr><td>Acknowledge</td><td>Lead or Manager, from Unowned, with sev1–sev4.</td></tr>
              <tr><td>Export logs / JUnit XML</td><td>Anyone who can open the dashboard</td></tr>
            </tbody>
          </table>
          <h3>Pages next to the dashboard</h3>
          <ul class="about-detail-list">
            <li><strong>Suite health</strong> - Last pipeline run for each gateway, compared with the last green run.</li>
            <li><strong>Activity</strong> - History grouped by gateway and suite. Open a row for the steps. Each incident and each step can be collapsed. <strong>History PDF</strong> is only on this page: it opens the print dialog (Save as PDF) for the newest 400 incidents you can see, including archived ones.</li>
            <li><strong>Unowned</strong> - Open incidents with no owner, longest wait first. An observer can read the queue and cannot take one.</li>
            <li><strong>Self-Healing</strong> - Open and Archive. Select failures, then archive or delete (Lead or Manager).</li>
          </ul>
          <p>Sub-alerts show per-test logs, the flaky badge (<code>[FLAKY]</code>), and checkboxes for bulk resolve.</p>
        </article>`
    },
    gateways: {
        title: 'CI/CD Gateways',
        breadcrumb: 'Documentation / Gateways',
        html: `
        <article class="about-doc about-doc-wide">
          <h2>CI/CD Gateways (Ingestion)</h2>
          <p class="about-lead">Each gateway is a <strong>project</strong> with its own API key, routing, and optional workflow DAG.</p>
          <h3>Webhook</h3>
          <pre class="about-code">POST /api/webhooks/
X-API-Key: &lt;gateway-secret&gt;
X-Run-Id: pipeline-123
X-Commit-Sha: abcdef</pre>
          <h3>Workflow column</h3>
          <table class="about-table">
            <thead><tr><th>Badge</th><th>Meaning</th></tr></thead>
            <tbody>
              <tr><td>Legacy</td><td>No DAG - AUTO-RUN + <code>trigger_on</code> on plugins</td></tr>
              <tr><td>Draft</td><td>DAG saved, not enabled</td></tr>
              <tr><td>Active</td><td>DAG enabled - WorkflowEngine runs</td></tr>
            </tbody>
          </table>
          <h3>SRE routing matrix</h3>
          <p>Add configuration rows to set Slack channel, Jira project, Teams webhook, etc. This defines which plugins may run for this gateway.</p>
        </article>`
    },
    analytics: {
        title: 'Dashboard analytics',
        breadcrumb: 'Documentation / Analytics',
        html: `
        <article class="about-doc about-doc-wide">
          <h2>System analytics &amp; quality</h2>
          <p class="about-lead">
            Built-in KPI tiles and charts on the Operations dashboard - <strong>not</strong> a separate query language.
            Use <strong>Customize layout</strong> to pick metrics, chart types (line, bar, doughnut), colors, and order. Layout is saved per user.
          </p>
          <h3>Common metrics</h3>
          <table class="about-table">
            <thead><tr><th>Metric</th><th>Meaning</th></tr></thead>
            <tbody>
              <tr><td>incidents</td><td>Failure count in time bucket</td></tr>
              <tr><td>flaky / flaky_ratio</td><td>Tests tagged <code>[FLAKY]</code></td></tr>
              <tr><td>resolved / active</td><td>Backlog vs cleared</td></tr>
              <tr><td>mttr</td><td>Mean resolution time (minutes)</td></tr>
              <tr><td>finops_cost</td><td>Modeled USD (Manager FinOps baselines)</td></tr>
            </tbody>
          </table>
          <p>All analytics respect the dashboard <strong>time range</strong> filter and auto-refresh.</p>
          <div class="about-callout">For FinOps formula details see <strong>FinOps metrics</strong> in this Documentation.</div>
        </article>`
    },
    architecture: {
        title: 'Architecture (summary)',
        breadcrumb: 'Documentation / Architecture',
        html: `
        <article class="about-doc about-doc-wide">
          <h2>How SRE Capsule works</h2>
          <ol class="about-detail-list">
            <li><strong>Ingest</strong> - Webhook validates API key → dedup by fingerprint + run → optional flaky/perf tags → SQLite insert.</li>
            <li><strong>Remediate</strong> - Visual workflow DAG <em>or</em> legacy AUTO-RUN plugins (async, max 32 concurrent).</li>
            <li><strong>Enrich</strong> - RCA job + MCP self-healing (async hooks).</li>
            <li><strong>Observe</strong> - Dashboard, DORA, FinOps, artifacts.</li>
          </ol>
          <h3>Storage</h3>
          <p>SQLite (<code>data/srecapsule.db</code>), plugin manifests in <code>plugins/</code>, artifacts on disk. Single Go process serves API + static UI.</p>
          <h3>Security</h3>
          <ul class="about-detail-list">
            <li>UI: JWT after login (role in claims).</li>
            <li>CI: per-gateway <code>X-API-Key</code> only.</li>
            <li>Teams scope projects via <code>user_teams</code>.</li>
          </ul>
          <p>Full visual schemas (C4, sequences, ER, state machines): MkDocs → <em>Design Schemas &amp; Diagrams</em>. Narrative: <em>System Architecture</em>.</p>
        </article>`
    }
};
