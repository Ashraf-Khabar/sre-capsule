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
            The <strong>?</strong> button on the workflow toolbar opens this page.
            Open <strong>Workflow</strong> in the sidebar, then <strong>Open workflow</strong> on one gateway.
            Everyone can read the graph. Lead and Manager can edit, enable, and save it.
            A saved enabled graph replaces legacy AUTO-RUN for that gateway only. A new CI failure is required. Older incidents are not replayed.
          </p>
          <h3>Space</h3>
          <p>The graph stays inside the frame. Scroll bars appear only when a node is placed outside that frame.</p>
          <h3>How to configure</h3>
          <ol class="about-detail-list">
            <li><strong>Plugin Engine → Configure</strong> - General settings for that plugin: server, token, channel, project, recipients. Each plugin has its own fields. Save there. The message is not edited on this screen.</li>
            <li><strong>CI/CD Gateways</strong> - Edit the gateway and <strong>Add configuration</strong> for the same plugin. An empty routing list blocks every workflow action.</li>
            <li><strong>Workflow</strong> - Nodes are rectangles. <strong>Edit</strong> opens the configuration. A condition sets the field, the operator, and the value. An action chooses the plugin and its message. Leave the message empty to keep the plugin default.</li>
            <li><strong>Enable workflow</strong> and <strong>Save</strong>. The badge must be Active. A draft does not run.</li>
          </ol>
          <h3>Nodes</h3>
          <table class="about-table">
            <thead><tr><th>Node</th><th>Role</th></tr></thead>
            <tbody>
              <tr><td><strong>Trigger</strong></td><td>One entry. It fires when a CI alert is ingested.</td></tr>
              <tr><td><strong>Condition</strong></td><td>Top output is true. Bottom output is false. Connect the action to the output that should run.</td></tr>
              <tr><td><strong>Action</strong></td><td>One plugin. Its output continues the graph, so several actions and conditions can be chained.</td></tr>
            </tbody>
          </table>
          <h3>Condition fields</h3>
          <table class="about-table">
            <thead><tr><th>Field</th><th>What it compares</th></tr></thead>
            <tbody>
              <tr><td><strong>Incident name</strong></td><td>The title on the incident card. The Flaky badge is ignored, so <em>Equals</em> or <em>Starts with</em> <code>[RobotFramework]</code> matches <code>[RobotFramework] Saucedemo…</code>. <em>Contains</em> finds a word anywhere. <em>Equals</em> of a full sentence must be the whole title.</td></tr>
              <tr><td><strong>Tag (FLAKY, PERF)</strong></td><td>Only those two marks. A framework name is not a tag.</td></tr>
              <tr><td><strong>Status</strong></td><td>Critical, resolved, and the other statuses.</td></tr>
              <tr><td><strong>Error message</strong></td><td>The failure text.</td></tr>
              <tr><td><strong>Console logs</strong></td><td>The console text.</td></tr>
            </tbody>
          </table>
          <h3>Message placeholders</h3>
          <p><code>{{name}}</code> <code>{{status}}</code> <code>{{error}}</code> <code>{{console}}</code> are replaced with the incident. Subject, body, title, description, and comment are the message fields. They differ per plugin and are stored on that gateway's action.</p>
          <p>Email actions open a fixed mail frame. The logo, the header, and the footer stay as they are. The toolbar formats only the text you write: bold, italic, underline, color, font size, bullet and numbered lists, symbols, emoji, and code. The same frame is used when the message is sent.</p>
          <h3>Plugin fields</h3>
          <ul class="about-detail-list">
            <li><strong>Email SMTP</strong> - Server, port, username, password, from, to, cc, subject, body.</li>
            <li><strong>SendGrid</strong> - API key, from, from name, to, cc, subject, body.</li>
            <li><strong>Slack</strong> - Webhook, channel, bot name, icon, color, title, message.</li>
            <li><strong>Jira</strong> - URL, email, token, issue type, project, priority, labels, assignee, components, summary, description.</li>
            <li><strong>Teams</strong> - Webhook, theme color, title, subtitle, message.</li>
            <li><strong>PagerDuty</strong> - Routing key, events URL, severity, source, component, group, class, summary, custom details.</li>
            <li><strong>Opsgenie</strong> - API key, API URL, team, priority, tags, message, description.</li>
            <li><strong>VictorOps</strong> - Routing URL, message type, entity, entity id, state message.</li>
            <li><strong>Datadog</strong> - API key, application key, site, tags, alert type, priority, source, title, text.</li>
            <li><strong>GitHub</strong> - Token, owner, repository, workflow file, git ref, and an optional dispatch note. The note is sent only when the workflow file declares an input named <code>note</code>.</li>
            <li><strong>Webhook</strong> - URL, QA URL, authorization header, event name, message.</li>
            <li><strong>TestRail</strong> - URL, user, API key, project id, run id, case id, status id (5 is Failed), comment.</li>
            <li><strong>Zephyr</strong> - API URL, token, project key, test case key, status, environment, comment.</li>
            <li><strong>Xray</strong> - Client id, client secret, cloud URL, project key, test key, test execution key, status, summary, comment.</li>
            <li><strong>Kubernetes</strong> - Context, namespace, deployment, container. The restart action is not executed.</li>
          </ul>
          <h3>Toolbar</h3>
          <ul class="about-detail-list">
            <li><strong>?</strong> - Opens this guide.</li>
            <li><strong>Example</strong> - A sample graph: flaky title to Slack, otherwise Jira.</li>
            <li><strong>Fit</strong> - Frames the nodes.</li>
            <li><strong>Reset</strong> - Deletes the graph and returns to legacy AUTO-RUN.</li>
            <li><strong>Back to gateways</strong> - Returns to the list. Active, Draft, and Legacy are the status marks.</li>
          </ul>
          <div class="about-callout">
            <strong>Allowed plugins</strong> - The action runs only when that plugin is on the gateway routing list.
            An empty list blocks the graph.
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
