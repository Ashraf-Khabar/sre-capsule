/**
* web/app.js
* Main controller for SRE Capsule Control Plane
*/

// IMPORT MODULES
import { notify, showConfirmModal, showPromptModal, closeModal, toggleTheme, initSidebar, toggleSidebar } from './js/ui.js';
import { parseJwt, performLogout, showLoginScreen, fetchWithAuth, parseApiJson, isApiOffline, pingApiServer, resetApiOfflineBanner } from './js/api.js';
import * as iam from './js/iam.js?v=1.0.101-workflow-page';
import * as settings from './js/settings.js?v=1.0.108-workflow-guide';
import * as profile from './js/profile.js?v=1.0.101-workflow-page';
import * as finops from './js/finops.js';
import * as about from './js/about.js?v=1.0.112-mail-size';
import * as analyticsLayout from './js/analytics-layout.js';
import { applyRoleVisibility, canAccessFinOps, canAccessPlugins, canResolveIncidents, canDeleteIncidents, hasMinRole, roleLabel, canManageTeams, canManageIAM, isAdmin, canAccessView, accessDeniedMessage, defaultViewForRole, canPatchExecutionFlags } from './js/roles.js?v=1.0.101-workflow-page';
import * as executionHub from './js/execution-hub.js?v=1.0.101-workflow-page';
import * as reportViewer from './js/report-viewer.js?v=1.0.99-maint';
import * as workflowEditor from './js/workflow-editor.js?v=1.0.112-mail-size';
import * as healing from './js/healing.js?v=1.0.101-workflow-page';
import * as dora from './js/dora.js?v=1.0.99-maint';
import { setupAutocomplete } from './js/autocomplete.js';
import { initTheme, applyTheme } from './js/ui.js';
import { initI18n, t, setLocale, applyI18n } from './js/i18n.js?v=1.0.101-workflow-page';
import { initCommentUI, openResolveComposer, hydrateOpenComments } from './js/comments.js?v=1.0.40-edit-fill';
import { publishSecureLink, secureLinkTokenFromPath } from './js/links.js?v=1.0.101-workflow-page';

// EXPORT GLOBALLY FOR HTML INLINE HANDLERS
Object.assign(window, { notify, showConfirmModal, showPromptModal, closeModal, toggleTheme, initSidebar, toggleSidebar, parseJwt, performLogout, fetchWithAuth, applyTheme, t, setLocale, applyI18n, openResolveComposer, hydrateOpenComments, publishSecureLink });

// Bind all module functions to the window so HTML 'onclick' can find them
for (const [key, value] of Object.entries(iam)) {
    if (typeof value === 'function') window[key] = value;
}
for (const [key, value] of Object.entries(settings)) {
    if (typeof value === 'function') window[key] = value;
}
for (const [key, value] of Object.entries(profile)) {
    if (typeof value === 'function') window[key] = value;
}
for (const [key, value] of Object.entries(finops)) {
    if (typeof value === 'function') window[key] = value;
}
window.refreshFinOpsView = function () {
    if (typeof finops.refreshFinOpsView === 'function') return finops.refreshFinOpsView();
    notify('FinOps module not loaded. Hard-refresh the page (Ctrl+Shift+R).', 'error');
};
for (const [key, value] of Object.entries(about)) {
    if (typeof value === 'function') window[key] = value;
}
for (const [key, value] of Object.entries(analyticsLayout)) {
    if (typeof value === 'function') window[key] = value;
}
for (const [key, value] of Object.entries(workflowEditor)) {
    if (typeof value === 'function') window[key] = value;
}
for (const [key, value] of Object.entries(healing)) {
    if (typeof value === 'function') window[key] = value;
}
for (const [key, value] of Object.entries(dora)) {
    if (typeof value === 'function') window[key] = value;
}
for (const [key, value] of Object.entries(executionHub)) {
    if (typeof value === 'function') window[key] = value;
}
for (const [key, value] of Object.entries(reportViewer)) {
    if (typeof value === 'function') window[key] = value;
}
// ------------------------------------------
// Global application state
// ------------------------------------------
window.currentIncidents = [];
window.selectedIncidents = new Set();
window.pausePollingUntil = 0;
window.statusFilter = 'all';
window.pendingResolvedIds = new Map();
window._resolveRetryInFlight = false;
window.groupedIncidents = {};

// FINOPS GLOBALS
window.isEnterpriseActive = false;
window.selectedCurrency = "USD"; 

// ==========================================
// INCIDENTS LOGIC
// ==========================================
function loadPendingResolvedFromStorage() {
    try {
        const raw = sessionStorage.getItem('srecapsule-pending-resolved');
        if (!raw) return;
        window.pendingResolvedIds = new Map(JSON.parse(raw));
    } catch (_) {
        window.pendingResolvedIds = new Map();
    }
}

function savePendingResolvedToStorage() {
    try {
        sessionStorage.setItem('srecapsule-pending-resolved', JSON.stringify([...window.pendingResolvedIds]));
    } catch (_) { }
}

function normalizeIsResolved(inc) {
    return inc.is_resolved === true || inc.is_resolved === 1 || inc.is_resolved === '1';
}

window.markIncidentsPendingResolve = function (ids, resolvedBy) {
    ids.forEach(id => {
        window.pendingResolvedIds.set(String(id), { resolvedBy: resolvedBy || 'You', since: Date.now() });
    });
    savePendingResolvedToStorage();
};

window.applyOptimisticResolve = function (ids, resolvedBy) {
    const idSet = new Set(ids.map(id => String(id)));
    window.currentIncidents.forEach(inc => {
        if (idSet.has(String(inc.id))) {
            inc.is_resolved = true;
            inc.status = 'resolved';
            inc.resolved_by = resolvedBy;
        }
    });
};

window.mergePendingResolvedState = function (incidents) {
    if (!incidents || window.pendingResolvedIds.size === 0) return incidents;
    return incidents.map(inc => {
        const pending = window.pendingResolvedIds.get(String(inc.id));
        if (!pending) return inc;
        if (normalizeIsResolved(inc)) {
            window.pendingResolvedIds.delete(String(inc.id));
            savePendingResolvedToStorage();
            return inc;
        }
        return { ...inc, is_resolved: true, status: 'resolved', resolved_by: inc.resolved_by || pending.resolvedBy };
    });
};

window.confirmPendingResolvedFromServer = function (rawIncidents) {
    const needsRetry = [];
    (rawIncidents || []).forEach(inc => {
        const key = String(inc.id);
        if (!window.pendingResolvedIds.has(key)) return;
        if (normalizeIsResolved(inc)) {
            window.pendingResolvedIds.delete(key);
        } else {
            const pending = window.pendingResolvedIds.get(key);
            if (pending && Date.now() - pending.since >= 2000) {
                const numId = parseInt(inc.id, 10);
                if (!isNaN(numId)) needsRetry.push(numId);
            }
        }
    });
    savePendingResolvedToStorage();
    return [...new Set(needsRetry)];
};

window.resolveIncidentsByIds = async function (ids, successMessage) {
    const uniqueIds = [...new Set(ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id)))];
    if (uniqueIds.length === 0) return false;

    const currentUser = parseJwt(localStorage.getItem('sre-jwt')).username || 'You';
    window.pausePollingUntil = Date.now() + 30000;

    window.markIncidentsPendingResolve(uniqueIds, currentUser);
    window.applyOptimisticResolve(uniqueIds, currentUser);
    window.renderIncidentsList();

    try {
        const res = await window.fetchWithAuth('/api/incidents', { method: 'PUT', body: JSON.stringify({ ids: uniqueIds }) });
        if (!res.ok) throw new Error('Update failed on server side');

        notify(successMessage || 'Alerts resolved', 'success');

        for (let attempt = 0; attempt < 8; attempt++) {
            await new Promise(r => setTimeout(r, attempt === 0 ? 600 : 800));
            await window.fetchIncidents(true, { skipPauseCheck: true });
            const allConfirmed = uniqueIds.every(id => !window.pendingResolvedIds.has(String(id)));
            if (allConfirmed) break;
        }

        if (uniqueIds.some(id => window.pendingResolvedIds.has(String(id))) && !window._resolveRetryInFlight) {
            window._resolveRetryInFlight = true;
            try {
                await window.fetchWithAuth('/api/incidents', { method: 'PUT', body: JSON.stringify({ ids: uniqueIds }) });
                await new Promise(r => setTimeout(r, 800));
                await window.fetchIncidents(true, { skipPauseCheck: true });
            } finally { window._resolveRetryInFlight = false; }
        }

        window.pausePollingUntil = Date.now() + 5000;
        await window.fetchMetricsOnly();
        return true;
    } catch (e) {
        notify('Failed to resolve incident(s)', 'error');
        window.pausePollingUntil = Date.now() + 5000;
        await window.fetchIncidents(true, { skipPauseCheck: true });
        return false;
    }
};

loadPendingResolvedFromStorage();

window.toggleIncidentSelection = function (id, checked) {
    window.pausePollingUntil = Date.now() + 15000;
    const strId = String(id);
    if (checked) window.selectedIncidents.add(strId);
    else window.selectedIncidents.delete(strId);

    const masterCb = document.getElementById('select-all-cb');
    if (masterCb) masterCb.checked = window.currentIncidents.length > 0 && window.currentIncidents.every(inc => window.selectedIncidents.has(String(inc.id)));
    window.updateBulkActionUI();
};

window.toggleGroupSelection = function (groupId, checked) {
    window.pausePollingUntil = Date.now() + 15000;
    const group = window.groupedIncidents[groupId];
    if (!group) return;

    group.incidents.forEach(inc => {
        const strId = String(inc.id);
        const cb = document.getElementById(`cb-inc-${inc.id}`);
        if (cb) cb.checked = checked;
        if (checked) window.selectedIncidents.add(strId);
        else window.selectedIncidents.delete(strId);
    });

    const masterCb = document.getElementById('select-all-cb');
    if (masterCb) masterCb.checked = window.currentIncidents.length > 0 && window.currentIncidents.every(inc => window.selectedIncidents.has(String(inc.id)));
    window.updateBulkActionUI();
};

window.toggleSelectAll = function (checked) {
    window.pausePollingUntil = Date.now() + 15000;
    window.currentIncidents.forEach(inc => {
        const strId = String(inc.id);
        if (checked) window.selectedIncidents.add(strId);
        else window.selectedIncidents.delete(strId);
        const cb = document.getElementById(`cb-inc-${inc.id}`);
        if (cb) cb.checked = checked;
    });
    document.querySelectorAll('[id^="cb-group-"]').forEach(cb => cb.checked = checked);
    window.updateBulkActionUI();
};

window.updateBulkActionUI = function () {
    const count = window.selectedIncidents.size;
    const banner = document.getElementById('bulk-action-banner');
    const label = document.getElementById('bulk-count-label');

    if (count === 0) {
        if (banner) banner.style.display = 'none';
    } else {
        if (banner) {
            banner.style.display = 'flex';
            if (label) label.innerText = `${count} Test(s) Selected`;
        }
    }
};

window.resolveSelected = async function () {
    if (window.selectedIncidents.size === 0) return;
    const ids = Array.from(window.selectedIncidents).map(id => parseInt(id, 10)).filter(id => !isNaN(id));
    if (ids.length === 0) return;
    window.openResolveComposer(ids, 'Alerts resolved');
};

window.deleteSelected = async function () {
    if (window.selectedIncidents.size === 0) return notify('Select at least one alert.', 'error');
    const role = parseJwt(localStorage.getItem('sre-jwt')).role;
    if (!canDeleteIncidents(role)) return notify('Manager or Lead role required to delete alerts.', 'error');

    showConfirmModal('Delete Selected?', `Permanently delete ${window.selectedIncidents.size} alert(s)?`, 'danger', async function () {
        window.pausePollingUntil = Date.now() + 15000;
        const ids = Array.from(window.selectedIncidents).map(id => parseInt(id, 10)).filter(id => !isNaN(id));
        window.currentIncidents = window.currentIncidents.filter(inc => !ids.includes(parseInt(inc.id, 10)));
        window.selectedIncidents.clear();
        window.renderIncidentsList();
        notify('Deleting alerts…', 'success');

        try {
            const res = await window.fetchWithAuth(`/api/incidents?ids=${ids.join(',')}`, { method: 'DELETE' });
            if (!res.ok) {
                const err = await res.text();
                notify(err || 'Delete failed', 'error');
                window.pausePollingUntil = 0;
                window.fetchIncidents(true);
                return;
            }
            setTimeout(() => { window.pausePollingUntil = 0; window.fetchIncidents(true); window.fetchMetricsOnly(); }, 800);
        } catch (e) {
            window.pausePollingUntil = 0;
            window.fetchIncidents(true);
            notify('Delete failed', 'error');
        }
    });
};

window.resolveGroup = async function (groupId, event) {
    if (event) { event.preventDefault(); event.stopPropagation(); }
    const dropdown = document.getElementById(`action-dropdown-${groupId}`);
    if (dropdown) dropdown.style.display = 'none';

    const group = window.groupedIncidents[groupId];
    if (!group) return;

    const selectedInGroup = group.incidents.filter(inc => window.selectedIncidents.has(String(inc.id)));
    const targetIncidents = selectedInGroup.length > 0 ? selectedInGroup : group.incidents;

    const ids = targetIncidents.filter(inc => !normalizeIsResolved(inc)).map(inc => parseInt(inc.id, 10)).filter(id => !isNaN(id));
    if (ids.length === 0) return;

    window.openResolveComposer(ids, ids.length === 1 ? 'Sub-alert resolved.' : 'Pipelines marked as resolved.');
}

window.deleteGroup = async function (groupId, event) {
    if (event) { event.preventDefault(); event.stopPropagation(); }
    const role = parseJwt(localStorage.getItem('sre-jwt')).role;
    if (!canDeleteIncidents(role)) return notify('Manager or Lead role required to delete alerts.', 'error');

    const dropdown = document.getElementById(`action-dropdown-${groupId}`);
    if (dropdown) dropdown.style.display = 'none';

    const group = window.groupedIncidents[groupId];
    if (!group) return;

    showConfirmModal('Delete Pipeline Execution?', 'Permanently delete this pipeline execution?', 'danger', async function () {
        window.pausePollingUntil = Date.now() + 15000;
        const ids = group.incidents.map(i => parseInt(i.id, 10)).filter(id => !isNaN(id));

        window.currentIncidents = window.currentIncidents.filter(inc => !ids.includes(parseInt(inc.id, 10)));
        group.incidents.forEach(i => window.selectedIncidents.delete(String(i.id)));

        window.renderIncidentsList();
        notify("Suppression du pipeline en cours...", "success");

        try {
            const res = await window.fetchWithAuth(`/api/incidents?ids=${ids.join(',')}`, { method: 'DELETE' });
            if (!res.ok) {
                notify('Delete failed', 'error');
                window.pausePollingUntil = 0;
                window.fetchIncidents(true);
                return;
            }
            setTimeout(() => { window.pausePollingUntil = 0; window.fetchIncidents(true); window.fetchMetricsOnly(); }, 800);
        } catch (e) {
            window.pausePollingUntil = 0;
            window.fetchIncidents(true);
            notify('Delete failed', 'error');
        }
    });
};

window.toggleActionDropdown = function (id, event) {
    if (event) { event.preventDefault(); event.stopPropagation(); }
    const dropdown = document.getElementById(`action-dropdown-${id}`);
    if (dropdown) {
        const isCurrentlyHidden = !dropdown.classList.contains('is-open');
        document.querySelectorAll('.action-dropdown-menu').forEach(el => el.classList.remove('is-open'));
        if (isCurrentlyHidden) { dropdown.classList.add('is-open'); window.pausePollingUntil = Date.now() + 15000; }
        else { window.pausePollingUntil = 0; }
    }
}

document.addEventListener('click', function (event) {
    if (!event.target.closest('.action-dropdown-container')) {
        document.querySelectorAll('.action-dropdown-menu').forEach(el => el.classList.remove('is-open'));
    }
});

window.downloadGroupLog = function (groupId, type, event) {
    if (event) { event.preventDefault(); event.stopPropagation(); }
    document.getElementById(`action-dropdown-${groupId}`).style.display = 'none';
    window.pausePollingUntil = 0;

    const group = window.groupedIncidents[groupId];
    if (!group) return notify("Could not retrieve group data.", "error");

    let fileContent = ""; let fileName = ""; let blobType = "text/plain";

    if (type === 'error') {
        fileName = `execution_${groupId}_errors.log`;
        group.incidents.forEach(inc => { fileContent += `--- [TEST: ${inc.name}] ---\n${inc.error_logs || inc.error_message || "No error details."}\n\n`; });
    } else if (type === 'full') {
        fileName = `execution_${groupId}_full_logs.log`;
        group.incidents.forEach(inc => { fileContent += `=======================================\nTEST: ${inc.name}\n=======================================\n[ERROR LOGS]\n${inc.error_logs || inc.error_message || "N/A"}\n\n[STDOUT]\n${inc.console_logs || "N/A"}\n\n`; });
    } else if (type === 'xml') {
        fileName = `execution_${groupId}_results.xml`; blobType = "application/xml";
        fileContent = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="SRE_Capsule_Reconstructed_Suite" tests="${group.incidents.length}" failures="${group.incidents.length}">\n`;
        group.incidents.forEach(inc => {
            const safeName = (inc.name || "").replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            const safeErr = (inc.error_message || "").replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const safeLogs = (inc.error_logs || "").replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const safeOut = (inc.console_logs || "").replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            fileContent += `    <testcase name="${safeName}">\n      <failure message="${safeErr}">${safeLogs}</failure>\n`;
            if (safeOut) fileContent += `      <system-out>${safeOut}</system-out>\n`;
            fileContent += `    </testcase>\n`;
        });
        fileContent += `  </testsuite>\n</testsuites>`;
    }

    const blob = new Blob([fileContent], { type: blobType });
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

window.toggleSubAlerts = function (groupId, event) {
    if (event) { event.preventDefault(); event.stopPropagation(); }
    window.pausePollingUntil = Date.now() + 15000;
    const container = document.getElementById(`sub-alerts-${groupId}`);
    const icon = document.getElementById(`toggle-icon-${groupId}`);
    if (container.style.display === 'none') {
        container.style.display = 'block';
        if (icon) icon.style.transform = 'rotate(180deg)';
        if (typeof window.onExecGroupExpanded === 'function') window.onExecGroupExpanded(groupId);
    } else {
        container.style.display = 'none';
        if (icon) icon.style.transform = 'rotate(0deg)';
    }
}

window.__logsExpandAll = null;

window.expandAllIncidentLogs = function () {
    window.__logsExpandAll = true;
    window.pausePollingUntil = Date.now() + 15000;
    window.renderIncidentsList();
};

window.collapseAllIncidentLogs = function () {
    window.__logsExpandAll = false;
    window.pausePollingUntil = Date.now() + 15000;
    window.renderIncidentsList();
};

window.toggleIncidentLog = function (id, event) {
    if (event) { event.preventDefault(); event.stopPropagation(); }
    window.__logsExpandAll = null;
    window.pausePollingUntil = Date.now() + 15000;
    const logContent = document.getElementById(`log-content-${id}`);
    const logIcon = document.getElementById(`log-icon-${id}`);
    const logText = document.getElementById(`log-text-${id}`);

    if (logContent.style.display === 'none') {
        logContent.style.display = 'block';
        if (logIcon) logIcon.style.transform = 'rotate(180deg)';
        if (logText) logText.innerText = 'Collapse logs';
    } else {
        logContent.style.display = 'none';
        if (logIcon) logIcon.style.transform = 'rotate(0deg)';
        if (logText) logText.innerText = 'Show logs';
    }
};

window.loadDashboardFilters = function () {
    const filter = document.getElementById('project-filter');
    if (!filter) return;
    return fetchWithAuth(`/api/my-projects?_ts=${Date.now()}`)
        .then(res => parseApiJson(res))
        .then(({ ok, data: projects }) => {
            if (!ok) throw new Error('projects');
            const currentVal = filter.value;
            filter.innerHTML = '<option value="all">All My Projects</option>';
            const list = Array.isArray(projects) ? projects : [];
            list.forEach(p => filter.innerHTML += `<option value="${p.name}">${p.name}</option>`);
            if (currentVal) filter.value = currentVal;
        })
        .catch(() => {
            if (filter.options.length <= 1) {
                filter.innerHTML = '<option value="all">All My Projects</option>';
            }
        });
}

window.setStatusFilter = function (status) {
    window.statusFilter = status;
    const allBtn = document.getElementById('status-all-btn'); const activeBtn = document.getElementById('status-active-btn'); const resolvedBtn = document.getElementById('status-resolved-btn');
    [allBtn, activeBtn, resolvedBtn].forEach(btn => { if (btn) btn.classList.remove('active-all', 'active-active', 'active-resolved'); });
    if (status === 'all' && allBtn) allBtn.classList.add('active-all');
    else if (status === 'active' && activeBtn) activeBtn.classList.add('active-active');
    else if (status === 'resolved' && resolvedBtn) resolvedBtn.classList.add('active-resolved');
    if (localStorage.getItem('sre-jwt')) {
        window.renderIncidentsList();
    }
}

/** KPI strip: counts for the selected time range (not status/search sub-filters). */
window.updateDashboardKpisFromIncidents = function (incidents) {
    const data = Array.isArray(incidents) ? incidents : [];
    const active = data.filter(i => !normalizeIsResolved(i)).length;
    const resolved = data.filter(i => normalizeIsResolved(i)).length;
    const flaky = data.filter(i => String(i.name || '').includes('[FLAKY]')).length;
    const total = data.length;
    const health = total > 0 ? Math.round((resolved / total) * 100) : 100;

    const kpiActive = document.getElementById('kpi-active');
    if (kpiActive) {
        kpiActive.innerText = active;
        kpiActive.className = `kpi-value ${active > 0 ? 'kpi-danger' : 'kpi-success'}`;
    }
    const kpiResolved = document.getElementById('kpi-resolved');
    if (kpiResolved) kpiResolved.innerText = resolved;
    const kpiHealth = document.getElementById('kpi-health');
    if (kpiHealth) {
        kpiHealth.innerText = `${health}%`;
        kpiHealth.className = `kpi-value ${health < 80 ? 'kpi-warn' : 'kpi-info'}`;
    }
    const flakyEl = document.getElementById('kpi-flaky');
    if (flakyEl) flakyEl.innerText = flaky;
};

window.updateDashboardKpiRangeLabels = function () {
    const summary = document.getElementById('dashboard-range-summary')?.textContent?.trim();
    const resolvedLabel = document.getElementById('kpi-resolved-label');
    if (resolvedLabel) {
        resolvedLabel.textContent = summary ? `Resolved (${summary})` : 'Resolved';
    }
};

/** Sync KPI strip with dashboard time range (and project when filtered client-side). */
window.syncDashboardKpis = function () {
    window.updateDashboardKpiRangeLabels();
    const filterEl = document.getElementById('project-filter');
    const projectFilter = filterEl ? filterEl.value : 'all';
    const rangeQ = typeof window.getDashboardRangeQueryResolved === 'function'
        ? window.getDashboardRangeQueryResolved()
        : (typeof window.getDashboardRangeQuery === 'function' ? window.getDashboardRangeQuery() : null);
    if (!rangeQ) return Promise.resolve();

    if (projectFilter && projectFilter !== 'all') {
        window.updateDashboardKpisFromIncidents(window.currentIncidents || []);
        return Promise.resolve();
    }

    if (isApiOffline()) return Promise.resolve();
    return fetchWithAuth(`/api/metrics?${rangeQ}&_ts=${Date.now()}`)
        .then(r => parseApiJson(r))
        .then(({ ok, data: metrics }) => {
            if (!ok || !metrics) return;
            const total = metrics.total_incidents ?? 0;
            const resolved = metrics.resolved_incidents ?? 0;
            const active = Math.max(0, total - resolved);
            const health = total > 0 ? Math.round((resolved / total) * 100) : 100;
            const kpiActive = document.getElementById('kpi-active');
            if (kpiActive) {
                kpiActive.innerText = active;
                kpiActive.className = `kpi-value ${active > 0 ? 'kpi-danger' : 'kpi-success'}`;
            }
            const kpiResolved = document.getElementById('kpi-resolved');
            if (kpiResolved) kpiResolved.innerText = resolved;
            const kpiHealth = document.getElementById('kpi-health');
            if (kpiHealth) {
                kpiHealth.innerText = `${health}%`;
                kpiHealth.className = `kpi-value ${health < 80 ? 'kpi-warn' : 'kpi-info'}`;
            }
            const flakyEl = document.getElementById('kpi-flaky');
            if (flakyEl) flakyEl.innerText = metrics.flaky_tests ?? 0;
        })
        .catch(err => console.error('syncDashboardKpis error:', err));
};

window.fetchMetricsOnly = function () {
    return window.syncDashboardKpis();
};

window.refreshDashboard = function () {
    window.updateDashboardKpiRangeLabels();
    return Promise.resolve(window.fetchIncidents(true)).then(() => window.syncDashboardKpis());
};

function renderDeployLink(group) {
    const inc = (group.incidents || []).find(item => item && item.deploy);
    const deploy = inc && inc.deploy;
    if (!deploy || !deploy.run_id) return '';
    const sha = String(deploy.commit || '').trim();
    const label = sha ? sha.slice(0, 7) : String(deploy.run_id).slice(0, 12);
    const branch = deploy.branch ? ` · ${escapeHtml(deploy.branch)}` : '';
    const outcome = deploy.outcome ? ` · ${escapeHtml(deploy.outcome)}` : '';
    const mins = Number(deploy.minutes_before);
    let when = 'on this incident';
    if (Number.isFinite(mins)) {
        const rounded = Math.max(0, Math.round(mins));
        when = rounded <= 1 ? 'with this incident' : `${rounded} min before this incident`;
    }
    return `<div class="deploy-link${deploy.close ? ' deploy-link--close' : ''}"><span>Deploy ${escapeHtml(label)}${branch}${outcome} · ${when}</span></div>`;
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

const DASHBOARD_RANGE_STORAGE_KEY = 'sre-dashboard-range';

const DASHBOARD_RANGE_LABELS = {
    '5m': 'Last 5 minutes',
    '15m': 'Last 15 minutes',
    '30m': 'Last 30 minutes',
    '1h': 'Last 1 hour',
    '6h': 'Last 6 hours',
    '24h': 'Last 24 hours',
    '7d': 'Last 7 days',
    '30d': 'Last 30 days',
    today: 'Today',
    yesterday: 'Yesterday',
    all: 'All time (1 year)',
    custom: 'Custom range'
};

let dashboardRangeDebounceTimer = null;
let dashboardRefreshTimer = null;

const DASHBOARD_REFRESH_MS = {
    '5m': 15000,
    '15m': 30000,
    '30m': 45000,
    '1h': 60000,
    '6h': 120000,
    '12h': 180000,
    '24h': 180000,
    'today': 120000,
    'yesterday': 300000,
    '7d': 300000,
    '30d': 600000,
    'all': 600000,
    'custom': 120000
};

function dashboardRefreshIntervalMs() {
    if (window.userDashboardAutoRefresh === false) return 0;
    const userSec = Number(window.userDashboardRefreshIntervalSec);
    if (userSec >= 15) return userSec * 1000;
    const preset = document.getElementById('dashboard-range-preset')?.value || '1h';
    return DASHBOARD_REFRESH_MS[preset] || 60000;
}

function updateDashboardRefreshHint() {
    const el = document.getElementById('dashboard-auto-refresh-hint');
    if (!el) return;
    const ms = dashboardRefreshIntervalMs();
    if (!ms) {
        el.textContent = 'Auto-refresh off';
        return;
    }
    const sec = Math.round(ms / 1000);
    el.textContent = `Auto-refresh ${sec}s`;
}

window.stopDashboardAutoRefresh = function () {
    if (dashboardRefreshTimer) clearInterval(dashboardRefreshTimer);
    dashboardRefreshTimer = null;
};

window.startDashboardAutoRefresh = function () {
    window.stopDashboardAutoRefresh();
    updateDashboardRefreshHint();
    const ms = dashboardRefreshIntervalMs();
    if (!ms) return;
    dashboardRefreshTimer = setInterval(() => {
        const dash = document.getElementById('view-dashboard');
        if (!dash || !dash.classList.contains('active')) return;
        if (Date.now() < window.pausePollingUntil) return;
        window.runDashboardRangeFilter();
    }, ms);
};

window.restartDashboardAutoRefresh = function () {
    window.startDashboardAutoRefresh();
};

function formatDateInput(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function formatTimeInput(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function setSplitDatetime(dateId, timeId, d) {
    const dateEl = document.getElementById(dateId);
    const timeEl = document.getElementById(timeId);
    if (dateEl) dateEl.value = formatDateInput(d);
    if (timeEl) timeEl.value = formatTimeInput(d);
}

function getCombinedCustomDatetime(dateId, timeId) {
    const date = document.getElementById(dateId)?.value;
    const time = document.getElementById(timeId)?.value || '00:00';
    if (!date) return null;
    return formatDatetimeForApi(`${date}T${time}`);
}

/** Sends naive local timestamps to match SQLite created_at (no UTC shift). */
function formatDatetimeForApi(value) {
    if (!value || !String(value).includes('T')) return null;
    const [date, time] = String(value).split('T');
    const [hh = '00', mm = '00', ss = '00'] = (time || '').split(':');
    return `${date} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function formatRangeSummary(fromVal, toVal) {
    try {
        const f = new Date(fromVal);
        const t = new Date(toVal);
        if (isNaN(f.getTime()) || isNaN(t.getTime())) return 'Custom range';
        return `${f.toLocaleString()} → ${t.toLocaleString()}`;
    } catch {
        return 'Custom range';
    }
}

window.getDashboardRangeQuery = function () {
    const preset = document.getElementById('dashboard-range-preset')?.value || '1h';
    if (preset === 'custom') {
        const from = getCombinedCustomDatetime('dashboard-range-from-date', 'dashboard-range-from-time');
        const to = getCombinedCustomDatetime('dashboard-range-to-date', 'dashboard-range-to-time');
        if (!from || !to) return null;
        return `range=custom&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    }
    return `range=${encodeURIComponent(preset)}`;
};

window.buildDashboardRangeQueryFromPreset = function (stored) {
    const preset = stored?.preset || '1h';
    if (preset === 'custom') {
        if (!stored?.fromDate || !stored?.toDate) return null;
        const from = formatDatetimeForApi(`${stored.fromDate}T${stored.fromTime || '00:00'}`);
        const to = formatDatetimeForApi(`${stored.toDate}T${stored.toTime || '23:59'}`);
        if (!from || !to) return null;
        return `range=custom&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    }
    return `range=${encodeURIComponent(preset)}`;
};

window.getDashboardRangeQueryResolved = function () {
    const live = window.getDashboardRangeQuery();
    if (live) return live;
    return window.buildDashboardRangeQueryFromPreset(readDashboardRangeStorage());
};

function syncDashboardRangeChips(preset) {
    document.querySelectorAll('#dashboard-range-quick .range-chip').forEach(chip => {
        chip.classList.toggle('active', chip.dataset.range === preset);
    });
}

function fillCustomRangeDefaults() {
    const to = new Date();
    const from = new Date(to);
    from.setHours(0, 0, 0, 0);
    setSplitDatetime('dashboard-range-from-date', 'dashboard-range-from-time', from);
    setSplitDatetime('dashboard-range-to-date', 'dashboard-range-to-time', to);
}

window.setDashboardRangePreset = function (preset) {
    const sel = document.getElementById('dashboard-range-preset');
    if (sel) sel.value = preset;
    window.onDashboardRangeChange();
};

window.setDashboardRangeEndToNow = function () {
    const to = new Date();
    setSplitDatetime('dashboard-range-to-date', 'dashboard-range-to-time', to);
    window.onDashboardCustomRangeInput();
};

window.onDashboardCustomRangeInput = function () {
    clearTimeout(dashboardRangeDebounceTimer);
    dashboardRangeDebounceTimer = setTimeout(() => {
        persistDashboardRange();
        window.runDashboardRangeFilter();
    }, 350);
};

window.runDashboardRangeFilter = function () {
    const preset = document.getElementById('dashboard-range-preset')?.value || '1h';
    if (preset === 'custom') {
        const fromRaw = `${document.getElementById('dashboard-range-from-date')?.value || ''}T${document.getElementById('dashboard-range-from-time')?.value || ''}`;
        const toRaw = `${document.getElementById('dashboard-range-to-date')?.value || ''}T${document.getElementById('dashboard-range-to-time')?.value || ''}`;
        if (!fromRaw.includes('T') || !toRaw.includes('T') || fromRaw === 'T' || toRaw === 'T') return;
        const from = new Date(fromRaw);
        const to = new Date(toRaw);
        if (isNaN(from.getTime()) || isNaN(to.getTime())) return;
        if (from > to) {
            notify('"Start" must be before "End".', 'error');
            return;
        }
        const summary = document.getElementById('dashboard-range-summary');
        if (summary) summary.textContent = formatRangeSummary(fromRaw, toRaw);
    }
    const rangeQ = window.getDashboardRangeQuery();
    if (rangeQ === null) return;
    window.updateDashboardKpiRangeLabels();
    Promise.resolve(window.fetchIncidents(true)).then(() => window.syncDashboardKpis());
    window.reloadDashboardAnalytics();
    if (typeof window.restartDashboardAutoRefresh === 'function') window.restartDashboardAutoRefresh();
    const finopsView = document.getElementById('view-finops');
    if (finopsView && finopsView.classList.contains('active')) {
        if (window.refreshFinOpsKPIs) window.refreshFinOpsKPIs();
        if (window.loadFinOpsWeeklyTable) window.loadFinOpsWeeklyTable();
        if (window.loadFinOpsWeeklyEvolution) window.loadFinOpsWeeklyEvolution();
    }
};

function isValidDashboardPreset(preset) {
    return preset && (preset in DASHBOARD_RANGE_LABELS || preset in DASHBOARD_REFRESH_MS);
}

function persistDashboardRange() {
    const preset = document.getElementById('dashboard-range-preset')?.value || '1h';
    const payload = { preset };
    if (preset === 'custom') {
        payload.fromDate = document.getElementById('dashboard-range-from-date')?.value || '';
        payload.fromTime = document.getElementById('dashboard-range-from-time')?.value || '';
        payload.toDate = document.getElementById('dashboard-range-to-date')?.value || '';
        payload.toTime = document.getElementById('dashboard-range-to-time')?.value || '';
    }
    try {
        localStorage.setItem(DASHBOARD_RANGE_STORAGE_KEY, JSON.stringify(payload));
    } catch (_) { /* quota / private mode */ }
}

function readDashboardRangeStorage() {
    try {
        const raw = localStorage.getItem(DASHBOARD_RANGE_STORAGE_KEY);
        if (!raw) return { preset: '1h' };
        if (raw.startsWith('{')) return JSON.parse(raw);
        return { preset: raw };
    } catch {
        return { preset: '1h' };
    }
}

/** Poll dashboard after async CI ingest (webhook returns 202 queued). */
window.schedulePostIngestRefresh = function (alertsQueued) {
    const n = Math.max(1, parseInt(alertsQueued, 10) || 3);
    const delays = [800, 2000, 4000, 6000, 10000];
    const maxAttempts = Math.min(delays.length, 3 + Math.ceil(n / 5));
    let attempt = 0;
    const run = () => {
        if (attempt >= maxAttempts) return;
        const delay = delays[attempt++];
        setTimeout(async () => {
            if (typeof window.fetchIncidents === 'function') {
                await window.fetchIncidents(true, { skipPauseCheck: true });
            }
            if (typeof window.syncDashboardKpis === 'function') window.syncDashboardKpis();
            run();
        }, delay);
    };
    notify('CI ingest queued - refreshing dashboard…', 'success');
    run();
};

window.restoreDashboardTimeRange = function () {
    const stored = readDashboardRangeStorage();
    const preset = isValidDashboardPreset(stored.preset) ? stored.preset : '1h';
    const sel = document.getElementById('dashboard-range-preset');
    const customEl = document.getElementById('dashboard-custom-range');
    const summary = document.getElementById('dashboard-range-summary');

    if (sel) sel.value = preset;
    syncDashboardRangeChips(preset);

    if (preset === 'custom') {
        if (customEl) customEl.style.display = 'grid';
        if (stored.fromDate && stored.toDate) {
            const fromDate = document.getElementById('dashboard-range-from-date');
            const fromTime = document.getElementById('dashboard-range-from-time');
            const toDate = document.getElementById('dashboard-range-to-date');
            const toTime = document.getElementById('dashboard-range-to-time');
            if (fromDate) fromDate.value = stored.fromDate;
            if (fromTime) fromTime.value = stored.fromTime || '00:00';
            if (toDate) toDate.value = stored.toDate;
            if (toTime) toTime.value = stored.toTime || formatTimeInput(new Date());
        } else {
            fillCustomRangeDefaults();
        }
        if (summary) {
            summary.textContent = formatRangeSummary(
                `${document.getElementById('dashboard-range-from-date')?.value}T${document.getElementById('dashboard-range-from-time')?.value}`,
                `${document.getElementById('dashboard-range-to-date')?.value}T${document.getElementById('dashboard-range-to-time')?.value}`
            );
        }
        return;
    }

    if (customEl) customEl.style.display = 'none';
    if (summary) summary.textContent = DASHBOARD_RANGE_LABELS[preset] || preset;
    window.updateDashboardKpiRangeLabels();
};

window.onDashboardRangeChange = function () {
    const preset = document.getElementById('dashboard-range-preset')?.value || '1h';
    const customEl = document.getElementById('dashboard-custom-range');
    const summary = document.getElementById('dashboard-range-summary');

    syncDashboardRangeChips(preset);

    if (preset === 'custom') {
        if (customEl) customEl.style.display = 'grid';
        if (!document.getElementById('dashboard-range-from-date')?.value) {
            fillCustomRangeDefaults();
        }
        if (summary) summary.textContent = formatRangeSummary(
            `${document.getElementById('dashboard-range-from-date')?.value}T${document.getElementById('dashboard-range-from-time')?.value}`,
            `${document.getElementById('dashboard-range-to-date')?.value}T${document.getElementById('dashboard-range-to-time')?.value}`
        );
        persistDashboardRange();
        window.runDashboardRangeFilter();
        return;
    }

    if (customEl) customEl.style.display = 'none';
    if (summary) summary.textContent = DASHBOARD_RANGE_LABELS[preset] || preset;
    persistDashboardRange();
    window.runDashboardRangeFilter();
};

window.reloadDashboardAnalytics = function () {
    const view = document.getElementById('analytics-view');
    if (view && view.style.display !== 'none' && typeof window.loadAnalytics === 'function') {
        window.loadAnalytics(false);
    }
};

window.initDashboardTimeRange = function () {
    window.restoreDashboardTimeRange();
    window.updateDashboardKpiRangeLabels();
};

window.fetchIncidents = function (forceRender = false, opts = {}) {
    if (!opts.skipPauseCheck && !forceRender && Date.now() < window.pausePollingUntil) return;
    const filterEl = document.getElementById('project-filter');
    const projectFilter = filterEl ? filterEl.value : 'all';
    const rangeQ = typeof window.getDashboardRangeQueryResolved === 'function'
        ? window.getDashboardRangeQueryResolved()
        : window.getDashboardRangeQuery();
    if (rangeQ === null) return Promise.resolve();

    const previousIncidents = window.currentIncidents || [];

    return fetchWithAuth(`/api/incidents?project=${encodeURIComponent(projectFilter)}&${rangeQ}&_ts=${Date.now()}&_bust=${Math.random()}`, {
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' }
    })
        .then(res => parseApiJson(res))
        .then(({ ok, data }) => {
            if (!ok) throw new Error('incidents');
            if (!opts.skipPauseCheck && !forceRender && Date.now() < window.pausePollingUntil) return;
            const rawData = [...(Array.isArray(data) ? data : [])].sort((a, b) => a.id - b.id);
            const retryIds = window.confirmPendingResolvedFromServer(rawData);

            if (retryIds.length > 0 && !window._resolveRetryInFlight) {
                window._resolveRetryInFlight = true;
                fetchWithAuth('/api/incidents', { method: 'PUT', body: JSON.stringify({ ids: retryIds }) }).finally(() => { window._resolveRetryInFlight = false; });
            }

            const safeData = window.mergePendingResolvedState(rawData);
            const safeCurrent = [...(window.currentIncidents || [])].sort((a, b) => a.id - b.id);
            const oldSig = safeCurrent.map(i => `${i.id}:${normalizeIsResolved(i)}`).join('|');
            const newSig = safeData.map(i => `${i.id}:${normalizeIsResolved(i)}`).join('|');

            if (forceRender || oldSig !== newSig) {
                const prevActiveIds = new Set(
                    previousIncidents.filter(i => !normalizeIsResolved(i)).map(i => i.id)
                );
                const newActive = safeData.filter(i => !normalizeIsResolved(i) && !prevActiveIds.has(i.id));
                if (newActive.length > 0) {
                    if (typeof window.playCriticalAlertSound === 'function') window.playCriticalAlertSound();
                    if (typeof window.notifyNewIncidentsIfEnabled === 'function') {
                        const activeCount = safeData.filter(i => !normalizeIsResolved(i)).length;
                        window.notifyNewIncidentsIfEnabled(activeCount, newActive[0]?.name);
                    }
                }
                window.currentIncidents = safeData;
                if (typeof executionHub.clearExecutionReportCache === 'function') {
                    executionHub.clearExecutionReportCache();
                }
                try {
                    window.renderIncidentsList();
                } catch (renderErr) {
                    console.error('renderIncidentsList failed:', renderErr);
                    throw renderErr;
                }
                window.syncDashboardKpis();
            }
            window.refreshMaintenanceBanner();
            return safeData;
        })
        .catch((err) => {
            console.error('fetchIncidents failed:', err);
            const listEl = document.getElementById('incident-list');
            if (listEl) {
                const detail = err && err.message ? escapeHtml(err.message) : '';
                const hint = detail.includes('displayExecutionEnv')
                    ? 'Dashboard render bug - hard-refresh the page (Ctrl+Shift+R).'
                    : 'Check that the server is running, sign in again if needed, then refresh.';
                listEl.innerHTML = `<div class="load-error-msg">Unable to load incidents. ${hint}${detail ? `<br><span class="form-hint">${detail}</span>` : ''}</div>`;
            }
        });
};

function causeKey(inc) {
    const fp = String(inc.fingerprint || '').trim();
    if (fp) return `${inc.project_name}|fp|${fp}`;
    const name = String(inc.name || '').replace(/^\[FLAKY\]\s*/i, '').trim().toLowerCase();
    if (!name) return '';
    return `${inc.project_name}|name|${name}`;
}

function causeStamp(value) {
    const parsed = Date.parse(String(value || '').replace(' ', 'T') + 'Z');
    return Number.isFinite(parsed) ? parsed : 0;
}

function sameCauseWindow(prev, inc) {
    const start = causeStamp((prev.signal_list && prev.signal_list[0] && prev.signal_list[0].at) || prev.created_at);
    const next = causeStamp(inc.created_at);
    if (!start || !next) return true;
    return Math.abs(next - start) <= 6 * 60 * 60 * 1000;
}

function foldSameCause(list) {
    const order = [];
    const byKey = new Map();
    list.forEach(inc => {
        const key = causeKey(inc);
        const stamp = { id: inc.id, at: inc.created_at || '' };
        if (!key) {
            order.push({ ...inc, signal_count: 1, signal_list: [stamp] });
            return;
        }
        const prev = byKey.get(key);
        if (!prev || !sameCauseWindow(prev, inc)) {
            const copy = { ...inc, signal_count: 1, signal_list: [stamp] };
            byKey.set(key, copy);
            order.push(copy);
            return;
        }
        prev.signal_count += 1;
        prev.signal_list.push(stamp);
        const prevOpen = !normalizeIsResolved(prev);
        const nextOpen = !normalizeIsResolved(inc);
        const nextNewer = String(inc.created_at || '') > String(prev.created_at || '');
        if ((nextOpen && !prevOpen) || (nextOpen === prevOpen && nextNewer)) {
            const replacement = { ...inc, signal_count: prev.signal_count, signal_list: prev.signal_list };
            const idx = order.indexOf(prev);
            if (idx >= 0) order[idx] = replacement;
            byKey.set(key, replacement);
        }
    });
    return order;
}

function incidentOpsHTML(inc, canAct) {
    const bits = [];
    if (inc.created_at) bits.push(`Detected ${inc.created_at}`);
    if (inc.acknowledged_at) bits.push(`Acknowledged ${inc.acknowledged_by || ''} ${inc.severity || ''}`.trim());
    if (inc.mitigated_at) bits.push(`Mitigated ${inc.mitigated_at}`);
    if (normalizeIsResolved(inc)) bits.push(`Resolved ${inc.resolved_by || ''}`.trim());
    const signalItems = (inc.signal_list || []).slice(0, 8).map(item =>
        `<li>#${Number(item.id)} · ${escapeHtml(item.at || '')}</li>`).join('');
    const signals = Number(inc.signal_count) > 1
        ? `<span class="ops-signal">${inc.signal_count} signals, same cause</span><ul class="ops-signal-list">${signalItems}</ul>` : '';
    const prior = priorCauseHTML(inc);
    const maint = inc.maintenance && inc.maintenance.reason
        ? `<span class="ops-signal">During maintenance · ${escapeHtml(inc.maintenance.reason)}</span>` : '';
    const waitingMin = unackedMinutes(inc);
    const waiting = waitingMin >= 15
        ? `<span class="ops-wait">Waiting ${waitingMin} min for an owner</span>` : '';
    let actions = '';
    if (canAct && !normalizeIsResolved(inc)) {
        if (!inc.acknowledged_at) {
            actions += `<label class="ops-sev"><span>Severity</span>
                <select id="sev-${inc.id}" aria-label="Severity">
                    <option value="sev1">Sev 1</option>
                    <option value="sev2">Sev 2</option>
                    <option value="sev3" selected>Sev 3</option>
                    <option value="sev4">Sev 4</option>
                </select></label>
                <button type="button" class="btn btn-secondary btn-sm" onclick="ackIncident(${Number(inc.id)})">Acknowledge</button>`;
        }
        if (!inc.mitigated_at) {
            actions += `<button type="button" class="btn btn-secondary btn-sm" onclick="mitigateIncident(${Number(inc.id)})">Mark mitigated</button>`;
        }
        actions += `<button type="button" class="btn btn-secondary btn-sm" onclick="runIncidentRunbook(${Number(inc.id)})">Runbook</button>`;
    }
    if (canAct && normalizeIsResolved(inc)) {
        actions += `<button type="button" class="btn btn-secondary btn-sm" onclick="draftPostmortem(${Number(inc.id)})">${inc.postmortem ? 'Refresh draft' : 'Write postmortem'}</button>`;
    }
    const runbook = inc.runbook_summary ? `<p class="ops-note">${escapeHtml(inc.runbook_summary)}</p>` : '';
    const draft = inc.postmortem
        ? `<pre class="ops-postmortem">${escapeHtml(inc.postmortem)}</pre>
           <textarea class="ops-postmortem-edit" id="pm-edit-${inc.id}">${escapeHtml(inc.postmortem)}</textarea>
           <button type="button" class="btn btn-secondary btn-sm" onclick="savePostmortem(${Number(inc.id)})">Save draft</button>`
        : '';
    const actionPanel = actions
        ? `<section class="ops-action-panel" aria-label="Incident response"><h4 class="ops-action-panel__title">Response</h4><div class="ops-actions">${actions}</div></section>`
        : '';
    return `<div class="incident-ops">${maint}${waiting}${signals}${prior}<p class="ops-timeline">${escapeHtml(bits.join(' · '))}</p></div>${actionPanel}${runbook}${draft}`;
}

function priorCauseHTML(inc) {
    const own = new Set((inc.signal_list || []).map(item => Number(item.id)));
    own.add(Number(inc.id));
    const priors = (Array.isArray(inc.prior_causes) ? inc.prior_causes : []).filter(item => !own.has(Number(item.id)));
    if (!priors.length) return '';
    const items = priors.map(item => {
        const bits = [`#${Number(item.id)}`];
        if (item.created_at) bits.push(item.created_at);
        if (item.acknowledged_by) bits.push(`Acknowledged ${item.acknowledged_by}${item.severity ? ' ' + item.severity : ''}`);
        if (item.resolved) bits.push(`Resolved ${item.resolved_by || ''}`.trim());
        const excerpt = item.postmortem ? `<p class="ops-prior__excerpt">${escapeHtml(item.postmortem)}</p>` : '';
        const change = item.change ? `<p class="ops-prior__excerpt">Selector ${escapeHtml(item.change)}</p>` : '';
        return `<li class="ops-prior__item"><span>${escapeHtml(bits.join(' · '))}</span>${excerpt}${change}</li>`;
    }).join('');
    return `<div class="ops-prior"><span class="ops-signal">Same cause before</span><ul class="ops-prior__list">${items}</ul></div>`;
}

function unackedMinutes(inc) {
    if (normalizeIsResolved(inc) || inc.acknowledged_at) return 0;
    const started = causeStamp(inc.created_at);
    if (!started) return 0;
    return Math.floor((Date.now() - started) / 60000);
}

function formatSuiteDuration(ms) {
    const n = Number(ms) || 0;
    if (n < 1000) return `${n} ms`;
    if (n < 60000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)} s`;
    const min = Math.floor(n / 60000);
    const sec = Math.round((n % 60000) / 1000);
    return `${min} min ${sec} s`;
}

function shortSuiteName(name) {
    const raw = String(name || '');
    const parts = raw.split('>');
    const last = parts[parts.length - 1].trim();
    return last || raw;
}

function shortRunId(id) {
    const raw = String(id || '');
    return raw.length > 12 ? raw.slice(-12) : raw;
}

let suiteRows = [];
let suiteSelected = '';
let suiteFiltersBound = false;

function suiteVersus(card) {
    const last = card.last || {};
    if (!card.last_green) return { text: 'No earlier green run', tone: 'muted' };
    const delta = (last.duration_ms || 0) - (card.last_green.duration_ms || 0);
    if (delta === 0) return { text: 'Same duration as last green', tone: 'info' };
    if (delta > 0) return { text: `Slower by ${formatSuiteDuration(delta)}`, tone: 'warn' };
    return { text: `Faster by ${formatSuiteDuration(Math.abs(delta))}`, tone: 'pass' };
}

function suiteFiltered() {
    const project = document.getElementById('suite-project-filter')?.value || '';
    const status = document.getElementById('suite-status-filter')?.value || 'all';
    const q = (document.getElementById('suite-search')?.value || '').trim().toLowerCase();
    return suiteRows.filter(card => {
        if (project && card.project_name !== project) return false;
        const green = !!card.last?.green;
        if (status === 'green' && !green) return false;
        if (status === 'failing' && green) return false;
        if (!q) return true;
        const names = []
            .concat(card.new_failures || [])
            .concat(card.fixed_since_previous || [])
            .concat((card.slowest || []).map(row => row.name));
        const blob = [card.project_name, card.last?.run_id, card.last?.branch, ...names].join(' ').toLowerCase();
        return blob.includes(q);
    });
}

function fillSuiteProjects() {
    const sel = document.getElementById('suite-project-filter');
    if (!sel) return;
    const current = sel.value;
    const names = [...new Set(suiteRows.map(row => row.project_name).filter(Boolean))].sort();
    sel.innerHTML = `<option value="">All gateways</option>${names.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')}`;
    if (names.includes(current)) sel.value = current;
}

function suiteListHTML(items, empty, withDuration) {
    if (!items.length) return `<p class="suite-detail__none">${empty}</p>`;
    return `<ul class="suite-detail__list">${items.map(item => {
        const name = typeof item === 'string' ? item : item.name;
        const meta = withDuration ? formatSuiteDuration(item.duration_ms) : '';
        return `<li><span class="suite-detail__name" title="${escapeHtml(name)}">${escapeHtml(shortSuiteName(name))}</span>${meta ? `<span class="suite-detail__meta">${meta}</span>` : ''}</li>`;
    }).join('')}</ul>`;
}

function renderSuiteDetail(card) {
    const box = document.getElementById('suite-detail');
    if (!box) return;
    if (!card) {
        box.hidden = true;
        box.innerHTML = '';
        return;
    }
    const last = card.last || {};
    const green = !!last.green;
    const failureTitle = green
        ? 'This run is green'
        : (card.last_green ? 'New since the last green run' : 'Failures in this run');
    box.hidden = false;
    const heading = (tone, title) => `<h3 class="form-section-title kpi-tone-${tone}" style="border-top:none;padding-top:0;margin:0 0 8px;">${title}</h3>`;
    box.innerHTML = `
        <section class="data-card">
            ${heading(green ? 'success' : 'danger', failureTitle)}
            ${suiteListHTML(card.new_failures || [], green ? 'No failures in this run.' : 'None named in the report.', false)}
        </section>
        <section class="data-card">
            ${heading('success', 'Fixed since the previous run')}
            ${suiteListHTML(card.fixed_since_previous || [], 'None', false)}
        </section>
        <section class="data-card">
            ${heading('warn', 'Slowest')}
            ${suiteListHTML(card.slowest || [], 'No durations in this report.', true)}
        </section>`;
}

function renderSuiteBoard() {
    const body = document.getElementById('suite-table-body');
    const empty = document.getElementById('suite-empty');
    const kpis = document.getElementById('suite-kpis');
    if (!body || !empty || !kpis) return;
    const rows = suiteFiltered();
    const failing = rows.filter(card => !card.last?.green).length;
    const green = rows.length - failing;
    const avg = rows.length
        ? Math.round(rows.reduce((sum, card) => sum + (Number(card.pass_rate) || 0), 0) / rows.length)
        : 0;
    const avgTone = !rows.length ? 'neutral' : (avg >= 90 ? 'success' : (avg >= 70 ? 'warn' : 'danger'));
    const tile = (label, value, tone) => `<article class="kpi-card-premium"><span class="kpi-card-premium__label">${label}</span><span class="kpi-card-premium__value kpi-tone-${tone}">${value}</span></article>`;
    kpis.innerHTML = [
        tile('Gateways', rows.length, 'info'),
        tile('Failing', failing, 'danger'),
        tile('Green', green, 'success'),
        tile('Average pass rate', `${avg}%`, avgTone)
    ].join('');
    if (!rows.length) {
        body.innerHTML = '';
        empty.hidden = false;
        empty.textContent = suiteRows.length ? 'No pipeline runs match these filters.' : 'No pipeline runs yet.';
        renderSuiteDetail(null);
        return;
    }
    empty.hidden = true;
    if (!rows.some(card => card.project_name === suiteSelected)) suiteSelected = rows[0].project_name;
    const statusClass = { pass: 'budget-status--healthy', warn: 'budget-status--watch', muted: 'budget-status--quiet', info: 'budget-status--quiet' };
    body.innerHTML = rows.map(card => {
        const last = card.last || {};
        const ok = !!last.green;
        const rate = Math.max(0, Math.min(100, Number(card.pass_rate) || 0));
        const versus = suiteVersus(card);
        const failed = Number(last.failed) || 0;
        const selected = card.project_name === suiteSelected ? ' class="is-selected"' : '';
        return `<tr${selected} data-suite-project="${escapeHtml(card.project_name || '')}">
            <td>${escapeHtml(card.project_name || '')}</td>
            <td class="budget-status ${ok ? 'budget-status--healthy' : 'budget-status--freeze'}">${rate}%</td>
            <td title="${escapeHtml(last.run_id || '')}">${escapeHtml(shortRunId(last.run_id))}</td>
            <td><span class="budget-status ${failed ? 'budget-status--freeze' : 'budget-status--healthy'}">${failed}</span> / ${Number(last.total) || 0}</td>
            <td>${formatSuiteDuration(last.duration_ms)}</td>
            <td>${escapeHtml(last.branch || '-')}</td>
            <td class="budget-status ${statusClass[versus.tone] || 'budget-status--quiet'}">${escapeHtml(versus.text)}</td>
        </tr>`;
    }).join('');
    body.querySelectorAll('tr').forEach(row => {
        row.addEventListener('click', () => {
            suiteSelected = row.getAttribute('data-suite-project') || '';
            renderSuiteBoard();
        });
    });
    renderSuiteDetail(rows.find(card => card.project_name === suiteSelected) || null);
}

function bindSuiteFilters() {
    if (suiteFiltersBound) return;
    suiteFiltersBound = true;
    ['suite-project-filter', 'suite-status-filter', 'suite-search'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', renderSuiteBoard);
        document.getElementById(id)?.addEventListener('change', renderSuiteBoard);
    });
    document.getElementById('suite-refresh')?.addEventListener('click', () => window.loadSuiteHealth(true));
}

window.loadSuiteHealth = async function (force) {
    const body = document.getElementById('suite-table-body');
    if (!body) return;
    bindSuiteFilters();
    try {
        const { ok, data } = await parseApiJson(await fetchWithAuth('/api/suite-health?project=all'));
        if (!ok) {
            suiteRows = [];
            renderSuiteBoard();
            document.getElementById('suite-empty').hidden = false;
            document.getElementById('suite-empty').textContent = 'Suite health is unavailable.';
            return;
        }
        const sig = JSON.stringify(data);
        if (!force && sig === window.__suiteHealthSig) {
            renderSuiteBoard();
            return;
        }
        window.__suiteHealthSig = sig;
        suiteRows = Array.isArray(data) ? data : [];
        fillSuiteProjects();
        renderSuiteBoard();
    } catch {
        const empty = document.getElementById('suite-empty');
        if (empty) {
            empty.hidden = false;
            empty.textContent = 'Suite health is unavailable.';
        }
    }
};

const HISTORY_KIND = {
    opened: 'Opened',
    acknowledged: 'Acknowledged',
    mitigated: 'Mitigated',
    comment: 'Message',
    selector: 'Selector',
    runbook: 'Runbook',
    patch: 'Patch',
    postmortem: 'Postmortem',
    resolved: 'Resolved',
};

let activityFlow = { incidents: [] };
let activityFiltersBound = false;
let activitySelected = '';

function activityKindTone(kind) {
    if (kind === 'resolved' || kind === 'selector' || kind === 'patch') return 'success';
    if (kind === 'opened') return 'danger';
    if (kind === 'mitigated' || kind === 'postmortem') return 'warn';
    if (kind === 'comment' || kind === 'runbook') return 'info';
    return 'neutral';
}

function activitySuiteOf(name) {
    let raw = String(name || '').replace(/^\[FLAKY\]\s*/i, '');
    raw = raw.replace(/^\[[^\]]+\]\s*/, '');
    const nested = raw.indexOf(' > ');
    if (nested > 0) return raw.slice(0, nested).trim();
    const robot = raw.indexOf(' - ');
    if (robot > 0) return raw.slice(0, robot).trim();
    return raw.trim() || 'Test suite';
}

function activityIncidentMatches(item) {
    const project = document.getElementById('activity-project-filter')?.value || '';
    const kind = document.getElementById('activity-kind-filter')?.value || '';
    const q = (document.getElementById('activity-search')?.value || '').trim().toLowerCase();
    if (project && (item.project || '') !== project) return false;
    const events = Array.isArray(item.events) ? item.events : [];
    if (kind && !events.some(ev => ev.kind === kind)) return false;
    if (!q) return true;
    const blob = [item.project, activitySuiteOf(item.name), item.name, item.status, item.severity, String(item.id)]
        .concat(events.flatMap(ev => [ev.actor, ev.text, ev.kind]))
        .join(' ')
        .toLowerCase();
    return blob.includes(q);
}

function activityGroups() {
    const groups = new Map();
    (Array.isArray(activityFlow.incidents) ? activityFlow.incidents : []).filter(activityIncidentMatches).forEach(item => {
        const suite = activitySuiteOf(item.name);
        const project = item.project || '';
        const key = `${project}\0${suite}`;
        if (!groups.has(key)) groups.set(key, { key, project, suite, incidents: [] });
        groups.get(key).incidents.push(item);
    });
    const rows = [...groups.values()];
    rows.forEach(group => {
        const events = group.incidents.flatMap(item => (item.events || []).map(ev => ({ ...ev, id: item.id })));
        events.sort((a, b) => String(b.at).localeCompare(String(a.at)) || (Number(b.id) - Number(a.id)));
        group.last = events[0] || null;
        group.actions = events.length;
    });
    rows.sort((a, b) => String(b.last?.at || '').localeCompare(String(a.last?.at || ''))
        || a.project.localeCompare(b.project)
        || a.suite.localeCompare(b.suite));
    return rows;
}

function fillActivityProjects() {
    const sel = document.getElementById('activity-project-filter');
    if (!sel) return;
    const current = sel.value;
    const names = [...new Set((activityFlow.incidents || []).map(row => row.project).filter(Boolean))].sort();
    sel.innerHTML = `<option value="">All gateways</option>${names.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')}`;
    if (names.includes(current)) sel.value = current;
}

function activityDetailHTML(group) {
    const incidents = [...group.incidents].sort((a, b) => {
        const last = item => String((item.events || [])[item.events.length - 1]?.at || '');
        return last(b).localeCompare(last(a)) || (Number(b.id) - Number(a.id));
    });
    return incidents.map(item => {
        const meta = [item.status, item.severity, item.archived ? 'Archived' : ''].filter(Boolean).map(escapeHtml).join(' · ');
        const steps = (item.events || []).map(ev => {
            const label = HISTORY_KIND[ev.kind] || ev.kind || 'Action';
            const who = ev.actor ? `<span class="activity-who">${escapeHtml(ev.actor)}</span>` : '';
            const text = ev.text ? escapeHtml(ev.text) : 'No extra detail.';
            return `<details class="ur-test-block" open>
                <summary class="ur-test-summary">
                    <strong class="kpi-tone-${activityKindTone(ev.kind)}">${escapeHtml(label)}</strong>
                    <time class="ur-test-duration">${escapeHtml(ev.at || '')}</time>
                    ${who}
                </summary>
                <p class="activity-step-body">${text}</p>
            </details>`;
        }).join('');
        return `<details class="ur-suite-block" open>
            <summary class="ur-suite-summary">
                <span class="ur-suite-name">#${Number(item.id)} · ${escapeHtml(item.name || group.suite)}</span>
                ${meta ? `<span class="ur-suite-stats">${meta}</span>` : ''}
            </summary>
            <div class="ur-suite-body">${steps}</div>
        </details>`;
    }).join('');
}

function showActivityDetail(group) {
    const root = document.getElementById('activity-detail-root');
    const title = document.getElementById('activity-detail-title');
    if (!root || !group) return;
    if (title) title.textContent = [group.project, group.suite].filter(Boolean).join(' · ');
    root.innerHTML = activityDetailHTML(group);
    document.querySelectorAll('.view-section').forEach(section => {
        section.classList.remove('active');
        section.style.removeProperty('display');
    });
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    document.querySelector('.nav-item[onclick*="switchView(\'activity\'"]')?.classList.add('active');
    const page = document.getElementById('view-activity-detail');
    if (page) {
        page.classList.add('active');
        page.style.removeProperty('display');
    }
    if (typeof window.stopDashboardAutoRefresh === 'function') window.stopDashboardAutoRefresh();
}

window.expandActivitySteps = function () {
    document.querySelectorAll('#activity-detail-root details').forEach(item => { item.open = true; });
};

window.collapseActivitySteps = function () {
    document.querySelectorAll('#activity-detail-root details').forEach(item => { item.open = false; });
};

window.closeActivityDetail = function () {
    const nav = document.querySelector('.nav-item[onclick*="switchView(\'activity\'"]');
    window.switchView('activity', nav);
};

function renderActivityBoard() {
    const body = document.getElementById('activity-table-body');
    const empty = document.getElementById('activity-empty');
    const kpis = document.getElementById('activity-kpis');
    if (!body || !empty || !kpis) return;
    const groups = activityGroups();
    const incidents = groups.reduce((count, group) => count + group.incidents.length, 0);
    const actions = groups.reduce((count, group) => count + group.actions, 0);
    const messages = groups.reduce((count, group) => count + group.incidents.reduce((n, item) => n + (item.events || []).filter(ev => ev.kind === 'comment').length, 0), 0);
    const people = new Set(groups.flatMap(group => group.incidents.flatMap(item => (item.events || []).map(ev => ev.actor).filter(Boolean)))).size;
    const tile = (label, value, tone) => `<article class="kpi-card-premium"><span class="kpi-card-premium__label">${label}</span><span class="kpi-card-premium__value kpi-tone-${tone}">${value}</span></article>`;
    kpis.innerHTML = [
        tile('Suites', groups.length, 'info'),
        tile('Incidents', incidents, 'neutral'),
        tile('Actions', actions, 'warn'),
        tile('Messages', messages, people ? 'success' : 'neutral'),
    ].join('');
    const known = (Array.isArray(activityFlow.incidents) ? activityFlow.incidents : []).length;
    if (!groups.length) {
        body.innerHTML = '';
        empty.hidden = false;
        empty.textContent = known ? 'No actions match these filters.' : 'No actions recorded yet.';
        activitySelected = '';
        return;
    }
    empty.hidden = true;
    if (!groups.some(group => group.key === activitySelected)) activitySelected = '';
    body.innerHTML = groups.map((group, index) => {
        const label = group.last ? (HISTORY_KIND[group.last.kind] || group.last.kind || 'Action') : '-';
        const tone = group.last ? activityKindTone(group.last.kind) : 'neutral';
        const selected = group.key === activitySelected ? ' class="is-selected"' : '';
        return `<tr${selected} data-activity-index="${index}">
            <td>${escapeHtml(group.project || '-')}</td>
            <td><span class="activity-suite" title="${escapeHtml(group.suite)}">${escapeHtml(group.suite)}</span></td>
            <td>${group.incidents.length}</td>
            <td><span class="kpi-tone-${tone}">${escapeHtml(label)}</span></td>
            <td class="activity-when">${escapeHtml(group.last?.at || '')}</td>
        </tr>`;
    }).join('');
    body.querySelectorAll('tr').forEach(row => {
        row.addEventListener('click', () => {
            const index = Number(row.getAttribute('data-activity-index'));
            const group = groups[index];
            if (!group) return;
            activitySelected = group.key;
            showActivityDetail(group);
        });
    });
}

function bindActivityFilters() {
    if (activityFiltersBound) return;
    activityFiltersBound = true;
    ['activity-project-filter', 'activity-kind-filter', 'activity-search'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', renderActivityBoard);
        document.getElementById(id)?.addEventListener('change', renderActivityBoard);
    });
    document.getElementById('activity-refresh')?.addEventListener('click', () => window.loadActivity(true));
}

window.loadActivity = async function (force) {
    const body = document.getElementById('activity-table-body');
    if (!body) return;
    bindActivityFilters();
    try {
        const { ok, data } = await parseApiJson(await fetchWithAuth('/api/history/flow'));
        if (!ok) {
            activityFlow = { incidents: [] };
            renderActivityBoard();
            const empty = document.getElementById('activity-empty');
            if (empty) {
                empty.hidden = false;
                empty.textContent = 'Activity is unavailable.';
            }
            return;
        }
        const sig = JSON.stringify(data);
        const note = document.getElementById('activity-note');
        if (note) note.hidden = !data?.truncated;
        if (!force && sig === window.__activitySig) {
            renderActivityBoard();
            return;
        }
        window.__activitySig = sig;
        activityFlow = data && typeof data === 'object' ? data : { incidents: [] };
        fillActivityProjects();
        renderActivityBoard();
    } catch {
        const empty = document.getElementById('activity-empty');
        if (empty) {
            empty.hidden = false;
            empty.textContent = 'Activity is unavailable.';
        }
    }
};

let unownedRows = [];
let unownedFiltersBound = false;

function formatWait(min) {
    const n = Math.max(0, Number(min) || 0);
    if (n < 60) return `${n} min`;
    const hours = Math.floor(n / 60);
    const minutes = n % 60;
    if (hours < 24) return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    return rest ? `${days} d ${rest} h` : `${days} d`;
}

function unownedSeverityTone(severity) {
    if (severity === 'sev1') return 'danger';
    if (severity === 'sev2') return 'warn';
    if (severity === 'sev3') return 'info';
    return 'neutral';
}

function unownedFiltered() {
    const project = document.getElementById('unowned-project-filter')?.value || '';
    const wait = document.getElementById('unowned-wait-filter')?.value || '';
    const q = (document.getElementById('unowned-search')?.value || '').trim().toLowerCase();
    return unownedRows.filter(row => {
        if (project && row.project !== project) return false;
        if (wait === '15' && (Number(row.waiting_min) || 0) < 15) return false;
        if (!q) return true;
        return [row.project, row.name, row.error, String(row.id)].join(' ').toLowerCase().includes(q);
    });
}

function fillUnownedProjects() {
    const sel = document.getElementById('unowned-project-filter');
    if (!sel) return;
    const current = sel.value;
    const names = [...new Set(unownedRows.map(row => row.project).filter(Boolean))].sort();
    sel.innerHTML = `<option value="">All gateways</option>${names.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')}`;
    if (names.includes(current)) sel.value = current;
}

function renderUnownedBoard() {
    const body = document.getElementById('unowned-table-body');
    const empty = document.getElementById('unowned-empty');
    const kpis = document.getElementById('unowned-kpis');
    if (!body || !empty || !kpis) return;
    const rows = unownedFiltered();
    const late = rows.filter(row => (Number(row.waiting_min) || 0) >= 15).length;
    const oldest = rows.reduce((max, row) => Math.max(max, Number(row.waiting_min) || 0), 0);
    const gateways = new Set(rows.map(row => row.project).filter(Boolean)).size;
    const tile = (label, value, tone) => `<article class="kpi-card-premium"><span class="kpi-card-premium__label">${label}</span><span class="kpi-card-premium__value kpi-tone-${tone}">${value}</span></article>`;
    kpis.innerHTML = [
        tile('Waiting', rows.length, rows.length ? 'danger' : 'success'),
        tile('15 min or more', late, late ? 'warn' : 'neutral'),
        tile('Oldest', rows.length ? formatWait(oldest) : '-', oldest >= 15 ? 'warn' : 'neutral'),
        tile('Gateways', gateways, 'info'),
    ].join('');
    if (!rows.length) {
        body.innerHTML = '';
        empty.hidden = false;
        empty.textContent = unownedRows.length ? 'No incidents match these filters.' : 'No unowned incidents.';
        return;
    }
    empty.hidden = true;
    const canTake = canResolveIncidents(parseJwt(localStorage.getItem('sre-jwt')).role);
    body.innerHTML = rows.map(row => {
        const waitTone = (Number(row.waiting_min) || 0) >= 15 ? 'warn' : 'neutral';
        const severity = row.severity ? row.severity : 'Not set';
        const name = `#${Number(row.id)} · ${row.name || ''}`;
        const take = canTake
            ? `<div class="unowned-take"><select id="unowned-sev-${Number(row.id)}" class="login-input" aria-label="Severity">
                    <option value="sev1">sev1</option>
                    <option value="sev2">sev2</option>
                    <option value="sev3" selected>sev3</option>
                    <option value="sev4">sev4</option>
               </select>
               <button type="button" class="btn btn-secondary btn-sm" onclick="takeUnowned(${Number(row.id)})">Acknowledge</button></div>`
            : '';
        return `<tr>
            <td class="unowned-wait kpi-tone-${waitTone}">${escapeHtml(formatWait(row.waiting_min))}</td>
            <td class="kpi-tone-${unownedSeverityTone(row.severity)}">${escapeHtml(severity)}</td>
            <td>${escapeHtml(row.project || '')}</td>
            <td><span class="unowned-name" title="${escapeHtml(row.error || name)}">${escapeHtml(name)}</span></td>
            <td>Lead or Manager</td>
            <td>${take}</td>
        </tr>`;
    }).join('');
}

function bindUnownedFilters() {
    if (unownedFiltersBound) return;
    unownedFiltersBound = true;
    ['unowned-project-filter', 'unowned-wait-filter', 'unowned-search'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', renderUnownedBoard);
        document.getElementById(id)?.addEventListener('change', renderUnownedBoard);
    });
    document.getElementById('unowned-refresh')?.addEventListener('click', () => window.loadUnowned(true));
}

window.loadUnowned = async function (force) {
    const body = document.getElementById('unowned-table-body');
    if (!body) return;
    bindUnownedFilters();
    try {
        const { ok, data } = await parseApiJson(await fetchWithAuth('/api/unowned'));
        if (!ok) {
            unownedRows = [];
            renderUnownedBoard();
            const empty = document.getElementById('unowned-empty');
            if (empty) {
                empty.hidden = false;
                empty.textContent = 'Unowned queue is unavailable.';
            }
            return;
        }
        const sig = JSON.stringify(data);
        if (!force && sig === window.__unownedSig) {
            renderUnownedBoard();
            return;
        }
        window.__unownedSig = sig;
        unownedRows = Array.isArray(data) ? data : [];
        fillUnownedProjects();
        renderUnownedBoard();
    } catch {
        const empty = document.getElementById('unowned-empty');
        if (empty) {
            empty.hidden = false;
            empty.textContent = 'Unowned queue is unavailable.';
        }
    }
};

window.takeUnowned = async function (id) {
    const sel = document.getElementById(`unowned-sev-${id}`);
    try {
        await postIncidentOps(id, { action: 'ack', severity: sel ? sel.value : 'sev3' });
        notify('Incident acknowledged');
        window.loadUnowned(true);
    } catch (err) {
        notify(err.message, 'error');
    }
};

function historyDocumentHTML(flow) {
    const incidents = Array.isArray(flow?.incidents) ? flow.incidents : [];
    const eventCount = incidents.reduce((count, item) => count + (item.events || []).length, 0);
    const ink = { danger: '#b42318', success: '#067647', warn: '#b54708', info: '#175cd3', neutral: '#344054' };
    const blocks = incidents.map(item => {
        const meta = [item.project, item.status, item.severity, item.archived ? 'Archived' : ''].filter(Boolean).map(escapeHtml).join(' · ');
        const steps = (item.events || []).map(ev => {
            const tone = activityKindTone(ev.kind);
            const color = ink[tone] || ink.neutral;
            const who = ev.actor ? `<span>${escapeHtml(ev.actor)}</span>` : '';
            return `<li class="step">
                <span class="mark" style="background:${color}"></span>
                <div>
                    <div class="meta"><strong style="color:${color}">${escapeHtml(HISTORY_KIND[ev.kind] || ev.kind || 'Action')}</strong><time>${escapeHtml(ev.at || '')}</time>${who}</div>
                    ${ev.text ? `<p>${escapeHtml(ev.text)}</p>` : ''}
                </div>
            </li>`;
        }).join('');
        return `<section class="card">
            <h2>#${Number(item.id)} · ${escapeHtml(item.name || '')}</h2>
            ${meta ? `<p class="sub">${meta}</p>` : ''}
            <ol>${steps}</ol>
        </section>`;
    }).join('');
    const note = flow?.truncated ? '<p class="note">The newest 400 incidents are included.</p>' : '';
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>SRE Capsule - Action history</title>
<style>
body{font-family:Inter,Segoe UI,sans-serif;color:#1c2434;margin:28px;background:#fff}
.doc-head{margin-bottom:20px;padding-bottom:14px;border-bottom:1px solid #d8dee6}
.brand{margin:0;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#5e6b7c}
h1{font-size:22px;margin:4px 0}
.lead,.sub,.note,.meta{color:#5e6b7c;font-size:12px}
.lead{margin:0}
.note{margin:8px 0 0}
.card{border:1px solid #d8dee6;border-radius:10px;padding:16px 18px;margin:0 0 14px;break-inside:avoid}
h2{font-size:15px;margin:0}
.sub{margin:4px 0 0}
ol{list-style:none;margin:14px 0 0;padding:0}
.step{display:grid;grid-template-columns:16px 1fr;column-gap:12px;position:relative;padding-bottom:12px}
.step:last-child{padding-bottom:0}
.step:not(:last-child)::before{content:"";position:absolute;left:7px;top:14px;bottom:0;width:1px;background:#d8dee6}
.mark{width:8px;height:8px;margin-top:4px;border-radius:50%;justify-self:center}
.meta{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:baseline}
.meta strong{font-weight:650}
p{margin:4px 0 0;font-size:13px;line-height:1.5;white-space:pre-wrap}
@media print{body{margin:12mm}.card{break-inside:auto}}
</style></head><body>
<header class="doc-head">
<p class="brand">SRE Capsule</p>
<h1>Action history</h1>
<p class="lead">${incidents.length} incidents · ${eventCount} actions and messages · ${escapeHtml(flow?.generated_at || '')}</p>
${note}
</header>
${blocks || '<p>No actions recorded yet.</p>'}
</body></html>`;
}

window.exportHistoryPDF = async function () {
    try {
        const { ok, data } = await parseApiJson(await fetchWithAuth('/api/history/flow'));
        if (!ok) {
            notify('History export is unavailable.', 'error');
            return;
        }
        const frame = window.open('', '_blank');
        if (!frame) {
            notify('Allow pop-ups, then export the history again. In the print dialog, choose Save as PDF.', 'error');
            return;
        }
        frame.document.open();
        frame.document.write(historyDocumentHTML(data));
        frame.document.close();
        frame.focus();
        setTimeout(() => frame.print(), 200);
    } catch {
        notify('History export is unavailable.', 'error');
    }
};

window.refreshMaintenanceBanner = async function () {
    const el = document.getElementById('maintenance-banner');
    if (!el) return;
    const parsed = await parseApiJson(await fetchWithAuth('/api/maintenance'));
    const windows = parsed.ok && parsed.data && Array.isArray(parsed.data.windows) ? parsed.data.windows : [];
    if (!windows.length) {
        el.hidden = true;
        el.innerHTML = '';
        return;
    }
    const role = parseJwt(localStorage.getItem('sre-jwt')).role;
    const canEnd = canAccessFinOps(role);
    el.hidden = false;
    el.innerHTML = window.maintenanceWindowTable ? window.maintenanceWindowTable(windows, canEnd) : '';
};

async function postIncidentOps(id, payload) {
    const parsed = await parseApiJson(await fetchWithAuth(`/api/incidents/${id}/ops`, {
        method: 'POST',
        body: JSON.stringify(payload),
    }));
    if (!parsed.ok) {
        const message = parsed.data && parsed.data.error ? parsed.data.error : 'Could not update the incident';
        throw new Error(message);
    }
    return parsed.data || {};
}

window.ackIncident = async function (id) {
    const sel = document.getElementById(`sev-${id}`);
    try {
        await postIncidentOps(id, { action: 'ack', severity: sel ? sel.value : 'sev3' });
        notify('Incident acknowledged');
        window.refreshDashboard();
    } catch (err) {
        notify(err.message, 'error');
    }
};

window.mitigateIncident = async function (id) {
    try {
        await postIncidentOps(id, { action: 'mitigate' });
        notify('Incident marked mitigated');
        window.refreshDashboard();
    } catch (err) {
        notify(err.message, 'error');
    }
};

window.runIncidentRunbook = async function (id) {
    let preview;
    try {
        preview = await postIncidentOps(id, { action: 'runbook_preview' });
    } catch (err) {
        notify(err.message, 'error');
        return;
    }
    const steps = preview.summary || 'the matching steps';
    showConfirmModal(
        preview.template_name || 'Record a runbook?',
        `The plugin engine would run: ${steps}. This dry-run is saved on the incident. Slack, Jira, and the cluster are not called.`,
        '',
        async function () {
            try {
                await postIncidentOps(id, { action: 'runbook', template_id: preview.template_id });
                notify('Runbook recorded on the incident');
                window.refreshDashboard();
            } catch (err) {
                notify(err.message, 'error');
            }
        }
    );
};

window.draftPostmortem = function (id) {
    showConfirmModal(
        'Write the postmortem draft?',
        'The draft is built from the timeline, comments, and the nearest deploy. If AI is enabled, the model rewrites that draft and does not add a cause that is not already written. You can edit it afterwards.',
        '',
        async function () {
            try {
                await postIncidentOps(id, { action: 'postmortem' });
                notify('Postmortem draft saved');
                window.refreshDashboard();
            } catch (err) {
                notify(err.message, 'error');
            }
        }
    );
};

window.savePostmortem = async function (id) {
    const box = document.getElementById(`pm-edit-${id}`);
    const body = box ? box.value : '';
    try {
        await postIncidentOps(id, { action: 'postmortem', body });
        notify('Postmortem draft saved');
        window.refreshDashboard();
    } catch (err) {
        notify(err.message, 'error');
    }
};

window.renderIncidentsList = function () {
    const listEl = document.getElementById('incident-list');
    const searchQuery = document.getElementById('incident-search') ? document.getElementById('incident-search').value.toLowerCase() : '';

    const openGroups = new Set();
    document.querySelectorAll('[id^="sub-alerts-"]').forEach(el => { if (el.style.display === 'block') openGroups.add(el.id.replace('sub-alerts-', '')); });

    let filteredData = window.currentIncidents || [];
    if (window.statusFilter === 'active') filteredData = filteredData.filter(inc => !normalizeIsResolved(inc));
    else if (window.statusFilter === 'resolved') filteredData = filteredData.filter(inc => normalizeIsResolved(inc));

    if (searchQuery) {
        filteredData = filteredData.filter(inc =>
            (inc.name && inc.name.toLowerCase().includes(searchQuery))
            || (inc.project_name && inc.project_name.toLowerCase().includes(searchQuery))
            || (inc.error_message && inc.error_message.toLowerCase().includes(searchQuery))
        );
    }

    // KPI strip always reflects the loaded time-range dataset (not status/search filters).
    window.updateDashboardKpisFromIncidents(window.currentIncidents || []);

    const openLogs = new Set();
    if (window.__logsExpandAll === true) {
        filteredData.forEach(inc => openLogs.add(String(inc.id)));
    } else if (window.__logsExpandAll !== false) {
        document.querySelectorAll('[id^="log-content-"]').forEach(el => {
            if (el.style.display === 'block') openLogs.add(el.id.replace('log-content-', ''));
        });
    }

    if (filteredData.length === 0) {
        const total = (window.currentIncidents || []).length;
        let msg = 'No incidents in this view. Send CI results to your gateway webhook (X-API-Key), wait a few seconds for ingest, then click Refresh.';
        if (total > 0 && searchQuery) msg = 'No incidents match your search. Clear the search box or change filters.';
        else if (total > 0 && window.statusFilter === 'active') {
            listEl.innerHTML = `<div class="incident-empty-state">
                <p>No active incidents. ${total} in this range ${total === 1 ? 'is' : 'are'} resolved.</p>
                <div class="incident-empty-actions">
                    <button type="button" class="btn btn-secondary btn-sm" onclick="setStatusFilter('all')">Show all</button>
                    <button type="button" class="btn btn-secondary btn-sm" onclick="setStatusFilter('resolved')">Show resolved</button>
                </div>
            </div>`;
            return;
        }
        else if (total > 0 && window.statusFilter === 'resolved') msg = 'No resolved incidents yet.';
        else if (total > 0) msg = 'No incidents match the current project filter.';
        listEl.innerHTML = `<div class="incident-empty-state">${msg}</div>`;
        return;
    }

    const sortedData = foldSameCause([...filteredData].sort((a, b) => a.id - b.id));
    const groupsArray = []; let currentGroup = null;

    sortedData.forEach(inc => {
        const safeDateStr = inc.created_at ? inc.created_at.replace(' ', 'T') + 'Z' : '';
        const incTime = new Date(safeDateStr).getTime() || 0;
        const runKey = (inc.pipeline_run_id && String(inc.pipeline_run_id).trim())
            ? String(inc.pipeline_run_id)
            : `legacy-${inc.project_name}-${Math.floor(incTime / 120000)}`;

        if (!currentGroup) {
            currentGroup = { id: inc.id, project_name: inc.project_name, created_at: inc.created_at, pipeline_run_id: runKey, is_resolved: true, incidents: [], firstTime: incTime, lastTime: incTime, lastId: inc.id };
            groupsArray.push(currentGroup);
        } else {
            const sameRun = inc.project_name === currentGroup.project_name && runKey === currentGroup.pipeline_run_id;
            if (sameRun) {
                currentGroup.lastTime = incTime; currentGroup.lastId = inc.id;
            } else {
                currentGroup = { id: inc.id, project_name: inc.project_name, created_at: inc.created_at, pipeline_run_id: runKey, is_resolved: true, incidents: [], firstTime: incTime, lastTime: incTime, lastId: inc.id };
                groupsArray.push(currentGroup);
            }
        }
        currentGroup.incidents.push(inc);
        if (!normalizeIsResolved(inc)) currentGroup.is_resolved = false;
    });

    groupsArray.reverse();
    groupsArray.forEach(g => executionHub.enrichExecutionGroup(g));
    window.groupedIncidents = {};
    groupsArray.forEach(g => {
        window.groupedIncidents[g.id] = g;
        openGroups.add(String(g.id));
    });

    const userRole = parseJwt(localStorage.getItem('sre-jwt')).role;
    const canResolve = canResolveIncidents(userRole);
    const canDelete = canDeleteIncidents(userRole);
    const canPatchFlags = canPatchExecutionFlags(userRole);

    const iconCheck = `<svg style="width:12px;height:12px;margin-right:4px;vertical-align:middle;stroke:currentColor;fill:none;" viewBox="0 0 24 24" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    const iconAlert = `<svg style="width:12px;height:12px;margin-right:4px;vertical-align:middle;stroke:currentColor;fill:none;" viewBox="0 0 24 24" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
    const iconWarning = `<svg style="width:12px;height:12px;margin-right:4px;vertical-align:middle;stroke:currentColor;fill:none;" viewBox="0 0 24 24" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
    const iconFile = `<svg style="width:12px;height:12px;margin-right:6px;vertical-align:middle;stroke:currentColor;fill:none;" viewBox="0 0 24 24" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`;
    const iconCode = `<svg style="width:12px;height:12px;margin-right:6px;vertical-align:middle;stroke:currentColor;fill:none;" viewBox="0 0 24 24" stroke-width="2"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>`;
    const iconChevron = `<svg style="width:14px;height:14px;stroke:currentColor;fill:none;transition: transform 0.2s;" viewBox="0 0 24 24" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
    const iconTrash = `<svg style="width:12px;height:12px;margin-right:4px;vertical-align:middle;stroke:currentColor;fill:none;" viewBox="0 0 24 24" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
    const iconGear = `<svg style="width:12px;height:12px;margin-right:4px;vertical-align:middle;stroke:currentColor;fill:none;" viewBox="0 0 24 24" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1 0-2.83 2 2 0 0 1 0-2.83l.06.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;

    const globalAllSelected = window.currentIncidents.length > 0 && window.currentIncidents.every(inc => window.selectedIncidents.has(String(inc.id)));

    let htmlContent = `
    <div id="bulk-action-banner" class="bulk-action-bar" style="display: ${window.selectedIncidents.size > 0 ? 'flex' : 'none'};">
        <div style="display:flex; align-items:center; gap: 10px;">
            <input type="checkbox" id="select-all-cb" onclick="toggleSelectAll(this.checked)" ${globalAllSelected ? 'checked' : ''} style="width: 16px; height: 16px; cursor: pointer;">
            <label for="select-all-cb" id="bulk-count-label" class="bulk-action-label">${window.selectedIncidents.size} Test(s) Selected</label>
        </div>
        <div style="display: flex; gap: 10px; margin-left: auto;">
            ${canResolve ? `<button type="button" class="btn btn-secondary btn-success btn-sm" onclick="resolveSelected()">${iconCheck} Resolve</button>` : ''}
            ${canDelete ? `<button type="button" class="btn btn-secondary btn-danger btn-sm" onclick="deleteSelected()">${iconTrash} Delete</button>` : ''}
        </div>
    </div>`;

    htmlContent += groupsArray.map(group => {
        const activeSubAlerts = group.incidents.filter(i => !normalizeIsResolved(i)).length;
        const cardStateClass = activeSubAlerts > 0 ? 'pipeline-exec-card--active' : 'pipeline-exec-card--resolved';

        const resolvedBadge = activeSubAlerts === 0
            ? `<span class="exec-status-badge exec-status-badge--resolved">${iconCheck} Execution resolved</span>`
            : `<span class="exec-status-badge exec-status-badge--active">${iconAlert} ${activeSubAlerts} Active / ${group.incidents.length} Total</span>`;

        const subAlertsHTML = group.incidents.map(inc => {
            const isFlaky = inc.name.includes("[FLAKY]");
            const flakyBadge = isFlaky ? `<span class="kpi-warn" style="margin-right:8px;">${iconWarning} Flaky</span>` : '';
            const cleanName = escapeHtml(inc.name.replace("[FLAKY] ", ""));
            const rawLog = inc.error_logs || inc.error_message || "No logs available.";
            const displayLog = String(rawLog)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

            const isResolved = normalizeIsResolved(inc);
            const nameClass = isResolved ? 'kpi-success' : '';
            const nameStyle = isResolved ? 'text-decoration:line-through;' : '';
            const isChecked = window.selectedIncidents.has(String(inc.id)) ? 'checked' : '';
            const rowClass = isResolved ? 'is-resolved' : 'is-active';

            const subAlertFlag = isResolved
                ? `<span class="incident-test-badge exec-status-badge exec-status-badge--resolved">${iconCheck} Resolved by ${escapeHtml(inc.resolved_by || 'System')}</span>`
                : `<span class="incident-test-badge exec-status-badge exec-status-badge--active">${iconAlert} Active test</span>`;

            const isLogOpen = openLogs.has(String(inc.id));
            const logDisplay = isLogOpen ? 'block' : 'none';
            const iconTransform = isLogOpen ? 'rotate(180deg)' : 'rotate(0deg)';
            const textLabel = isLogOpen ? 'Collapse logs' : 'Show logs';

            return `
            <div class="incident-test-row ${rowClass}">
                <div class="incident-test-row-header">
                    <div class="incident-test-row-title">
                        <input type="checkbox" id="cb-inc-${inc.id}" onclick="toggleIncidentSelection('${inc.id}', this.checked)" ${isChecked} style="width: 14px; height: 14px; cursor: pointer; flex-shrink: 0;">
                        <strong class="${nameClass}" style="font-size: 13px; ${nameStyle}">${flakyBadge}${cleanName}</strong>
                    </div>
                    ${subAlertFlag}
                </div>
                ${incidentOpsHTML(inc, canResolve)}
                <div class="incident-test-row-actions">
                    <button type="button" class="btn btn-secondary btn-sm exec-detail-btn" onclick="openExecutionSheetFromIncident('${inc.id}', event)">Command panel</button>
                    <button type="button" class="log-toggle-btn" onclick="window.toggleIncidentLog('${inc.id}', event)">
                        <svg id="log-icon-${inc.id}" style="width:12px;height:12px;stroke:currentColor;fill:none;transition: transform 0.2s; transform: ${iconTransform};" viewBox="0 0 24 24" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg>
                        <span id="log-text-${inc.id}">${textLabel}</span>
                    </button>
                    <div id="log-content-${inc.id}" class="incident-log-panel" style="display: ${logDisplay};">${displayLog}</div>
                </div>
                <div class="incident-comments" data-incident-id="${inc.id}"></div>
            </div>`;
        }).join('');

        const actionDropdown = `
            <div class="action-dropdown-container">
                <button type="button" class="btn btn-secondary btn-sm" onclick="toggleActionDropdown('${group.id}', event)">${iconGear} Actions</button>
                <div id="action-dropdown-${group.id}" class="action-dropdown-menu">
                    ${(!group.is_resolved && canResolve) ? `<a href="#" class="action-resolve" onclick="resolveGroup('${group.id}', event)">${iconCheck} Resolve Execution</a>` : ''}
                    ${canDelete ? `<a href="#" class="action-delete" onclick="deleteGroup('${group.id}', event)">${iconTrash} Delete Execution</a>` : ''}
                    <a href="#" class="action-export-err" onclick="downloadGroupLog('${group.id}', 'error', event)">${iconAlert} Export Errors</a>
                    <a href="#" class="action-export-full" onclick="downloadGroupLog('${group.id}', 'full', event)">${iconFile} Export Full Logs</a>
                    <a href="#" class="action-export-xml" onclick="downloadGroupLog('${group.id}', 'xml', event)">${iconCode} Generate JUnit XML</a>
                </div>
            </div>`;

        const groupAllSelected = group.incidents.length > 0 && group.incidents.every(inc => window.selectedIncidents.has(String(inc.id)));
        const groupChecked = groupAllSelected ? 'checked' : '';

        return `
        <div class="data-card pipeline-exec-card ${cardStateClass}">
            <div class="pipeline-exec-header">
                <div class="pipeline-exec-meta">
                    <input type="checkbox" id="cb-group-${group.id}" onclick="toggleGroupSelection('${group.id}', this.checked)" ${groupChecked} style="width: 16px; height: 16px; cursor: pointer; flex-shrink: 0; margin-top: 4px;">
                    <div>
                        <span class="pipeline-exec-label">Pipeline execution</span>
                        <span class="pipeline-exec-title">${group.project_name}</span>
                        <span class="pipeline-exec-submeta">${group.created_at} · ${group.incidents.length} alert(s)${group.has_real_run ? ` · run ${String(group.pipeline_run_id).slice(0, 20)}` : ''}</span>
                        ${renderDeployLink(group, userRole)}
                        ${executionHub.renderGroupExecFlagsHtml(group, canPatchFlags)}
                    </div>
                </div>
                <div class="pipeline-exec-toolbar">
                    ${resolvedBadge}
                    ${group.has_real_run ? `<button type="button" class="btn btn-primary btn-sm ur-open-report-btn" onclick="openReport('${group.id}', event)">View Full Report</button>` : ''}
                    ${actionDropdown}
                    <button type="button" class="btn btn-secondary btn-sm" onclick="toggleSubAlerts('${group.id}', event)">
                        ${group.incidents.length} Alert(s) <span id="toggle-icon-${group.id}" style="display: inline-block;">${iconChevron}</span>
                    </button>
                </div>
            </div>
            <div id="sub-alerts-${group.id}" class="pipeline-exec-body" style="display: none;">
                ${executionHub.renderMatrixSectionHtml(group)}
                ${subAlertsHTML}
            </div>
        </div>`;
    }).join('');

    listEl.innerHTML = htmlContent;
    window.updateBulkActionUI();

    openGroups.forEach(groupId => {
        const el = document.getElementById(`sub-alerts-${groupId}`);
        const icon = document.getElementById(`toggle-icon-${groupId}`);
        if (el) {
            el.style.display = 'block';
            if (icon) icon.style.transform = 'rotate(180deg)';
            executionHub.onExecGroupExpanded(groupId);
            hydrateOpenComments();
        }
    });
};

window.initDashboardScrollHelpers = function () {
    const main = document.querySelector('.main-content');
    const btn = document.getElementById('scroll-top-btn');
    if (!main || !btn || main.dataset.scrollBound) return;
    main.dataset.scrollBound = '1';
    main.addEventListener('scroll', () => {
        btn.classList.toggle('visible', main.scrollTop > 280);
    }, { passive: true });
    btn.addEventListener('click', () => main.scrollTo({ top: 0, behavior: 'smooth' }));
};

window.scrollDashboardToTop = function () {
    const main = document.querySelector('.main-content');
    if (main) main.scrollTo({ top: 0, behavior: 'smooth' });
};

window.connectWebSocket = function () {
    if (window.__incidentPollTimer) clearInterval(window.__incidentPollTimer);
    window.__incidentPollTimer = setInterval(() => {
        if (isApiOffline()) return;
        const dashboard = document.getElementById('view-dashboard');
        if (Date.now() < window.pausePollingUntil) return;
        if (dashboard && dashboard.classList.contains('active')) window.fetchIncidents();
    }, 5000);
}

// ==========================================
// AUTH & ROUTING
// ==========================================
window.performLogin = function () {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl = document.getElementById('login-error');
    if (!username || !password) {
        if (errEl) { errEl.textContent = 'Enter username and password.'; errEl.style.display = 'block'; }
        return notify("Enter username and password", "error");
    }
    if (errEl) errEl.style.display = 'none';

    const loginBtn = document.querySelector('#login-screen .btn-primary');
    if (loginBtn) { loginBtn.disabled = true; loginBtn.textContent = 'Signing in…'; }

    const controller = new AbortController();
    const loginTimeout = setTimeout(() => controller.abort(), 30000);

    fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }), signal: controller.signal })
        .then(async res => {
            let body = null;
            try { body = await res.json(); } catch (_) { /* plain text */ }
            if (res.ok) return body;
            const msg = (body && body.error) ? body.error
                : res.status === 401 ? 'Invalid username or password.'
                : res.status === 403 ? (body?.error || 'Account disabled.')
                : `Login failed (${res.status}).`;
            throw new Error(msg);
        })
        .then(data => {
            localStorage.setItem('sre-jwt', data.token);
            if (errEl) errEl.style.display = 'none';
            resetApiOfflineBanner();
            if (data.require_password_change) {
                notify('Sign-in OK. Set a new password below to enter the app.', 'info');
            }
            window.checkAuth();
        })
        .catch(err => {
            const isAbort = err?.name === 'AbortError';
            const isNetwork = err instanceof TypeError || isAbort || (err.message && /failed|network/i.test(err.message));
            const text = isAbort
                ? 'Login timed out. The server may be overloaded - wait and try again.'
                : isNetwork
                ? 'Cannot reach the server. Open http://localhost:9000 and start the backend (go run ./cmd/srecapsule).'
                : (err.message || 'Invalid username or password.');
            if (errEl) { errEl.textContent = text.toUpperCase(); errEl.style.display = 'block'; }
            notify(text, "error");
        })
        .finally(() => {
            clearTimeout(loginTimeout);
            if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = 'Sign in'; }
        });
}

window.probeLoginServer = function () {
    const hint = document.getElementById('login-server-hint');
    if (!hint) return;
    pingApiServer().then(ok => {
        if (ok) hint.style.display = 'none';
        else {
            hint.style.display = 'block';
            hint.textContent = 'Backend not reachable at this URL. Start with: docker compose up -d --build (or go run ./cmd/srecapsule).';
        }
    });
}

window.checkAuth = function () {
    const token = localStorage.getItem('sre-jwt');
    if (!token) {
        showLoginScreen();
        return;
    }
    const payload = parseJwt(token);
    if (!payload || !payload.role) {
        localStorage.removeItem('sre-jwt');
        showLoginScreen();
        notify('Invalid session. Please sign in again.', 'error');
        return;
    }

    if (payload.require_password_change) {
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('app-container').style.display = 'none';
        document.getElementById('force-password-screen').style.display = 'flex';
        return;
    }

    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('force-password-screen').style.display = 'none';
    document.getElementById('app-container').style.display = 'flex';

    pingApiServer().then(() => {
        const linkToken = secureLinkTokenFromPath(window.location.pathname || '');
        const linkMatch = linkToken ? [null, linkToken] : null;
        if (linkMatch) window.__openingSecureLink = true;
        window.applyPermissions();
        if (window.bootstrapDashboardRangeFromPreferences) window.bootstrapDashboardRangeFromPreferences();
        window.restoreDashboardTimeRange();
        if (window.loadUserPreferences) window.loadUserPreferences();

        if (payload.role === 'admin') window.loadUsers();

        if (linkMatch && window.openSecureLink) {
            window.openSecureLink(decodeURIComponent(linkMatch[1]));
        } else if (document.getElementById('view-dashboard').classList.contains('active')) {
            window.initDashboardTimeRange();
            window.loadDashboardFilters();
            window.pausePollingUntil = 0;
            if (window.loadAnalyticsLayoutFromPrefs) window.loadAnalyticsLayoutFromPrefs();
            window.fetchIncidents(true).then(() => window.syncDashboardKpis());
            if (window.startDashboardAutoRefresh) window.startDashboardAutoRefresh();
            window.initDashboardScrollHelpers();
        }
        if (document.getElementById('view-organizations').classList.contains('active') && canManageTeams(payload.role)) {
            window.loadOrganizations();
        }
        if (document.getElementById('view-management').classList.contains('active') && payload.role === 'admin') {
            if (window.renderUserTable) window.renderUserTable(iam.allUsers);
        }
        if (document.getElementById('view-settings').classList.contains('active') && window.loadConfig) {
            window.loadConfig();
        }
        if (document.getElementById('view-plugins').classList.contains('active') && hasMinRole(payload.role, 'lead')) {
            if (window.loadPlugins) window.loadPlugins();
        }
        if (document.getElementById('view-ingestion').classList.contains('active') && hasMinRole(payload.role, 'lead')) {
            if (window.loadGatewaysData) window.loadGatewaysData();
        }
        if (!linkMatch && window.publishSecureLink) {
            const active = document.querySelector('.view-section.active')?.id?.replace(/^view-/, '') || 'dashboard';
            window.publishSecureLink({ kind: 'view', view: active === 'about' ? 'about' : active, topic: active === 'about' ? (window.__aboutTopic || 'overview') : '' });
        }
        window.connectWebSocket();
    });
}

window.submitNewPassword = function () {
    const p1 = document.getElementById('force-new-pass').value;
    const p2 = document.getElementById('force-new-pass-confirm').value;
    if (!p1 || p1.length < 6) return notify("Password must be at least 6 characters", "error");
    if (p1 !== p2) return notify("Passwords do not match", "error");

    const payload = parseJwt(localStorage.getItem('sre-jwt'));
    const username = payload?.username || document.getElementById('login-username')?.value?.trim();
    if (!username) return notify("Session expired. Sign in again.", "error");

    fetchWithAuth('/api/users/change-password', { method: 'POST', body: JSON.stringify({ new_password: p1 }) })
        .then(res => parseApiJson(res))
        .then(async ({ ok }) => {
            if (!ok) {
                notify("Error updating password", "error");
                return;
            }
            localStorage.removeItem('sre-jwt');
            const loginRes = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password: p1 })
            });
            const loginBody = await loginRes.json().catch(() => ({}));
            if (!loginRes.ok) {
                notify(loginBody.error || 'Password saved. Sign in with your new password.', 'info');
                showLoginScreen();
                return;
            }
            localStorage.setItem('sre-jwt', loginBody.token);
            notify("Password secured. Welcome!", "success");
            document.getElementById('force-new-pass').value = '';
            document.getElementById('force-new-pass-confirm').value = '';
            window.checkAuth();
        }).catch(() => notify("Network error", "error"));
}


window.switchView = function (id, el) {
    if (id === 'rca' || id === 'ai' || id === 'ai-usage') id = 'healing';
    const payload = parseJwt(localStorage.getItem('sre-jwt'));
    if (payload?.role && !canAccessView(payload.role, id)) {
        notify(accessDeniedMessage(id), 'error');
        return;
    }

    document.querySelectorAll('.view-section').forEach(x => {
        x.classList.remove('active');
        x.style.removeProperty('display');
    });
    document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));

    const targetSection = document.getElementById('view-' + id);
    if (targetSection) {
        targetSection.classList.add('active');
        targetSection.style.removeProperty('display');
    }
    if (el) el.classList.add('active');

    if (id === 'dashboard') {
        window.restoreDashboardTimeRange();
        window.loadDashboardFilters();
        window.pausePollingUntil = 0;
        if (window.loadAnalyticsLayoutFromPrefs) window.loadAnalyticsLayoutFromPrefs();
        window.fetchIncidents(true).then(() => window.syncDashboardKpis());
        if (window.startDashboardAutoRefresh) window.startDashboardAutoRefresh();
        window.initDashboardScrollHelpers();
    } else if (typeof window.stopDashboardAutoRefresh === 'function') {
        window.stopDashboardAutoRefresh();
    }
    if (id === 'organizations' && payload && canManageTeams(payload.role)) {
        if (window.loadOrganizations) window.loadOrganizations();
    }
    if (id === 'management' && payload && payload.role === 'admin') if (window.renderUserTable) window.renderUserTable(iam.allUsers);
    if (id === 'plugins' && payload && canAccessPlugins(payload.role)) {
        if (window.loadPlugins) window.loadPlugins();
    }
    if (id === 'settings' && payload && canManageIAM(payload.role)) {
        if (window.loadConfig) window.loadConfig();
    }
    if (id === 'ingestion' && payload && canAccessView(payload.role, 'ingestion')) {
        if (window.loadGatewaysData) window.loadGatewaysData();
    }
    if (id === 'finops' && payload && canAccessFinOps(payload.role)) {
        if (window.loadFinOpsView) window.loadFinOpsView();
    }
    if ((id === 'healing' || id === 'rca') && payload && canAccessView(payload.role, 'healing')) {
        if (window.loadHealingView) window.loadHealingView();
    }
    if (id === 'ai-config' && payload && canAccessView(payload.role, 'ai-config')) {
        if (window.loadAIConfig) window.loadAIConfig();
    }
    if (id === 'dora' && payload && canAccessView(payload.role, 'dora')) {
        if (window.loadDORAView) window.loadDORAView();
    } else if (typeof window.destroyDORAChart === 'function') {
        window.destroyDORAChart();
    }
    if (id === 'suite' && payload && canAccessView(payload.role, 'suite')) {
        if (window.loadSuiteHealth) window.loadSuiteHealth();
    }
    if (id === 'activity' && payload && canAccessView(payload.role, 'activity')) {
        if (window.loadActivity) window.loadActivity();
    }
    if (id === 'unowned' && payload && canAccessView(payload.role, 'unowned')) {
        if (window.loadUnowned) window.loadUnowned();
    }
    if (id === 'about') {
        if (window.loadAboutView) window.loadAboutView();
    }
    if (id === 'workflow') {
        if (window.loadWorkflowPage) window.loadWorkflowPage();
    } else if (typeof window.closeWorkflowEditor === 'function') {
        window.closeWorkflowEditor();
    }
    if (id === 'profile' && window.loadProfileView) window.loadProfileView();

    if (!window.__openingSecureLink && id !== 'about' && window.publishSecureLink) {
        window.publishSecureLink({ kind: 'view', view: id === 'rca' ? 'healing' : id });
    }

    if (typeof window.applyI18n === 'function') window.applyI18n();
}

window.applyPermissions = function () {
    const payload = parseJwt(localStorage.getItem('sre-jwt'));
    if (!payload) return;
    applyRoleVisibility(payload.role);
    window.initSmartSearchFields();

    const activeSection = document.querySelector('.view-section.active');
    const activeId = activeSection?.id?.replace('view-', '');
    if (activeId && !canAccessView(payload.role, activeId)) {
        const fallback = defaultViewForRole(payload.role);
        const nav = document.querySelector(`.nav-item[onclick*="switchView('${fallback}'"]`);
        window.switchView(fallback, nav);
    } else if (isAdmin(payload.role)) {
        const onAdminView = ['organizations', 'management', 'settings', 'profile'].includes(activeId);
        if (!onAdminView) {
            window.switchView('organizations', document.querySelector('.nav-item.role-workspace'));
        }
    }

    const roleEl = document.getElementById('profile-role');
    if (roleEl) roleEl.textContent = roleLabel(payload.role);
}

window.initSmartSearchFields = function () {
    const incidentInput = document.getElementById('incident-search');
    const incidentList = document.getElementById('incident-search-ac');
    if (incidentInput && incidentList && !incidentInput.dataset.acBound) {
        incidentInput.dataset.acBound = '1';
        setupAutocomplete({
            input: incidentInput,
            list: incidentList,
            minChars: 1,
            getSuggestions: q => {
                const v = q.toLowerCase();
                const hints = new Map();
                (window.currentIncidents || []).forEach(inc => {
                    if (inc.name) hints.set(inc.name, { label: inc.name, sublabel: inc.project_name || '', value: inc.name });
                    if (inc.project_name) hints.set(inc.project_name, { label: inc.project_name, sublabel: 'Project', value: inc.project_name });
                });
                document.querySelectorAll('#project-filter option').forEach(opt => {
                    if (opt.value && opt.value !== 'all' && opt.text.toLowerCase().includes(v)) {
                        hints.set(opt.value, { label: opt.text, sublabel: 'Project', value: opt.value });
                    }
                });
                return [...hints.values()].filter(h => h.label.toLowerCase().includes(v)).slice(0, 12);
            },
            onSelect: item => { incidentInput.value = item.value; window.fetchIncidents(true); }
        });
    }
    if (window.initIamUserSearchAutocomplete) window.initIamUserSearchAutocomplete();
};

// ==========================================
// STARTUP
// ==========================================
window.addEventListener('unhandledrejection', (e) => {
    console.error('[SRE Capsule] unhandled promise rejection', e.reason);
});

window.onload = function () {
    initI18n();
    initTheme();
    initSidebar();
    initCommentUI();
    pingApiServer();
    window.checkAuth();
    if (!localStorage.getItem('sre-jwt') && window.probeLoginServer) window.probeLoginServer();
    if (window.checkSSOStatus) window.checkSSOStatus();
};