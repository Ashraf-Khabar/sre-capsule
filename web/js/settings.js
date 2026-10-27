/**
 * web/js/settings.js
 * Technical settings, FinOps, Plugins, Analytics and Reports
 */
import { fetchWithAuth, parseJwt, parseApiJson, asArray, describeApiFailure, performLogout } from './api.js';
import { notify, showConfirmModal, showPromptModal } from './ui.js';
import { canManagePluginAutoRun } from './roles.js?v=1.0.101-workflow-page';
import * as analyticsLayout from './analytics-layout.js';
import { applyChartThemeDefaults, getChartTheme } from './chart-theme.js';
import { AI_PROVIDERS, logoForProvider, getProviderMeta } from './ai-provider-icons.js';

export let allProjects = [];
let editingProjectId = null;
let currentSelectedCI = 'gitlab';
/** Per-pipeline SRE routing rows (CI/CD Gateway form). */
let ciSRERoutingRows = [];
/** Active plugins for Add configuration dropdown. */
let activePluginsForRouting = [];
let sreRoutingControlsBound = false;
export let selectedCurrency = 'USD';

const CI_SYSTEMS = [
    { id: 'gitlab', label: 'GitLab CI', field: 'GitLab Repository Path', placeholder: 'group/project', logo: '/img/ci/gitlab.png' },
    { id: 'github', label: 'GitHub Actions', field: 'GitHub Workflow File', placeholder: 'build-deploy.yml', logo: '/img/ci/github.png' },
    { id: 'jenkins', label: 'Jenkins', field: 'Jenkins Job Name', placeholder: 'PROD-Deployment-Job', logo: '/img/ci/jenkins.png' },
    { id: 'azure', label: 'Azure Pipelines', field: 'Azure DevOps Pipeline', placeholder: 'org/project/pipeline', logo: '/img/ci/azure.png' },
    { id: 'circleci', label: 'CircleCI', field: 'CircleCI Project', placeholder: 'org/repo', logo: '/img/ci/circleci.svg' },
    { id: 'bitbucket', label: 'Bitbucket Pipelines', field: 'Bitbucket Repository', placeholder: 'workspace/repo', logo: '/img/ci/bitbucket.png' },
    { id: 'teamcity', label: 'TeamCity', field: 'TeamCity Build', placeholder: 'Project_Build', logo: '/img/ci/teamcity.png' },
    { id: 'travis', label: 'Travis CI', field: 'Travis Repository', placeholder: 'org/repo', logo: '/img/ci/travis.svg' },
    { id: 'buildkite', label: 'Buildkite', field: 'Buildkite Pipeline', placeholder: 'org/pipeline', logo: '/img/ci/buildkite.svg' },
    { id: 'cloudbuild', label: 'Cloud Build', field: 'Cloud Build Trigger', placeholder: 'project/trigger', logo: '/img/ci/cloudbuild.png' },
    { id: 'bamboo', label: 'Bamboo', field: 'Bamboo Plan Key', placeholder: 'PROJ-PLAN', logo: '/img/ci/bamboo.svg' },
];

function ciMeta(id) {
    return CI_SYSTEMS.find((item) => item.id === id) || null;
}

export function renderCICards() {
    const grid = document.getElementById('ci-grid');
    if (!grid || grid.dataset.ready === '1') return;
    grid.dataset.ready = '1';
    grid.innerHTML = CI_SYSTEMS.map((ci) => `
        <button type="button" class="ci-card${ci.id === 'gitlab' ? ' active' : ''}" data-ci="${ci.id}">
            <img class="ci-icon" src="${ci.logo}" alt="" width="32" height="32" draggable="false">
            <span>${ci.label}</span>
        </button>`).join('');
    grid.addEventListener('click', (event) => {
        const card = event.target.closest('.ci-card');
        if (!card) return;
        selectCI(card.dataset.ci, card);
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderCICards);
} else {
    renderCICards();
}

export let analyticsChart = null;
export let evolutionChart = null;

export const currencySymbols = {
    'USD': '$', 'EUR': '€', 'GBP': '£', 'JPY': '¥', 'AUD': 'A$',
    'CAD': 'C$', 'CHF': 'Fr', 'INR': '₹', 'CNY': '¥', 'MXN': '$',
    'SGD': 'S$', 'NZD': 'NZ$'
};

// Chart.js defaults applied via chart-theme.js (see loadAnalytics)

export function setSelectedCurrency(val) { selectedCurrency = val; }

export function selectCI(ciName, element) {
    document.querySelectorAll('.ci-card').forEach(card => card.classList.remove('active'));
    element.classList.add('active');
    currentSelectedCI = ciName;

    const dynamicField = document.getElementById('dynamic-ci-field');
    const specificInput = document.getElementById('ci-specific');

    const meta = ciMeta(ciName);
    if (meta && dynamicField && specificInput) {
        dynamicField.querySelector('label').innerText = meta.field;
        specificInput.placeholder = meta.placeholder;
    }

    const baseUrl = window.location.origin;
    document.getElementById('ci-webhook-url').value = `${baseUrl}/api/webhooks/${ciName}`;

    if (!editingProjectId) {
        const apiKeyInput = document.getElementById('ci-api-key');
        if (apiKeyInput) {
            apiKeyInput.type = 'text';
            const randomHex = Math.random().toString(16).substring(2, 10);
            apiKeyInput.value = `sre_pk_${ciName}_${randomHex}`;
        }
    }
}

let gatewayTableClickBound = false;
let gatewayFiltersBound = false;

function bindGatewayFilters() {
    const search = document.getElementById('gateway-filter-search');
    const ci = document.getElementById('gateway-filter-ci');
    if (gatewayFiltersBound) return;
    gatewayFiltersBound = true;
    if (ci) {
        ci.innerHTML = '<option value="">All CI systems</option>' + CI_SYSTEMS.map((item) =>
            `<option value="${item.id}">${item.label}</option>`
        ).join('');
    }
    if (search) search.addEventListener('input', renderGatewayTable);
    if (ci) ci.addEventListener('change', renderGatewayTable);
}

function renderGatewayTable() {
    const tbody = document.getElementById('projects-table-body');
    if (!tbody) return;
    const query = (document.getElementById('gateway-filter-search')?.value || '').trim().toLowerCase();
    const ci = document.getElementById('gateway-filter-ci')?.value || '';
    const rows = allProjects.filter((project) => {
        const name = String(project.name || '').toLowerCase();
        if (query && !name.includes(query)) return false;
        if (ci && project.ci_system !== ci) return false;
        return true;
    });
    if (!allProjects.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="table-empty">No pipelines provisioned yet.</td></tr>';
        return;
    }
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="table-empty">No gateways match these filters.</td></tr>';
        return;
    }
    tbody.innerHTML = rows.map(p => `
                <tr>
                    <td><strong>${escapePluginHtml(p.name)}</strong></td>
                    <td class="ci-system-cell">${ciSystemCell(p.ci_system)}</td>
                    <td><code class="secret-mask">••••••••••••</code></td>
                    <td class="data-table__actions">
                        <button type="button" class="btn btn-secondary btn-sm btn-info btn-edit-project" data-project-id="${escapePluginHtml(String(p.id))}">EDIT</button>
                        <button type="button" class="btn btn-secondary btn-sm btn-danger btn-delete-project" data-project-id="${escapePluginHtml(String(p.id))}">DELETE</button>
                    </td>
                </tr>
            `).join('');
}

function bindGatewayTableClicks() {
    const tbody = document.getElementById('projects-table-body');
    if (!tbody || gatewayTableClickBound) return;
    gatewayTableClickBound = true;
    tbody.addEventListener('click', (e) => {
        const editBtn = e.target.closest('.btn-edit-project');
        if (editBtn) {
            e.preventDefault();
            editProject(editBtn.getAttribute('data-project-id'));
            return;
        }
        const delBtn = e.target.closest('.btn-delete-project');
        if (delBtn) {
            e.preventDefault();
            deleteProject(delBtn.getAttribute('data-project-id'));
        }
    });
}

function ciSystemCell(id) {
    const meta = ciMeta(id);
    if (!meta) return escapePluginHtml(id || '');
    return `<span class="ci-system-pill"><img src="${meta.logo}" alt="" width="18" height="18">${escapePluginHtml(meta.label)}</span>`;
}

export function loadGatewaysData() {
    renderCICards();
    bindSRERoutingControls();
    bindGatewayTableClicks();
    bindGatewayFilters();
    const tbody = document.getElementById('projects-table-body');
    fetchWithAuth(`/api/my-projects?_ts=${Date.now()}`)
        .then(res => parseApiJson(res))
        .then(({ ok, data }) => {
            allProjects = ok ? asArray(data) : [];
            if (!tbody) return;
            if (!ok) {
                tbody.innerHTML = '<tr><td colspan="4"><span class="load-error-msg">Unable to load gateways.</span></td></tr>';
                return;
            }
            renderGatewayTable();
        })
        .catch(() => {
            if (tbody) tbody.innerHTML = '<tr><td colspan="4"><span class="load-error-msg">Unable to load gateways.</span></td></tr>';
        });

    loadActivePluginsForRouting();

    fetchWithAuth(`/api/teams?_ts=${Date.now()}`)
        .then(res => parseApiJson(res))
        .then(({ ok, data }) => {
            const select = document.getElementById('ci-team-id');
            if (!select || !ok) return;
            select.innerHTML = '<option value="" disabled selected>Select a Team</option>';
            asArray(data).forEach(t => select.innerHTML += `<option value="${t.id}">${t.name}</option>`);
        })
        .catch(() => {});
}

export function editProject(projectId) {
    const p = allProjects.find(item => String(item.id) === String(projectId));
    if (!p) return;

    editingProjectId = projectId;
    document.getElementById('ci-project-name').value = p.name || "";
    document.getElementById('ci-team-id').value = p.team_id || "";
    document.getElementById('ci-specific').value = p.repo_path || "";

    ciSRERoutingRows = [];
    if (Array.isArray(p.sre_routing) && p.sre_routing.length > 0) {
        ciSRERoutingRows = p.sre_routing.map(e => ({
            file_path: e.file_path || '',
            integration: e.integration || '',
            name: e.name || '',
            values: { ...(e.values || {}) }
        }));
    } else {
        const routing = p.routing || {};
        if (p.slack_channel || routing.slack_channel) {
            ciSRERoutingRows.push({ file_path: 'slack/slack-notifier.json', integration: 'slack', name: 'Slack', values: { SLACK_CHANNEL: p.slack_channel || routing.slack_channel } });
        }
        if (p.jira_project_key || routing.jira_project_key) {
            ciSRERoutingRows.push({ file_path: 'jira/jira-ticket.json', integration: 'jira', name: 'Jira', values: { JIRA_PROJECT_KEY: p.jira_project_key || routing.jira_project_key } });
        }
        if (p.teams_webhook || routing.teams_webhook) {
            ciSRERoutingRows.push({ file_path: 'teams/teams.json', integration: 'teams', name: 'Teams', values: { TEAMS_WEBHOOK_URL: p.teams_webhook || routing.teams_webhook } });
        }
    }
    renderSRERoutingList();

    renderCICards();
    const ciCard = document.querySelector(`.ci-card[data-ci="${p.ci_system}"]`);
    if (ciCard) selectCI(p.ci_system, ciCard);

    const apiKeyInput = document.getElementById('ci-api-key');
    if (apiKeyInput) {
        apiKeyInput.value = p.api_key || "";
        apiKeyInput.type = 'password';
    }

    const btn = document.getElementById('save-ci-btn');
    if (btn) {
        btn.innerText = "Update Project Endpoint";
        btn.classList.add('btn-edit-mode');
    }

    document.getElementById('ci-project-name').focus();
    notify("Editing project: " + p.name, "success");
}

export function deleteProject(projectId) {
    showConfirmModal("Delete Pipeline Endpoint?", "Are you sure? This will permanently delete this pipeline endpoint and all its routing configurations.", "danger", function () {
        fetchWithAuth(`/api/config/projects?id=${projectId}`, { method: 'DELETE' })
            .then(res => {
                if (res.ok) { notify("Pipeline deleted successfully.", "success"); loadGatewaysData(); window.loadDashboardFilters(); }
                else notify("Failed to delete pipeline.", "error");
            });
    });
}

export function saveCIConfig() {
    const projectName = document.getElementById('ci-project-name').value;
    const teamId = document.getElementById('ci-team-id').value;

    if (!projectName) return notify("Error: Project Name is required.", "error");
    if (!teamId) return notify("Error: You must assign this pipeline to a Team.", "error");

    const payload = {
        id: editingProjectId || projectName.toLowerCase().replace(/\s+/g, '-'),
        name: projectName,
        team_id: parseInt(teamId),
        ci_system: currentSelectedCI,
        repo_path: document.getElementById('ci-specific').value,
        api_key: document.getElementById('ci-api-key').value,
        sre_routing: collectSRERoutingPayload(),
        routing: {}
    };

    const method = editingProjectId ? 'PUT' : 'POST';

    fetchWithAuth('/api/config/projects', { method: method, body: JSON.stringify(payload) })
        .then(res => parseApiJson(res))
        .then(({ ok, offline, status, data }) => {
            if (!ok) {
                const msg = offline ? 'Server unreachable.' : (data?.error || `Operation failed (${status || 'error'})`);
                notify(msg, 'error');
                return;
            }
            notify(editingProjectId ? "Project updated!" : "Endpoint Provisioned!", "success");
            editingProjectId = null;
            document.getElementById('ci-project-name').value = "";
            document.getElementById('ci-specific').value = "";
            ciSRERoutingRows = [];
            renderSRERoutingList();
            const apiKeyInput = document.getElementById('ci-api-key');
            if (apiKeyInput) {
                apiKeyInput.type = 'text';
                const randomHex = Math.random().toString(16).substring(2, 10);
                apiKeyInput.value = `sre_pk_${currentSelectedCI}_${randomHex}`;
            }
            const btn = document.getElementById('save-ci-btn');
            if (btn) {
                btn.innerText = "Provision Project Endpoint";
                btn.classList.remove('btn-edit-mode');
            }
            loadGatewaysData();
            if (window.loadDashboardFilters) window.loadDashboardFilters();
        }).catch(() => notify("Network error", "error"));
}

export function revealApiKey() {
    const apiKeyInput = document.getElementById('ci-api-key');
    if (!apiKeyInput) return;

    if (apiKeyInput.type === 'text') {
        apiKeyInput.type = 'password';
        return;
    }

    const token = localStorage.getItem('sre-jwt');
    if (!token) return;
    const currentUser = parseJwt(token).username;

    showPromptModal("Security Verification", "Please enter your password to reveal this secret API Key.", "", function (password) {
        fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: currentUser, password: password })
        })
            .then(res => {
                if (res.ok) {
                    apiKeyInput.type = 'text';
                    notify("Secret revealed. It will be masked on reload.", "success");
                } else {
                    notify("Access Denied: Incorrect password", "error");
                }
            }).catch(() => notify("Network error", "error"));
    }, true);
}

export function toggleAnalytics() {
    const view = document.getElementById('analytics-view');
    if (view.style.display === 'none') {
        view.style.display = 'block';
        analyticsLayout.loadAnalyticsLayoutFromPrefs().then(() => loadAnalytics(false));
    } else {
        view.style.display = 'none';
    }
}

// Re-export for inline handlers
if (typeof window !== 'undefined') {
    window.reloadDashboardAnalytics = window.reloadDashboardAnalytics || function () {
        const view = document.getElementById('analytics-view');
        if (view && view.style.display !== 'none') loadAnalytics(false);
    };
}

export function loadAnalytics(isExport = false) {
    applyChartThemeDefaults();
    const theme = getChartTheme();
    const rangeQ = typeof window.getDashboardRangeQuery === 'function' ? window.getDashboardRangeQuery() : 'range=7d';
    if (rangeQ === null) {
        notify('Select both From and To dates before loading analytics.', 'error');
        return Promise.resolve();
    }
    return fetchWithAuth(`/api/metrics?${rangeQ}&_ts=${Date.now()}`)
        .then(res => res.json())
        .then(data => {
            window.__lastMetricsData = data;
            analyticsLayout.renderAnalyticsGrid(data, { isExport, theme });
            return data;
        })
        .catch(err => {
            console.error('Error loading analytics:', err);
            return null;
        });
}

function hexToRgb(hex) {
    const h = (hex || '#3b82f6').replace('#', '');
    if (h.length !== 6) return [59, 130, 246];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

async function loadImageAsDataUrl(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('logo');
    const blob = await res.blob();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

export function downloadWeeklyReportCSV() {
    const filterEl = document.getElementById('project-filter');
    const projectFilter = filterEl ? filterEl.value : 'all';
    const rangeQ = typeof window.getDashboardRangeQuery === 'function' ? window.getDashboardRangeQuery() : 'range=7d';
    if (rangeQ === null) return notify('Select a valid time range first.', 'error');

    fetchWithAuth(`/api/reports/weekly?project=${encodeURIComponent(projectFilter)}&${rangeQ}&_ts=${Date.now()}`)
        .then(res => res.json())
        .then(data => {
            if (!data || data.length === 0) {
                return notify('No incidents in the selected time range.', 'warning');
            }

            let csvContent = "Pipeline Name,Total Alerts,Resolved Alerts,Flaky Tests,Health Score (%)\n";

            data.forEach(row => {
                csvContent += `${row.pipeline},${row.total_alerts},${row.resolved_alerts},${row.flaky_tests},${row.health_score}%\n`;
            });

            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            const dateStr = new Date().toISOString().split('T')[0];
            let suffix = projectFilter === 'all' ? 'Global' : projectFilter;
            a.download = `SRE_Capsule_Weekly_Report_${suffix}_${dateStr}.csv`;

            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            notify("CSV report generated successfully.", "success");
        })
        .catch(() => notify("Failed to generate CSV report", "error"));
}

const PDF_PAGE = { w: 210, h: 297, margin: 14 };

function pdfEnsureSpace(doc, y, need, margin = PDF_PAGE.margin) {
    if (y + need > PDF_PAGE.h - margin) {
        doc.addPage();
        doc.setFillColor(248, 250, 252);
        doc.rect(0, 0, PDF_PAGE.w, PDF_PAGE.h, 'F');
        return margin + 4;
    }
    return y;
}

function pdfDrawHeader(doc, { logoData, titleScope, rangeLabel }) {
    const m = PDF_PAGE.margin;
    const headerH = 34;
    doc.setFillColor(248, 250, 252);
    doc.rect(0, 0, PDF_PAGE.w, headerH, 'F');
    doc.setFillColor(37, 99, 235);
    doc.rect(0, 0, 3, headerH, 'F');
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.3);
    doc.line(0, headerH, PDF_PAGE.w, headerH);

    const textX = logoData ? m + 28 : m;
    if (logoData) doc.addImage(logoData, 'PNG', m, 7, 22, 22);

    doc.setTextColor(15, 23, 42);
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text('SRE Capsule - Flight Recorder', textX, 14);

    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(71, 85, 105);
    doc.text(`Executive SRE Observability Report · ${titleScope}`, textX, 20);

    doc.setFontSize(8);
    doc.setTextColor(100, 116, 139);
    doc.text(`Period: ${rangeLabel}`, textX, 25);
    doc.text(`Generated ${new Date().toLocaleString()}`, textX, 29);

    return headerH + 8;
}

function pdfDrawKpiRow(doc, startY, metricWidgets, metricsData) {
    if (!metricWidgets.length) return startY;
    const m = PDF_PAGE.margin;
    const contentW = PDF_PAGE.w - m * 2;
    const cols = Math.min(4, metricWidgets.length);
    const gap = 5;
    const cardW = (contentW - gap * (cols - 1)) / cols;
    const cardH = 26;
    let y = startY;

    metricWidgets.forEach((w, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const x = m + col * (cardW + gap);
        const cy = y + row * (cardH + gap);
        const rgb = hexToRgb(w.color);
        const label = w.title || analyticsLayout.METRIC_CATALOG[w.metric]?.label || w.metric || 'Metric';
        const val = analyticsLayout.getMetricDisplayValue(metricsData, w.metric);

        doc.setFillColor(255, 255, 255);
        doc.setDrawColor(226, 232, 240);
        doc.setLineWidth(0.25);
        if (typeof doc.roundedRect === 'function') {
            doc.roundedRect(x, cy, cardW, cardH, 2, 2, 'FD');
        } else {
            doc.rect(x, cy, cardW, cardH, 'FD');
        }
        doc.setFillColor(rgb[0], rgb[1], rgb[2]);
        doc.rect(x, cy, cardW, 1.2, 'F');

        doc.setFontSize(7);
        doc.setTextColor(100, 116, 139);
        doc.setFont('helvetica', 'bold');
        const labelLines = doc.splitTextToSize(label.toUpperCase(), cardW - 8);
        doc.text(labelLines, x + 4, cy + 8);

        doc.setFontSize(16);
        doc.setTextColor(rgb[0], rgb[1], rgb[2]);
        doc.setFont('helvetica', 'bold');
        doc.text(String(val), x + 4, cy + 19);
    });

    const rows = Math.ceil(metricWidgets.length / cols);
    return y + rows * (cardH + gap) + 6;
}

function pdfDrawSectionTitle(doc, y, title) {
    const m = PDF_PAGE.margin;
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30, 41, 59);
    doc.text(title, m, y);
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.2);
    doc.line(m, y + 2, PDF_PAGE.w - m, y + 2);
    return y + 8;
}

function pdfDrawChartBlock(doc, y, title, imgMeta, chartType) {
    const m = PDF_PAGE.margin;
    const contentW = PDF_PAGE.w - m * 2;
    const dataUrl = typeof imgMeta === 'string' ? imgMeta : imgMeta?.dataUrl;
    const srcW = imgMeta?.width || (chartType === 'evolution' ? 1000 : 720);
    const srcH = imgMeta?.height || (chartType === 'evolution' ? 440 : 380);
    if (!dataUrl) return y;

    const maxImgH = chartType === 'evolution' ? 118 : 82;
    const aspect = srcW > 0 && srcH > 0 ? srcW / srcH : (chartType === 'evolution' ? 2 : 1.2);
    let imgW = contentW - 8;
    let imgH = imgW / aspect;
    if (imgH > maxImgH) {
        imgH = maxImgH;
        imgW = imgH * aspect;
    }

    const cardPad = 6;
    const blockH = imgH + cardPad * 2;
    const titleH = 10;
    y = pdfEnsureSpace(doc, y, titleH + blockH + 8, m);

    y = pdfDrawSectionTitle(doc, y, title);

    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.25);
    if (typeof doc.roundedRect === 'function') {
        doc.roundedRect(m, y, contentW, blockH, 2, 2, 'FD');
    } else {
        doc.rect(m, y, contentW, blockH, 'FD');
    }

    const imgX = m + (contentW - imgW) / 2;
    if (typeof doc.addImage === 'function') {
        try {
            doc.addImage(dataUrl, 'PNG', imgX, y + cardPad, imgW, imgH, undefined, 'NONE');
        } catch {
            doc.addImage(dataUrl, 'PNG', imgX, y + cardPad, imgW, imgH);
        }
    }
    return y + blockH + 12;
}

export async function downloadWeeklyReportPDF() {
    const filterEl = document.getElementById('project-filter');
    const projectFilter = filterEl ? filterEl.value : 'all';
    const rangeQ = typeof window.getDashboardRangeQuery === 'function' ? window.getDashboardRangeQuery() : 'range=7d';
    if (rangeQ === null) return notify('Select a valid time range first.', 'error');

    try {
        const fetchMetrics = async () => {
            const metricsRes = await fetchWithAuth(`/api/metrics?${rangeQ}&_ts=${Date.now()}`);
            return metricsRes.json();
        };

        const { layout, metricsData } = await analyticsLayout.prepareDashboardDataForPdf(fetchMetrics);
        if (!metricsData || metricsData.error) {
            return notify('Could not load metrics for export.', 'error');
        }

        if (!window.jspdf?.jsPDF) {
            return notify('PDF library not loaded. Refresh the page (Ctrl+F5).', 'error');
        }

        const res = await fetchWithAuth(`/api/reports/weekly?project=${encodeURIComponent(projectFilter)}&${rangeQ}&_ts=${Date.now()}`);
        const tableData = await res.json();

        if (!tableData || tableData.length === 0) {
            return notify('No incidents in the selected time range.', 'warning');
        }

        const chartWidgets = (layout || []).filter(w => w.type === 'doughnut' || w.type === 'evolution');
        let chartImages = {};
        try {
            chartImages = await analyticsLayout.renderChartsForPdfExport(metricsData, layout);
        } catch (chartErr) {
            console.warn('[PDF] chart render:', chartErr);
        }
        const rangeLabel = document.getElementById('dashboard-range-summary')?.textContent || rangeQ;
        const titleScope = projectFilter === 'all' ? 'Global Organization' : `Project: ${projectFilter}`;

        let logoData = null;
        try { logoData = await loadImageAsDataUrl('/assets/logo.png'); } catch { /* optional */ }

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ unit: 'mm', format: 'a4' });

        const paintPageBg = () => {
            doc.setFillColor(248, 250, 252);
            doc.rect(0, 0, PDF_PAGE.w, PDF_PAGE.h, 'F');
        };
        paintPageBg();

        let y = pdfDrawHeader(doc, { logoData, titleScope, rangeLabel });
        y = pdfDrawSectionTitle(doc, y, 'System analytics & quality');
        y = pdfDrawKpiRow(doc, y, layout.filter(w => w.type === 'metric'), metricsData);

        chartWidgets.forEach((w) => {
            const imgMeta = chartImages[`analytics-${w.id}`];
            if (!imgMeta?.dataUrl) return;
            try {
                doc.addPage();
                doc.setFillColor(248, 250, 252);
                doc.rect(0, 0, PDF_PAGE.w, PDF_PAGE.h, 'F');
                const chartY = PDF_PAGE.margin + 4;
                pdfDrawChartBlock(doc, chartY, w.title || (w.type === 'doughnut' ? 'Failure taxonomy' : 'Incident evolution'), imgMeta, w.type);
            } catch (imgErr) {
                console.warn(`[PDF] skip image ${w.id}:`, imgErr);
            }
        });

        doc.addPage();
        doc.setFillColor(248, 250, 252);
        doc.rect(0, 0, PDF_PAGE.w, PDF_PAGE.h, 'F');
        y = PDF_PAGE.margin + 4;
        y = pdfDrawSectionTitle(doc, y, 'Pipeline health summary');

        if (typeof doc.autoTable !== 'function') {
            throw new Error('PDF table plugin missing');
        }
        doc.autoTable({
            head: [['Pipeline', 'Total alerts', 'Resolved', 'Flaky tests', 'Health']],
            body: tableData.map(row => [
                row.pipeline,
                row.total_alerts,
                row.resolved_alerts,
                row.flaky_tests,
                `${row.health_score}%`
            ]),
            startY: y,
            margin: { left: PDF_PAGE.margin, right: PDF_PAGE.margin },
            theme: 'plain',
            headStyles: {
                fillColor: [241, 245, 249],
                textColor: [51, 65, 85],
                fontStyle: 'bold',
                fontSize: 9,
                cellPadding: 4
            },
            bodyStyles: {
                fillColor: [255, 255, 255],
                textColor: [30, 41, 59],
                fontSize: 9,
                cellPadding: 4
            },
            alternateRowStyles: { fillColor: [248, 250, 252] },
            styles: {
                font: 'helvetica',
                lineColor: [226, 232, 240],
                lineWidth: 0.2
            }
        });

        const pageCount = doc.getNumberOfPages();
        for (let p = 1; p <= pageCount; p++) {
            doc.setPage(p);
            doc.setFontSize(7);
            doc.setTextColor(148, 163, 184);
            doc.text(
                `SRE Capsule · Confidential · Page ${p} / ${pageCount}`,
                PDF_PAGE.w / 2,
                PDF_PAGE.h - 8,
                { align: 'center' }
            );
        }

        const dateStr = new Date().toISOString().split('T')[0];
        const suffix = projectFilter === 'all' ? 'Global' : projectFilter;
        doc.save(`SRE_Capsule_Executive_Report_${suffix}_${dateStr}.pdf`);
        notify('PDF report generated successfully.', 'success');
    } catch (err) {
        console.error('PDF Gen Error:', err);
        const hint = err?.message ? ` (${err.message})` : '';
        notify(`Failed to generate PDF report${hint}`, 'error');
    } finally {
        analyticsLayout.refreshMainAnalyticsGrid();
    }
}

export function saveAnalyticsLayout() {
    const modal = document.getElementById('analytics-layout-modal');
    if (modal && modal.style.display === 'flex') {
        return analyticsLayout.saveAnalyticsLayoutFromModal();
    }
    return analyticsLayout.saveAnalyticsLayoutToPrefs();
}

export function resetAnalyticsLayout() {
    analyticsLayout.resetAnalyticsLayoutDefault();
    notify('Analytics layout reset to default. Click Save layout to persist.', 'info');
}

const PLUGIN_FOLDER_LABELS = {
    pagerduty: 'Paging (PagerDuty)',
    opsgenie: 'Paging (Opsgenie)',
    victorops: 'Paging (Splunk On-Call / VictorOps)',
    github: 'CI/CD (GitHub Actions)',
    datadog: 'Observability (Datadog)',
    webhook: 'Integrations (HTTP webhook)',
    qa: 'QA workflows',
    testrail: 'Test management (TestRail)',
    zephyr: 'Test management (Zephyr Scale)',
    xray: 'Test management (Xray Cloud)',
    email: 'Email (SendGrid / SMTP)',
    jira: 'Ticketing (Jira)',
    slack: 'Chat (Slack)',
    teams: 'Chat (Microsoft Teams)',
    k8s: 'Kubernetes remediation'
};

function escapePluginHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const INTEGRATION_ASSET = {
    sendgrid: 'email',
    smtp: 'email',
    qa: 'qa',
    testrail: 'testrail',
    zephyr: 'zephyr',
    xray: 'xray'
};

function pluginLogoUrl(integration) {
    const key = (integration || '').toLowerCase();
    const asset = INTEGRATION_ASSET[key] || key;
    return `/assets/${asset}.png`;
}

function isPluginRoutingEligible(p) {
    const st = String(p?.status ?? 'active').trim().toLowerCase();
    if (st !== 'active') return false;
    if (p?.routing_enabled === true) return true;
    if (p?.routing_enabled === false) return false;
    return p?.auto_run === true;
}

/** Load integrations available for SRE routing dropdown (Manager-enabled). */
export async function loadActivePluginsForRouting() {
    const apply = (list) => {
        activePluginsForRouting = list.filter(isPluginRoutingEligible);
        bindSRERoutingControls();
        renderSRERoutingList();
    };

    const loadFromFullList = async () => {
        const res = await fetchWithAuth(`/api/plugins?_ts=${Date.now()}`);
        const { ok, data } = await parseApiJson(res);
        if (!ok) return [];
        return asArray(data).map(p => ({
            ...p,
            routing_fields: p.routing_fields || routingFieldsForIntegrationClient(p.integration)
        }));
    };

    try {
        const res = await fetchWithAuth(`/api/plugins/active?_ts=${Date.now()}`);
        const { ok, data, status } = await parseApiJson(res);
        if (ok) {
            apply(asArray(data));
            return;
        }
        if (status === 404) {
            apply(await loadFromFullList());
            return;
        }
        const fallback = await loadFromFullList();
        if (fallback.length) apply(fallback);
        else {
            activePluginsForRouting = [];
            bindSRERoutingControls();
            renderSRERoutingList();
        }
    } catch (e) {
        console.warn('[SRE routing] failed to load active plugins', e);
        try {
            apply(await loadFromFullList());
        } catch {
            activePluginsForRouting = [];
            bindSRERoutingControls();
            renderSRERoutingList();
        }
    }
}

const PLUGIN_TEMPLATE_HINT = 'Placeholders: {{name}} {{status}} {{error}} {{console}}';

function routingFieldsForIntegrationClient(integration) {
    const message = (key, label, placeholder) => ({ key, label, placeholder, input_type: 'textarea', group: 'message', hint: PLUGIN_TEMPLATE_HINT });
    const map = {
        slack: [
            { key: 'SLACK_CHANNEL', label: 'Channel', placeholder: '#alerts-backend', group: 'delivery' },
            { key: 'SLACK_TITLE', label: 'Title', placeholder: 'SRE Alert: {{name}}', group: 'message', hint: PLUGIN_TEMPLATE_HINT },
            message('SLACK_TEXT', 'Message', '{{error}}')
        ],
        jira: [
            { key: 'JIRA_PROJECT_KEY', label: 'Project key', placeholder: 'PAY', group: 'delivery' },
            { key: 'JIRA_SUMMARY', label: 'Summary', placeholder: '[SRE Capsule] {{name}}', group: 'message', hint: PLUGIN_TEMPLATE_HINT },
            message('JIRA_DESCRIPTION', 'Description', '{{error}}')
        ],
        teams: [
            { key: 'TEAMS_WEBHOOK_URL', label: 'Webhook URL', placeholder: 'https://...', input_type: 'url', group: 'connection' },
            { key: 'TEAMS_TITLE', label: 'Title', placeholder: 'SRE incident: {{name}}', group: 'message', hint: PLUGIN_TEMPLATE_HINT },
            message('TEAMS_TEXT', 'Message', '{{error}}')
        ],
        pagerduty: [
            { key: 'PAGERDUTY_ROUTING_KEY', label: 'Routing key', input_type: 'password', group: 'connection' },
            { key: 'PAGERDUTY_SUMMARY', label: 'Summary', placeholder: '[SRE Capsule] {{name}}', group: 'message', hint: PLUGIN_TEMPLATE_HINT }
        ],
        opsgenie: [
            { key: 'OPSGENIE_TEAM', label: 'Team', placeholder: 'team-name', group: 'delivery' },
            { key: 'OPSGENIE_MESSAGE', label: 'Message', placeholder: '[SRE Capsule] {{name}}', group: 'message', hint: PLUGIN_TEMPLATE_HINT },
            message('OPSGENIE_DESCRIPTION', 'Description', '{{error}}')
        ],
        victorops: [
            { key: 'VICTOROPS_ROUTING_URL', label: 'Routing URL', placeholder: 'https://...', input_type: 'url', group: 'connection' },
            message('VICTOROPS_MESSAGE', 'State message', '[SRE Capsule] {{name}}')
        ],
        datadog: [
            { key: 'DATADOG_TAGS', label: 'Tags', placeholder: 'env:ci,service:api', group: 'delivery' },
            { key: 'DD_TITLE', label: 'Title', placeholder: 'SRE Capsule: {{name}}', group: 'message', hint: PLUGIN_TEMPLATE_HINT },
            message('DD_TEXT', 'Text', '{{error}}')
        ],
        webhook: [
            { key: 'WEBHOOK_URL', label: 'Webhook URL', placeholder: 'https://...', input_type: 'url', group: 'connection' },
            message('WEBHOOK_MESSAGE', 'Message', '{{name}}\n{{error}}')
        ],
        sendgrid: [
            { key: 'SENDGRID_TO', label: 'To', placeholder: 'oncall@company.com', group: 'delivery' },
            { key: 'SENDGRID_SUBJECT', label: 'Subject', placeholder: '[SRE Capsule] {{name}}', group: 'message', hint: PLUGIN_TEMPLATE_HINT },
            message('SENDGRID_BODY', 'Body', '{{error}}')
        ],
        smtp: [
            { key: 'SMTP_TO', label: 'To', placeholder: 'oncall@company.com', group: 'delivery' },
            { key: 'SMTP_SUBJECT', label: 'Subject', placeholder: '[SRE Capsule] {{name}}', group: 'message', hint: PLUGIN_TEMPLATE_HINT },
            message('SMTP_BODY', 'Body', 'Incident: {{name}}\n\n{{error}}')
        ],
        github: [
            { key: 'GITHUB_OWNER', label: 'Owner', placeholder: 'org', group: 'delivery' },
            { key: 'GITHUB_REPO', label: 'Repository', placeholder: 'repo', group: 'delivery' },
            { key: 'GITHUB_WORKFLOW_ID', label: 'Workflow file', placeholder: 'ci.yml', group: 'delivery' },
            { key: 'GITHUB_REF', label: 'Git ref', placeholder: 'main', group: 'delivery' }
        ],
        testrail: [
            { key: 'TESTRAIL_RUN_ID', label: 'Run ID', group: 'delivery' },
            { key: 'TESTRAIL_CASE_ID', label: 'Case ID', group: 'delivery' }
        ],
        zephyr: [
            { key: 'ZEPHYR_PROJECT_KEY', label: 'Project key', group: 'delivery' },
            { key: 'ZEPHYR_TEST_CASE_KEY', label: 'Test case key', group: 'delivery' }
        ],
        xray: [
            { key: 'XRAY_PROJECT_KEY', label: 'Project key', group: 'delivery' },
            { key: 'XRAY_TEST_KEY', label: 'Test key', group: 'delivery' }
        ],
        k8s: [{ key: 'DEPLOYMENT_NAME', label: 'Deployment name', placeholder: 'my-app', group: 'delivery' }]
    };
    return map[(integration || '').toLowerCase()] || [];
}

function fieldsForPluginConfig(plugin) {
    const schema = Array.isArray(plugin?.config_fields) ? plugin.config_fields : [];
    const known = new Set(schema.map(f => f.key));
    const extra = Object.keys(plugin?.env || {}).filter(k => !known.has(k) && !k.endsWith('_SUBJECT') && !k.endsWith('_BODY') && !k.endsWith('_TITLE') && !k.endsWith('_TEXT') && !k.endsWith('_MESSAGE') && !k.endsWith('_DESCRIPTION') && k !== 'WEBHOOK_MESSAGE').map(k => ({
        key: k,
        label: k,
        input_type: 'text',
        group: 'connection'
    }));
    return schema.concat(extra).filter(f => f.group !== 'message');
}

function pluginConfigControl(field, idx, value) {
    const id = `env-${idx}-${field.key}`;
    const label = escapePluginHtml(field.label || field.key);
    const placeholder = escapePluginHtml(field.placeholder || '');
    const hint = field.hint ? `<p class="plugin-config-hint">${escapePluginHtml(field.hint)}</p>` : '';
    const safe = escapePluginHtml(value || '');
    let control;
    if (field.input_type === 'textarea') {
        control = `<textarea id="${id}" class="login-input plugin-config-textarea" placeholder="${placeholder}">${safe}</textarea>`;
    } else {
        const type = field.input_type === 'password' ? 'password' : (field.input_type === 'url' ? 'url' : 'text');
        control = `<input type="${type}" id="${id}" class="login-input" placeholder="${placeholder}" value="${safe}">`;
    }
    return `<div class="plugin-env-field"><label>${label}</label>${control}${hint}</div>`;
}

function renderRoutingFieldGroups(fields, idx, values) {
    const titles = { connection: 'Connection', delivery: 'Delivery', message: 'Message' };
    const order = ['connection', 'delivery', 'message'];
    const control = (f) => {
        const val = values?.[f.key] || '';
        const label = escapePluginHtml(f.label || f.key);
        const key = escapePluginHtml(f.key);
        const placeholder = escapePluginHtml(f.placeholder || '');
        const hint = f.hint ? `<p class="plugin-config-hint">${escapePluginHtml(f.hint)}</p>` : '';
        if (f.input_type === 'textarea') {
            return `<div class="sre-routing-field"><label>${label}</label>
                <textarea class="login-input sre-route-field plugin-config-textarea" data-row="${idx}" data-key="${key}" placeholder="${placeholder}">${escapePluginHtml(val)}</textarea>${hint}</div>`;
        }
        const type = f.input_type === 'password' ? 'password' : (f.input_type === 'url' ? 'url' : 'text');
        return `<div class="sre-routing-field"><label>${label}</label>
            <input type="${type}" class="login-input sre-route-field" data-row="${idx}" data-key="${key}"
            placeholder="${placeholder}" value="${escapePluginHtml(val)}">${hint}</div>`;
    };
    const known = new Set(order);
    let html = '';
    order.forEach(group => {
        const rows = fields.filter(f => (f.group || 'delivery') === group);
        if (!rows.length) return;
        html += `<section class="plugin-config-group"><h4 class="plugin-config-group__title">${titles[group]}</h4>${rows.map(control).join('')}</section>`;
    });
    const rest = fields.filter(f => !known.has(f.group || 'delivery'));
    if (rest.length) html += rest.map(control).join('');
    return html;
}

function renderPluginConfigPanel(plugin, idx) {
    const fields = fieldsForPluginConfig(plugin);
    if (!fields.length) return '<p class="form-hint">No external variables required.</p>';
    const titles = { connection: 'Connection', delivery: 'Delivery', message: 'Message' };
    const order = ['connection', 'delivery', 'message'];
    let html = '';
    order.forEach(group => {
        const rows = fields.filter(f => (f.group || 'connection') === group);
        if (!rows.length) return;
        html += `<section class="plugin-config-group"><h4 class="plugin-config-group__title">${titles[group]}</h4>`;
        rows.forEach(f => {
            html += pluginConfigControl(f, idx, plugin.env?.[f.key] || '');
        });
        html += '</section>';
    });
    const rest = fields.filter(f => !order.includes(f.group || 'connection'));
    rest.forEach(f => { html += pluginConfigControl(f, idx, plugin.env?.[f.key] || ''); });
    return html;
}

function isPluginActiveForRouting(p) {
    return isPluginRoutingEligible(p);
}

function bindSRERoutingControls() {
    if (sreRoutingControlsBound) return;
    const btn = document.getElementById('ci-add-routing-btn');
    if (!btn) return;
    sreRoutingControlsBound = true;
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        void addSRERoutingRow();
    });
}

function initSRERoutingUI() {
    bindSRERoutingControls();
    bindGatewayTableClicks();}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSRERoutingUI);
} else {
    initSRERoutingUI();
}

function findActivePlugin(filePath) {
    return activePluginsForRouting.find(p => p.file_path === filePath);
}

export function renderSRERoutingList() {
    const container = document.getElementById('ci-sre-routing-list');
    const addBtn = document.getElementById('ci-add-routing-btn');
    if (!container) return;

    if (addBtn) {
        addBtn.disabled = false;
        addBtn.title = 'Add a routing block for an active integration';
    }

    if (!activePluginsForRouting.length) {
        container.innerHTML = '<p class="sre-routing-hint">No integrations enabled for gateways yet. Open <strong>Plugin Engine</strong> (sidebar → Infrastructure), find Jira/Slack/etc., click <strong>Enable for gateways</strong> or <strong>Configure → Save</strong>, then refresh this page (Ctrl+F5).</p>';
        return;
    }

    if (!ciSRERoutingRows.length) {
        container.innerHTML = '<p class="sre-routing-hint--subtle">No routing configured. Click <strong>Add configuration</strong> to bind Slack, Jira, Teams, etc.</p>';
        return;
    }

    container.innerHTML = ciSRERoutingRows.map((row, idx) => {
        const plugin = findActivePlugin(row.file_path) || activePluginsForRouting.find(p => p.integration === row.integration);
        const fields = plugin?.routing_fields || [];
        const logo = pluginLogoUrl(row.integration || plugin?.integration);
        const options = activePluginsForRouting.map(p => {
            const usedElsewhere = ciSRERoutingRows.some((r, i) => i !== idx && r.file_path === p.file_path);
            const sel = p.file_path === row.file_path ? ' selected' : '';
            const dis = usedElsewhere ? ' disabled' : '';
            return `<option value="${escapePluginHtml(p.file_path)}"${sel}${dis}>${escapePluginHtml(p.name)}</option>`;
        }).join('');
        const fieldInputs = renderRoutingFieldGroups(fields, idx, row.values || {});
        return `<div class="sre-routing-card" data-row-idx="${idx}">
            <div class="sre-routing-card__head">
                <img src="${logo}" alt="" class="sre-routing-card__logo" onerror="this.style.display='none'">
                <select class="login-input sre-route-plugin-select sre-routing-card__select" data-row="${idx}" onchange="window.onSRERoutingPluginChange(${idx}, this.value)">${options}</select>
                <button type="button" class="btn-secondary btn-sm btn-danger-outline" onclick="window.removeSRERoutingRow(${idx})" title="Remove">×</button>
            </div>
            <div class="sre-routing-card__fields">${fieldInputs || '<p class="sre-routing-hint">No routing fields for this integration.</p>'}</div>
        </div>`;
    }).join('');
}

export async function addSRERoutingRow() {
    try {
        if (!activePluginsForRouting.length) {
            await loadActivePluginsForRouting();
        }
    } catch (e) {
        console.error('[SRE routing] load plugins', e);
        notify('Could not load integrations. Check the server and refresh the page.', 'error');
        return;
    }
    if (!activePluginsForRouting.length) {
        notify('No gateway-enabled integrations. Ask a Manager to Configure & Save in Plugin Engine, or enable "for gateways", then refresh (Ctrl+F5).', 'error');
        return;
    }
    const available = activePluginsForRouting.find(p => !ciSRERoutingRows.some(r => r.file_path === p.file_path));
    if (!available) {
        notify('All active integrations are already configured for this pipeline.', 'error');
        return;
    }
    ciSRERoutingRows.push({
        file_path: available.file_path,
        integration: available.integration,
        name: available.name,
        values: {}
    });
    renderSRERoutingList();
    const container = document.getElementById('ci-sre-routing-list');
    const lastCard = container?.querySelector('.sre-routing-card:last-child');
    if (lastCard) lastCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

export function removeSRERoutingRow(idx) {
    ciSRERoutingRows.splice(idx, 1);
    renderSRERoutingList();
}

export function onSRERoutingPluginChange(idx, filePath) {
    const plugin = findActivePlugin(filePath);
    if (!plugin) return;
    ciSRERoutingRows[idx] = {
        file_path: plugin.file_path,
        integration: plugin.integration,
        name: plugin.name,
        values: {}
    };
    renderSRERoutingList();
}

function collectSRERoutingPayload() {
    const container = document.getElementById('ci-sre-routing-list');
    if (!container) return [];
    return ciSRERoutingRows.map((row, idx) => {
        const values = { ...(row.values || {}) };
        container.querySelectorAll(`.sre-route-field[data-row="${idx}"]`).forEach(inp => {
            const key = inp.getAttribute('data-key');
            if (key) values[key] = inp.value.trim();
        });
        const plugin = findActivePlugin(row.file_path);
        return {
            file_path: row.file_path,
            integration: row.integration || plugin?.integration,
            name: row.name || plugin?.name,
            values
        };
    }).filter(e => e.file_path);
}

export function togglePluginAutoRun(filePath, enable) {
    const role = parseJwt(localStorage.getItem('sre-jwt'))?.role;
    if (!canManagePluginAutoRun(role)) {
        notify('Only Manager or Platform Admin can change AUTO-RUN.', 'error');
        return;
    }
    fetchWithAuth('/api/plugins/autorun', {
        method: 'POST',
        body: JSON.stringify({ file_path: filePath, auto_run: enable })
    }).then(res => parseApiJson(res)).then(({ ok }) => {
        if (ok) {
            notify(enable ? 'AUTO-RUN enabled for this integration.' : 'AUTO-RUN disabled - webhooks will not trigger it.', 'success');
            loadPlugins();
            loadGatewaysData();
        } else notify('Failed to update AUTO-RUN.', 'error');
    });
}

export function togglePluginGatewayRouting(filePath, enable) {
    const role = parseJwt(localStorage.getItem('sre-jwt'))?.role;
    if (!canManagePluginAutoRun(role)) {
        notify('Only Manager or Platform Admin can enable integrations for CI/CD gateways.', 'error');
        return;
    }
    fetchWithAuth('/api/plugins/routing', {
        method: 'POST',
        body: JSON.stringify({ file_path: filePath, enabled: enable })
    }).then(res => parseApiJson(res)).then(({ ok }) => {
        if (ok) {
            notify(enable ? 'Integration enabled for CI/CD gateways.' : 'Integration removed from gateway routing list.', 'success');
            loadPlugins();
            loadGatewaysData();
        } else notify('Failed to update gateway routing.', 'error');
    });
}

function pluginFolderName(filePath) {
    const parts = (filePath || '').split(/[/\\]/);
    return parts.length > 1 ? parts[0] : 'general';
}

function pluginSearchHaystack(p, folder, folderLabel) {
    return [
        p.name,
        p.description,
        p.status,
        p.version,
        p.file_path,
        folder,
        folderLabel,
        ...(p.trigger_on || []),
        ...Object.keys(p.env || {})
    ].join(' ').toLowerCase();
}

function pluginMatchesFilters(p, folder, folderLabel, query, category) {
    if (category && category !== 'all' && folder.toLowerCase() !== category) return false;
    if (!query) return true;
    return pluginSearchHaystack(p, folder, folderLabel).includes(query);
}

function populatePluginCategoryFilter(plugins) {
    const sel = document.getElementById('plugin-category-filter');
    if (!sel) return;
    const folders = [...new Set(plugins.map(p => pluginFolderName(p.file_path).toLowerCase()))].sort();
    const current = sel.value || 'all';
    sel.innerHTML = '<option value="all">All categories</option>';
    folders.forEach(f => {
        const label = PLUGIN_FOLDER_LABELS[f] || f;
        sel.innerHTML += `<option value="${escapePluginHtml(f)}">${escapePluginHtml(label)}</option>`;
    });
    if ([...sel.options].some(o => o.value === current)) sel.value = current;
}

function updatePluginSearchMeta(shown, total, query, category) {
    const meta = document.getElementById('plugin-search-meta');
    if (!meta) return;
    if (total === 0) {
        meta.textContent = 'No modules detected in the plugins directory.';
        return;
    }
    let text = `Showing ${shown} of ${total} plugin${total === 1 ? '' : 's'}`;
    if (query || (category && category !== 'all')) text += ' (filtered)';
    meta.textContent = text;
}

function renderPluginList(plugins, query = '', category = 'all') {
    const listEl = document.getElementById('plugin-list');
    if (!listEl) return;

    const q = (query || '').trim().toLowerCase();
    if (!plugins || plugins.length === 0) {
        listEl.innerHTML = '<div class="empty-state">No modules detected in the plugins directory.</div>';
        updatePluginSearchMeta(0, 0, q, category);
        return;
    }

    const configIcon = `<svg class="plugin-btn-icon" viewBox="0 0 24 24" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;
    const runIcon = `<svg class="plugin-btn-icon" viewBox="0 0 24 24" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
    const saveIcon = `<svg class="plugin-btn-icon" viewBox="0 0 24 24" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>`;
    const consoleIcon = `<svg class="plugin-btn-icon plugin-btn-icon--sm" viewBox="0 0 24 24" stroke-width="2"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`;
    const pluginIconSVG = `<svg class="plugin-icon-svg" viewBox="0 0 24 24" stroke-width="1.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`;

    const groupedPlugins = {};
    plugins.forEach(p => {
        const folder = pluginFolderName(p.file_path);
        if (!groupedPlugins[folder]) groupedPlugins[folder] = [];
        groupedPlugins[folder].push(p);
    });

    let html = '';
    let globalIdx = 0;
    let shown = 0;

    const sortedFolders = Object.keys(groupedPlugins).sort((a, b) => {
        const la = PLUGIN_FOLDER_LABELS[a.toLowerCase()] || a;
        const lb = PLUGIN_FOLDER_LABELS[b.toLowerCase()] || b;
        return la.localeCompare(lb);
    });

    for (const folder of sortedFolders) {
        const folderLabel = PLUGIN_FOLDER_LABELS[folder.toLowerCase()] || folder;
        const visible = groupedPlugins[folder].filter(p => pluginMatchesFilters(p, folder, folderLabel, q, category));
        if (visible.length === 0) continue;

        html += `<h3 class="plugin-category-heading" data-folder="${escapePluginHtml(folder.toLowerCase())}">${escapePluginHtml(folderLabel)} <span class="plugin-category-heading__count">(${visible.length})</span></h3>`;

        visible.forEach(p => {
            shown++;
            const safePath = p.file_path.replace(/\\/g, '/');
            const configFields = fieldsForPluginConfig(p);
            const envs = renderPluginConfigPanel(p, globalIdx);
            const envKeys = configFields.map(f => f.key);
            const desc = p.description || 'No description provided.';
            const logoUrl = `/assets/${folder.toLowerCase()}.png`;
            const triggers = (p.trigger_on || []).join(', ');
            const userRole = parseJwt(localStorage.getItem('sre-jwt'))?.role;
            const canToggleAuto = canManagePluginAutoRun(userRole);
            const autoOn = p.auto_run !== false && String(p.status).toLowerCase() === 'active';
            const gatewayOn = isPluginRoutingEligible(p);
            const autoBadge = autoOn
                ? '<span class="plugin-badge plugin-badge--auto-on">Auto-run on</span>'
                : '<span class="plugin-badge">Auto-run off</span>';
            const gatewayBadge = gatewayOn
                ? '<span class="plugin-badge plugin-badge--gateway-on">Gateways on</span>'
                : '<span class="plugin-badge">Gateways off</span>';
            const autoToggleBtn = canToggleAuto
                ? `<button type="button" class="btn-secondary plugin-btn-compact" onclick="window.togglePluginAutoRun('${safePath}', ${!autoOn})">${autoOn ? 'Disable auto-run' : 'Enable auto-run'}</button>`
                : '';
            const gatewayToggleBtn = canToggleAuto
                ? `<button type="button" class="btn-secondary plugin-btn-compact" onclick="window.togglePluginGatewayRouting('${safePath}', ${!gatewayOn})">${gatewayOn ? 'Disable for gateways' : 'Enable for gateways'}</button>`
                : '';
            const envKeysAttr = envKeys.join(',');

            html += `
                <div class="data-card plugin-card" data-plugin-idx="${globalIdx}" data-folder="${escapePluginHtml(folder.toLowerCase())}">
                    <div class="plugin-card__row">
                        <div class="plugin-card__main">
                            <div class="plugin-card__media">
                                <div class="plugin-card__icon-bg">${pluginIconSVG}</div>
                                <img src="${logoUrl}" onerror="this.style.display='none'" alt="" class="plugin-card__logo" />
                            </div>
                            <div>
                                <h3 class="plugin-card__title">
                                    ${escapePluginHtml(p.name)} <span class="plugin-card__version">v${escapePluginHtml(p.version || '1.0')}</span>
                                    ${gatewayBadge} ${autoBadge} ${gatewayToggleBtn} ${autoToggleBtn}
                                </h3>
                                <p class="plugin-card__desc">${escapePluginHtml(desc)}</p>
                                ${triggers ? `<p class="plugin-card__triggers">Triggers: ${escapePluginHtml(triggers)}</p>` : ''}
                            </div>
                        </div>
                        <div class="plugin-card__actions">
                            <button type="button" class="btn-secondary" onclick="window.togglePluginConfig('config-${globalIdx}')">${configIcon} Configure</button>
                            <button type="button" class="btn-primary" id="btn-run-${globalIdx}" onclick="window.runPlugin('${safePath}', ${globalIdx})">${runIcon} Execute</button>
                        </div>
                    </div>
                    <div id="config-${globalIdx}" class="plugin-config-panel">
                        ${envs}
                        <p class="plugin-config-hint">The message is set on the action in <strong>Workflow</strong>, separately for each gateway.</p>
                        ${envKeys.length ? `<button type="button" class="btn-primary plugin-save-fullwidth" onclick="window.savePluginConfig('${safePath}', ${globalIdx}, '${envKeysAttr}')">${saveIcon} Save</button>` : ''}
                    </div>
                    <div id="logs-container-${globalIdx}" class="plugin-logs">
                        <div class="plugin-logs__label">${consoleIcon} STDOUT Console</div>
                        <pre id="logs-${globalIdx}" class="plugin-console plugin-console--pending"></pre>
                    </div>
                </div>`;
            globalIdx++;
        });
    }

    if (!html) {
        html = `<div class="empty-state--lg">
            <p>No plugins match your search.</p>
            <p>Try another keyword or reset filters.</p>
        </div>`;
    }

    listEl.innerHTML = html;
    updatePluginSearchMeta(shown, plugins.length, q, category);
}

let pluginFilterDebounce = null;

export function filterPlugins() {
    if (!window.__pluginsCache) return;
    clearTimeout(pluginFilterDebounce);
    pluginFilterDebounce = setTimeout(() => {
        const query = document.getElementById('plugin-search')?.value || '';
        const category = document.getElementById('plugin-category-filter')?.value || 'all';
        renderPluginList(window.__pluginsCache, query, category);
    }, 120);
}

export function resetPluginFilters() {
    const search = document.getElementById('plugin-search');
    const cat = document.getElementById('plugin-category-filter');
    if (search) search.value = '';
    if (cat) cat.value = 'all';
    filterPlugins();
}

export function loadPlugins() {
    const meta = document.getElementById('plugin-search-meta');
    const listEl = document.getElementById('plugin-list');
    if (meta) meta.textContent = 'Loading modules…';

    fetchWithAuth(`/api/plugins?_ts=${Date.now()}`)
        .then(res => parseApiJson(res))
        .then(({ ok, data, status, offline }) => {
            if (!ok) {
                const msg = offline
                    ? 'Cannot reach server. Start: go run ./cmd/srecapsule'
                    : (data?.error || describeApiFailure(status, offline));
                if (listEl) {
                    listEl.innerHTML = `<div class="empty-state--lg"><p>Failed to load plugins.</p><p>${escapePluginHtml(msg)}</p></div>`;
                }
                if (meta) meta.textContent = 'Load failed.';
                if (status === 401) performLogout();
                return;
            }
            window.__pluginsCache = asArray(data);
            populatePluginCategoryFilter(window.__pluginsCache);
            const query = document.getElementById('plugin-search')?.value || '';
            const category = document.getElementById('plugin-category-filter')?.value || 'all';
            renderPluginList(window.__pluginsCache, query, category);
            if (window.__pluginsCache.length === 0 && meta) {
                meta.textContent = 'No modules in registry - check plugins/ folder and server logs (remediation registry loaded).';
            }
        })
        .catch(() => {
            notify('Network error', 'error');
            if (meta) meta.textContent = 'Failed to load plugins.';
        });
}

export function togglePluginConfig(id) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('is-open');
}

export function savePluginConfig(path, idx, keysStr) {
    const env = {};
    keysStr.split(',').filter(k => k).forEach(k => env[k] = document.getElementById(`env-${idx}-${k}`).value);
    fetchWithAuth('/api/plugins/config', {
        method: 'POST',
        body: JSON.stringify({ file_path: path, env: env, enable_routing: true })
    })
        .then(res => parseApiJson(res))
        .then(({ ok }) => {
            if (ok) {
                notify('Configuration saved', 'success');
                loadPlugins();
                loadGatewaysData();
            } else notify('Failed to save', 'error');
        });
}

export function runPlugin(path, idx) {
    const btn = document.getElementById(`btn-run-${idx}`);
    const logsContainer = document.getElementById(`logs-container-${idx}`);
    const logsEl = document.getElementById(`logs-${idx}`);

    btn.innerHTML = `Running...`;
    btn.disabled = true;
    btn.style.opacity = '0.7';
    logsContainer.classList.add('is-visible');
    logsEl.className = 'plugin-console plugin-console--pending';
    logsEl.innerHTML = 'Init...';

    fetchWithAuth('/api/plugins/run', { method: 'POST', body: JSON.stringify({ file_path: path }) }).then(async (res) => {
        const data = await res.json();
        const logs = data.logs || data.error || 'No output.';
        const failed = !res.ok || /\[ERROR\]|Failed to create|ERREUR:/i.test(logs);
        btn.innerHTML = `Execute`;
        btn.disabled = false;
        btn.style.opacity = '1';
        if (failed) {
            notify('Plugin execution failed - see console output.', 'error');
            logsEl.className = 'plugin-console plugin-console--error';
        } else {
            notify('Plugin executed successfully.', 'success');
            logsEl.className = 'plugin-console plugin-console--success';
        }
        logsEl.innerText = logs;
    });
}

export function loadConfig() {
    fetchWithAuth(`/api/config?_ts=${Date.now()}`).then(res => res.json()).then(c => {
        document.getElementById('policy-domain').value = c.security.allowed_domain || "";
        if (c.smtp) {
            document.getElementById('smtp-host').value = c.smtp.host || "";
            document.getElementById('smtp-port').value = c.smtp.port || "";
            document.getElementById('smtp-user').value = c.smtp.user || "";
            document.getElementById('smtp-pass').value = c.smtp.password || "";
            document.getElementById('smtp-from').value = c.smtp.from || "";
        }
        document.getElementById('config-container').innerHTML = `<pre class="config-json-preview">${JSON.stringify(c, null, 2)}</pre>`;
    });
}

export function saveSecurityPolicy() { fetchWithAuth('/api/config/policy', { method: 'POST', body: JSON.stringify({ allowed_domain: document.getElementById('policy-domain').value }) }).then(res => { if (res.ok) notify("Policy updated", "success"); }); }

export function saveSMTPConfig() {
    const payload = { host: document.getElementById('smtp-host').value, port: parseInt(document.getElementById('smtp-port').value) || 0, user: document.getElementById('smtp-user').value, password: document.getElementById('smtp-pass').value, from: document.getElementById('smtp-from').value };
    fetchWithAuth('/api/config/smtp', { method: 'POST', body: JSON.stringify(payload) }).then(res => { if (res.ok) notify("SMTP saved", "success"); });
}

export function loadFinOps() {
    fetchWithAuth(`/api/finops?_ts=${Date.now()}`)
        .then(res => { if (res.ok) return res.json(); throw new Error(); })
        .then(data => {
            const devRateInput = document.getElementById('finops-dev-rate');
            if (devRateInput) devRateInput.value = data.dev_hourly_rate;

            const ciCostInput = document.getElementById('finops-ci-cost');
            if (ciCostInput) ciCostInput.value = data.ci_minute_cost;

            const durationInput = document.getElementById('finops-duration');
            if (durationInput) durationInput.value = data.avg_pipeline_duration;

            const invTimeInput = document.getElementById('finops-investigation');
            if (invTimeInput) invTimeInput.value = data.avg_investigation_time;

            const currencySelector = document.getElementById('finops-currency');
            if (currencySelector && data.currency) {
                const preferred = window.selectedCurrency || localStorage.getItem('sre-pref-currency');
                const code = preferred || data.currency;
                currencySelector.value = code;
                selectedCurrency = code;
                window.selectedCurrency = code;
            }
        })
        .catch(e => console.error("Could not load FinOps settings"));
}

export function saveCurrencyPreference() {
    const currency = document.getElementById('finops-currency').value;
    window.selectedCurrency = currency;
    selectedCurrency = currency;
    localStorage.setItem('selected-currency', currency);
    try {
        localStorage.setItem('sre-pref-currency', currency);
    } catch (_) { /* quota */ }
    const prefSel = document.getElementById('pref-currency');
    if (prefSel) prefSel.value = currency;
    notify(`Currency changed to ${currency}`, 'success');
    if (document.getElementById('view-finops')?.classList.contains('active') && window.refreshFinOpsKPIs) {
        window.refreshFinOpsKPIs();
    }
}

export function saveFinOps() {
    const payload = {
        dev_hourly_rate: parseFloat(document.getElementById('finops-dev-rate').value) || 50,
        ci_minute_cost: parseFloat(document.getElementById('finops-ci-cost').value) || 0.008,
        avg_pipeline_duration: parseFloat(document.getElementById('finops-duration').value) || 15,
        avg_investigation_time: parseFloat(document.getElementById('finops-investigation').value) || 30,
        currency: document.getElementById('finops-currency').value || 'USD'
    };

    fetchWithAuth('/api/finops', { method: 'PUT', body: JSON.stringify(payload) })
        .then(res => {
            if (res.ok) {
                notify('FinOps settings updated. Dashboard metrics will recalculate.', 'success');
                if (document.getElementById('view-dashboard').classList.contains('active')) {
                    window.fetchIncidents(true);
                }
            } else { notify('Failed to update FinOps settings', 'error'); }
        }).catch(e => notify('Network error saving FinOps', 'error'));
}

export function updateCurrencyDisplay() {
    const currencySymbol = currencySymbols[selectedCurrency] || '$';
    const symbolElement = document.getElementById('kpi-cost-symbol');
    if (symbolElement) {
        symbolElement.textContent = currencySymbol;
    }
}

export function checkSSOStatus() {
    fetch('/api/sso/status')
        .then(res => res.json())
        .then(data => {
            const edition = String(data.edition || 'community').toLowerCase();
            const badge = document.getElementById('login-edition-badge');
            const ssoSection = document.getElementById('login-sso-section');
            const ssoContainer = document.getElementById('sso-container');
            const ssoLocked = document.getElementById('sso-locked');

            if (badge) {
                badge.textContent = edition === 'enterprise' ? 'Enterprise Edition' : 'Community Edition';
            }
            if (edition === 'community') {
                if (ssoSection) ssoSection.classList.add('u-hidden');
                return;
            }
            if (ssoSection) ssoSection.classList.remove('u-hidden');
            if (ssoContainer && ssoLocked) {
                if (data.enterprise_active || data.sso_available) {
                    ssoContainer.classList.remove('u-hidden');
                    ssoLocked.classList.add('u-hidden');
                } else {
                    ssoContainer.classList.add('u-hidden');
                    ssoLocked.classList.remove('u-hidden');
                }
            }
        }).catch(err => console.log("Edition check failed", err));
}

export function triggerSSO() {
    fetch('/api/sso/login')
        .then(res => {
            if (res.status === 402) {
                notify("SRE Capsule PRO License is missing or expired.", "error");
                return null;
            }
            return res.json();
        })
        .then(data => {
            if (data && data.sso_url) {
                notify(data.message, "success");
                setTimeout(() => { alert("Redirecting to: " + data.sso_url); }, 1500);
            }
        }).catch(err => notify("SSO failed. Please try again.", "error"));
}

// ── AI Provider & MCP Self-Healing ───────────────────────────────────────────

let _selectedAIProvider = 'disabled';

export async function loadAIConfig() {
    // Load AI provider config
    const res = await fetchWithAuth('/api/ai/config');
    const { ok, data } = await parseApiJson(res);

    _renderProviderPicker(ok && data ? data.provider : 'disabled');

    if (ok && data) {
        _selectedAIProvider = data.provider || 'disabled';
        const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
        // Populate model select first, then set base URL and key env
        _populateModelSelect(_selectedAIProvider, data.model);
        setVal('ai-base-url', data.base_url);
        setVal('ai-key-env', data.api_key_env);
        // Never pre-fill the key input - only indicate whether a key is already stored
        const apiKeyInput = document.getElementById('ai-api-key');
        if (apiKeyInput) apiKeyInput.value = '';
        const maxTok = document.getElementById('ai-max-tokens');
        if (maxTok) maxTok.value = data.max_tokens || 1024;
        const timeoutEl = document.getElementById('ai-timeout');
        if (timeoutEl) timeoutEl.value = data.timeout_seconds || 45;
        const enabled = document.getElementById('ai-enabled');
        if (enabled) enabled.checked = !!data.enabled;
        const keyStatus = document.getElementById('ai-key-status');
        if (keyStatus) {
            if (data.api_key_set) {
                const src = data.api_key_stored ? 'stored in database' : 'environment variable on server';
                keyStatus.textContent = `API key active (${src})`;
                keyStatus.style.color = 'var(--success-text)';
            } else {
                keyStatus.textContent = 'No API key found - enter one below or set the environment variable';
                keyStatus.style.color = 'var(--warn-text)';
            }
        }
        // KPI cards
        const setKpi = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        setKpi('ai-kpi-provider', data.provider && data.provider !== 'disabled' ? data.provider : '-');
        setKpi('ai-kpi-model', data.model || '-');
        setKpi('ai-kpi-apikey', data.api_key_set ? 'Set' : 'Missing');
        const apiKpiEl = document.getElementById('ai-kpi-apikey');
        if (apiKpiEl) apiKpiEl.style.color = data.api_key_set ? 'var(--success-text)' : 'var(--warn-text)';
    }

    // Load MCP status
    const statusRes = await fetchWithAuth('/api/ai/status');
    const { ok: sok, data: sdata } = await parseApiJson(statusRes);
    _updateAIStatusBadge(sok && sdata ? sdata : null);
}

export async function saveAIConfig() {
    // Read model from select; fall back to custom input if "__custom__" selected
    const sel = document.getElementById('ai-model-select');
    const model = (sel?.value === '__custom__' || !sel)
        ? (document.getElementById('ai-model')?.value?.trim() || '')
        : (sel?.value?.trim() || '');
    const baseUrl  = document.getElementById('ai-base-url')?.value?.trim() || '';
    const keyEnv   = document.getElementById('ai-key-env')?.value?.trim() || '';
    const apiKey   = document.getElementById('ai-api-key')?.value?.trim() || '';
    const maxTok   = parseInt(document.getElementById('ai-max-tokens')?.value || '1024', 10);
    const timeout  = parseInt(document.getElementById('ai-timeout')?.value || '45', 10);
    const enabled  = document.getElementById('ai-enabled')?.checked || false;

    const payload = {
        provider:        _selectedAIProvider,
        model,
        base_url:        baseUrl,
        api_key_env:     keyEnv,
        api_key:         apiKey,
        max_tokens:      maxTok,
        timeout_seconds: timeout,
        enabled,
    };

    const res = await fetchWithAuth('/api/ai/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (res.ok) {
        notify('AI configuration saved.', 'success');
        loadAIConfig();
    } else {
        notify('Failed to save configuration.', 'error');
    }
}

function _renderProviderPicker(currentProvider) {
    const container = document.getElementById('ai-provider-picker');
    if (!container) return;
    container.innerHTML = AI_PROVIDERS.map(p => {
        const selected = p.id === (currentProvider || 'disabled');
        return `
        <button type="button"
            class="ai-provider-option${selected ? ' ai-provider-option--selected' : ''}"
            data-provider="${_esc(p.id)}"
            title="${_esc(p.label)}"
            onclick="window._onAIProviderClick('${_esc(p.id)}')">
            <span class="ai-provider-option__logo">${logoForProvider(p.id)}</span>
            <span class="ai-provider-option__label">${_esc(p.label)}</span>
        </button>`;
    }).join('');
}

function _populateModelSelect(providerId, currentModel) {
    const sel = document.getElementById('ai-model-select');
    const customRow = document.getElementById('ai-model-custom-row');
    const customInput = document.getElementById('ai-model');
    if (!sel) return;

    const meta = getProviderMeta(providerId);
    const models = meta.models || [];

    if (models.length === 0) {
        // Provider like Disabled or unknown - show only custom input
        sel.innerHTML = '<option value="__custom__">Custom model…</option>';
        if (customRow) customRow.classList.add('visible');
        if (customInput) customInput.value = currentModel || '';
        return;
    }

    const opts = models.map(m =>
        `<option value="${_esc(m.id)}"${m.id === (currentModel || meta.defaultModel) ? ' selected' : ''}>${_esc(m.label)}</option>`
    );
    opts.push(`<option value="__custom__"${!models.find(m => m.id === currentModel) && currentModel ? ' selected' : ''}>Custom model…</option>`);
    sel.innerHTML = opts.join('');

    const isCustom = sel.value === '__custom__';
    if (customRow) customRow.classList.toggle('visible', isCustom);
    if (customInput && isCustom && currentModel && !models.find(m => m.id === currentModel)) {
        customInput.value = currentModel;
    } else if (customInput && !isCustom) {
        customInput.value = '';
    }
}

window._onAIModelSelectChange = function(value) {
    const customRow = document.getElementById('ai-model-custom-row');
    if (customRow) customRow.classList.toggle('visible', value === '__custom__');
};

window._onAIProviderClick = function(providerId) {
    _selectedAIProvider = providerId;
    document.querySelectorAll('#ai-provider-picker .ai-provider-option').forEach(btn => {
        btn.classList.toggle('ai-provider-option--selected', btn.dataset.provider === providerId);
    });
    const meta = getProviderMeta(providerId);

    // Populate model select for new provider
    _populateModelSelect(providerId, meta.defaultModel);

    // Auto-fill base URL and key env (always overwrite on provider change)
    const baseUrlEl = document.getElementById('ai-base-url');
    const keyEnvEl  = document.getElementById('ai-key-env');
    if (baseUrlEl) baseUrlEl.value = meta.defaultBaseUrl || '';
    if (keyEnvEl)  keyEnvEl.value  = meta.defaultKeyEnv  || '';

    const keyStatus = document.getElementById('ai-key-status');
    if (keyStatus) {
        keyStatus.textContent = meta.keyOptional
            ? 'No API key required for this local provider.'
            : meta.defaultKeyEnv
                ? `Set ${meta.defaultKeyEnv} as a server environment variable, or paste the key below.`
                : '';
        keyStatus.style.color = '';
    }
};

function _updateAIStatusBadge(data) {
    const badge = document.getElementById('ai-status-badge');
    if (!badge) return;
    if (!data || !data.enabled || data.provider === 'disabled') {
        badge.textContent = 'AI disabled';
        badge.className = 'intel-badge intel-badge--manual';
    } else {
        badge.textContent = `${data.provider} / ${data.model || 'default model'}`;
        badge.className = 'intel-badge intel-badge--healed';
    }
}

export async function loadAIUsageView() {
    const res = await fetchWithAuth('/api/ai/status');
    const { ok, data } = await parseApiJson(res);
    const badge = document.getElementById('ai-usage-status-badge');
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v || '-'; };
    if (ok && data) {
        if (badge) {
            badge.textContent = data.enabled ? `${data.provider || 'AI'} on` : 'AI off';
            badge.className = 'intel-badge ' + (data.enabled ? 'intel-badge--on' : 'intel-badge--manual');
        }
        set('ai-usage-provider', data.provider || 'disabled');
        set('ai-usage-model', data.model || '-');
        set('ai-usage-enabled', data.enabled ? 'Yes' : 'No');
    } else if (badge) {
        badge.textContent = 'AI off';
        badge.className = 'intel-badge intel-badge--manual';
    }
}

window.loadAIUsageView = loadAIUsageView;

// ── Test LLM Connection ──────────────────────────────────────────────────────

window.testAIConnection = async function testAIConnection() {
    const btn = document.getElementById('ai-test-btn');
    const resultEl = document.getElementById('ai-test-result');
    if (!resultEl) return;

    if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; }
    resultEl.style.display = 'none';
    resultEl.className = 'ai-test-result';

    try {
        const { fetchWithAuth, parseApiJson } = await import('./api.js');
        const res = await fetchWithAuth('/api/ai/test', { method: 'POST' });
        const { ok, data } = await parseApiJson(res);
        const payload = data || {};
        if (ok && payload.ok) {
            resultEl.className = 'ai-test-result ai-test-result--ok';
            resultEl.innerHTML = `
                <strong>Connection successful</strong>
                <span class="ai-test-meta">${_esc(payload.provider)} / ${_esc(payload.model)} &nbsp;·&nbsp; ${payload.elapsed_ms}ms</span>
                <p class="ai-test-response">${_esc(payload.response || '')}</p>
            `;
        } else {
            resultEl.className = 'ai-test-result ai-test-result--error';
            resultEl.innerHTML = `
                <strong>Connection failed</strong>
                <p class="ai-test-response">${_esc(payload.error || 'Unknown error')}</p>
            `;
        }
    } catch (e) {
        resultEl.className = 'ai-test-result ai-test-result--error';
        resultEl.innerHTML = `<strong>Connection failed</strong><p class="ai-test-response">${_esc(String(e))}</p>`;
    } finally {
        resultEl.style.display = 'block';
        if (btn) { btn.disabled = false; btn.textContent = 'Test Connection'; }
    }
};

function _esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

window._toggleAPIKeyVisibility = function() {
    const input = document.getElementById('ai-api-key');
    const btn   = document.getElementById('ai-api-key-toggle');
    if (!input) return;
    if (input.type === 'password') {
        input.type = 'text';
        if (btn) btn.textContent = 'Hide';
    } else {
        input.type = 'password';
        if (btn) btn.textContent = 'Show';
    }
};