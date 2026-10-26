/**
 * web/js/iam.js
 * Identity & Access Management (Users, Organizations, Teams)
 */
import { fetchWithAuth, parseJwt, parseApiJson, asArray, describeApiFailure } from './api.js';
import { notify, showConfirmModal, showPromptModal } from './ui.js';
import { roleLabel, canManageTeams } from './roles.js?v=1.0.101-workflow-page';
import { setupAutocomplete } from './autocomplete.js';

export let allUsers = [];
export let allTeamsFlatList = [];
let currentSelectedOrgId = null;
let currentlyManagedUser = null;
let draggedOrgId = null;
let orgAcInit = false;
let iamUserAcInit = false;
let teamModalAcInit = false;

function escapeAttr(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function teamRolePillClass(role) {
    if (role === 'team_admin') return 'role-pill role-pill--admin';
    if (role === 'team_operator') return 'role-pill role-pill--operator';
    return 'role-pill role-pill--member';
}

function fetchUsersDirectory() {
    if (allUsers.length) return Promise.resolve(allUsers);
    return fetchWithAuth(`/api/users?_ts=${Date.now()}`)
        .then(r => parseApiJson(r))
        .then(({ ok, data }) => {
            allUsers = ok ? asArray(data) : [];
            return allUsers;
        })
        .catch(() => {
            allUsers = [];
            return allUsers;
        });
}

export function loadOrganizations() {
    const teamsReq = fetchWithAuth(`/api/teams?_ts=${Date.now()}`)
        .then(r => parseApiJson(r))
        .then(result => {
            if (!result.ok) {
                const err = new Error(describeApiFailure(result.status, result.offline));
                err.status = result.status;
                err.offline = result.offline;
                throw err;
            }
            return asArray(result.data);
        });
    const usersReq = fetchUsersDirectory();

    Promise.all([teamsReq, usersReq])
        .then(([data]) => {
            allTeamsFlatList = data || [];
            const treeContainer = document.getElementById('organization-tree');
            if (!data || data.length === 0) {
                treeContainer.innerHTML = "<p>No organizations found.</p>";
                return;
            }

            initOrgAutocompletes();

            const treeMap = {};
            const roots = [];
            data.forEach(node => { treeMap[node.id] = { ...node, children: [] }; });
            data.forEach(node => {
                if (node.parent_id === null || node.parent_id === 0) {
                    roots.push(treeMap[node.id]);
                } else if (treeMap[node.parent_id]) {
                    treeMap[node.parent_id].children.push(treeMap[node.id]);
                }
            });

            const canDrag = canManageTeams(parseJwt(localStorage.getItem('sre-jwt'))?.role);
            const rootDrop = canDrag ? `
                <div class="org-root-drop" id="org-root-drop"
                    ondragover="orgDragOver(event)" ondragleave="orgDragLeave(event)" ondrop="orgDropOnRoot(event)">
                    Drop here to move to top level
                </div>` : '';

            treeContainer.innerHTML = rootDrop + roots.map(root => renderTreeNode(root, canDrag)).join('');
            if (roots.length > 0) selectOrg(roots[0].id, roots[0].name);
        })
        .catch(err => {
            console.error('loadOrganizations:', err);
            const treeContainer = document.getElementById('organization-tree');
            const msg = err?.message || 'Unable to load directory.';
            if (treeContainer) {
                treeContainer.replaceChildren();
                const p = document.createElement('p');
                p.className = 'load-error-msg';
                p.textContent = msg;
                treeContainer.appendChild(p);
            }
            notify(msg, "error");
        });
}

function initOrgAutocompletes() {
    if (!orgAcInit) {
        orgAcInit = true;
        const input = document.getElementById('org-add-user-email');
        const list = document.getElementById('user-autocomplete-list');
        if (input && list) {
            setupAutocomplete({
                input,
                list,
                minChars: 1,
                getSuggestions: q => {
                    const v = q.toLowerCase();
                    return allUsers
                        .filter(u => u.username?.toLowerCase().includes(v) || (u.fullname && u.fullname.toLowerCase().includes(v)))
                        .map(u => ({ label: u.fullname || u.username, sublabel: u.username, value: u.username }));
                },
                onSelect: item => { input.value = item.value; }
            });
        }
    }
}

export function initIamUserSearchAutocomplete() {
    if (iamUserAcInit) return;
    const input = document.getElementById('user-search');
    const list = document.getElementById('user-search-ac');
    if (!input || !list) return;
    iamUserAcInit = true;
    setupAutocomplete({
        input,
        list,
        minChars: 1,
        getSuggestions: q => {
            const v = q.toLowerCase();
            return allUsers
                .filter(u => u.username?.toLowerCase().includes(v) || (u.fullname && u.fullname.toLowerCase().includes(v)))
                .slice(0, 15)
                .map(u => ({ label: u.fullname || u.username, sublabel: `${u.username} · ${roleLabel(u.role)}`, value: u.username }));
        },
        onSelect: item => {
            input.value = item.value;
            filterUsers();
        }
    });
}

function renderTreeNode(node, canDrag) {
    const hasChildren = node.children && node.children.length > 0;
    const toggleIcon = hasChildren ? `<span class="tree-toggle" onclick="toggleTree(event, 'tree-children-${node.id}')">▼</span>` : `<span class="tree-spacer"></span>`;
    const draggable = canDrag && node.id !== 1;
    const dragAttrs = draggable ? `draggable="true" ondragstart="orgDragStart(event, ${node.id})" ondragend="orgDragEnd(event)"` : '';
    const dropAttrs = canDrag ? `ondragover="orgDragOver(event)" ondragleave="orgDragLeave(event)" ondrop="orgDropOnNode(event, ${node.id})"` : '';

    let html = `
    <div class="tree-node${!node.parent_id ? ' tree-node--root' : ''}" id="node-container-${node.id}">
        <div class="tree-row">
            ${toggleIcon}
            <div class="tree-item ${draggable ? 'tree-draggable' : ''}" id="org-node-${node.id}"
                data-org-id="${node.id}" data-org-name="${escapeAttr(node.name)}"
                onclick="window.selectOrgFromEl(this)" ${dragAttrs} ${dropAttrs}>
                <svg style="width:16px;height:16px;stroke:currentColor;fill:none;flex-shrink:0;" viewBox="0 0 24 24" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                <span class="tree-item-label">${escapeAttr(node.name)}</span>
            </div>
        </div>`;

    if (hasChildren) {
        html += `<div id="tree-children-${node.id}" class="tree-children">` + node.children.map(child => renderTreeNode(child, canDrag)).join('') + `</div>`;
    }
    html += `</div>`;
    return html;
}

export function selectOrgFromEl(el) {
    if (!el?.dataset?.orgId) return;
    selectOrg(parseInt(el.dataset.orgId, 10), el.dataset.orgName || '');
}

window.orgDragStart = function (e, nodeId) {
    draggedOrgId = nodeId;
    e.dataTransfer.setData('text/plain', String(nodeId));
    e.dataTransfer.effectAllowed = 'move';
    e.currentTarget?.classList?.add('tree-dragging');
};

window.orgDragEnd = function () {
    document.querySelectorAll('.tree-dragging').forEach(el => el.classList.remove('tree-dragging'));
};

window.orgDragOver = function (e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const item = e.target.closest('.tree-item, .org-root-drop');
    if (item) item.classList.add('tree-drop-target');
};

window.orgDragLeave = function (e) {
    const item = e.target.closest('.tree-item, .org-root-drop');
    if (item) item.classList.remove('tree-drop-target');
};

window.orgDropOnNode = function (e, targetId) {
    e.preventDefault();
    e.stopPropagation();
    document.querySelectorAll('.tree-drop-target, .tree-dragging').forEach(el => {
        el.classList.remove('tree-drop-target', 'tree-dragging');
    });
    const sourceId = draggedOrgId || parseInt(e.dataTransfer.getData('text/plain'), 10);
    draggedOrgId = null;
    if (!sourceId || sourceId === targetId) return;
    moveOrgNode(sourceId, targetId);
};

window.orgDropOnRoot = function (e) {
    e.preventDefault();
    document.querySelectorAll('.tree-drop-target, .tree-dragging').forEach(el => {
        el.classList.remove('tree-drop-target', 'tree-dragging');
    });
    const sourceId = draggedOrgId || parseInt(e.dataTransfer.getData('text/plain'), 10);
    draggedOrgId = null;
    if (!sourceId || sourceId === 1) return;
    moveOrgNode(sourceId, 0);
};

function moveOrgNode(nodeId, newParentId) {
    fetchWithAuth('/api/teams', {
        method: 'PUT',
        body: JSON.stringify({ id: nodeId, parent_id: newParentId })
    }).then(async res => {
        const errText = !res.ok ? await res.text() : '';
        if (res.ok) {
            notify(newParentId === 0 ? 'Moved to top level' : 'Sub-organization moved', 'success');
            loadOrganizations();
        } else {
            notify(errText || 'Failed to move group', 'error');
        }
    });
}

export function toggleTree(e, id) {
    e.stopPropagation();
    const el = document.getElementById(id);
    const icon = e.target;
    if (el.style.display === 'none') {
        el.style.display = 'block';
        icon.setAttribute('data-expanded', 'true');
        icon.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    } else {
        el.style.display = 'none';
        icon.setAttribute('data-expanded', 'false');
        icon.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    }
}

export function selectOrg(id, name) {
    currentSelectedOrgId = id;
    document.querySelectorAll('.tree-item').forEach(el => el.classList.remove('active'));
    const selectedEl = document.getElementById(`org-node-${id}`);
    if (selectedEl) selectedEl.classList.add('active');

    document.getElementById('org-management-panel').style.display = 'block';
    document.getElementById('org-selected-name').innerText = name;
    document.getElementById('org-selected-id').innerText = `Internal DB ID: ${id}`;

    loadOrgMembers(id);
}

export function promptRenameGroup() {
    if (!currentSelectedOrgId) return;
    const currentName = document.getElementById('org-selected-name').innerText;

    showPromptModal("Rename Group", `Enter a new name for '${currentName}':`, currentName, function (newName) {
        if (newName === currentName || !newName) return;

        fetchWithAuth('/api/teams', {
            method: 'PUT',
            body: JSON.stringify({ id: currentSelectedOrgId, name: newName })
        }).then(res => {
            if (res.ok) { notify("Group renamed successfully!", "success"); loadOrganizations(); }
            else notify("Failed to rename group. Name might exist.", "error");
        });
    });
}

export function loadOrgMembers(orgId) {
    fetchWithAuth(`/api/teams/members?team_id=${orgId}&_ts=${Date.now()}`)
        .then(res => res.json())
        .then(members => {
            const tbody = document.getElementById('org-members-list');
            if (!members || members.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" class="table-empty">No members assigned.</td></tr>';
                return;
            }
            tbody.innerHTML = members.map(m => {
                const inheritedTag = m.inherited
                    ? '<span class="member-inherited-tag" title="Inherited from parent group - remove to opt out">inherited</span>'
                    : '';
                return `
                <tr>
                    <td><strong>${m.fullname}</strong> ${inheritedTag}<br><small class="text-subtle-sm">${m.username}</small></td>
                    <td><span class="${teamRolePillClass(m.team_role)}">${m.team_role.replace('team_', '')}</span></td>
                    <td><span class="text-subtle-sm" style="font-size:11px;text-transform:uppercase;">${m.global_role}</span></td>
                    <td class="data-table__actions">
                        <button type="button" class="btn-secondary btn-sm btn-danger-outline" onclick="window.removeUserFromOrg('${m.username}', ${orgId})">REMOVE</button>
                    </td>
                </tr>`;
            }).join('');
        });
}

export function removeUserFromOrg(username, teamId) {
    showConfirmModal("Remove User?", `Are you sure you want to remove '${username}' from this group?`, "warning", function () {
        fetchWithAuth(`/api/teams/members?username=${username}&team_id=${teamId}`, { method: 'DELETE' })
            .then(res => {
                if (res.ok) { notify("User removed successfully", "success"); loadOrgMembers(teamId); }
                else notify("Failed to remove user", "error");
            });
    });
}

export function promptCreateSubGroup() {
    if (!currentSelectedOrgId) return notify("Please select a parent group first.", "error");
    showPromptModal("Create Sub-Group", "Enter the name of the new sub-group:", "e.g. Backend Squad", function (name) {
        fetchWithAuth('/api/teams', { method: 'POST', body: JSON.stringify({ name: name, parent_id: currentSelectedOrgId }) })
            .then(res => {
                if (res.ok) { notify("Sub-group created!", "success"); loadOrganizations(); }
                else notify("Failed to create group. Name might exist.", "error");
            });
    });
}

export function promptDeleteGroup() {
    if (!currentSelectedOrgId) return;
    showConfirmModal("Delete Branch?", "WARNING: Deleting this group will ALSO DELETE ALL of its Sub-Groups. Are you absolutely sure?", "danger", function () {
        fetchWithAuth(`/api/teams?id=${currentSelectedOrgId}`, { method: 'DELETE' })
            .then(res => {
                if (res.ok) { notify("Branch deleted successfully.", "success"); document.getElementById('org-management-panel').style.display = 'none'; loadOrganizations(); }
                else notify("Cannot delete Root Organization or error occurred.", "error");
            });
    });
}

export function handleUserSearch() {
    const val = document.getElementById('org-add-user-email').value.toLowerCase();
    const list = document.getElementById('user-autocomplete-list');
    list.innerHTML = '';
    if (!val) { list.style.display = 'none'; return; }

    const matches = allUsers.filter(u => u.username.toLowerCase().includes(val) || (u.fullname && u.fullname.toLowerCase().includes(val)));
    if (matches.length === 0) { list.style.display = 'none'; return; }

    matches.forEach(m => {
        const div = document.createElement('div');
        div.innerHTML = `<strong>${m.fullname}</strong> <span style="opacity:0.6">(${m.username})</span>`;
        div.onclick = () => {
            document.getElementById('org-add-user-email').value = m.username;
            list.style.display = 'none';
        };
        list.appendChild(div);
    });
    list.style.display = 'block';
}

export function assignUserToGroup() {
    if (!currentSelectedOrgId) return;
    const username = document.getElementById('org-add-user-email').value;
    const role = document.getElementById('org-add-user-role').value;
    if (!username) return notify("Please enter an email", "error");

    fetchWithAuth('/api/teams/members', { method: 'POST', body: JSON.stringify({ username: username.trim(), team_id: currentSelectedOrgId, team_role: role }) })
        .then(res => {
            if (res.ok) { notify("User assigned successfully!", "success"); document.getElementById('org-add-user-email').value = ''; loadOrgMembers(currentSelectedOrgId); }
            else if (res.status === 404) notify("User does not exist in the system.", "error");
            else notify("Assignment failed.", "error");
        });
}

export function openUserTeamsModal(username) {
    currentlyManagedUser = username;
    document.getElementById('manage-teams-username').innerText = username;
    document.getElementById('user-add-team-input').value = '';
    document.getElementById('user-teams-modal').style.display = 'flex';

    fetchWithAuth(`/api/teams?_ts=${Date.now()}`).then(res => res.json()).then(data => { allTeamsFlatList = data || []; });
    initTeamModalAutocomplete();
    refreshUserTeamsModal();
}

function initTeamModalAutocomplete() {
    if (teamModalAcInit) return;
    const input = document.getElementById('user-add-team-input');
    const list = document.getElementById('team-autocomplete-list');
    if (!input || !list) return;
    teamModalAcInit = true;
    setupAutocomplete({
        input,
        list,
        minChars: 1,
        getSuggestions: q => {
            const v = q.toLowerCase();
            return allTeamsFlatList
                .filter(t => t.name.toLowerCase().includes(v))
                .slice(0, 12)
                .map(t => ({ label: t.name, sublabel: `Group #${t.id}`, value: t.id }));
        },
        onSelect: item => {
            input.value = '';
            assignUserToTeamFromModal(item.value);
        }
    });
}

export function closeUserTeamsModal() {
    document.getElementById('user-teams-modal').style.display = 'none';
}

export function refreshUserTeamsModal() {
    fetchWithAuth(`/api/users/teams?username=${currentlyManagedUser}&_ts=${Date.now()}`)
        .then(res => res.json())
        .then(teams => {
            const tbody = document.getElementById('user-teams-list');
            if (!teams || teams.length === 0) {
                tbody.innerHTML = '<tr><td colspan="3" class="table-empty">User is not assigned to any groups.</td></tr>';
                return;
            }
            tbody.innerHTML = teams.map(t => `
            <tr>
                <td><strong>${t.name}</strong></td>
                <td><span class="${teamRolePillClass(t.role)} role-pill--sm">${t.role.replace('team_', '')}</span></td>
                <td class="data-table__actions">
                    <button type="button" class="btn-secondary btn-sm btn-danger-outline" onclick="window.removeUserFromTeamModal(${t.id})">REMOVE</button>
                </td>
            </tr>`).join('');
        });
}

export function removeUserFromTeamModal(teamId) {
    fetchWithAuth(`/api/teams/members?username=${currentlyManagedUser}&team_id=${teamId}`, { method: 'DELETE' })
        .then(res => {
            if (res.ok) { notify("Removed from group", "success"); refreshUserTeamsModal(); }
            else notify("Failed to remove", "error");
        });
}

export function handleTeamSearch() {
    /* handled by setupAutocomplete in initTeamModalAutocomplete */
}

export function assignUserToTeamFromModal(teamId) {
    fetchWithAuth('/api/teams/members', { method: 'POST', body: JSON.stringify({ username: currentlyManagedUser, team_id: teamId }) })
        .then(res => {
            if (res.ok) { notify("Added to group!", "success"); refreshUserTeamsModal(); }
            else notify("Failed to assign group", "error");
        });
}

export function loadUsers() {
    fetchWithAuth(`/api/users?_ts=${Date.now()}`)
        .then(res => { if (!res.ok) throw new Error(); return res.json(); })
        .then(users => {
            allUsers = users || [];
            initIamUserSearchAutocomplete();
            if (document.getElementById('view-management').classList.contains('active')) {
                renderUserTable(allUsers);
            }
        })
        .catch(() => notify("Failed to load users", "error"));
}

export function renderUserTable(users) {
    const tbody = document.getElementById('user-list-body');
    if (!tbody) return;

    const currentUser = parseJwt(localStorage.getItem('sre-jwt')).username;
    if (users.length === 0) { tbody.innerHTML = '<tr><td colspan="4" class="table-empty">No identities found.</td></tr>'; return; }

    tbody.innerHTML = users.map(u => {
        const isMe = u.username === currentUser;
        const disabledState = isMe ? 'disabled class="is-self-disabled" title="You cannot modify yourself"' : '';
        const statusClass = u.is_active ? 'user-status--active' : 'user-status--disabled';
        return `
            <tr>
                <td class="${statusClass}">${u.is_active ? '● ACTIVE' : '○ DISABLED'}</td>
                <td><strong>${escapeHtml(u.fullname || 'N/A')}</strong> ${isMe ? '<small>(YOU)</small>' : ''}<br><small class="text-subtle-sm">${escapeHtml(u.username)}</small></td>
                <td><small>${roleLabel(u.role)}</small><br><small class="text-subtle-sm"><code>${escapeHtml(u.role)}</code></small></td>
                <td class="data-table__actions">
                    <div class="btn-action-group">
                    <button type="button" class="btn btn-secondary btn-sm btn-info" onclick="window.openUserTeamsModal('${escapeAttr(u.username)}')">TEAMS</button>
                    <button type="button" class="btn btn-secondary btn-sm" onclick="window.adminResetPassword('${escapeAttr(u.username)}')" ${disabledState}>RESET PWD</button>
                    <button type="button" class="btn btn-secondary btn-sm ${u.is_active ? 'btn-danger' : 'btn-success'}" onclick="window.toggleUserStatus('${escapeAttr(u.username)}', ${u.is_active})" ${disabledState}>${u.is_active ? 'Disable' : 'Enable'}</button>
                    <button type="button" class="btn btn-primary btn-danger btn-sm" onclick="window.deleteUser('${escapeAttr(u.username)}')" ${disabledState}>DEL</button>
                    </div>
                </td></tr>`;
    }).join('');
}

export function filterUsers() {
    const q = document.getElementById('user-search').value.toLowerCase();
    const r = document.getElementById('role-filter').value;
    renderUserTable(allUsers.filter(u => (u.username.toLowerCase().includes(q) || (u.fullname && u.fullname.toLowerCase().includes(q))) && (r === 'all' || u.role === r)));
}

export function createUser() {
    const name = document.getElementById('new-user-fullname').value;
    const email = document.getElementById('new-user-name').value;
    if (!name || !email) return notify("Name and Email are required", "error");

    fetchWithAuth('/api/users', { method: 'POST', body: JSON.stringify({ username: email, fullname: name, role: document.getElementById('new-user-role').value }) })
        .then(async res => {
            if (res.ok) {
                notify("Identity deployed!", "success");
                document.getElementById('new-user-fullname').value = '';
                document.getElementById('new-user-name').value = '';
                loadUsers();
            } else {
                const err = await res.json().catch(() => ({}));
                notify(err.error || err.message || "Failed to provision identity.", "error");
            }
        });
}

export function toggleUserStatus(username, current) {
    fetchWithAuth('/api/users/status', { method: 'POST', body: JSON.stringify({ username, is_active: !current }) })
        .then(res => {
            if (res.ok) { notify("Status updated", "success"); loadUsers(); }
            else notify("Update failed", "error");
        });
}

export function adminResetPassword(username) {
    showConfirmModal("Reset Password?", `Are you sure you want to force a password reset for '${username}'?`, "warning", function () {
        fetchWithAuth('/api/users/reset-password', { method: 'POST', body: JSON.stringify({ username }) })
            .then(async res => {
                if (res.ok) notify("New password emailed", "success");
                else {
                    const err = await res.json().catch(() => ({}));
                    notify(err.error || "Reset failed - check domain policy", "error");
                }
            });
    });
}

export function deleteUser(username) {
    showConfirmModal("Delete Identity?", `Are you absolutely sure you want to completely remove the user '${username}'? This action cannot be undone.`, "danger", function () {
        fetchWithAuth(`/api/users/delete?username=${username}`, { method: 'DELETE' }).then(res => {
            if (res.ok) { notify("Identity deleted", "success"); loadUsers(); }
            else notify("Deletion failed", "error");
        });
    });
}