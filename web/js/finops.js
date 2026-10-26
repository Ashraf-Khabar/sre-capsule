/**

 * FinOps Intelligence - Manager role only

 */

import { fetchWithAuth, parseApiJson, asArray } from './api.js';

import { notify } from './ui.js';

import { currencySymbols } from './settings.js';

import { getChartPalette } from './chart-palette.js';
import { getChartTheme, withChartTheme } from './chart-theme.js';
import { setPremiumKpi } from './kpi-premium.js';



let finopsWeeklyChart = null;

let finopsMetricsChart = null;



/** Same time range as the Operations dashboard (DOM or localStorage). */
export function getFinOpsRangeQuery() {
    if (typeof window.getDashboardRangeQueryResolved === 'function') {
        const q = window.getDashboardRangeQueryResolved();
        if (q) return q;
    }
    if (typeof window.getDashboardRangeQuery === 'function') {
        const q = window.getDashboardRangeQuery();
        if (q) return q;
    }
    return 'range=5m';
}

function finopsCurrencyCode() {
    return window.selectedCurrency
        || document.getElementById('finops-currency')?.value
        || document.getElementById('pref-currency')?.value
        || 'USD';
}

function finopsCurrencySymbol() {
    return currencySymbols[finopsCurrencyCode()] || '$';
}

function updateFinOpsRangeHint() {
    const hint = document.getElementById('finops-range-hint');
    if (!hint) return;
    const summary = document.getElementById('dashboard-range-summary')?.textContent?.trim();
    hint.textContent = summary
        ? `Metrics aligned with dashboard: ${summary}`
        : 'Metrics aligned with the dashboard time range.';
}



export function loadFinOpsView() {
    updateFinOpsRangeHint();
    loadFinOpsBaselines();
    loadFinOpsProjectFilter();
    refreshFinOpsKPIs();
    loadFinOpsWeeklyTable();
    loadFinOpsWeeklyEvolution();
}

function ensureFinOpsChartCanvas(canvasId) {
    let canvas = document.getElementById(canvasId);
    if (canvas) return canvas;
    const dead = document.querySelector(`.finops-chart-empty[data-chart-for="${canvasId}"]`);
    if (dead) {
        const box = dead.parentElement;
        if (box) {
            box.innerHTML = `<canvas id="${canvasId}"></canvas>`;
            return document.getElementById(canvasId);
        }
    }
    const legacyBox = document.getElementById(canvasId)?.parentElement
        || document.querySelector(`#${canvasId}`)?.parentElement;
    if (legacyBox?.querySelector('.finops-chart-empty')) {
        legacyBox.innerHTML = `<canvas id="${canvasId}"></canvas>`;
        return document.getElementById(canvasId);
    }
    return null;
}

/** Reload all FinOps panels (same time range as Operations dashboard). */
export function refreshFinOpsView() {
    const btn = document.querySelector('.finops-refresh-btn');
    if (btn) {
        btn.disabled = true;
        btn.dataset.label = btn.textContent;
        btn.textContent = 'Refreshing…';
    }
    updateFinOpsRangeHint();
    ensureFinOpsChartCanvas('finops-evolution-chart');
    ensureFinOpsChartCanvas('finops-cost-evolution-chart');
    refreshFinOpsKPIs();
    loadFinOpsWeeklyTable();
    loadFinOpsWeeklyEvolution();
    window.setTimeout(() => {
        if (btn) {
            btn.disabled = false;
            btn.textContent = btn.dataset.label || 'Refresh';
        }
    }, 600);
}



function loadFinOpsProjectFilter() {

    fetchWithAuth('/api/my-projects')

        .then(res => parseApiJson(res))

        .then(({ ok, data }) => {

            const sel = document.getElementById('finops-export-project');

            if (!sel || !ok) return;

            sel.innerHTML = '<option value="all">All gateways</option>';

            asArray(data).forEach(p => {

                sel.innerHTML += `<option value="${p.name}">${p.name}</option>`;

            });

        })

        .catch(() => {});

}



function loadFinOpsBaselines() {

    fetchWithAuth(`/api/finops?_ts=${Date.now()}`)

        .then(res => { if (!res.ok) throw new Error(); return res.json(); })

        .then(data => {

            const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };

            set('finops-dev-rate', data.dev_hourly_rate ?? 50);

            set('finops-ci-cost', data.ci_minute_cost ?? 0.008);

            set('finops-duration', data.avg_pipeline_duration ?? 15);

            set('finops-investigation', data.avg_investigation_time ?? 30);

            const cur = document.getElementById('finops-currency');
            const preferred = window.selectedCurrency || localStorage.getItem('sre-pref-currency');
            if (cur) {
                cur.value = preferred || data.currency || 'USD';
            }
            if (preferred || data.currency) {
                const code = preferred || data.currency;
                window.selectedCurrency = code;
            }

        })

        .catch(() => notify('Could not load FinOps settings', 'error'));

}



export function saveFinOpsBaselines() {

    const payload = {

        dev_hourly_rate: parseFloat(document.getElementById('finops-dev-rate').value) || 50,

        ci_minute_cost: parseFloat(document.getElementById('finops-ci-cost').value) || 0.008,

        avg_pipeline_duration: parseFloat(document.getElementById('finops-duration').value) || 15,

        avg_investigation_time: parseFloat(document.getElementById('finops-investigation').value) || 30,

        currency: document.getElementById('finops-currency').value || 'USD'

    };



    window.selectedCurrency = payload.currency;

    fetchWithAuth('/api/finops', { method: 'PUT', body: JSON.stringify(payload) })

        .then(res => {

            if (res.ok) {

                notify('FinOps baseline saved. KPIs will recalculate.', 'success');

                refreshFinOpsKPIs();

                loadFinOpsWeeklyEvolution();

                loadFinOpsWeeklyTable();

            } else notify('Failed to save FinOps baseline', 'error');

        });

}



export function exportFinOpsReport() {

    const period = document.getElementById('finops-export-period')?.value || 'week';

    const project = document.getElementById('finops-export-project')?.value || 'all';

    const url = `/api/finops/export?period=${encodeURIComponent(period)}&project=${encodeURIComponent(project)}&format=csv&_ts=${Date.now()}`;



    fetchWithAuth(url)

        .then(res => {

            if (!res.ok) throw new Error();

            return res.blob();

        })

        .then(blob => {

            const a = document.createElement('a');

            a.href = URL.createObjectURL(blob);

            a.download = `finops-report-${period}-${project}-${new Date().toISOString().slice(0, 10)}.csv`;

            a.click();

            notify('FinOps report exported', 'success');

        })

        .catch(() => notify('Export failed', 'error'));

}



export function refreshFinOpsKPIs() {
    updateFinOpsRangeHint();
    const rangeQ = getFinOpsRangeQuery();

    fetchWithAuth(`/api/metrics?${rangeQ}&_ts=${Date.now()}`)

        .then(res => parseApiJson(res))

        .then(({ ok, data }) => {

            if (!ok || !data) return;

            const sym = finopsCurrencySymbol();
            const impact = data.sre_impact || {};
            const total = Number(impact.estimated_cost_usd) || 0;
            const flaky = Number(impact.flaky_waste_cost_usd) || 0;
            const pct = total > 0 ? Math.round((flaky / total) * 100) : 0;
            const ciMin = impact.ci_minutes_lost ?? 0;
            const incidents = data.total_incidents ?? 0;
            const flakyCount = data.flaky_tests ?? 0;

            setPremiumKpi('finops-kpi-total-cost', sym + (impact.estimated_cost_usd ?? '0'), {
                tone: 'info',
                trend: total > 100 ? 'down' : '',
                trendText: total > 100 ? '↓ Spend in range' : ''
            });

            setPremiumKpi('finops-kpi-flaky-cost', sym + (impact.flaky_waste_cost_usd ?? '0'), {
                tone: 'warn',
                trend: flaky > 0 ? 'down' : 'up',
                trendText: flaky > 0 ? '↓ Flaky waste' : '↑ No flaky waste'
            });

            const hintEl = document.getElementById('finops-kpi-waste-pct');
            if (hintEl) hintEl.textContent = pct + '% of total';

            setPremiumKpi('finops-kpi-ci-minutes', ciMin + ' min', {
                tone: 'danger',
                trend: ciMin > 30 ? 'down' : 'up',
                trendText: ciMin > 30 ? '↓ CI time lost' : '↑ Low CI loss'
            });

            setPremiumKpi('finops-kpi-mttr', (data.mttr_minutes ?? 0) + ' min', {
                tone: 'success',
                trend: (data.mttr_minutes ?? 0) > 60 ? 'down' : 'up',
                trendText: (data.mttr_minutes ?? 0) > 60 ? '↓ Elevated MTTR' : '↑ Recovery OK'
            });

            setPremiumKpi('finops-kpi-incidents', String(incidents), {
                tone: incidents > 10 ? 'warn' : 'neutral',
                trend: incidents > 0 ? 'down' : 'up',
                trendText: incidents > 0 ? '↓ Active volume' : '↑ Quiet period'
            });

            setPremiumKpi('finops-kpi-flaky-count', String(flakyCount), {
                tone: 'warn',
                trend: flakyCount > 0 ? 'down' : 'up',
                trendText: flakyCount > 0 ? '↓ Flaky detected' : '↑ Stable tests'
            });

        })

        .catch(() => notify('Could not load FinOps KPIs', 'error'));

}



export function loadFinOpsWeeklyTable() {

    const rangeQ = getFinOpsRangeQuery();

    fetchWithAuth(`/api/reports/weekly?${rangeQ}&_ts=${Date.now()}`)

        .then(res => parseApiJson(res))

        .then(({ ok, data }) => {

            const tbody = document.getElementById('finops-weekly-body');

            if (!tbody) return;

            if (!ok) {

                tbody.innerHTML = '<tr><td colspan="5" class="load-error-msg">Unable to load weekly report.</td></tr>';

                return;

            }

            const rows = asArray(data);

            if (rows.length === 0) {

                tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No incidents in the selected time range.</td></tr>';

                return;

            }

            tbody.innerHTML = rows.map(r => `
                <tr>
                    <td><strong>${r.pipeline}</strong></td>
                    <td>${r.total_alerts}</td>
                    <td class="metric-cell--success">${r.resolved_alerts}</td>
                    <td class="metric-cell--warn">${r.flaky_tests}</td>
                    <td>${r.health_score}%</td>
                </tr>`).join('');

        })

        .catch(() => {});

}



function showFinOpsChartEmpty(canvasId, message) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const wrap = canvas.parentElement;
    if (wrap) {
        wrap.innerHTML = `<div class="finops-chart-empty" data-chart-for="${canvasId}">${message}</div>`;
    }
}



function formatFinOpsLabel(raw, bucket) {
    if (!raw) return raw;
    const d = new Date(String(raw).replace(' ', 'T'));
    if (isNaN(d.getTime())) return raw;
    if (bucket === 'hour') return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    if (bucket === 'day') return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function loadFinOpsWeeklyEvolution() {
    const rangeQ = getFinOpsRangeQuery();
    fetchWithAuth(`/api/finops/evolution?${rangeQ}&_ts=${Date.now()}`)
        .then(res => parseApiJson(res))
        .then(({ ok, data }) => {
            if (!ok || !data?.series?.length) {
                const hint = 'No data for the selected time range. Widen the dashboard period or ingest more incidents.';
                showFinOpsChartEmpty('finops-evolution-chart', hint);
                showFinOpsChartEmpty('finops-cost-evolution-chart', hint);
                return;
            }
            renderFinOpsMetricsChart(data.series, data.evolution_bucket);
            renderFinOpsCostChart(data.series, data.evolution_bucket);
        })
        .catch(() => {
            showFinOpsChartEmpty('finops-evolution-chart', 'Failed to load FinOps evolution.');
        });
}



function renderFinOpsMetricsChart(series, bucket = 'week') {
    const canvas = ensureFinOpsChartCanvas('finops-evolution-chart');
    if (!canvas || !series.length) return;
    if (finopsWeeklyChart) finopsWeeklyChart.destroy();

    const theme = getChartTheme();
    const pal = getChartPalette();
    finopsWeeklyChart = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
            labels: series.map(s => formatFinOpsLabel(s.week_start, bucket)),
            datasets: [
                { label: 'Incidents', data: series.map(s => s.total_incidents), backgroundColor: pal.series[0] },
                { label: 'Flaky', data: series.map(s => s.flaky_count), backgroundColor: pal.semantic.warning },
                { label: 'MTTR (min)', type: 'line', data: series.map(s => Math.round(s.mttr_minutes)), borderColor: pal.semantic.success, yAxisID: 'y1', tension: 0.3 }
            ]
        },
        options: withChartTheme({
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'top' } },
            scales: {
                x: { grid: { display: false } },
                y: { position: 'left', beginAtZero: true },
                y1: { position: 'right', grid: { drawOnChartArea: false }, beginAtZero: true }
            }
        }, theme)
    });

}



function renderFinOpsCostChart(series, bucket = 'week') {
    const canvas = ensureFinOpsChartCanvas('finops-cost-evolution-chart');
    if (!canvas || !series.length) return;
    if (finopsMetricsChart) finopsMetricsChart.destroy();

    const sym = finopsCurrencySymbol();

    const theme = getChartTheme();
    const pal = getChartPalette();
    finopsMetricsChart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: series.map(s => formatFinOpsLabel(s.week_start, bucket)),
            datasets: [
                { label: `Total cost (${sym})`, data: series.map(s => s.estimated_cost_usd), borderColor: pal.series[0], backgroundColor: 'rgba(30,58,95,0.1)', fill: true, tension: 0.35 },
                { label: `Flaky waste (${sym})`, data: series.map(s => s.flaky_cost_usd), borderColor: pal.semantic.warning, tension: 0.35 }
            ]
        },
        options: withChartTheme({
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'top' } },
            scales: {
                x: { grid: { display: false } },
                y: { beginAtZero: true }
            }
        }, theme)
    });

}


