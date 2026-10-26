/**
 * Unified pipeline report viewer - full HTML report from GET /api/reports/{runId}
 */
import { fetchWithAuth, parseApiJson } from './api.js';
import { notify } from './ui.js';
import { hydrateOpenComments, revealComment } from './comments.js?v=1.0.40-edit-fill';
import { publishSecureLink } from './links.js';

function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatDuration(ms) {
    const n = Number(ms) || 0;
    if (n <= 0) return '-';
    if (n < 1000) return `${n}ms`;
    const sec = Math.floor(n / 1000);
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    if (min > 0) return `${min}m ${remSec}s`;
    return `${sec}s`;
}

function formatSummaryDuration(ms) {
    return formatDuration(ms);
}

function statusCase(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return '';
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function statusLabel(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'pass') return 'Pass';
    if (s === 'skip') return 'Skip';
    if (s === 'flaky') return 'Flaky';
    return 'Fail';
}

function statusRowClass(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'pass') return 'ur-test-row--pass';
    if (s === 'skip') return 'ur-test-row--skip';
    if (s === 'flaky') return 'ur-test-row--flaky';
    return 'ur-test-row--fail';
}

function logBlockContent(test) {
    const parts = [];
    if (test.error_message) parts.push(test.error_message);
    if (test.error_logs) parts.push(test.error_logs);
    if (test.console_logs) parts.push(test.console_logs);
    return parts.join('\n\n').trim() || 'No error details captured.';
}

function hasLogContent(test) {
    return !!(test.error_message || test.error_logs || test.console_logs);
}

/** Strip framework prefix and long unified name for display. */
function displayTestName(test) {
    let n = String(test.name || '').replace(/^\[[^\]]+\]\s*/, '');
    if (n.includes(' : ')) {
        const parts = n.split(/\s*:\s*/);
        n = (parts[parts.length - 1] || n).trim();
    }
    if (test.class_name) {
        const cls = String(test.class_name).replace(/\\/g, '/');
        const clsLeaf = cls.includes('/') ? cls.split('/').pop() : cls;
        const shortSuite = clsLeaf.split('.').slice(0, -1).join('.') || clsLeaf;
        let shortName = n;
        if (shortName.includes('>')) shortName = shortName.split('>').pop().trim();
        else if (shortName.includes('::')) shortName = shortName.split('::').pop().trim();
        else if (shortName.replace(/\\/g, '/').includes('/')) shortName = shortName.replace(/\\/g, '/').split('/').pop().trim();
        return `${shortSuite} › ${shortName}`;
    }
    if (n.includes(' > ')) {
        return n.replace(/\s*>\s*/g, ' › ');
    }
    if (n.includes('::')) {
        return n.replace(/\s*::\s*/g, ' › ');
    }
    const flat = n.replace(/\\/g, '/');
    if (flat.includes('/')) {
        return flat.split('/').pop() || n;
    }
    return n || '-';
}

function suiteKeyFor(test) {
    if (test.suite) return test.suite;
    if (test.class_name) return test.class_name;
    const n = String(test.name || '').replace(/^\[[^\]]+\]\s*/, '');
    const idx = n.indexOf(' > ');
    if (idx > 0) return n.slice(0, idx).trim();
    const sep = n.indexOf(' : ');
    if (sep > 0) return n.slice(0, sep).trim();
    return 'Test Suite';
}

function buildSuiteTree(tests) {
    const tree = new Map();
    for (const t of tests) {
        const key = suiteKeyFor(t);
        if (!tree.has(key)) {
            tree.set(key, { name: key, tests: [], passed: 0, failed: 0, skipped: 0, flaky: 0, durationMs: 0 });
        }
        const node = tree.get(key);
        node.tests.push(t);
        node.durationMs += Number(t.duration_ms) || 0;
        const st = String(t.status || '').toLowerCase();
        if (st === 'pass') node.passed++;
        else if (st === 'skip') node.skipped++;
        else if (st === 'flaky') { node.flaky++; node.failed++; }
        else node.failed++;
    }
    return [...tree.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function renderTestDetailBlock(test, idx) {
    const st = String(test.status || '').toLowerCase();
    const isFail = st === 'fail' || st === 'flaky';
    const openAttr = isFail ? ' open' : '';
    const logs = logBlockContent(test);
    const showLogs = isFail || hasLogContent(test);
    return `
    <details class="ur-test-block ${statusRowClass(test.status)}"${openAttr}>
        <summary class="ur-test-summary">
            <span class="ur-status-pill ur-status-pill--${escapeHtml(st)}">${statusLabel(test.status)}</span>
            <span class="ur-test-name">${escapeHtml(displayTestName(test))}</span>
            <span class="ur-test-duration">${formatDuration(test.duration_ms)}</span>
            ${test.incident_id ? `<span class="ur-comment-count" hidden></span>` : ''}
            ${test.incident_id ? `<span class="ur-test-inc">INC #${test.incident_id}</span>` : ''}
        </summary>
        ${test.incident_id ? `
        <section class="ur-discussion">
            <h4 class="ur-discussion__title">Discussion</h4>
            <div class="incident-comments ur-comments" data-incident-id="${test.incident_id}"></div>
        </section>` : ''}
        ${showLogs ? `<pre class="log-block ur-test-log">${escapeHtml(logs)}</pre>` : ''}
    </details>`;
}

function renderRunDiscussion(tests) {
    const seen = new Set();
    const blocks = [];
    for (const test of tests) {
        const id = test.incident_id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        blocks.push(`
        <article class="ur-run-thread">
            <h3 class="ur-run-thread__title">${escapeHtml(displayTestName(test))}</h3>
            <div class="incident-comments ur-comments" data-incident-id="${id}"></div>
        </article>`);
    }
    if (!blocks.length) return '';
    return `
    <section class="ur-run-discussion">
        <h2 class="ur-section-title">Discussion</h2>
        <p class="ur-report-hint">Notes and replies on the tests in this run.</p>
        ${blocks.join('')}
    </section>`;
}

function renderSuiteTreeHtml(tests) {
    const suites = buildSuiteTree(tests);
    if (!suites.length) {
        return '<p class="ur-empty">No test cases in this report. Upload JUnit/XML via CI webhook <code>/api/webhooks/upload</code>.</p>';
    }
    return suites.map(suite => {
        const total = suite.tests.length;
        const openSuite = suite.failed > 0 ? ' open' : '';
        const testsHtml = suite.tests.map((t, i) => renderTestDetailBlock(t, i)).join('');
        return `
        <details class="ur-suite-block"${openSuite}>
            <summary class="ur-suite-summary">
                <span class="ur-suite-chevron" aria-hidden="true"></span>
                <span class="ur-suite-name">${escapeHtml(suite.name)}</span>
                <span class="ur-suite-stats">
                    <span class="ur-suite-stat ur-suite-stat--pass">${suite.passed} pass</span>
                    <span class="ur-suite-stat ur-suite-stat--fail">${suite.failed} fail</span>
                    ${suite.skipped ? `<span class="ur-suite-stat">${suite.skipped} skip</span>` : ''}
                    <span class="ur-suite-stat">${total} tests · ${formatDuration(suite.durationMs)}</span>
                </span>
            </summary>
            <div class="ur-suite-body">${testsHtml}</div>
        </details>`;
    }).join('');
}

function renderReportHtml(data) {
    const passed = data.status === 'passed';
    const headerClass = passed ? 'ur-header ur-header--passed' : 'ur-header ur-header--failed';
    const statusText = passed ? 'All tests passed' : 'Failures detected';
    const sum = data.summary || {};
    const tests = Array.isArray(data.tests) ? data.tests : [];

    const testRows = tests.map(t => {
        const isFail = t.status === 'fail' || t.status === 'flaky';
        const logRow = isFail
            ? `<tr class="ur-test-log-row">
                <td colspan="4"><pre class="log-block">${escapeHtml(logBlockContent(t))}</pre></td>
               </tr>` : '';
        return `
        <tr class="ur-test-row ${statusRowClass(t.status)}">
            <td class="ur-col-status"><span class="ur-status-pill ur-status-pill--${escapeHtml(t.status)}">${statusLabel(t.status)}</span></td>
            <td class="ur-col-name">${escapeHtml(t.name || '-')}</td>
            <td class="ur-col-duration">${formatDuration(t.duration_ms)}</td>
            <td class="ur-col-inc">${t.incident_id ? `#${t.incident_id}` : '-'}</td>
        </tr>${logRow}`;
    }).join('');

    const matrixCells = tests.slice(0, 288).map(t =>
        `<span class="ur-matrix-dot ur-matrix-dot--${escapeHtml(t.status)}" title="${escapeHtml(t.name)}"></span>`
    ).join('');

    return `
    <article class="unified-report-article">
        <header class="${headerClass}">
            <div class="ur-header-top">
                <span class="ur-header-status">${statusText}</span>
                <span class="ur-header-outcome">${escapeHtml(statusCase(data.outcome || ''))}</span>
            </div>
            <h1 class="ur-header-project">${escapeHtml(data.project_name)}</h1>
            <p class="ur-header-meta">
                <span>Run <code>${escapeHtml(data.pipeline_run_id)}</code></span>
                ${data.branch ? `<span>Branch ${escapeHtml(data.branch)}</span>` : ''}
                ${data.commit_sha ? `<span>SHA ${escapeHtml(String(data.commit_sha).slice(0, 12))}</span>` : ''}
            </p>
            <p class="ur-header-meta">
                ${data.started_at ? `<span>${escapeHtml(data.started_at)}</span>` : ''}
                ${data.finished_at ? `<span>→ ${escapeHtml(data.finished_at)}</span>` : ''}
                <span class="ur-flag">${escapeHtml(data.execution_env || 'UNKNOWN')}</span>
                <span class="ur-flag">${escapeHtml(data.execution_type || 'REAL')}</span>
                ${data.framework ? `<span>${escapeHtml(data.framework)}</span>` : ''}
            </p>
        </header>

        ${renderRunDiscussion(tests)}

        <div class="ur-summary-bar">
            <div class="ur-kpi"><span class="ur-kpi-label">Total</span><span class="ur-kpi-value">${sum.total || 0}</span></div>
            <div class="ur-kpi ur-kpi--pass"><span class="ur-kpi-label">Passed</span><span class="ur-kpi-value">${sum.passed || 0}</span></div>
            <div class="ur-kpi ur-kpi--fail"><span class="ur-kpi-label">Failed</span><span class="ur-kpi-value">${sum.failed || 0}</span></div>
            <div class="ur-kpi ur-kpi--skip"><span class="ur-kpi-label">Skipped</span><span class="ur-kpi-value">${sum.skipped || 0}</span></div>
            ${sum.flaky ? `<div class="ur-kpi ur-kpi--flaky"><span class="ur-kpi-label">Flaky</span><span class="ur-kpi-value">${sum.flaky}</span></div>` : ''}
            <div class="ur-kpi"><span class="ur-kpi-label">Duration</span><span class="ur-kpi-value">${formatSummaryDuration(data.duration_ms || sum.duration_ms)}</span></div>
        </div>

        ${tests.length ? `
        <section class="ur-matrix-section">
            <h2 class="ur-section-title">Test matrix</h2>
            <div class="ur-matrix-grid">${matrixCells}</div>
        </section>` : ''}

        <section class="ur-suite-tree-section">
            <h2 class="ur-section-title">Execution details (suite hierarchy)</h2>
            <p class="ur-report-hint">Structured like Robot Framework / JUnit reports: suites → tests → logs. Expand failed tests for stack traces and <code>system-out</code> / <code>system-err</code>.</p>
            <div class="ur-suite-tree">${renderSuiteTreeHtml(tests)}</div>
        </section>

        <section class="ur-table-section ur-table-section--compact">
            <details>
                <summary class="ur-section-title ur-flat-toggle">Flat table view (${tests.length} tests)</summary>
            <div class="ur-table-wrap">
                <table class="ur-tests-table">
                    <thead>
                        <tr>
                            <th>Status</th>
                            <th>Test</th>
                            <th>Duration</th>
                            <th>Incident</th>
                        </tr>
                    </thead>
                    <tbody>${testRows || '<tr><td colspan="4" class="ur-empty">No test cases in report.</td></tr>'}</tbody>
                </table>
            </div>
            </details>
        </section>
    </article>`;
}

function showReportView() {
    if (typeof window.stopDashboardAutoRefresh === 'function') {
        window.stopDashboardAutoRefresh();
    }
    document.querySelectorAll('.view-section').forEach(x => {
        x.classList.remove('active');
        x.style.removeProperty('display');
    });
    document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
    const section = document.getElementById('view-unified-report');
    if (section) {
        section.classList.add('active');
        section.style.removeProperty('display');
    }
}

export async function openReport(groupId, event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    const group = window.groupedIncidents && window.groupedIncidents[groupId];
    if (!group) {
        notify('Execution group not found', 'error');
        return;
    }
    if (!group.has_real_run) {
        notify('Full report requires a pipeline run id from CI webhook (X-Run-Id)', 'warning');
        return;
    }

    const root = document.getElementById('unified-report-root');
    if (!root) return;

    showReportView();
    root.innerHTML = '<div class="unified-report-loading">Loading unified report…</div>';

    try {
        const res = await fetchWithAuth(
            `/api/reports/${encodeURIComponent(group.pipeline_run_id)}?project=${encodeURIComponent(group.project_name)}`
        );
        const { data } = await parseApiJson(res);
        if (!res.ok) {
            throw new Error((data && data.error) || 'Failed to load report');
        }
        root.innerHTML = renderReportHtml(data);
        await hydrateOpenComments();
        publishSecureLink({ kind: 'report', project: group.project_name, run_id: group.pipeline_run_id });
    } catch (e) {
        root.innerHTML = `<div class="unified-report-error">
            <p>${escapeHtml(e.message || 'Report load failed')}</p>
            <button type="button" class="btn btn-secondary" onclick="closeUnifiedReport()">Back to Dashboard</button>
        </div>`;
        notify(e.message || 'Report load failed', 'error');
    }
}

export async function openReportByRun(project, runId, commentId) {
    const root = document.getElementById('unified-report-root');
    if (!root || !project || !runId) return;
    showReportView();
    root.innerHTML = '<div class="unified-report-loading">Loading unified report…</div>';
    try {
        const res = await fetchWithAuth(
            `/api/reports/${encodeURIComponent(runId)}?project=${encodeURIComponent(project)}`
        );
        const { data } = await parseApiJson(res);
        if (!res.ok) {
            throw new Error((data && data.error) || 'Failed to load report');
        }
        root.innerHTML = renderReportHtml(data);
        await hydrateOpenComments();
        if (commentId) revealComment(commentId);
        else publishSecureLink({ kind: 'report', project, run_id: runId });
    } catch (e) {
        root.innerHTML = `<div class="unified-report-error">
            <p>${escapeHtml(e.message || 'Report load failed')}</p>
            <button type="button" class="btn btn-secondary" onclick="closeUnifiedReport()">Back to Dashboard</button>
        </div>`;
        notify(e.message || 'Report load failed', 'error');
    }
}

export async function openSecureLink(token) {
    if (!token) {
        window.__openingSecureLink = false;
        return;
    }
    window.__openingSecureLink = true;
    try {
        const res = await fetchWithAuth(`/api/links/${encodeURIComponent(token)}`);
        const { data } = await parseApiJson(res);
        if (!res.ok) {
            throw new Error((data && data.error) || 'This link is not valid');
        }
        if (data.kind === 'view') {
            const view = (data.view === 'rca' || data.view === 'ai' || data.view === 'ai-usage') ? 'healing' : data.view;
            if (view === 'about') window.__pendingAboutTopic = data.topic || 'overview';
            const nav = document.querySelector(`.nav-item[onclick*="switchView('${view}'"]`);
            if (typeof window.switchView === 'function') window.switchView(view, nav);
            return;
        }
        if (data.kind === 'report') {
            await openReportByRun(data.project_name, data.pipeline_run_id, 0);
            return;
        }
        await openReportByRun(data.project_name, data.pipeline_run_id, data.comment_id);
    } catch (e) {
        notify(e.message || 'This link is not valid', 'error');
    } finally {
        window.__openingSecureLink = false;
    }
}

export function closeUnifiedReport() {
    const dashNav = document.querySelector('.nav-item[onclick*="switchView(\'dashboard\'"]');
    if (typeof window.switchView === 'function') {
        window.switchView('dashboard', dashNav);
    }
}
