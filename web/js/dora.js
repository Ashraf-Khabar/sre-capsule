/**
 * DORA & Executive dashboard (Manager).
 */
import { fetchWithAuth, parseApiJson } from './api.js';
import { getChartPalette } from './chart-palette.js';
import { getChartTheme, withChartTheme } from './chart-theme.js';
import { setPremiumKpi } from './kpi-premium.js';

let doraTrendChart = null;

export function loadDORAView() {
    loadDORAProjectFilter();
    refreshDORAMetrics();
    refreshMaintenanceCard();
}

export function destroyDORAChart() {
    if (doraTrendChart) {
        doraTrendChart.destroy();
        doraTrendChart = null;
    }
}

function loadDORAProjectFilter() {
    const sel = document.getElementById('dora-project-filter');
    if (!sel) return;
    fetchWithAuth('/api/my-projects')
        .then(res => parseApiJson(res))
        .then(({ ok, data }) => {
            if (!ok) return;
            const projects = Array.isArray(data) ? data : data?.projects || [];
            sel.innerHTML = '<option value="">All projects</option>';
            const maint = document.getElementById('maintenance-project');
            if (maint) maint.innerHTML = '<option value="">Select a gateway</option>';
            projects.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.name ?? p.Name ?? '';
                opt.textContent = opt.value;
                sel.appendChild(opt);
                if (maint && opt.value) maint.appendChild(opt.cloneNode(true));
            });
        });
}

export function refreshDORAMetrics() {
    const project = document.getElementById('dora-project-filter')?.value || '';
    const range = document.getElementById('dora-range-select')?.value || '30d';
    const q = new URLSearchParams({ range, project }).toString();
    fetchWithAuth(`/api/dora/metrics?${q}`)
        .then(res => parseApiJson(res))
        .then(({ ok, data }) => {
            if (!ok || !data?.metrics) return;
            const m = data.metrics;
            const cfr = m.change_failure_rate;
            const cfrPct = cfr != null ? `${(cfr * 100).toFixed(1)}%` : '-';
            const deployFreq = m.deployment_frequency_per_day?.toFixed(2) ?? '-';

            setPremiumKpi('dora-kpi-deploy-freq', deployFreq, {
                tone: 'info',
                trend: (m.deployment_frequency_per_day ?? 0) >= 0.5 ? 'up' : '',
                trendText: '↑ Delivery cadence'
            });

            const leadMin = m.lead_time_minutes_median;
            setPremiumKpi('dora-kpi-lead-time', formatMinutes(leadMin), {
                tone: leadMin != null && leadMin > 120 ? 'warn' : 'success',
                trend: leadMin != null && leadMin > 120 ? 'down' : 'up',
                trendText: leadMin != null && leadMin > 120 ? '↓ Slow lead time' : '↑ On track'
            });

            setPremiumKpi('dora-kpi-cfr', cfrPct, {
                tone: cfr != null && cfr > 0.15 ? 'danger' : 'success',
                trend: cfr != null && cfr > 0.15 ? 'down' : 'up',
                trendText: cfr != null && cfr > 0.15 ? '↓ Above target' : '↑ Within target'
            });

            const mttr = m.mttr_minutes;
            setPremiumKpi('dora-kpi-mttr', formatMinutes(mttr), {
                tone: mttr != null && mttr > 60 ? 'warn' : 'success',
                trend: mttr != null && mttr > 60 ? 'down' : 'up',
                trendText: mttr != null && mttr > 60 ? '↓ Recovery slow' : '↑ Healthy MTTR'
            });

            setPremiumKpi('dora-kpi-deployments', String(m.deployments ?? '-'), {
                tone: 'neutral',
                trend: (m.deployments ?? 0) > 0 ? 'up' : '',
                trendText: '↑ Pipeline activity'
            });

            setPremiumKpi('dora-kpi-signals', String(m.external_signals ?? 0), {
                tone: 'info',
                trend: (m.external_signals ?? 0) > 0 ? 'up' : '',
                trendText: '↑ Observability linked'
            });

            setPremiumKpi('dora-kpi-correlated', String(m.correlated_incidents ?? 0), {
                tone: (m.correlated_incidents ?? 0) > 0 ? 'warn' : 'neutral',
                trend: (m.correlated_incidents ?? 0) > 0 ? 'down' : 'up',
                trendText: (m.correlated_incidents ?? 0) > 0 ? '↓ Correlations found' : '↑ No correlations'
            });

            renderDORATrend(m.series || []);
            renderCorrelations(data.correlations || []);
            renderErrorBudgets(data.error_budgets || []);
        });
}

function formatMinutes(v) {
    if (v == null || Number.isNaN(v)) return '-';
    if (v < 60) return `${Math.round(v)}m`;
    return `${(v / 60).toFixed(1)}h`;
}

function renderDORATrend(series) {
    const canvas = document.getElementById('dora-trend-chart');
    if (!canvas || typeof Chart === 'undefined') return;
    if (doraTrendChart) doraTrendChart.destroy();
    const labels = series.map(s => s.period_start || '');
    const theme = getChartTheme();
    const pal = getChartPalette();
    doraTrendChart = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'Deployments',
                    data: series.map(s => s.deployments),
                    backgroundColor: pal.series[0]
                },
                {
                    label: 'Failed',
                    data: series.map(s => s.failed_deployments),
                    backgroundColor: pal.semantic.danger
                }
            ]
        },
        options: withChartTheme({
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom' } },
            scales: {
                x: { stacked: true, grid: { display: false } },
                y: { stacked: true, beginAtZero: true }
            }
        }, theme)
    });
}

function renderCorrelations(rows) {
    const tbody = document.getElementById('dora-correlations-body');
    if (!tbody) return;
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="modern-data-grid__empty">No Prometheus ↔ incident correlations in range.</td></tr>';
        return;
    }
    tbody.innerHTML = rows.map(r => `
        <tr>
            <td>${escapeHtml(r.signal_name)}</td>
            <td>#${r.incident_id}</td>
            <td>${escapeHtml(r.incident_name || '')}</td>
            <td>${escapeHtml(r.fired_at || '')}</td>
        </tr>
    `).join('');
}

function renderErrorBudgets(rows) {
    const tbody = document.getElementById('dora-budget-body');
    const banner = document.getElementById('dora-budget-banner');
    if (!tbody) return;
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="modern-data-grid__empty">No pipeline runs in this window.</td></tr>';
        if (banner) banner.hidden = true;
        return;
    }
    const decision = {
        quiet: 'No runs',
        healthy: 'Within budget',
        watch: 'Close to budget',
        freeze: 'Freeze deploys'
    };
    const frozen = rows.filter(row => row.status === 'freeze').map(row => row.project);
    const watching = rows.filter(row => row.status === 'watch').map(row => row.project);
    if (banner) {
        if (frozen.length) {
            banner.hidden = false;
            banner.textContent = `Freeze deploys on ${frozen.join(', ')}. Those gateways used their error budget for this window.`;
        } else if (watching.length) {
            banner.hidden = false;
            banner.textContent = `${watching.join(', ')} ${watching.length === 1 ? 'is' : 'are'} close to the error budget.`;
        } else {
            banner.hidden = true;
            banner.textContent = '';
        }
    }
    tbody.innerHTML = rows.map(row => {
        const left = row.status === 'quiet' ? '-' : `${Math.round((row.remaining_ratio || 0) * 100)}%`;
        const burn = row.status === 'quiet' ? '-' : `${Number(row.burn_rate || 0).toFixed(1)}×`;
        const sloPct = Math.round((row.slo_failure_rate || 0.15) * 100);
        const project = escapeHtml(row.project || '').replace(/"/g, '&quot;');
        return `<tr>
            <td>${escapeHtml(row.project || '')}</td>
            <td>
                <form class="budget-slo" data-project="${project}" onsubmit="saveGatewaySLO(event)">
                    <input type="number" min="1" max="50" step="1" value="${sloPct}" aria-label="Change-failure SLO percent">
                    <span>%</span>
                    <button type="submit" class="btn btn-secondary btn-sm">Save</button>
                </form>
            </td>
            <td>${row.deployments ?? 0}</td>
            <td>${row.failed ?? 0}</td>
            <td>${left}</td>
            <td>${burn}</td>
            <td><span class="budget-status budget-status--${escapeHtml(row.status || 'quiet')}">${decision[row.status] || 'Within budget'}</span></td>
        </tr>`;
    }).join('');
}

async function refreshMaintenanceCard() {
    const list = document.getElementById('maintenance-active');
    if (!list) return;
    const parsed = await parseApiJson(await fetchWithAuth('/api/maintenance'));
    const windows = parsed.ok && parsed.data && Array.isArray(parsed.data.windows) ? parsed.data.windows : [];
    list.innerHTML = maintenanceWindowTable(windows, true);
}

function maintenanceUntil(value) {
    const raw = String(value || '').trim();
    if (!raw) return '-';
    const parsed = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
    if (Number.isNaN(parsed.getTime())) return raw;
    return parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function maintenanceWindowTable(windows, canEnd) {
    if (!windows.length) {
        return '<p class="maintenance-empty">No gateway is in maintenance.</p>';
    }
    const rows = windows.map(row => {
        const project = row.project || '';
        const end = canEnd
            ? `<button type="button" class="btn btn-secondary btn-sm" data-project="${encodeURIComponent(project)}" onclick="endMaintenance(this.dataset.project)">End</button>`
            : '';
        return `<tr>
            <td>${escapeHtml(project)}</td>
            <td>${escapeHtml(row.reason || '-')}</td>
            <td>${escapeHtml(maintenanceUntil(row.ends_at))}</td>
            <td>${end}</td>
        </tr>`;
    }).join('');
    return `<table class="data-table maintenance-table">
        <thead><tr><th>Gateway</th><th>Reason</th><th>Until</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
    </table>`;
}

export async function startMaintenance(event) {
    event.preventDefault();
    const project = document.getElementById('maintenance-project')?.value || '';
    const reason = document.getElementById('maintenance-reason')?.value || '';
    const hours = Number(document.getElementById('maintenance-hours')?.value || 0);
    const parsed = await parseApiJson(await fetchWithAuth('/api/maintenance', {
        method: 'POST',
        body: JSON.stringify({ project, reason, hours }),
    }));
    if (!parsed.ok) {
        const message = parsed.data && parsed.data.error ? parsed.data.error : 'Could not start maintenance';
        if (window.notify) window.notify(message, 'error');
        return;
    }
    const reasonBox = document.getElementById('maintenance-reason');
    if (reasonBox) reasonBox.value = '';
    if (window.notify) window.notify('Maintenance started');
    refreshMaintenanceCard();
    if (window.refreshMaintenanceBanner) window.refreshMaintenanceBanner();
}

export async function endMaintenance(project) {
    project = decodeURIComponent(project || '');
    const parsed = await parseApiJson(await fetchWithAuth('/api/maintenance', {
        method: 'POST',
        body: JSON.stringify({ action: 'end', project }),
    }));
    if (!parsed.ok) {
        const message = parsed.data && parsed.data.error ? parsed.data.error : 'Could not end maintenance';
        if (window.notify) window.notify(message, 'error');
        return;
    }
    if (window.notify) window.notify('Maintenance ended');
    refreshMaintenanceCard();
    if (window.refreshMaintenanceBanner) window.refreshMaintenanceBanner();
    if (window.refreshDashboard) window.refreshDashboard();
}

export async function saveGatewaySLO(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const project = form.dataset.project || '';
    const input = form.querySelector('input');
    const percent = Number(input && input.value);
    const parsed = await parseApiJson(await fetchWithAuth('/api/dora/slo', {
        method: 'POST',
        body: JSON.stringify({ project, slo_percent: percent }),
    }));
    if (!parsed.ok) {
        const message = parsed.data && parsed.data.error ? parsed.data.error : 'Could not save the SLO';
        if (window.notify) window.notify(message, 'error');
        return;
    }
    if (window.notify) window.notify('SLO saved');
    refreshDORAMetrics();
}

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
