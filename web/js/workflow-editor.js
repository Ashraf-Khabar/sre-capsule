/**
 * Visual SRE Workflow Builder (Drawflow + canonical DAG JSON).
 */
import { fetchWithAuth, parseApiJson, parseJwt } from './api.js';
import { notify, showConfirmModal } from './ui.js';
import { canManageWorkflow, normalizeRole } from './roles.js?v=1.0.101-workflow-page';

let editor = null;
let currentProjectId = null;
let canEditWorkflow = false;
let workflowCatalog = [];
let canonicalWorkflow = null;

const NODE_TEMPLATES = {
    trigger: {
        html: `<div class="wf-node wf-trigger"><div class="wf-title">Trigger</div><div class="wf-desc">On CI alert ingested</div></div>`,
        inputs: 0,
        outputs: 1,
        data: { label: 'On CI alert', nodeType: 'trigger' }
    },
    condition: {
        html: `<div class="wf-node wf-condition">
            <div class="wf-node-bar"><div class="wf-title">Condition</div><button type="button" class="wf-node-edit">Edit</button></div>
            <div class="wf-branch-hint"><span class="true">●</span> top = true · <span class="false">●</span> bottom = false</div>
            <div class="wf-summary"></div>
        </div>`,
        inputs: 1,
        outputs: 2,
        data: { label: 'Condition', nodeType: 'condition', when: { op: 'text', match: 'prefix', value: '[FLAKY]', field: 'incident.name' } }
    },
    action: {
        html: `<div class="wf-node wf-action">
            <div class="wf-node-bar"><div class="wf-title">Action</div><button type="button" class="wf-node-edit">Edit</button></div>
            <div class="wf-summary">Choose a plugin</div>
        </div>`,
        inputs: 1,
        outputs: 1,
        data: { label: 'Action', nodeType: 'action', file_path: '', integration: '', config: {} }
    }
};

/** Drawflow typenode: false = HTML template (required for custom node HTML). */
const HTML_NODE = false;

function mountWorkflowEditor() {
    const slot = document.getElementById('workflow-page-slot');
    const modal = document.getElementById('workflow-editor-modal');
    if (slot && modal && modal.parentElement !== slot) slot.appendChild(modal);
}

let workflowGateways = [];

const CI_LABELS = {
    gitlab: 'GitLab CI',
    github: 'GitHub Actions',
    jenkins: 'Jenkins',
    azure: 'Azure Pipelines',
    circleci: 'CircleCI',
    bitbucket: 'Bitbucket Pipelines',
    teamcity: 'TeamCity',
    travis: 'Travis CI',
    buildkite: 'Buildkite',
    cloudbuild: 'Cloud Build',
    bamboo: 'Bamboo'
};

function workflowStatusKey(project) {
    if (project.workflow_enabled) return 'active';
    if (project.has_workflow) return 'draft';
    return 'legacy';
}

function workflowStatusBadge(project) {
    const key = workflowStatusKey(project);
    const label = key === 'active' ? 'Active' : key === 'draft' ? 'Draft' : 'Legacy';
    const title = key === 'active'
        ? 'This graph is live for the gateway'
        : key === 'draft'
            ? 'Saved, but legacy AUTO-RUN still runs'
            : 'No graph yet. Legacy AUTO-RUN still runs';
    return `<span class="wf-table-badge ${key}" title="${title}">${label}</span>`;
}

function renderWorkflowTable() {
    const tbody = document.getElementById('workflow-gateway-table');
    if (!tbody) return;
    const query = (document.getElementById('workflow-filter-search')?.value || '').trim().toLowerCase();
    const status = document.getElementById('workflow-filter-status')?.value || '';
    const rows = workflowGateways.filter((project) => {
        const name = String(project.name || project.id || '').toLowerCase();
        if (query && !name.includes(query)) return false;
        if (status && workflowStatusKey(project) !== status) return false;
        return true;
    });
    if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="table-empty">No gateways match these filters.</td></tr>';
        return;
    }
    tbody.innerHTML = rows.map((project) => {
        const id = escapeAttr(project.id);
        const name = escapeHtml(project.name || project.id);
        const ci = escapeHtml(CI_LABELS[project.ci_system] || project.ci_system || '');
        return `<tr>
            <td><strong>${name}</strong></td>
            <td>${ci}</td>
            <td>${workflowStatusBadge(project)}</td>
            <td class="data-table__actions">
                <button type="button" class="btn btn-secondary btn-sm btn-open-workflow-page" data-project-id="${id}" data-project-name="${name}">Open workflow</button>
            </td>
        </tr>`;
    }).join('');
}

function bindWorkflowTable() {
    const tbody = document.getElementById('workflow-gateway-table');
    const search = document.getElementById('workflow-filter-search');
    const status = document.getElementById('workflow-filter-status');
    if (search && !search.dataset.bound) {
        search.dataset.bound = '1';
        search.addEventListener('input', renderWorkflowTable);
    }
    if (status && !status.dataset.bound) {
        status.dataset.bound = '1';
        status.addEventListener('change', renderWorkflowTable);
    }
    if (tbody && !tbody.dataset.bound) {
        tbody.dataset.bound = '1';
        tbody.addEventListener('click', (event) => {
            const button = event.target.closest('.btn-open-workflow-page');
            if (!button) return;
            openWorkflowFromList(button.dataset.projectId, button.dataset.projectName);
        });
    }
}

function showWorkflowEditorHost() {
    const list = document.getElementById('workflow-list-panel');
    const host = document.getElementById('workflow-editor-host');
    if (list) list.hidden = true;
    if (host) host.hidden = false;
}

export function showWorkflowList() {
    closeWorkflowEditor();
    const list = document.getElementById('workflow-list-panel');
    const host = document.getElementById('workflow-editor-host');
    if (list) list.hidden = false;
    if (host) host.hidden = true;
    renderWorkflowTable();
}

function openWorkflowFromList(projectId, projectName) {
    if (!projectId) return;
    showWorkflowEditorHost();
    openWorkflowEditor(projectId, projectName);
}

export async function loadWorkflowPage() {
    mountWorkflowEditor();
    bindWorkflowTable();
    const pending = String(window.__pendingWorkflowGateway || '');
    window.__pendingWorkflowGateway = '';
    try {
        const res = await fetchWithAuth('/api/my-projects');
        const { ok, data } = await parseApiJson(res);
        workflowGateways = ok && Array.isArray(data) ? data : [];
    } catch (err) {
        console.error('[workflow] gateway list failed', err);
        notify('Could not load CI/CD gateways.', 'error');
        workflowGateways = [];
    }
    renderWorkflowTable();
    if (pending && editor && String(currentProjectId) === pending) {
        showWorkflowEditorHost();
        return;
    }
    const pendingProject = workflowGateways.find((project) => String(project.id) === pending);
    if (pendingProject) {
        openWorkflowFromList(pendingProject.id, pendingProject.name || pendingProject.id);
        return;
    }
    showWorkflowList();
}

export function toggleWorkflowTester() {
    const view = document.getElementById('view-workflow');
    if (!view) return;
    view.classList.toggle('workflow-tester-collapsed');
    const collapsed = view.classList.contains('workflow-tester-collapsed');
    const button = document.getElementById('workflow-tester-toggle');
    if (button) button.textContent = collapsed ? 'Show tester' : 'Hide tester';
    const panel = document.getElementById('workflow-help-panel');
    if (panel) panel.classList.toggle('open', !collapsed);
    refreshDrawflowViewport();
}

export function openWorkflowEditor(projectId, projectName) {
    if (!projectId) {
        notify('Invalid project id.', 'error');
        return;
    }
    mountWorkflowEditor();
    currentProjectId = projectId;
    const modal = document.getElementById('workflow-editor-modal');
    if (!modal) {
        notify('Workflow editor UI is missing. Refresh the page.', 'error');
        return;
    }
    const titleEl = document.getElementById('workflow-editor-title');
    if (titleEl) {
        titleEl.textContent = `Visual Workflow - ${projectName || projectId}`;
    }
    const empty = document.getElementById('workflow-page-empty');
    if (empty) empty.hidden = true;
    modal.style.display = 'flex';
    document.body.classList.remove('workflow-modal-open');
    bindWorkflowToolbar();
    bindWorkflowModalKeys();
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            void loadWorkflow(projectId).catch((err) => {
                console.error('[workflow] load failed', err);
                notify('Failed to open workflow editor.', 'error');
            });
        });
    });
}

function bindWorkflowToolbar() {
    const toggle = document.getElementById('workflow-enabled-toggle');
    if (toggle && !toggle.dataset.bound) {
        toggle.dataset.bound = '1';
        toggle.addEventListener('change', () => updateWorkflowStatusPill());
    }
}

export function closeWorkflowEditor() {
    const modal = document.getElementById('workflow-editor-modal');
    if (modal) modal.style.display = 'none';
    document.body.classList.remove('workflow-modal-open');
    destroyDrawflowEditor();
    currentProjectId = null;
}

let workflowModalKeysBound = false;

function bindWorkflowModalKeys() {
    if (workflowModalKeysBound) return;
    workflowModalKeysBound = true;
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isNodeModalOpen()) {
            e.preventDefault();
            closeNodeEditor();
            return;
        }
        const modal = document.getElementById('workflow-editor-modal');
        if (!modal || modal.style.display === 'none') return;
        if (e.key === 'Escape' && modal.closest('#workflow-page-slot')) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            closeWorkflowEditor();
        }
    });
}
function destroyDrawflowEditor() {
    const container = document.getElementById('drawflow');
    if (container) {
        container.innerHTML = '';
    }
    editor = null;
}

function initDrawflow() {
    if (typeof Drawflow === 'undefined') {
        notify('Drawflow library not loaded. Check your network or refresh.', 'error');
        return null;
    }
    const container = document.getElementById('drawflow');
    if (!container) return null;

    destroyDrawflowEditor();
    container.innerHTML = '';

    editor = new Drawflow(container);
    editor.reroute = true;
    editor.reroute_fix_curvature = true;
    editor.curvature = 0.45;
    editor.zoom_max = 1.6;
    editor.zoom_min = 0.15;
    editor.editor_mode = canEditWorkflow ? 'edit' : 'fixed';
    editor.start();
    bindDrawflowEvents();

    const canvas = container.querySelector('.drawflow');
    if (canvas) {
        canvas.style.width = '100%';
        canvas.style.height = '100%';
    }
    refreshDrawflowViewport();
    return editor;
}

function bindDrawflowEvents() {
    if (!editor || editor._sreCapsuleBound) return;
    editor._sreCapsuleBound = true;
    const refresh = () => {
        populateActionSelects();
        bindNodeControls();
        scheduleSyncControlsFromNodeData();
        updateCanvasEmptyState();
        requestAnimationFrame(() => {
            refreshDrawflowViewport();
            syncCanvasExtent();
        });
    };
    if (typeof editor.on === 'function') {
        editor.on('nodeCreated', refresh);
        editor.on('nodeRemoved', () => {
            updateCanvasEmptyState();
            syncCanvasExtent();
        });
        editor.on('nodeMoved', () => syncCanvasExtent());
        editor.on('connectionCreated', () => updateCanvasEmptyState());
        editor.on('connectionRemoved', () => updateCanvasEmptyState());
    }
}
function refreshDrawflowViewport() {
    if (!editor) return;
    requestAnimationFrame(() => {
        try {
            if (typeof editor.zoom_refresh === 'function') {
                editor.zoom_refresh();
            }
            if (typeof editor.zoom_reset === 'function') {
                editor.zoom_reset();
            }
        } catch (_) { /* ignore */ }
        updateCanvasEmptyState();
    });
}

function drawflowNodeCount() {
    if (!editor?.drawflow?.drawflow?.Home?.data) return 0;
    return Object.keys(editor.drawflow.drawflow.Home.data).length;
}

function updateCanvasEmptyState() {
    const el = document.getElementById('workflow-canvas-empty');
    if (!el) return;
    el.classList.toggle('visible', drawflowNodeCount() === 0);
}

/** Grow the canvas only when a node sits outside the visible frame. */
function syncCanvasExtent() {
    const host = document.getElementById('drawflow');
    const canvas = host?.querySelector('.drawflow');
    if (!host || !canvas) return;
    const viewW = host.clientWidth || 0;
    const viewH = host.clientHeight || 0;
    if (viewW < 80 || viewH < 80) return;
    if (!host._sreCanvasSize && typeof ResizeObserver !== 'undefined') {
        host._sreCanvasSize = new ResizeObserver(() => syncCanvasExtent());
        host._sreCanvasSize.observe(host);
    }
    let maxX = 0;
    let maxY = 0;
    canvas.querySelectorAll('.drawflow-node').forEach((node) => {
        maxX = Math.max(maxX, node.offsetLeft + node.offsetWidth + 36);
        maxY = Math.max(maxY, node.offsetTop + node.offsetHeight + 36);
    });
    if (maxX <= viewW + 1 && maxY <= viewH + 1) {
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        return;
    }
    canvas.style.width = Math.max(viewW, Math.ceil(maxX)) + 'px';
    canvas.style.height = Math.max(viewH, Math.ceil(maxY)) + 'px';
}

function addDrawflowNode(type, posX, posY, data, html) {
    const tpl = NODE_TEMPLATES[type];
    if (!editor || !tpl) return null;
    const nodeData = { ...tpl.data, ...data };
    return editor.addNode(
        type,
        tpl.inputs,
        tpl.outputs,
        posX,
        posY,
        type,
        nodeData,
        html || tpl.html,
        HTML_NODE
    );
}

async function loadWorkflow(projectId) {
    const res = await fetchWithAuth(`/api/projects/${encodeURIComponent(projectId)}/workflow`);
    const { ok, data } = await parseApiJson(res);
    if (!ok) {
        notify(data?.error || 'Failed to load workflow.', 'error');
        return;
    }
    canEditWorkflow = !!data.can_edit;
    workflowCatalog = Array.isArray(data.catalog) ? data.catalog : [];
    canonicalWorkflow = data.workflow || null;

    applyEditorRBAC();
    if (!initDrawflow()) return;

    populateActionSelects();
    syncEnableToggle(data.workflow, data.workflow_enabled, data.has_workflow);
    importWorkflowToCanvas(data.workflow, data.workflow?.ui);
    refreshDrawflowViewport();
    updateWorkflowStatusPill();
}

function syncEnableToggle(workflow, workflowEnabled, hasWorkflow) {
    const toggle = document.getElementById('workflow-enabled-toggle');
    if (!toggle) return;
    if (workflow && typeof workflow.enabled === 'boolean') {
        toggle.checked = workflow.enabled;
    } else if (hasWorkflow) {
        toggle.checked = !!workflowEnabled;
    } else {
        toggle.checked = false;
    }
}

export function isWorkflowEnabled() {
    const toggle = document.getElementById('workflow-enabled-toggle');
    return toggle ? toggle.checked : false;
}

export function updateWorkflowStatusPill() {
    const pill = document.getElementById('workflow-status-pill');
    if (!pill) return;
    const enabled = isWorkflowEnabled();
    const hasGraph = drawflowNodeCount() > 0;
    const hasStored = canonicalWorkflow && (canonicalWorkflow.entry || Object.keys(canonicalWorkflow.nodes || {}).length > 0);

    pill.classList.remove('state-active', 'state-draft', 'state-legacy');
    if (enabled && (hasGraph || hasStored)) {
        pill.textContent = 'DAG active';
        pill.classList.add('state-active');
        pill.title = 'Visual workflow drives remediation on alert ingest';
    } else if (hasGraph || hasStored) {
        pill.textContent = 'Draft';
        pill.classList.add('state-draft');
        pill.title = 'Workflow saved but disabled - legacy AUTO-RUN still applies';
    } else {
        pill.textContent = 'Legacy';
        pill.classList.add('state-legacy');
        pill.title = 'No visual workflow - legacy AUTO-RUN and trigger_on rules';
    }
}

function applyEditorRBAC() {
    const role = normalizeRole(parseJwt(localStorage.getItem('sre-jwt'))?.role);
    canEditWorkflow = canManageWorkflow(role) && canEditWorkflow;
    document.querySelectorAll('.wf-edit-only').forEach(el => {
        el.style.display = canEditWorkflow ? '' : 'none';
    });
    const badge = document.getElementById('workflow-readonly-badge');
    if (badge) badge.style.display = canEditWorkflow ? 'none' : 'block';
    const toggle = document.getElementById('workflow-enabled-toggle');
    if (toggle) toggle.disabled = !canEditWorkflow;
    if (editor) {
        editor.editor_mode = canEditWorkflow ? 'edit' : 'fixed';
    }
}

function setSelectValue(sel, value) {
    if (!sel || value == null || value === '') return;
    const path = String(value);
    if (![...sel.options].some(o => o.value === path)) {
        const plug = workflowCatalog.find(p => p.file_path === path);
        const opt = document.createElement('option');
        opt.value = path;
        opt.textContent = plug?.name || path;
        sel.appendChild(opt);
    }
    sel.value = path;
}

function populateActionSelects() {
    refreshNodeCards();
    syncCanvasExtent();
}

function importWorkflowToCanvas(workflow, ui) {
    if (!editor) return;
    editor.clear();

    let imported = false;
    if (ui && ui.drawflow && drawflowImportHasNodes(ui)) {
        try {
            editor.import(ui);
            imported = drawflowNodeCount() > 0;
        } catch (e) {
            console.warn('[workflow] drawflow import failed', e);
        }
    }

    if (imported) {
        refreshImportedNodeHtml();
        populateActionSelects();
        bindNodeControls();
        scheduleSyncControlsFromNodeData();
        updateCanvasEmptyState();
        return;
    }

    if (workflow?.nodes && Object.keys(workflow.nodes).length > 0) {
        buildCanvasFromCanonical(workflow);
        return;
    }

    addDefaultStarterGraph();
}

function refreshImportedNodeHtml() {
    document.querySelectorAll('.drawflow-node.condition, .drawflow-node.action').forEach((nodeEl) => {
        const content = nodeEl.querySelector('.drawflow_content_node');
        if (!content) return;
        if (nodeEl.classList.contains('condition')) content.innerHTML = NODE_TEMPLATES.condition.html;
        if (nodeEl.classList.contains('action')) content.innerHTML = NODE_TEMPLATES.action.html;
    });
}

function drawflowImportHasNodes(ui) {
    const data = ui?.drawflow?.Home?.data;
    return data && Object.keys(data).length > 0;
}

function layoutWorkflowPositions(workflow, entryId) {
    const positions = {};
    const queue = [{ id: entryId, depth: 0 }];
    const seen = new Set();
    while (queue.length) {
        const { id, depth } = queue.shift();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        positions[id] = { x: 80 + depth * 260, y: 120 };
        (workflow.edges || []).forEach((e) => {
            if (e.from !== id) return;
            const child = e.to;
            if (child && workflow.nodes[child]) {
                queue.push({ id: child, depth: depth + 1 });
            }
        });
    }
    let orphanY = 320;
    Object.keys(workflow.nodes || {}).forEach((cid) => {
        if (!positions[cid]) {
            positions[cid] = { x: 80, y: orphanY };
            orphanY += 120;
        }
    });
    return positions;
}

function buildCanvasFromCanonical(workflow) {
    const entry = workflow.entry;
    if (!entry || !workflow.nodes?.[entry]) {
        addDefaultStarterGraph();
        return;
    }
    const idMap = {};
    const positions = layoutWorkflowPositions(workflow, entry);
    for (const [cid, node] of Object.entries(workflow.nodes)) {
        const tpl = NODE_TEMPLATES[node.type];
        if (!tpl) continue;
        const pos = positions[cid] || { x: 80, y: 80 };
        const data = { ...tpl.data, label: node.label || tpl.data.label, nodeType: node.type };
        if (node.type === 'condition' && node.when) data.when = node.when;
        if (node.type === 'action') {
            data.file_path = node.file_path || '';
            data.integration = node.integration || '';
            data.config = node.config || {};
        }
        const numId = addDrawflowNode(node.type, pos.x, pos.y, data, tpl.html);
        if (numId != null) idMap[cid] = numId;
    }
    (workflow.edges || []).forEach((e) => {
        const from = idMap[e.from];
        const to = idMap[e.to];
        if (!from || !to) return;
        let outPort = 'output_1';
        if (e.when === 'false') outPort = 'output_2';
        try {
            editor.addConnection(from, to, outPort, 'input_1');
        } catch (err) {
            console.warn('[workflow] connection failed', e, err);
        }
    });
    bindNodeControls();
    scheduleSyncControlsFromNodeData();
    updateCanvasEmptyState();
    refreshDrawflowViewport();
}

function addDefaultStarterGraph() {
    if (!editor) return;
    const t = addDrawflowNode('trigger', 120, 120, {}, null);
    const c = addDrawflowNode('condition', 380, 120, {}, null);
    if (t && c) {
        editor.addConnection(t, c, 'output_1', 'input_1');
    }
    if (canEditWorkflow && workflowCatalog.length > 0) {
        const plugin = workflowCatalog[0];
        const a = addDrawflowNode('action', 640, 60, {
            file_path: plugin.file_path,
            integration: plugin.integration,
            label: plugin.name || 'Action'
        }, null);
        if (c && a) editor.addConnection(c, a, 'output_1', 'input_1');
    }
    bindNodeControls();
    scheduleSyncControlsFromNodeData();
    updateCanvasEmptyState();
}

const CONDITION_FIELD_HINTS = {
    name: '',
    tag: 'Only the tags FLAKY and PERF. RobotFramework is not a tag.',
    status: 'The incident status, such as Critical or resolved.',
    error: 'The failure text, not the test title.',
    console: 'The console log text.'
};

const CONDITION_MATCH_OPTIONS = {
    name: [
        { value: 'prefix', label: 'Starts with' },
        { value: 'contains', label: 'Contains' },
        { value: 'not_contains', label: 'Does not contain' },
        { value: 'equals', label: 'Equals' }
    ],
    tag: [
        { value: 'equals', label: 'Equals' },
        { value: 'in', label: 'In list (comma-separated)' }
    ],
    status: [
        { value: 'equals', label: 'Equals' },
        { value: 'in', label: 'In list (comma-separated)' }
    ],
    error: [
        { value: 'contains', label: 'Contains' },
        { value: 'not_contains', label: 'Does not contain' },
        { value: 'prefix', label: 'Starts with' },
        { value: 'equals', label: 'Equals' }
    ],
    console: [
        { value: 'contains', label: 'Contains' },
        { value: 'not_contains', label: 'Does not contain' },
        { value: 'prefix', label: 'Starts with' },
        { value: 'equals', label: 'Equals' }
    ]
};

function getDrawflowNodeEl(nodeId) {
    return document.getElementById(`node-${nodeId}`);
}

function scheduleSyncControlsFromNodeData() {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => syncControlsFromNodeData());
    });
}

function syncControlsFromNodeData() {
    if (!editor?.drawflow?.drawflow?.Home?.data) return;
    Object.values(editor.drawflow.drawflow.Home.data).forEach((node) => {
        syncOneNodeControls(node.id, node.data || {}, 0);
    });
}

function syncOneNodeControls(nodeId, data, attempt) {
    const el = getDrawflowNodeEl(nodeId);
    if (!el) {
        if (attempt < 10) {
            requestAnimationFrame(() => syncOneNodeControls(nodeId, data, attempt + 1));
        }
        return;
    }
    paintNodeCard(nodeId, data);
}

function conditionUiField(when) {
    if (!when) return 'tag';
    const op = (when.op || '').toLowerCase();
    const field = (when.field || '').toLowerCase();
    if (op === 'status') return 'status';
    if (op === 'tag') {
        const match = String(when.match || '').toLowerCase();
        const value = String(when.value || '').trim();
        if (match === 'prefix' || match === 'contains' || match === 'not_contains' || match === 'not-contains') return 'name';
        if (value.includes('[') || (value && !/^(flaky|perf)$/i.test(value))) return 'name';
        return 'tag';
    }
    if (op === 'text') {
        if (field.includes('console')) return 'console';
        if (field.includes('error') || field === 'err' || field.includes('message')) return 'error';
        return 'name';
    }
    return 'name';
}

function populateMatchOptions(matchSel, uiField, selectedMatch) {
    if (!matchSel) return;
    const opts = CONDITION_MATCH_OPTIONS[uiField] || CONDITION_MATCH_OPTIONS.tag;
    matchSel.innerHTML = opts.map(o =>
        `<option value="${escapeAttr(o.value)}">${escapeHtml(o.label)}</option>`
    ).join('');
    const match = selectedMatch || opts[0]?.value || 'prefix';
    if ([...matchSel.options].some(o => o.value === match)) {
        matchSel.value = match;
    } else {
        matchSel.value = opts[0]?.value || '';
    }
}

function applyConditionToControls(nodeEl, when) {
    const fieldSel = nodeEl.querySelector('.wf-cond-field');
    const matchSel = nodeEl.querySelector('.wf-cond-match');
    const valueInp = nodeEl.querySelector('.wf-cond-value');
    if (!fieldSel || !matchSel || !valueInp) return;

    const uiField = conditionUiField(when);
    fieldSel.value = uiField;
    populateMatchOptions(matchSel, uiField, when?.match);
    valueInp.value = when?.value != null ? String(when.value) : '';
    if (!valueInp.value && uiField === 'tag') valueInp.value = 'FLAKY';
    setConditionHint(nodeEl, uiField);
}

function setConditionHint(nodeEl, uiField) {
    const hint = nodeEl?.querySelector('.wf-cond-hint');
    if (!hint) return;
    const text = CONDITION_FIELD_HINTS[uiField] || '';
    hint.textContent = text;
    hint.hidden = !text;
}

function buildConditionExpr(uiField, match, value) {
    const v = String(value ?? '').trim();
    switch (uiField) {
        case 'status':
            return { op: 'status', match: match || 'equals', value: v || 'Critical' };
        case 'error':
            return { op: 'text', match: match || 'contains', field: 'incident.error', value: v };
        case 'console':
            return { op: 'text', match: match || 'contains', field: 'incident.console', value: v };
        case 'name':
            return { op: 'text', match: match || 'contains', field: 'incident.name', value: v };
        case 'tag':
            return { op: 'tag', match: match || 'equals', field: 'incident.name', value: v || 'FLAKY' };
        default:
            return { op: 'text', match: match || 'contains', field: 'incident.name', value: v };
    }
}

let nodeEditBound = false;
let editingNodeId = null;

function bindNodeControls() {
    const container = document.getElementById('drawflow');
    if (!container || nodeEditBound) return;
    nodeEditBound = true;
    container.addEventListener('mousedown', (e) => {
        if (e.target.closest('.wf-node-edit')) e.stopPropagation();
    }, true);
    container.addEventListener('click', (e) => {
        const btn = e.target.closest('.wf-node-edit');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        openNodeEditor(btn.closest('.drawflow-node'));
    });
    const modal = document.getElementById('wf-node-modal');
    modal?.querySelectorAll('[data-wf-node-close]').forEach((btn) => {
        btn.addEventListener('click', closeNodeEditor);
    });
    modal?.querySelector('[data-wf-node-apply]')?.addEventListener('click', applyNodeEditor);
    document.getElementById('wf-node-modal-backdrop')?.addEventListener('click', closeNodeEditor);
}

function displayPluginName(name) {
    return String(name || '').replace(/\u2014/g, '-');
}

function matchLabel(uiField, match) {
    const opts = CONDITION_MATCH_OPTIONS[uiField] || [];
    return opts.find(o => o.value === match)?.label || match || '';
}

function conditionSummary(when) {
    const uiField = conditionUiField(when);
    const names = {
        name: 'Incident name',
        tag: 'Tag',
        status: 'Status',
        error: 'Error message',
        console: 'Console logs'
    };
    const value = String(when?.value || '').trim();
    const parts = [names[uiField] || 'Condition', matchLabel(uiField, when?.match)];
    if (value) parts.push(value);
    return parts.filter(Boolean).join(' · ');
}

function actionSummary(data) {
    const plugin = workflowCatalog.find(p => p.file_path === data?.file_path);
    const name = displayPluginName(plugin?.name || data?.label || 'Choose a plugin');
    const cfg = data?.config || {};
    const subject = cfg.SMTP_SUBJECT || cfg.SENDGRID_SUBJECT || cfg.SLACK_TITLE || cfg.JIRA_SUMMARY || cfg.TEAMS_TITLE || '';
    const line = String(subject).trim();
    return line ? `${name} - ${line}` : name;
}

function paintNodeCard(nodeId, data) {
    const el = getDrawflowNodeEl(nodeId);
    if (!el) return;
    const summary = el.querySelector('.wf-summary');
    const edit = el.querySelector('.wf-node-edit');
    if (edit) edit.textContent = canEditWorkflow ? 'Edit' : 'View';
    if (!summary) return;
    if (data?.nodeType === 'condition' || el.classList.contains('condition')) {
        summary.textContent = conditionSummary(data?.when || NODE_TEMPLATES.condition.data.when);
    }
    if (data?.nodeType === 'action' || el.classList.contains('action')) {
        summary.textContent = actionSummary(data || {});
    }
}

function refreshNodeCards() {
    if (!editor?.drawflow?.drawflow?.Home?.data) return;
    Object.values(editor.drawflow.drawflow.Home.data).forEach((node) => {
        paintNodeCard(node.id, node.data || {});
    });
}

function isNodeModalOpen() {
    const modal = document.getElementById('wf-node-modal');
    return !!modal && !modal.hidden;
}

function closeNodeEditor() {
    const modal = document.getElementById('wf-node-modal');
    if (modal) modal.hidden = true;
    editingNodeId = null;
}

function isMailPlugin(plugin) {
    const id = String(plugin?.integration || '').toLowerCase();
    return id === 'smtp' || id === 'sendgrid';
}

function mailKeys(plugin) {
    if (String(plugin?.integration || '').toLowerCase() === 'sendgrid') {
        return { subject: 'SENDGRID_SUBJECT', body: 'SENDGRID_BODY' };
    }
    return { subject: 'SMTP_SUBJECT', body: 'SMTP_BODY' };
}

const MAIL_TAGS = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'DIV', 'SPAN', 'FONT', 'CODE', 'PRE']);
const MAIL_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#e7eef6'];
const MAIL_EMOJIS = ['😀', '😁', '😂', '🙂', '😉', '😊', '😍', '🤔', '👍', '👎', '👏', '🙏', '👀', '💡', '🔥', '✨', '✅', '❌', '⚠️', '🐛', '🚀', '📌', '⏳', '🎉'];
const MAIL_SYMBOLS = ['•', '●', '○', '■', '✓', '✗', '★', '☆', '⚠', '➜', '→', '#', '@', '[ ]', '{ }', '</>'];
const MAIL_SIZES = ['12', '14', '16', '18', '20', '24', '28'];

function mailColor(node) {
    const attr = node.getAttribute?.('color') || '';
    if (/^#[0-9a-fA-F]{6}$/.test(attr)) return attr.toLowerCase();
    const style = node.getAttribute?.('style') || '';
    const hex = style.match(/color\s*:\s*(#[0-9a-fA-F]{6})/i);
    if (hex) return hex[1].toLowerCase();
    const rgb = style.match(/color\s*:\s*rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
    if (!rgb) return '';
    const parts = [rgb[1], rgb[2], rgb[3]].map((n) => {
        const v = Math.max(0, Math.min(255, Number(n)));
        return v.toString(16).padStart(2, '0');
    });
    return `#${parts.join('')}`;
}

function mailSize(node) {
    const style = node.getAttribute?.('style') || '';
    const match = style.match(/font-size\s*:\s*(12|14|16|18|20|24|28)px/i);
    return match ? `${match[1]}px` : '';
}

function sanitizeMailHtml(html) {
    const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
    const root = doc.body.firstElementChild;
    if (!root) return '';
    const clean = (node) => {
        const out = [];
        node.childNodes.forEach((child) => {
            if (child.nodeType === Node.TEXT_NODE) {
                out.push(document.createTextNode(child.textContent));
                return;
            }
            if (child.nodeType !== Node.ELEMENT_NODE) return;
            if (!MAIL_TAGS.has(child.tagName)) {
                out.push(...clean(child));
                return;
            }
            const el = document.createElement(child.tagName.toLowerCase());
            if (child.tagName === 'FONT' || child.tagName === 'SPAN') {
                const bits = [];
                const color = mailColor(child);
                const size = mailSize(child);
                if (color) {
                    bits.push(`color:${color}`);
                    el.setAttribute('color', color);
                }
                if (size) bits.push(`font-size:${size}`);
                if (bits.length) el.setAttribute('style', bits.join(';'));
            }
            clean(child).forEach((part) => el.appendChild(part));
            out.push(el);
        });
        return out;
    };
    const holder = document.createElement('div');
    clean(root).forEach((part) => holder.appendChild(part));
    return holder.innerHTML;
}

function fillMailBody(el, value) {
    const raw = String(value || '');
    if (raw.includes('<')) el.innerHTML = sanitizeMailHtml(raw);
    else el.textContent = raw;
}

let mailPopBound = false;

function closeMailPops(root) {
    (root || document).querySelectorAll('.wf-mail-pop').forEach((pop) => {
        pop.hidden = true;
    });
    (root || document).querySelectorAll('.wf-mail-toolbar [data-pop]').forEach((btn) => {
        btn.setAttribute('aria-expanded', 'false');
    });
}

function toggleMailPop(root, btn) {
    const pop = btn.parentElement?.querySelector('.wf-mail-pop');
    const opening = !!pop?.hidden;
    closeMailPops(root);
    if (!opening || !pop) return;
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
}

function focusMailBody(body) {
    body?.focus();
}

function insertMailText(body, text) {
    if (!text) return;
    focusMailBody(body);
    document.execCommand('insertText', false, text);
}

function applyMailCommand(body, cmd) {
    focusMailBody(body);
    if (cmd === 'bold') document.execCommand('bold');
    if (cmd === 'italic') document.execCommand('italic');
    if (cmd === 'underline') document.execCommand('underline');
    if (cmd === 'ul') document.execCommand('insertUnorderedList');
    if (cmd === 'ol') document.execCommand('insertOrderedList');
    if (cmd === 'code') {
        const text = window.getSelection()?.toString() || 'code';
        document.execCommand('insertHTML', false, `<code>${escapeHtml(text)}</code>`);
    }
    if (cmd === 'pre') {
        const text = window.getSelection()?.toString() || 'code';
        document.execCommand('insertHTML', false, `<pre><code>${escapeHtml(text)}</code></pre>`);
    }
}

function applyMailColor(body, color) {
    focusMailBody(body);
    document.execCommand('styleWithCSS', false, false);
    if (color === 'default') {
        document.execCommand('foreColor', false, '#e7eef6');
        body?.querySelectorAll('font, span').forEach((node) => {
            if (mailColor(node) === '#e7eef6') {
                const parent = node.parentNode;
                if (!parent) return;
                while (node.firstChild) parent.insertBefore(node.firstChild, node);
                parent.removeChild(node);
            }
        });
        return;
    }
    if (/^#[0-9a-fA-F]{6}$/.test(color || '')) document.execCommand('foreColor', false, color);
}

function unwrapMailNode(node) {
    const parent = node.parentNode;
    if (!parent) return;
    while (node.firstChild) parent.insertBefore(node.firstChild, node);
    parent.removeChild(node);
}

function applyMailSize(body, size) {
    focusMailBody(body);
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !body) return;
    const range = sel.getRangeAt(0);
    if (size === 'default') {
        body.querySelectorAll('span, font').forEach((node) => {
            let hit = false;
            try { hit = range.intersectsNode(node); } catch (_) { hit = false; }
            if (!hit) return;
            node.style.fontSize = '';
            if (!node.getAttribute('style')?.trim() && !node.getAttribute('color')) unwrapMailNode(node);
        });
        return;
    }
    if (!MAIL_SIZES.includes(String(size))) return;
    const text = range.toString();
    if (!text) {
        document.execCommand('insertHTML', false, `<span style="font-size:${size}px">&#8203;</span>`);
        return;
    }
    document.execCommand('insertHTML', false, `<span style="font-size:${size}px">${escapeHtml(text)}</span>`);
}

function bindMailToolbar(root) {
    const body = root.querySelector('.wf-mail-body');
    const toolbar = root.querySelector('.wf-mail-toolbar');
    if (!mailPopBound) {
        mailPopBound = true;
        document.addEventListener('click', (event) => {
            if (event.target.closest('.wf-mail-toolbar')) return;
            closeMailPops(document);
        });
    }
    toolbar?.addEventListener('mousedown', (event) => {
        if (event.target.closest('button')) event.preventDefault();
    });
    toolbar?.addEventListener('click', (event) => {
        const swatch = event.target.closest('[data-color]');
        if (swatch) {
            applyMailColor(body, swatch.dataset.color);
            closeMailPops(root);
            return;
        }
        const sizeBtn = event.target.closest('[data-size]');
        if (sizeBtn) {
            applyMailSize(body, sizeBtn.dataset.size);
            closeMailPops(root);
            return;
        }
        const emoji = event.target.closest('[data-emoji]');
        if (emoji) {
            insertMailText(body, emoji.dataset.emoji);
            closeMailPops(root);
            return;
        }
        const symbol = event.target.closest('[data-symbol]');
        if (symbol) {
            insertMailText(body, symbol.dataset.symbol);
            closeMailPops(root);
            return;
        }
        const popBtn = event.target.closest('[data-pop]');
        if (popBtn) {
            event.stopPropagation();
            toggleMailPop(root, popBtn);
            return;
        }
        const token = event.target.closest('[data-token]');
        if (token) {
            closeMailPops(root);
            insertMailText(body, token.dataset.token);
            return;
        }
        const btn = event.target.closest('[data-cmd]');
        if (!btn) return;
        closeMailPops(root);
        applyMailCommand(body, btn.dataset.cmd);
    });
    if (!canEditWorkflow && body) body.setAttribute('contenteditable', 'false');
}

function mailPopButtons(items, attr) {
    return items.map((item) => {
        const value = Array.isArray(item) ? item[0] : item;
        const label = Array.isArray(item) ? item[1] : item;
        return `<button type="button" ${attr}="${escapeAttr(value)}" title="${escapeAttr(label)}">${escapeHtml(label)}</button>`;
    }).join('');
}

function mailToolbarHTML() {
    const colors = ['<button type="button" class="wf-mail-swatch wf-mail-swatch--default" data-color="default" title="Default">A</button>']
        .concat(MAIL_COLORS.filter((c) => c !== '#e7eef6').map((c) =>
            `<button type="button" class="wf-mail-swatch" data-color="${c}" style="background:${c}" title="${c}"></button>`
        )).join('');
    return '<div class="wf-mail-toolbar" role="toolbar" aria-label="Message formatting">'
        + '<button type="button" data-cmd="bold" title="Bold"><b>B</b></button>'
        + '<button type="button" data-cmd="italic" title="Italic"><i>I</i></button>'
        + '<button type="button" data-cmd="underline" title="Underline"><u>U</u></button>'
        + '<span class="wf-mail-popwrap"><button type="button" data-pop="color" title="Text color" aria-expanded="false"><span class="wf-mail-ink">A</span></button>'
        + `<span class="wf-mail-pop wf-mail-colors" hidden>${colors}</span></span>`
        + '<span class="wf-mail-popwrap"><button type="button" data-pop="size" title="Font size" aria-expanded="false">Aa</button>'
        + `<span class="wf-mail-pop wf-mail-sizes" hidden><button type="button" data-size="default" title="Default size">Aa</button>${MAIL_SIZES.map((size) => `<button type="button" data-size="${size}" title="${size} px">${size}</button>`).join('')}</span></span>`
        + '<button type="button" data-cmd="ul" title="Bullet list">•</button>'
        + '<button type="button" data-cmd="ol" title="Numbered list">1.</button>'
        + '<span class="wf-mail-popwrap"><button type="button" data-pop="symbol" title="Symbols" aria-expanded="false">Ω</button>'
        + `<span class="wf-mail-pop wf-mail-symbols" hidden>${mailPopButtons(MAIL_SYMBOLS, 'data-symbol')}</span></span>`
        + '<span class="wf-mail-popwrap"><button type="button" data-pop="emoji" title="Emoji" aria-expanded="false">😀</button>'
        + `<span class="wf-mail-pop wf-mail-emojis" hidden>${mailPopButtons(MAIL_EMOJIS, 'data-emoji')}</span></span>`
        + '<button type="button" data-cmd="code" title="Inline code">&lt;/&gt;</button>'
        + '<button type="button" data-cmd="pre" title="Code block">{ }</button>'
        + '<button type="button" data-token="{{name}}">Name</button>'
        + '<button type="button" data-token="{{status}}">Status</button>'
        + '<button type="button" data-token="{{error}}">Error</button>'
        + '<button type="button" data-token="{{console}}">Console</button>'
        + '</div>';
}

function messageControl(field, values) {
    const val = values?.[field.key] || '';
    const label = escapeHtml(field.label || field.key);
    const name = escapeAttr(field.key);
    const placeholder = escapeAttr(field.placeholder || '');
    const hint = field.hint ? `<p class="wf-cond-hint">${escapeHtml(field.hint)}</p>` : '';
    const disabled = canEditWorkflow ? '' : 'disabled';
    if (field.input_type === 'textarea') {
        return `<label class="wf-cond-label">${label}</label>
            <textarea class="login-input wf-action-field" data-key="${name}" placeholder="${placeholder}" ${disabled}>${escapeHtml(val)}</textarea>${hint}`;
    }
    return `<label class="wf-cond-label">${label}</label>
        <input type="text" class="login-input wf-action-field" data-key="${name}" placeholder="${placeholder}" value="${escapeAttr(val)}" ${disabled}>${hint}`;
}

function renderMailComposer(host, plugin, values) {
    const keys = mailKeys(plugin);
    const subject = escapeAttr(values?.[keys.subject] || '');
    const disabled = canEditWorkflow ? '' : 'disabled';
    const toolbar = canEditWorkflow ? mailToolbarHTML() : '';
    host.innerHTML = `
        <p class="wf-cond-hint">The logo and the frame are fixed. Write the subject and the message only.</p>
        <label class="wf-cond-label" for="wf-mail-subject">Subject</label>
        <input id="wf-mail-subject" class="login-input" data-key="${escapeAttr(keys.subject)}" value="${subject}" placeholder="[SRE Capsule] {{name}}" ${disabled}>
        <div class="wf-mail-frame">
            <div class="wf-mail-brand">
                <img src="assets/logo.png" alt="SRE Capsule">
            </div>
            ${toolbar}
            <div class="wf-mail-body" contenteditable="true" data-key="${escapeAttr(keys.body)}" role="textbox" aria-multiline="true"></div>
            <div class="wf-mail-foot">SRE Capsule</div>
        </div>`;
    const body = host.querySelector('.wf-mail-body');
    if (body) fillMailBody(body, values?.[keys.body] || '');
    bindMailToolbar(host);
}

function renderActionMessage(path, values) {
    const host = document.getElementById('wf-modal-message');
    if (!host) return;
    const plugin = workflowCatalog.find(p => p.file_path === path);
    if (!path) {
        host.innerHTML = '<p class="wf-cond-hint">Choose a plugin to write its message.</p>';
        return;
    }
    if (isMailPlugin(plugin)) {
        renderMailComposer(host, plugin, values || {});
        return;
    }
    const fields = (plugin?.config_fields || []).filter(f => f.group === 'message');
    if (!fields.length) {
        host.innerHTML = '<p class="wf-cond-hint">This plugin has no message. Connection settings stay in Plugin Engine.</p>';
        return;
    }
    host.innerHTML = `<p class="wf-cond-hint">Message for this gateway. Leave empty to keep the plugin default.</p>${fields.map(f => messageControl(f, values)).join('')}`;
}

function renderConditionForm(when) {
    const body = document.getElementById('wf-node-modal-body');
    body.innerHTML = `
        <label class="wf-cond-label">Field</label>
        <select class="wf-cond-field login-input">
            <option value="name">Incident name</option>
            <option value="tag">Tag (FLAKY, PERF)</option>
            <option value="status">Status</option>
            <option value="error">Error message</option>
            <option value="console">Console logs</option>
        </select>
        <label class="wf-cond-label">Operator</label>
        <select class="wf-cond-match login-input"></select>
        <label class="wf-cond-label">Value</label>
        <input type="text" class="wf-cond-value login-input" placeholder="e.g. [RobotFramework], [FLAKY], Critical">
        <p class="wf-cond-hint"></p>`;
    applyConditionToControls(body, when || NODE_TEMPLATES.condition.data.when);
    const fieldSel = body.querySelector('.wf-cond-field');
    fieldSel.onchange = () => {
        populateMatchOptions(body.querySelector('.wf-cond-match'), fieldSel.value, null);
        setConditionHint(body, fieldSel.value);
    };
    if (!canEditWorkflow) {
        body.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = true; });
    }
}

function renderActionForm(data) {
    const body = document.getElementById('wf-node-modal-body');
    const options = workflowCatalog.map(p =>
        `<option value="${escapeAttr(p.file_path)}">${escapeHtml(displayPluginName(p.name || p.file_path))}</option>`
    ).join('');
    body.innerHTML = `
        <label class="wf-cond-label" for="wf-modal-plugin">Plugin</label>
        <select id="wf-modal-plugin" class="login-input">
            <option value="">Select integration…</option>${options}
        </select>
        <div id="wf-modal-message"></div>`;
    const sel = document.getElementById('wf-modal-plugin');
    if (data?.file_path) setSelectValue(sel, data.file_path);
    sel.onchange = () => renderActionMessage(sel.value, {});
    if (!canEditWorkflow) sel.disabled = true;
    renderActionMessage(sel.value, data?.config || {});
}

function openNodeEditor(nodeEl) {
    if (!nodeEl || !editor) return;
    const id = nodeEl.id.replace('node-', '');
    const data = editor.getNodeFromId(id)?.data || {};
    const type = data.nodeType || (nodeEl.classList.contains('condition') ? 'condition' : 'action');
    editingNodeId = id;
    const title = document.getElementById('wf-node-modal-title');
    const apply = document.querySelector('[data-wf-node-apply]');
    if (title) title.textContent = type === 'condition' ? 'Condition' : 'Action';
    if (apply) apply.hidden = !canEditWorkflow;
    if (type === 'condition') renderConditionForm(data.when);
    else renderActionForm(data);
    const modal = document.getElementById('wf-node-modal');
    if (modal) modal.hidden = false;
}

function readModalConfig() {
    const config = {};
    const root = document.getElementById('wf-node-modal-body');
    root?.querySelectorAll('.wf-action-field, #wf-mail-subject').forEach((inp) => {
        if (inp.dataset.key) config[inp.dataset.key] = inp.value;
    });
    const body = root?.querySelector('.wf-mail-body');
    if (body?.dataset.key) {
        const html = sanitizeMailHtml(body.innerHTML);
        const text = body.textContent.replace(/\u00a0/g, ' ').trim();
        if (text) config[body.dataset.key] = html;
    }
    return config;
}

function applyNodeEditor() {
    if (!editingNodeId || !editor || !canEditWorkflow) {
        closeNodeEditor();
        return;
    }
    const id = editingNodeId;
    const data = { ...(editor.getNodeFromId(id)?.data || {}) };
    const root = document.getElementById('wf-node-modal-body');
    if (root?.querySelector('.wf-cond-field')) {
        data.when = buildConditionExpr(
            root.querySelector('.wf-cond-field')?.value || 'name',
            root.querySelector('.wf-cond-match')?.value || 'prefix',
            root.querySelector('.wf-cond-value')?.value ?? ''
        );
        data.nodeType = 'condition';
        data.label = 'Condition';
    } else {
        const path = document.getElementById('wf-modal-plugin')?.value || '';
        const plugin = workflowCatalog.find(p => p.file_path === path);
        data.file_path = path;
        data.integration = plugin?.integration || '';
        data.label = plugin?.name || 'Action';
        data.config = readModalConfig();
        data.nodeType = 'action';
    }
    editor.updateNodeDataFromId(id, data);
    paintNodeCard(id, data);
    closeNodeEditor();
}

/** Legacy preset strings (imported workflows) → structured when. */
function whenFromLegacyPreset(val) {
    const [op, match, ...rest] = String(val || '').split(':');
    const value = rest.join(':');
    if (op === 'tag') return { op: 'tag', match, value, field: 'incident.name' };
    if (op === 'status') return { op: 'status', match: match || 'equals', value };
    if (op === 'text') return { op: 'text', match: match || 'contains', field: 'incident.error', value };
    return null;
}

function parseConditionPreset(val) {
    return whenFromLegacyPreset(val) || NODE_TEMPLATES.condition.data.when;
}

export function addWorkflowNode(type) {
    if (!canEditWorkflow || !editor) return;
    const count = drawflowNodeCount();
    const y = 100 + count * 100;
    addDrawflowNode(type, 200, y, {}, null);
    populateActionSelects();
    bindNodeControls();
    scheduleSyncControlsFromNodeData();
    updateCanvasEmptyState();
}

function flushAllNodeDataBeforeExport() {
    if (isNodeModalOpen() && canEditWorkflow) applyNodeEditor();
}

function validateWorkflowDoc(doc, enabled) {
    if (!doc?.entry || !doc.nodes?.[doc.entry]) {
        return 'Workflow must include a Trigger node.';
    }
    const triggers = Object.values(doc.nodes).filter(n => n.type === 'trigger');
    if (triggers.length > 1) {
        return 'Only one Trigger node is allowed.';
    }
    if (enabled) {
        const actions = Object.values(doc.nodes).filter(n => n.type === 'action');
        if (!actions.length) {
            return 'Enable requires at least one Action node.';
        }
        const missing = actions.find(a => !a.file_path?.trim());
        if (missing) {
            return 'Every Action node must select an integration before enabling.';
        }
    }
    return '';
}

export async function saveWorkflow() {
    if (!canEditWorkflow || !currentProjectId || !editor) return;
    flushAllNodeDataBeforeExport();
    const enabled = isWorkflowEnabled();
    const exported = editor.export();
    let doc = canonicalFromDrawflow(exported);

    if (!doc) {
        if (enabled) {
            notify('Workflow must include a Trigger node before enabling.', 'error');
            return;
        }
        doc = {
            version: 1,
            enabled: false,
            entry: '',
            nodes: {},
            edges: [],
            meta: { name: 'Remediation workflow (draft)' }
        };
    }

    const validationErr = validateWorkflowDoc(doc, enabled);
    if (validationErr) {
        notify(validationErr, 'error');
        return;
    }
    doc.ui = exported;
    doc.enabled = enabled;
    doc.version = 1;
    doc.meta = { ...(doc.meta || {}), name: doc.meta?.name || 'Remediation workflow' };

    const res = await fetchWithAuth(`/api/projects/${encodeURIComponent(currentProjectId)}/workflow`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc)
    });
    const { ok, data } = await parseApiJson(res);
    if (!ok) {
        notify(data?.error || 'Failed to save workflow.', 'error');
        return;
    }
    canonicalWorkflow = doc;
    updateWorkflowStatusPill();
    if (enabled) {
        notify('Workflow saved and enabled - DAG is active for this pipeline.', 'success');
    } else {
        notify('Workflow saved as draft - legacy AUTO-RUN remains active.', 'success');
    }
    if (typeof window.loadGatewaysData === 'function') {
        window.loadGatewaysData();
    }
}

export async function clearWorkflow() {
    if (!canEditWorkflow || !currentProjectId) return;
    showConfirmModal(
        'Reset visual workflow?',
        'This deletes the DAG for this pipeline and restores legacy AUTO-RUN behavior.',
        'danger',
        async () => {
            const res = await fetchWithAuth(`/api/projects/${encodeURIComponent(currentProjectId)}/workflow`, {
                method: 'DELETE'
            });
            if (res.ok) {
                notify('Workflow cleared - legacy AUTO-RUN restored.', 'success');
                canonicalWorkflow = null;
                const toggle = document.getElementById('workflow-enabled-toggle');
                if (toggle) toggle.checked = false;
                if (initDrawflow()) {
                    addDefaultStarterGraph();
                }
                updateWorkflowStatusPill();
                if (typeof window.loadGatewaysData === 'function') {
                    window.loadGatewaysData();
                }
            } else {
                notify('Failed to clear workflow.', 'error');
            }
        }
    );
}

function canonicalFromDrawflow(exported) {
    const home = exported?.drawflow?.Home?.data;
    if (!home) return null;
    const nodes = {};
    const idMap = {};
    let entry = '';

    Object.entries(home).forEach(([numId, node]) => {
        const cid = `n_${numId}`;
        idMap[numId] = cid;
        const d = node.data || {};
        const type = d.nodeType || node.name;
        const out = { type, label: d.label || type };
        if (type === 'condition') out.when = d.when || NODE_TEMPLATES.condition.data.when;
        if (type === 'action') {
            out.file_path = d.file_path || '';
            out.integration = d.integration || '';
            if (d.config && Object.keys(d.config).length) out.config = d.config;
        }
        nodes[cid] = out;
        if (type === 'trigger' && !entry) entry = cid;
    });
    if (!entry) return null;

    const edges = [];
    Object.entries(home).forEach(([numId, node]) => {
        const outs = node.outputs || {};
        Object.entries(outs).forEach(([outKey, out]) => {
            const conns = out.connections || [];
            conns.forEach(c => {
                const target = idMap[String(c.node)];
                if (!target) return;
                let when = '';
                const isCondition = node.name === 'condition' || node.data?.nodeType === 'condition';
                if (isCondition && outKey === 'output_2') when = 'false';
                else if (isCondition && outKey === 'output_1') when = 'true';
                edges.push({
                    from: idMap[numId],
                    to: target,
                    when
                });
            });
        });
    });

    return { version: 1, enabled: false, entry, nodes, edges };
}

function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
}

export function toggleWorkflowHelp() {
    const panel = document.getElementById('workflow-help-panel');
    if (panel) panel.classList.toggle('open');
}

export function fitWorkflowCanvas() {
    refreshDrawflowViewport();
    syncCanvasExtent();
}

export async function simulateWorkflow() {
    if (!currentProjectId || !editor) return;
    flushAllNodeDataBeforeExport();
    const exported = editor.export();
    const doc = canonicalFromDrawflow(exported);
    if (!doc) {
        notify('Add a Trigger node before simulating.', 'error');
        return;
    }
    const sample = {
        name: document.getElementById('wf-sim-name')?.value?.trim() || '[FLAKY] checkout payment',
        status: document.getElementById('wf-sim-status')?.value?.trim() || 'Critical',
        error: document.getElementById('wf-sim-error')?.value?.trim() || 'timeout waiting for upstream'
    };
    const res = await fetchWithAuth(`/api/projects/${encodeURIComponent(currentProjectId)}/workflow/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...sample, workflow: doc })
    });
    const { ok, data } = await parseApiJson(res);
    const out = document.getElementById('workflow-simulate-result');
    if (!ok) {
        notify(data?.error || 'Simulation failed.', 'error');
        if (out) out.textContent = '';
        return;
    }
    const plan = data?.plan || {};
    const lines = [
        `Sample: ${sample.name} (${sample.status})`,
        plan.visited?.length ? `Path: ${plan.visited.join(' → ')}` : '',
        plan.actions?.length ? `Would run: ${plan.actions.join(' → ')}` : 'Would run: (no actions)',
        plan.skipped?.length ? `Skipped: ${plan.skipped.join('; ')}` : ''
    ].filter(Boolean);
    if (out) {
        out.textContent = lines.join('\n');
        out.classList.add('visible');
    }
    notify('Simulation complete - see panel below canvas.', 'success');
}

export function loadFlakyExampleWorkflow() {
    if (!canEditWorkflow || !editor) return;
    editor.clear();
    const t = addDrawflowNode('trigger', 80, 140, {}, null);
    const c = addDrawflowNode('condition', 340, 140, {
        when: { op: 'text', match: 'prefix', value: '[FLAKY]', field: 'incident.name' }
    }, null);
    const slackPath = workflowCatalog.find(p => p.file_path?.includes('slack'))?.file_path || workflowCatalog[0]?.file_path;
    const jiraPath = workflowCatalog.find(p => p.file_path?.includes('jira'))?.file_path;
    const a1 = slackPath ? addDrawflowNode('action', 600, 80, {
        file_path: slackPath,
        integration: 'slack',
        label: 'Slack notify'
    }, null) : null;
    const a2 = jiraPath ? addDrawflowNode('action', 600, 200, {
        file_path: jiraPath,
        integration: 'jira',
        label: 'Jira ticket'
    }, null) : null;
    if (t && c) editor.addConnection(t, c, 'output_1', 'input_1');
    if (c && a1) editor.addConnection(c, a1, 'output_1', 'input_1');
    if (c && a2) editor.addConnection(c, a2, 'output_2', 'input_1');
    populateActionSelects();
    bindNodeControls();
    scheduleSyncControlsFromNodeData();
    updateCanvasEmptyState();
    refreshDrawflowViewport();
    notify('Flaky example loaded - true→Slack, false→Jira.', 'success');
}
