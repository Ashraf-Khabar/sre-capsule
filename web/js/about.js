/**
 * Documentation - available to all roles
 */
import { FINOPS_METRICS_DOC_HTML } from './finops-metrics-doc.js?v=1.0.99-maint';
import { EXTENDED_HELP_TOPICS } from './help-center-topics.js?v=1.0.102-workflow-table';
import { SRE_THEORY_DOC_HTML } from './sre-theory-doc.js?v=1.0.101-workflow-page';
import { ROLE_LABELS, ROLE_DESCRIPTIONS } from './roles.js?v=1.0.101-workflow-page';

const TOPIC_ICONS = {
    sre_practice: '<svg class="about-topic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    overview: '<svg class="about-topic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    architecture: '<svg class="about-topic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    roles: '<svg class="about-topic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>',
    operations: '<svg class="about-topic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>',
    gateways: '<svg class="about-topic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    workflow: '<svg class="about-topic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.5 8.5L15.5 15.5"/></svg>',
    plugins: '<svg class="about-topic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
    analytics: '<svg class="about-topic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    finops_metrics: '<svg class="about-topic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    glossary: '<svg class="about-topic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>'
};

const ABOUT_TOPICS = {
    sre_practice: {
        title: 'SRE theory and the product',
        breadcrumb: 'Documentation / SRE practice',
        html: SRE_THEORY_DOC_HTML
    },
    overview: {
        title: 'Product overview',
        breadcrumb: 'Documentation / Overview',
        html: `
        <article class="about-doc about-doc-wide">
          <h2>SRE Capsule - SRE control plane</h2>
          <p class="about-lead">
            SRE Capsule is a <strong>flight recorder for CI quality</strong>: signed gateways ingest failures,
            fingerprints deduplicate noise, flaky tests are tagged, and remediation runs through
            <strong>visual workflows</strong> or legacy plugins - plus AI summaries, self-healing, and DORA.
          </p>
          <h3>Major capabilities</h3>
          <ul class="about-detail-list">
            <li><strong>Operations dashboard</strong> - Pipeline executions, resolve, archive, delete, log export.</li>
            <li><strong>Suite health, Activity, Unowned</strong> - Last run versus last green, history by suite, and the queue with no owner.</li>
            <li><strong>CI/CD Gateways</strong> - API keys, routing matrix, workflow badges.</li>
            <li><strong>Plugin Engine</strong> - Native Go integrations (Slack, Jira, PagerDuty, webhook, …).</li>
            <li><strong>Visual Workflows</strong> - DAG editor with simulate dry-run.</li>
            <li><strong>AI RCA & Self-Healing</strong> - Async LLM summaries and MCP-driven locator healing.</li>
            <li><strong>DORA</strong> - Deployment metrics + Prometheus correlation.</li>
            <li><strong>FinOps</strong> - Cost of failures and flaky waste (Manager).</li>
          </ul>
          <div class="about-callout">
            <strong>Typical flow</strong>
            <ol>
              <li>Admin/Manager provisions gateway + team access.</li>
              <li>CI posts failures with <code>X-API-Key</code> and <code>X-Run-Id</code>.</li>
              <li>Lead triages on Operations; workflow or plugins notify chat/tickets.</li>
              <li>Manager reviews DORA and FinOps.</li>
            </ol>
          </div>
        </article>`
    },
    ...EXTENDED_HELP_TOPICS,
    roles: {
        title: 'Role hierarchy',
        breadcrumb: 'Documentation / Roles',
        html: buildRolesDoc()
    },
    finops_metrics: {
        title: 'About FinOps metrics',
        breadcrumb: 'Documentation / FinOps metrics',
        html: FINOPS_METRICS_DOC_HTML
    },
    plugins: {
        title: 'Plugin Engine',
        breadcrumb: 'Documentation / Plugins',
        html: `
        <article class="about-doc about-doc-wide">
          <h2>Native integration engine</h2>
          <p class="about-lead">
            Plugins are JSON manifests under <code>plugins/</code> loaded at server start.
            Remediation runs in <strong>Go</strong> (HTTP clients) - not shell scripts in production paths.
          </p>
          <table class="about-table">
            <thead><tr><th>Category</th><th>Use case</th></tr></thead>
            <tbody>
              <tr><td>Slack / Teams</td><td>Chat alerts with per-gateway channel routing</td></tr>
              <tr><td>Jira</td><td>Create/update issues from failures</td></tr>
              <tr><td>PagerDuty / Opsgenie / VictorOps</td><td>On-call paging</td></tr>
              <tr><td>Datadog</td><td>Events on the SRE timeline</td></tr>
              <tr><td>Webhook / GitHub Actions</td><td>Custom automation. GitHub re-runs a workflow. A webhook posts JSON to a URL you configure.</td></tr>
              <tr><td>Kubernetes</td><td>Not executed. Use a webhook to your own GitOps controller.</td></tr>
              <tr><td>Test management</td><td>TestRail, Zephyr, Xray - delivered as a webhook</td></tr>
            </tbody>
          </table>
          <h3>How to use a plugin</h3>
          <ol class="about-detail-list">
            <li><strong>Plugin Engine</strong> - Lead or Manager opens the integration and saves its URL, token, or channel. Values can also come from server environment variables of the same name.</li>
            <li><strong>Enable for gateways</strong> - Manager (or Platform Admin) turns routing on, then the gateway’s <em>Add configuration</em> row stores the channel, project key, or webhook for that pipeline.</li>
            <li><strong>AUTO-RUN</strong> - Separate switch. When it is on, a matching <code>trigger_on</code> keyword fires the plugin after ingest. If the gateway has a routing list, only plugins on that list run. If the gateway has no routing JSON at all, every AUTO-RUN plugin is considered.</li>
            <li><strong>Execute test</strong> - Sends one sample incident through that manifest. This does call the vendor. It uses the saved config, not a chosen gateway’s routing row.</li>
          </ol>
          <h3>How to use a workflow</h3>
          <ol class="about-detail-list">
            <li>On the gateway, add a routing row for every plugin the graph may call. A workflow action that is not on that list is skipped. Saving an enabled graph without that row is rejected.</li>
            <li>Open <strong>WORKFLOW</strong>. One Trigger, then Conditions and Actions. The top output of a condition is true. The bottom output is false.</li>
            <li><strong>Simulate</strong> is a dry-run. <strong>Enable workflow</strong> and <strong>Save</strong> make the graph live and stop legacy AUTO-RUN for that gateway only. A save with Enable off keeps the graph as a draft.</li>
            <li><strong>Reset</strong> deletes the graph and returns the gateway to legacy AUTO-RUN.</li>
          </ol>
          <p>Plugin calls cannot target this server, localhost, or a link-local address such as the cloud metadata IP. An internal webhook on a private network address is allowed. The same documentation is in <strong>My Account → Documentation</strong> and at <code>/about</code>.</p>
        </article>`
    },
    glossary: {
        title: 'SRE glossary',
        breadcrumb: 'Documentation / Glossary',
        html: `
        <article class="about-doc about-doc-wide">
          <h2>SRE &amp; quality engineering glossary</h2>
          <p class="about-lead">Definitions as used in SRE Capsule UI, APIs, and documentation.</p>
          <dl class="about-dl">
            <dt>MTTR (Mean Time To Resolution)</dt>
            <dd>Average minutes from <code>created_at</code> to <code>resolved_at</code> for resolved incidents.</dd>
            <dt>Flaky test</dt>
            <dd>The same test fails again within 48 hours and is prefixed <code>[FLAKY]</code>. The check-flaky API reports a fingerprint that already carries that tag in the last 30 days.</dd>
            <dt>Fingerprint</dt>
            <dd>SHA-256(name ∥ error) for dedup per pipeline run.</dd>
            <dt>Pipeline execution</dt>
            <dd>UI group keyed by <code>pipeline_run_id</code> (header <code>X-Run-Id</code>).</dd>
            <dt>Gateway</dt>
            <dd>CI/CD project with API key, routing, and optional workflow DAG.</dd>
            <dt>Legacy mode</dt>
            <dd>No enabled workflow - linear AUTO-RUN on plugin <code>trigger_on</code> keywords.</dd>
            <dt>DAG / Visual workflow</dt>
            <dd>Enabled <code>sre_workflow_json</code> executed by WorkflowEngine.</dd>
            <dt>RCA</dt>
            <dd>AI-generated root cause summary stored per incident.</dd>
            <dt>Analytics layout</dt>
            <dd>Per-user dashboard chart configuration (not a separate DSL).</dd>
            <dt>Error budget</dt>
            <dd>Failed changes allowed in the DORA window. Burn is failures divided by deployments times the gateway SLO. Freeze on screen means the budget is spent. It does not block a pipeline.</dd>
            <dt>SLO</dt>
            <dd>Allowed change-failure rate for one gateway, 1% to 50%, saved on DORA. Default 15%.</dd>
            <dt>Acknowledge</dt>
            <dd>A lead or manager takes the incident, with sev1–sev4. The first owner stays.</dd>
            <dt>Mitigate</dt>
            <dd>User impact has been stopped. Distinct from Resolved.</dd>
            <dt>Same cause</dt>
            <dd>Same gateway and same test, or the same fingerprint, inside 6 hours, shown as one row with a signal list.</dd>
            <dt>Maintenance window</dt>
            <dd>A manager marks a gateway for 1–24 hours with a reason. Incidents in that window stay visible and carry the reason.</dd>
            <dt>Postmortem draft</dt>
            <dd>Written after resolve from the timeline, comments, and nearest deploy. AI may rewrite only those facts.</dd>
          </dl>
        </article>`
    }
};

function buildRolesDoc() {
    const rows = Object.keys(ROLE_LABELS).map(code => `
      <tr>
        <td><code>${code}</code></td>
        <td><strong>${ROLE_LABELS[code]}</strong></td>
        <td>${ROLE_DESCRIPTIONS[code]}</td>
      </tr>`).join('');

    return `
    <article class="about-doc">
      <h2>Global roles</h2>
      <p class="about-lead">Roles gate views and mutations. Observer is read-only on operations; Manager owns FinOps and DORA.</p>
      <table class="about-table">
        <thead><tr><th>Code</th><th>UI label</th><th>Scope</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="about-callout" style="margin-top:20px;">
        <strong>Platform Admin</strong> - Workspaces, IAM, Settings.<br>
        <strong>Manager</strong> - FinOps, DORA, gateways, plugins, full triage.<br>
        <strong>Lead</strong> - Operations, gateways, plugins, workflows, self-healing.<br>
        <strong>Observer</strong> - Read-only dashboard, suite health, activity, and the unowned queue. Cannot acknowledge, resolve, archive, or delete.<br>
        Documentation for every role is <strong>My Account → Documentation</strong>. The same pages are at <code>/about</code>.
      </div>
    </article>`;
}

const ABOUT_TOPIC_ORDER = [
    'sre_practice', 'overview', 'architecture', 'roles', 'operations', 'gateways',
    'workflow', 'plugins',
    'analytics', 'finops_metrics', 'glossary'
];

function aboutTopicButtons() {
    return ABOUT_TOPIC_ORDER
        .filter(key => ABOUT_TOPICS[key])
        .map(key => {
            const topic = ABOUT_TOPICS[key];
            return `
            <button type="button" class="about-topic-btn" data-topic="${key}" onclick="window.showAboutTopic('${key}')">
                ${TOPIC_ICONS[key] || ''}<span>${topic.title}</span>
            </button>`;
        }).join('');
}

export function loadAboutView() {
    const navs = document.querySelectorAll('[data-about-nav]');
    if (!navs.length) return;
    navs.forEach(nav => {
        if (nav.dataset.built) return;
        nav.dataset.built = '1';
        nav.innerHTML = aboutTopicButtons();
    });
    const key = window.__pendingAboutTopic || window.__aboutTopic || 'sre_practice';
    window.__pendingAboutTopic = '';
    showAboutTopic(key);
}

export function showAboutTopic(key) {
    const topic = ABOUT_TOPICS[key];
    if (!topic) return;

    document.querySelectorAll('.about-topic-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.topic === key);
    });

    const html = `
            <div class="about-breadcrumb">${topic.breadcrumb}</div>
            ${topic.html}`;
    document.querySelectorAll('[data-about-content]').forEach(content => {
        content.innerHTML = html;
    });
    window.__aboutTopic = key;
    const aboutOpen = document.getElementById('view-about')?.classList.contains('active');
    if (aboutOpen && !window.__openingSecureLink && window.publishSecureLink) {
        window.publishSecureLink({ kind: 'view', view: 'about', topic: key });
    }
    const anchor = window.__pendingAboutAnchor || '';
    window.__pendingAboutAnchor = '';
    if (anchor) {
        const node = document.querySelector(`#view-about [data-doc-anchor="${anchor}"]`);
        if (node) node.scrollIntoView({ block: 'start' });
    }
}

/** Open Documentation from workflow editor (?) */
export function openWorkflowHelpTopic() {
    window.__pendingAboutTopic = 'workflow';
    if (typeof window.switchView === 'function') {
        window.switchView('about', document.querySelector('.nav-item[onclick*="about"]'));
    }
}

export function openMaintenanceHelp() {
    window.__pendingAboutTopic = 'sre_practice';
    window.__pendingAboutAnchor = 'maintenance';
    if (typeof window.switchView === 'function') {
        window.switchView('about', document.querySelector('.nav-item[onclick*="about"]'));
    }
}
