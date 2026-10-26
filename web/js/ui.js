/**
 * web/js/ui.js
 * UI utilities: Notifications, Modals, Sidebar, and Theme (via theme-engine)
 */
export {
    applyTheme,
    applyThemeAppearance,
    getStoredTheme,
    getStoredThemeAppearance,
    initThemeFromStorage,
    THEME_MODES,
    THEME_PALETTES,
    resolveThemeMode,
    normalizeThemePalette
} from './theme-engine.js';

import {
    applyThemeAppearance,
    getStoredThemeAppearance,
    initThemeFromStorage,
    toggleTheme as engineToggleTheme
} from './theme-engine.js';

export function notify(message, type = 'success') {
    const container = document.getElementById('notification-container');
    if (!container) return alert(message);

    const toast = document.createElement('div');
    toast.className = type === 'error' ? 'sre-toast sre-toast--error' : 'sre-toast sre-toast--success';
    toast.setAttribute('role', 'status');

    const text = document.createElement('span');
    text.textContent = String(message ?? '');

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'sre-toast__close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '×';

    let hideTimer = 0;
    let gone = false;
    const dismiss = () => {
        if (gone) return;
        gone = true;
        clearTimeout(hideTimer);
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 200);
    };
    close.addEventListener('click', dismiss);

    toast.append(text, close);
    container.appendChild(toast);
    hideTimer = setTimeout(dismiss, 4000);
}

export function initTheme() {
    initThemeFromStorage();
}

const SIDEBAR_COLLAPSED_KEY = 'sre-sidebar-collapsed';

function syncSidebarCollapsedClass(collapsed) {
    document.documentElement.classList.toggle('sidebar-is-collapsed', !!collapsed);
}

let sidebarNavTip = null;

function ensureSidebarNavTip() {
    if (sidebarNavTip) return sidebarNavTip;
    sidebarNavTip = document.createElement('div');
    sidebarNavTip.className = 'sidebar-nav-tip';
    sidebarNavTip.hidden = true;
    document.body.appendChild(sidebarNavTip);
    return sidebarNavTip;
}

function sidebarItemLabel(item) {
    const text = item.querySelector('.nav-text')?.textContent || item.dataset.tooltip || '';
    return text.replace(/\s+/g, ' ').trim();
}

function bindSidebarHoverLabels(sidebar) {
    if (sidebar.dataset.hoverLabels === '1') return;
    sidebar.dataset.hoverLabels = '1';
    const tip = ensureSidebarNavTip();

    const hide = () => { tip.hidden = true; };
    sidebar.addEventListener('mouseover', (event) => {
        if (!sidebar.classList.contains('collapsed')) {
            hide();
            return;
        }
        const item = event.target.closest?.('.nav-item');
        if (!item || !sidebar.contains(item)) return;
        const label = sidebarItemLabel(item);
        if (!label) {
            hide();
            return;
        }
        const rect = item.getBoundingClientRect();
        tip.textContent = label;
        tip.hidden = false;
        tip.style.top = `${rect.top + rect.height / 2}px`;
        tip.style.left = `${rect.right + 10}px`;
    });
    sidebar.addEventListener('mouseleave', hide);
}

export function initSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const btn = document.getElementById('sidebar-collapse-btn');
    if (!sidebar) return;
    const collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
    sidebar.classList.toggle('collapsed', collapsed);
    syncSidebarCollapsedClass(collapsed);
    if (btn) {
        btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    }
    bindSidebarHoverLabels(sidebar);
}

export function toggleSidebar() {
    const sidebar = document.querySelector('.sidebar');
    const btn = document.getElementById('sidebar-collapse-btn');
    if (!sidebar) return;
    const collapsed = !sidebar.classList.contains('collapsed');
    sidebar.classList.toggle('collapsed', collapsed);
    syncSidebarCollapsedClass(collapsed);
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
    if (sidebarNavTip) sidebarNavTip.hidden = true;
    if (btn) {
        btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    }
}

export function toggleTheme(e) {
    return engineToggleTheme(e);
}

export function showConfirmModal(title, message, type, confirmCallback) {
    const modal = document.getElementById('custom-modal');
    const box = document.getElementById('custom-modal-box');
    const titleEl = document.getElementById('custom-modal-title');

    titleEl.innerText = title;
    document.getElementById('custom-modal-message').innerText = message;
    document.getElementById('custom-modal-input').style.display = 'none';

    if (type === 'danger') {
        box.style.borderColor = 'var(--log-fatal)';
        titleEl.style.color = 'var(--log-fatal)';
    } else {
        box.style.borderColor = 'var(--border-main)';
        titleEl.style.color = 'var(--text-main)';
    }

    modal.style.display = 'flex';
    const confirmBtn = document.getElementById('custom-modal-confirm');
    confirmBtn.onclick = () => {
        closeModal();
        if (confirmCallback) confirmCallback();
    };
}

export function showPromptModal(title, message, defaultValue, confirmCallback, passwordField = false) {
    const modal = document.getElementById('custom-modal');
    const box = document.getElementById('custom-modal-box');
    const titleEl = document.getElementById('custom-modal-title');
    const inputEl = document.getElementById('custom-modal-input');

    titleEl.innerText = title;
    titleEl.style.color = 'var(--text-main)';
    box.style.borderColor = 'var(--border-main)';
    document.getElementById('custom-modal-message').innerText = message;
    inputEl.style.display = 'block';
    inputEl.type = passwordField ? 'password' : 'text';
    inputEl.placeholder = '';
    inputEl.value = defaultValue || '';
    inputEl.autocomplete = passwordField ? 'current-password' : 'off';

    modal.style.display = 'flex';
    inputEl.focus();
    const confirmBtn = document.getElementById('custom-modal-confirm');
    confirmBtn.onclick = () => {
        const val = inputEl.value;
        closeModal();
        if (confirmCallback) confirmCallback(val);
    };
}

export function closeModal() {
    const modal = document.getElementById('custom-modal');
    const inputEl = document.getElementById('custom-modal-input');
    if (inputEl) {
        inputEl.type = 'text';
        inputEl.placeholder = '';
        inputEl.autocomplete = 'off';
    }
    if (modal) modal.style.display = 'none';
}

export function previewThemeFromForm() {
    const mode = document.getElementById('pref-theme-mode')?.value
        || document.querySelector('.theme-mode-chip.active')?.dataset.themeMode
        || 'dark';
    const palette = document.getElementById('pref-theme-palette')?.value
        || document.querySelector('.theme-palette-chip.active')?.dataset.themePalette
        || 'default';
    window.__qaActiveThemeMode = mode;
    window.__qaActiveThemePalette = palette;
    applyThemeAppearance({ theme_mode: mode, theme_palette: palette });
}
