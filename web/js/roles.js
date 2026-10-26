/**
 * Global RBAC - mirrors pkg/core/rbac.go
 */
export const ROLE_LEVEL = { observer: 1, lead: 2, manager: 3, admin: 4 };

const LEGACY_ROLE_MAP = { operator: 'lead', viewer: 'observer' };

export function normalizeRole(role) {
    if (!role) return '';
    const key = String(role).trim().toLowerCase();
    return LEGACY_ROLE_MAP[key] || key;
}

export const ROLE_LABELS = {
    admin: 'Platform Admin',
    manager: 'Manager',
    lead: 'Lead',
    observer: 'Observer'
};

export const ROLE_DESCRIPTIONS = {
    admin: 'Workspaces hierarchy, global IAM, license, and system settings. Does not use Operations or FinOps.',
    manager: 'FinOps, workspaces, CI gateways, plugins, and full incident triage.',
    lead: 'Resolve and delete alerts, CI gateways, plugins, and webhook routing.',
    observer: 'Read-only Operations dashboard, analytics layout, and Documentation.'
};

export const ROLE_SELECT_OPTIONS = [
    { value: 'observer', label: 'Observer' },
    { value: 'lead', label: 'Lead' },
    { value: 'manager', label: 'Manager' },
    { value: 'admin', label: 'Platform Admin' }
];

export function roleLevel(role) {
    return ROLE_LEVEL[normalizeRole(role)] || 0;
}

export function hasMinRole(userRole, minRole) {
    return roleLevel(userRole) >= roleLevel(minRole);
}

export function roleLabel(role) {
    return ROLE_LABELS[normalizeRole(role)] || role;
}

export function isAdmin(role) {
    return normalizeRole(role) === 'admin';
}

export function canAccessFinOps(role) {
    return normalizeRole(role) === 'manager';
}

export function canManageTeams(role) {
    const r = normalizeRole(role);
    return r === 'admin' || r === 'manager';
}

export function canManageIAM(role) {
    return normalizeRole(role) === 'admin';
}

export function canManageProjects(role) {
    const r = normalizeRole(role);
    return r === 'manager' || r === 'lead';
}

export function canManageWorkflow(role) {
    const normalized = normalizeRole(role);
    return normalized === 'lead' || normalized === 'manager';
}

export function canViewHealing(role) {
    const r = normalizeRole(role);
    return r === 'lead' || r === 'manager' || r === 'observer';
}

export function canConfigureAI(role) {
    return normalizeRole(role) === 'manager';
}

export function canViewAIUsage(role) {
    const r = normalizeRole(role);
    return r === 'lead' || r === 'manager' || r === 'observer';
}

export function canManageHealing(role) {
    return hasMinRole(role, 'lead');
}

export function canPatchExecutionFlags(role) {
    return hasMinRole(role, 'lead');
}

export function canAccessDORA(role) {
    return normalizeRole(role) === 'manager';
}

export function canAccessPlugins(role) {
    const r = normalizeRole(role);
    return r === 'manager' || r === 'lead';
}

export function canManagePluginAutoRun(role) {
    const r = normalizeRole(role);
    return r === 'manager' || r === 'admin';
}

export function canResolveIncidents(role) {
    return hasMinRole(role, 'lead') && normalizeRole(role) !== 'admin';
}

export function canDeleteIncidents(role) {
    const r = normalizeRole(role);
    return r === 'manager' || r === 'lead';
}

export function canAccessOperations(role) {
    return normalizeRole(role) !== 'admin';
}

function setRoleElVisible(el, visible) {
    if (!el) return;
    const isNav = el.classList.contains('nav-item');
    el.style.display = visible ? (isNav ? 'flex' : '') : 'none';
}

function isPureNonAdminEl(el) {
    return el.classList.contains('role-non-admin')
        && !el.classList.contains('role-manager-only')
        && !el.classList.contains('role-lead')
        && !el.classList.contains('role-workspace');
}

export function applyRoleVisibility(role) {
    const r = normalizeRole(role);

    document.querySelectorAll('.role-admin, .admin-only').forEach(el => {
        setRoleElVisible(el, r === 'admin');
    });

    document.querySelectorAll('.role-workspace').forEach(el => {
        setRoleElVisible(el, canManageTeams(role));
    });

    document.querySelectorAll('.role-manager-only, .role-manager').forEach(el => {
        setRoleElVisible(el, r === 'manager');
    });

    document.querySelectorAll('.role-lead, .role-operator').forEach(el => {
        setRoleElVisible(el, r === 'lead' || r === 'manager');
    });

    document.querySelectorAll('.role-non-admin').forEach(el => {
        if (!isPureNonAdminEl(el)) return;
        setRoleElVisible(el, r !== 'admin');
    });

    document.querySelectorAll('.role-observer-only, .role-viewer-only').forEach(el => {
        setRoleElVisible(el, r === 'observer');
    });

    document.querySelectorAll('.role-hide-observer, .role-hide-viewer').forEach(el => {
        setRoleElVisible(el, r !== 'observer');
    });
}

export function defaultViewForRole(role) {
    if (normalizeRole(role) === 'admin') return 'organizations';
    return 'dashboard';
}

export function canAccessView(role, viewId) {
    switch (viewId) {
        case 'dashboard':
        case 'suite':
        case 'activity':
        case 'activity-detail':
        case 'unowned':
        case 'unified-report':
            return canAccessOperations(role);
        case 'about':
        case 'profile':
        case 'workflow':
            return true;
        case 'finops':
            return canAccessFinOps(role);
        case 'organizations':
            return canManageTeams(role);
        case 'management':
        case 'settings':
            return canManageIAM(role);
        case 'plugins':
            return canAccessPlugins(role);
        case 'ingestion':
            return canManageProjects(role);
        case 'healing':
        case 'rca':
            return canViewHealing(role);
        case 'ai-config':
            return canConfigureAI(role);
        case 'ai-usage':
            return canViewAIUsage(role);
        case 'dora':
            return canAccessDORA(role);
        default:
            return false;
    }
}

export function accessDeniedMessage(viewId) {
    const labels = {
        dashboard: 'Dashboard',
        suite: 'Suite health',
        activity: 'Activity',
        finops: 'FinOps Intelligence',
        organizations: 'Workspaces',
        management: 'IAM Access',
        settings: 'Settings',
        plugins: 'Plugin Engine',
        ingestion: 'CI/CD Gateways',
        healing: 'Self-Healing Hub',
        rca: 'Self-Healing Hub',
        'ai-config': 'AI Configuration',
        'ai-usage': 'AI status',
        dora: 'DORA Dashboard',
        workflow: 'Workflow'
    };
    const name = labels[viewId] || viewId;
    return `You do not have access to ${name}.`;
}
