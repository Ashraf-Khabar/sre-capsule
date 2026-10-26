/**
 * web/js/profile.js
 * Personal account settings and persisted user preferences
 */
import { fetchWithAuth, parseJwt, parseApiJson } from './api.js';
import { secureLinkTokenFromPath } from './links.js?v=1.0.101-workflow-page';
import { notify, applyThemeAppearance, previewThemeFromForm } from './ui.js';
import { roleLabel, normalizeRole, canAccessView } from './roles.js?v=1.0.101-workflow-page';
import { setSelectedCurrency } from './settings.js';
import { renderConfigurationPresets, renderThemePickers, initConfigurationPresetsUI } from './config-presets.js?v=1.0.101-workflow-page';
import { setLocale, applyI18n, t, getLocale, PREF_LANGUAGE_KEY } from './i18n.js?v=1.0.101-workflow-page';
import { avatarMarkup, renderAvatarPicker, resizeProfilePhoto } from './avatars.js';

export const PREF_DEFAULT_RANGE_KEY = 'sre-pref-default-range';
export const PREF_CURRENCY_KEY = 'sre-pref-currency';
export const PREF_ALERT_SOUNDS_KEY = 'sre-alert-sounds';
export const PREF_PROFILE_TAB_KEY = 'sre-profile-active-tab';

let preferencesLoadSeq = 0;

const VALID_DEFAULT_RANGE_PRESETS = [
    '5m', '15m', '30m', '1h', '6h', '24h', '7d', '30d', 'today', 'yesterday', 'all'
];

const DEFAULT_PREFS = {
    theme: 'dark',
    theme_mode: 'dark',
    theme_palette: 'default',
    default_status_filter: 'all',
    analytics_expanded: false,
    default_time_range: '15m',
    compact_ui: false,
    sidebar_collapsed_default: false,
    dashboard_auto_refresh: true,
    dashboard_refresh_interval_sec: 60,
    date_format: 'locale',
    timezone: 'auto',
    default_landing_view: 'dashboard',
    reduced_motion: false,
    high_contrast: false,
    browser_notifications: false,
    expand_incident_cards: false,
    dense_tables: false,
    currency: 'USD',
    alert_sounds: false,
    language: 'en',
    active_preset_id: 'sre-default',
    configuration_presets: []
};

export let userPreferences = { ...DEFAULT_PREFS };
let profileTabInitialized = false;
let lastIncidentCountForNotify = null;

export function initialsFromDisplayName(name) {
    const cleaned = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!cleaned) return '?';
    const parts = cleaned.split(' ').filter(Boolean);
    if (parts.length >= 2) {
        return ((parts[0][0] ?? '') + (parts[parts.length - 1][0] ?? '')).toUpperCase();
    }
    const token = parts[0];
    if (token.length >= 2) return token.slice(0, 2).toUpperCase();
    return token[0].toUpperCase();
}

export function displayNameFromJwtUsername(username) {
    const u = String(username ?? '').trim();
    if (!u) return '';
    const local = u.includes('@') ? u.split('@')[0] : u;
    return local.replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function resolveProfileDisplayName({ fullname, username }) {
    const fn = String(fullname ?? '').trim();
    if (fn) return fn;
    return displayNameFromJwtUsername(username);
}

export function isValidDefaultRangePreset(preset) {
    return VALID_DEFAULT_RANGE_PRESETS.includes(preset);
}

export function applyPreferredDefaultRange(preset) {
    if (!isValidDefaultRangePreset(preset)) return;
    try {
        localStorage.setItem(PREF_DEFAULT_RANGE_KEY, preset);
    } catch (_) { /* quota */ }
}

export function bootstrapDashboardRangeFromPreferences() {
    try {
        if (localStorage.getItem('sre-dashboard-range')) return;
        const preferred = userPreferences.default_time_range
            || localStorage.getItem(PREF_DEFAULT_RANGE_KEY)
            || '15m';
        const preset = isValidDefaultRangePreset(preferred) ? preferred : '15m';
        localStorage.setItem('sre-dashboard-range', JSON.stringify({ preset }));
    } catch (_) { /* private mode */ }
}

export function isAlertSoundsEnabled() {
    if (typeof userPreferences.alert_sounds === 'boolean') {
        return userPreferences.alert_sounds;
    }
    return localStorage.getItem(PREF_ALERT_SOUNDS_KEY) === '1';
}

export function isBrowserNotificationsEnabled() {
    return !!userPreferences.browser_notifications;
}

export function playCriticalAlertSound() {
    if (!isAlertSoundsEnabled()) return;
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
        osc.start();
        osc.stop(ctx.currentTime + 0.28);
        osc.onended = () => ctx.close();
    } catch (_) { /* autoplay policy */ }
}

export function notifyNewIncidentsIfEnabled(count, sampleTitle) {
    if (!isBrowserNotificationsEnabled()) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (lastIncidentCountForNotify !== null && count <= lastIncidentCountForNotify) {
        lastIncidentCountForNotify = count;
        return;
    }
    if (lastIncidentCountForNotify !== null && count > lastIncidentCountForNotify) {
        try {
            new Notification('SRE Capsule - new incident', {
                body: sampleTitle || 'New failure detected on Telemetry Stream',
                tag: 'sre-capsule-incident'
            });
        } catch (_) { /* blocked */ }
    }
    lastIncidentCountForNotify = count;
}

export function formatUserDateTime(value) {
    if (!value) return '-';
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    const fmt = userPreferences.date_format || 'locale';
    const tz = userPreferences.timezone && userPreferences.timezone !== 'auto'
        ? userPreferences.timezone
        : undefined;
    const opts = { dateStyle: 'medium', timeStyle: 'short' };
    if (tz) opts.timeZone = tz;
    if (fmt === 'iso') {
        const pad = (n) => String(n).padStart(2, '0');
        const local = tz
            ? new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
            : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        return local.replace(',', '');
    }
    if (fmt === 'short') {
        return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: tz });
    }
    return d.toLocaleString(undefined, { ...opts, timeZone: tz });
}

export function syncApplicationCurrency(code) {
    const currency = code || 'USD';
    window.selectedCurrency = currency;
    setSelectedCurrency(currency);
    try {
        localStorage.setItem(PREF_CURRENCY_KEY, currency);
        localStorage.setItem('selected-currency', currency);
    } catch (_) { /* quota */ }
    const finopsSel = document.getElementById('finops-currency');
    if (finopsSel && finopsSel.value !== currency) finopsSel.value = currency;
    const prefSel = document.getElementById('pref-currency');
    if (prefSel && prefSel.value !== currency) prefSel.value = currency;
}

function readStoredSidebarCollapsed() {
    try {
        const stored = localStorage.getItem('sre-sidebar-collapsed');
        if (stored === '1') return true;
        if (stored === '0') return false;
    } catch (_) { /* private mode */ }
    return null;
}

function paintSidebarCollapsed(collapsed) {
    const sidebar = document.querySelector('.sidebar');
    const btn = document.getElementById('sidebar-collapse-btn');
    if (!sidebar) return;
    sidebar.classList.toggle('collapsed', !!collapsed);
    document.documentElement.classList.toggle('sidebar-is-collapsed', !!collapsed);
    if (btn) {
        btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        btn.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    }
}

function applySidebarCollapsedPref(collapsed) {
    paintSidebarCollapsed(collapsed);
    try {
        localStorage.setItem('sre-sidebar-collapsed', collapsed ? '1' : '0');
    } catch (_) { /* quota */ }
}

function applyVisualPreferenceClasses(prefs) {
    document.body.classList.toggle('ui-compact', !!prefs.compact_ui);
    document.body.classList.toggle('ui-high-contrast', !!prefs.high_contrast);
    document.body.classList.toggle('ui-dense-tables', !!prefs.dense_tables);
    document.documentElement.classList.toggle('reduced-motion', !!prefs.reduced_motion);
}

function syncDashboardRefreshGlobals(prefs) {
    window.userDashboardAutoRefresh = prefs.dashboard_auto_refresh !== false;
    window.userDashboardRefreshIntervalSec = prefs.dashboard_refresh_interval_sec || 60;
    if (typeof window.restartDashboardAutoRefresh === 'function') {
        const dash = document.getElementById('view-dashboard');
        if (dash?.classList.contains('active')) window.restartDashboardAutoRefresh();
    }
}

export function applyDefaultLandingView(prefs, role) {
    let view = prefs?.default_landing_view || 'dashboard';
    if (view === 'rca') view = 'healing';
    if (!role || !canAccessView(role, view)) return;
    if (window.__qaLandingViewApplied) return;
    window.__qaLandingViewApplied = true;
    if (secureLinkTokenFromPath(window.location.pathname || '')) return;
    const nav = document.querySelector(`.nav-item[onclick*="switchView('${view}'"]`);
    if (typeof window.switchView === 'function') window.switchView(view, nav);
}

let currentAvatar = { kind: '', value: '' };

function renderProfileHeader({ fullname, username, role }) {
    const displayName = resolveProfileDisplayName({ fullname, username });
    const bubble = document.getElementById('profile-avatar-bubble');
    const nameEl = document.getElementById('profile-display-name');
    const badgeEl = document.getElementById('profile-role-badge');
    const roleEl = document.getElementById('profile-role');
    if (bubble) {
        bubble.innerHTML = avatarMarkup({
            avatar_kind: currentAvatar.kind,
            avatar_value: currentAvatar.value,
            fullname: displayName,
            username
        }, 40);
    }
    if (nameEl) nameEl.textContent = displayName || username || '-';
    if (roleEl && role) roleEl.textContent = roleLabel(role);
    if (badgeEl && role) {
        const norm = normalizeRole(role);
        badgeEl.textContent = roleLabel(role);
        badgeEl.className = `profile-role-badge role-${norm || 'observer'}`;
    }
}

export function applyTheme(theme) {
    applyThemeAppearance({
        theme_mode: theme === 'light' ? 'light' : 'dark',
        theme_palette: userPreferences.theme_palette || 'default',
        theme
    });
    const analyticsView = document.getElementById('analytics-view');
    if (analyticsView && analyticsView.style.display !== 'none' && typeof window.loadAnalytics === 'function') {
        window.loadAnalytics(false);
    }
}

export function previewThemeAppearance() {
    previewThemeFromForm();
}

function syncLocaleFromPreferences(prefs) {
    const stored = (() => {
        try { return localStorage.getItem(PREF_LANGUAGE_KEY); } catch (_) { return null; }
    })();
    const lang = prefs?.language || stored || 'en';
    setLocale(lang, { persist: true });
}

export function applyPreferences(prefs) {
    if (!prefs) return;
    userPreferences = { ...DEFAULT_PREFS, ...userPreferences, ...prefs };
    if (!userPreferences.language) {
        userPreferences.language = getLocale() || 'en';
    }
    window.__userPreferences = userPreferences;
    applyThemeAppearance({
        theme_mode: userPreferences.theme_mode || userPreferences.theme || 'dark',
        theme_palette: userPreferences.theme_palette || 'default',
        theme: userPreferences.theme
    });
    applyVisualPreferenceClasses(userPreferences);
    const storedCollapsed = readStoredSidebarCollapsed();
    if (storedCollapsed === null) {
        applySidebarCollapsedPref(!!userPreferences.sidebar_collapsed_default);
    } else {
        paintSidebarCollapsed(storedCollapsed);
    }
    syncDashboardRefreshGlobals(userPreferences);

    if (userPreferences.currency) {
        syncApplicationCurrency(userPreferences.currency);
    }

    try {
        localStorage.setItem(PREF_ALERT_SOUNDS_KEY, userPreferences.alert_sounds ? '1' : '0');
    } catch (_) { /* quota */ }

    if (userPreferences.default_time_range) {
        applyPreferredDefaultRange(userPreferences.default_time_range);
    }

    if (userPreferences.default_status_filter && window.setStatusFilter) {
        window.statusFilter = userPreferences.default_status_filter;
        window.setStatusFilter(userPreferences.default_status_filter);
    }

    if (typeof window.loadAnalyticsLayoutFromPrefs === 'function') {
        window.loadAnalyticsLayoutFromPrefs();
    }

    const analytics = document.getElementById('analytics-view');
    if (analytics && userPreferences.analytics_expanded) {
        analytics.style.display = 'block';
        if (typeof window.loadAnalytics === 'function') window.loadAnalytics(false);
    }

    window.userExpandIncidentCards = !!userPreferences.expand_incident_cards;

    syncLocaleFromPreferences(userPreferences);
}

export async function loadUserPreferences() {
    const seq = ++preferencesLoadSeq;
    try {
        const savedCur = localStorage.getItem(PREF_CURRENCY_KEY) || localStorage.getItem('selected-currency');
        if (savedCur) syncApplicationCurrency(savedCur);

        const res = await fetchWithAuth('/api/me');
        if (seq !== preferencesLoadSeq) return;
        const { ok, data } = await parseApiJson(res);
        if (!ok || !data) return;
        if (data.preferences) applyPreferences(data.preferences);
        if (seq !== preferencesLoadSeq) return;
        const payload = parseJwt(localStorage.getItem('sre-jwt'));
        if (payload?.role) applyDefaultLandingView(userPreferences, payload.role);
        return data;
    } catch {
        /* offline */
    }
}

function readProfileFormPreferences() {
    const mode = document.getElementById('pref-theme-mode')?.value
        || document.querySelector('.theme-mode-chip.active')?.dataset.themeMode
        || document.getElementById('pref-theme')?.value
        || 'dark';
    const palette = document.getElementById('pref-theme-palette')?.value
        || document.querySelector('.theme-palette-chip.active')?.dataset.themePalette
        || 'default';
    return {
        theme: mode === 'system' ? 'dark' : (mode === 'light' ? 'light' : 'dark'),
        theme_mode: mode,
        theme_palette: palette,
        default_status_filter: document.getElementById('pref-status-filter')?.value || 'all',
        analytics_expanded: !!document.getElementById('pref-analytics-expanded')?.checked,
        default_time_range: document.getElementById('pref-default-range')?.value || '15m',
        compact_ui: !!document.getElementById('pref-compact-ui')?.checked,
        sidebar_collapsed_default: !!document.getElementById('pref-sidebar-collapsed')?.checked,
        dashboard_auto_refresh: !!document.getElementById('pref-dashboard-auto-refresh')?.checked,
        dashboard_refresh_interval_sec: parseInt(document.getElementById('pref-refresh-interval')?.value || '60', 10),
        date_format: document.getElementById('pref-date-format')?.value || 'locale',
        timezone: document.getElementById('pref-timezone')?.value || 'auto',
        default_landing_view: document.getElementById('pref-landing-view')?.value || 'dashboard',
        reduced_motion: !!document.getElementById('pref-reduced-motion')?.checked,
        high_contrast: !!document.getElementById('pref-high-contrast')?.checked,
        browser_notifications: !!document.getElementById('pref-browser-notifications')?.checked,
        expand_incident_cards: !!document.getElementById('pref-expand-incidents')?.checked,
        dense_tables: !!document.getElementById('pref-dense-tables')?.checked,
        currency: document.getElementById('pref-currency')?.value || 'USD',
        alert_sounds: !!document.getElementById('pref-alert-sounds')?.checked,
        language: document.getElementById('pref-language')?.value || 'en',
        active_preset_id: userPreferences.active_preset_id || 'sre-default'
    };
}

export { readProfileFormPreferences };

function hydrateProfileFormFields(prefs) {
    hydrateProfileFormFromPrefs(prefs);
}

export function hydrateProfileFormFromPrefs(prefs) {
    const p = { ...DEFAULT_PREFS, ...prefs };
    const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val;
    };
    const setChk = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.checked = !!val;
    };

    const mode = p.theme_mode || p.theme || 'dark';
    setVal('pref-theme-mode', mode);
    setVal('pref-theme', mode === 'system' ? 'dark' : mode);
    setVal('pref-theme-palette', p.theme_palette || 'default');
    setVal('pref-status-filter', p.default_status_filter);
    setChk('pref-analytics-expanded', p.analytics_expanded);
    setVal('pref-default-range', isValidDefaultRangePreset(p.default_time_range) ? p.default_time_range : '15m');
    setVal('pref-refresh-interval', String(p.dashboard_refresh_interval_sec || 60));
    setChk('pref-dashboard-auto-refresh', p.dashboard_auto_refresh !== false);
    setVal('pref-date-format', p.date_format);
    setVal('pref-timezone', p.timezone);
    setVal('pref-landing-view', p.default_landing_view);
    setChk('pref-compact-ui', p.compact_ui);
    setChk('pref-sidebar-collapsed', p.sidebar_collapsed_default);
    setChk('pref-reduced-motion', p.reduced_motion);
    setChk('pref-high-contrast', p.high_contrast);
    setChk('pref-expand-incidents', p.expand_incident_cards);
    setChk('pref-dense-tables', p.dense_tables);
    setChk('pref-browser-notifications', p.browser_notifications);

    const currency = p.currency || localStorage.getItem(PREF_CURRENCY_KEY) || window.selectedCurrency || 'USD';
    setVal('pref-currency', currency);
    syncApplicationCurrency(currency);
    setChk('pref-alert-sounds', p.alert_sounds || isAlertSoundsEnabled());
    setVal('pref-language', p.language || 'en');

    renderThemePickers(p);
    syncLocaleFromPreferences(p);
}

export function switchProfileTab(tabId, btn) {
    document.querySelectorAll('.profile-nav-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.profile-panel').forEach((panel) => {
        const active = panel.dataset.profilePanel === tabId;
        panel.classList.toggle('active', active);
        panel.hidden = !active;
    });
    if (tabId === 'docs' && window.loadAboutView) window.loadAboutView();
    try {
        localStorage.setItem(PREF_PROFILE_TAB_KEY, tabId);
    } catch (_) { /* quota */ }
}

function initProfileTabs() {
    if (profileTabInitialized) return;
    profileTabInitialized = true;
    let tab = 'identity';
    try {
        tab = localStorage.getItem(PREF_PROFILE_TAB_KEY) || 'identity';
    } catch (_) { /* quota */ }
    const btn = document.querySelector(`.profile-nav-btn[data-profile-tab="${tab}"]`)
        || document.querySelector('.profile-nav-btn[data-profile-tab="identity"]');
    if (btn) switchProfileTab(btn.dataset.profileTab, btn);
}

export function loadProfileView() {
    const loadSeq = preferencesLoadSeq;
    initProfileTabs();
    initConfigurationPresetsUI();
    const payload = parseJwt(localStorage.getItem('sre-jwt'));
    const usernameEl = document.getElementById('profile-username');
    if (usernameEl && payload.username) usernameEl.textContent = payload.username;
    renderProfileHeader({ fullname: '', username: payload.username, role: payload.role });
    hydrateProfileFormFromPrefs(userPreferences);
    renderConfigurationPresets(userPreferences);
    renderThemePickers(userPreferences);
    renderAvatarChooser();

    fetchWithAuth('/api/me')
        .then((res) => parseApiJson(res))
        .then(({ ok, data }) => {
            if (loadSeq !== preferencesLoadSeq) return;
            if (!ok || !data) throw new Error('Failed to load profile');
            const nameInput = document.getElementById('profile-fullname');
            if (nameInput) nameInput.value = data.fullname || '';
            currentAvatar = { kind: data.avatar_kind || '', value: data.avatar_value || '' };
            renderAvatarChooser();
            renderProfileHeader({
                fullname: data.fullname,
                username: data.username ?? payload.username,
                role: data.role ?? payload.role
            });
            if (data.preferences) {
                applyPreferences(data.preferences);
                hydrateProfileFormFromPrefs(data.preferences);
                renderConfigurationPresets(data.preferences);
                renderThemePickers(data.preferences);
            }
        })
        .catch(() => notify(t('notify.profileLoadError'), 'error'));
}

export function resetProfileFormDefaults() {
    hydrateProfileFormFromPrefs(DEFAULT_PREFS);
    renderConfigurationPresets({ ...DEFAULT_PREFS, configuration_presets: userPreferences.configuration_presets || [] });
    renderThemePickers(DEFAULT_PREFS);
    notify(t('notify.profileReset'), 'success');
}

export function onProfileCurrencyChange() {
    const code = document.getElementById('pref-currency')?.value || 'USD';
    syncApplicationCurrency(code);
    if (document.getElementById('view-finops')?.classList.contains('active') && window.refreshFinOpsKPIs) {
        window.refreshFinOpsKPIs();
    }
    if (typeof window.updateCurrencyDisplay === 'function') window.updateCurrencyDisplay();
}

export function requestBrowserNotificationPermission() {
    if (typeof Notification === 'undefined') {
        notify('Notifications not supported in this browser', 'error');
        return;
    }
    Notification.requestPermission().then((perm) => {
        if (perm === 'granted') notify('Desktop notifications enabled', 'success');
        else notify('Permission denied or dismissed', 'error');
    });
}

export function exportProfilePreferences() {
    const bundle = {
        server: readProfileFormPreferences(),
        presets: userPreferences.configuration_presets || [],
        active_preset_id: userPreferences.active_preset_id || 'sre-default',
        local: {
            sidebar: localStorage.getItem('sre-sidebar-collapsed'),
            default_range: localStorage.getItem(PREF_DEFAULT_RANGE_KEY)
        },
        exported_at: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sre-capsule-preferences.json';
    a.click();
    URL.revokeObjectURL(a.href);
    notify('Preferences exported', 'success');
}

export function clearLocalProfileData() {
    if (!window.confirm('Clear local browser preferences (theme cache, sidebar, currency, sounds)? Server account data is kept.')) return;
    ['sre-theme', PREF_CURRENCY_KEY, PREF_ALERT_SOUNDS_KEY, PREF_DEFAULT_RANGE_KEY, 'sre-sidebar-collapsed', 'sre-dashboard-range', PREF_PROFILE_TAB_KEY].forEach((k) => {
        try { localStorage.removeItem(k); } catch (_) { /* quota */ }
    });
    notify('Local data cleared - reload recommended', 'success');
}

function renderAvatarChooser() {
    const picker = document.getElementById('avatar-picker');
    renderAvatarPicker(picker, currentAvatar.kind === 'preset' ? currentAvatar.value : '', (id) => {
        saveAvatar('preset', id);
    });
    const file = document.getElementById('avatar-file');
    if (file && file.dataset.bound !== '1') {
        file.dataset.bound = '1';
        file.addEventListener('change', async () => {
            const chosen = file.files && file.files[0];
            file.value = '';
            if (!chosen) return;
            try {
                const dataUrl = await resizeProfilePhoto(chosen);
                await saveAvatar('photo', dataUrl);
            } catch (err) {
                notify(err.message || 'Could not use that photo', 'error');
            }
        });
    }
    const clear = document.getElementById('avatar-clear');
    if (clear && clear.dataset.bound !== '1') {
        clear.dataset.bound = '1';
        clear.addEventListener('click', () => saveAvatar('', ''));
    }
}

async function saveAvatar(kind, value) {
    const res = await fetchWithAuth('/api/me/avatar', {
        method: 'PUT',
        body: JSON.stringify({ kind, value })
    });
    if (!res.ok) {
        notify('Could not save the avatar', 'error');
        return;
    }
    currentAvatar = { kind, value };
    renderAvatarChooser();
    const payload = parseJwt(localStorage.getItem('sre-jwt'));
    renderProfileHeader({
        fullname: document.getElementById('profile-fullname')?.value,
        username: payload.username,
        role: payload.role
    });
    notify('Profile picture saved', 'success');
}

export function saveProfile() {
    const fullname = document.getElementById('profile-fullname')?.value?.trim();
    if (!fullname) return notify('Display name is required', 'error');

    const preferences = readProfileFormPreferences();
    preferencesLoadSeq++;
    syncLocaleFromPreferences(preferences);
    applyPreferredDefaultRange(preferences.default_time_range);
    syncApplicationCurrency(document.getElementById('pref-currency')?.value || 'USD');

    try {
        localStorage.setItem(PREF_ALERT_SOUNDS_KEY, document.getElementById('pref-alert-sounds')?.checked ? '1' : '0');
    } catch (_) { /* quota */ }

    Promise.all([
        fetchWithAuth('/api/me', { method: 'PUT', body: JSON.stringify({ fullname }) }),
        fetchWithAuth('/api/me/preferences', { method: 'PUT', body: JSON.stringify(preferences) })
    ])
        .then(([profileRes, prefsRes]) => {
            if (!profileRes.ok || !prefsRes.ok) throw new Error('Save failed');
            return prefsRes.json();
        })
        .then((prefs) => {
            preferencesLoadSeq++;
            applyPreferences(prefs);
            applyI18n();
            renderProfileHeader({
                fullname,
                username: parseJwt(localStorage.getItem('sre-jwt')).username,
                role: parseJwt(localStorage.getItem('sre-jwt')).role
            });
            notify('Account settings saved', 'success');
        })
        .catch(() => notify('Failed to save profile', 'error'));
}

export function changeOwnPassword() {
    const current = document.getElementById('profile-current-password')?.value;
    const next = document.getElementById('profile-new-password')?.value;
    const confirm = document.getElementById('profile-confirm-password')?.value;
    if (!current || !next) return notify('Fill in all password fields', 'error');
    if (next !== confirm) return notify('New passwords do not match', 'error');
    if (next.length < 8) return notify('Password must be at least 8 characters', 'error');

    fetchWithAuth('/api/me/password', {
        method: 'PUT',
        body: JSON.stringify({ current_password: current, new_password: next })
    })
        .then((res) => {
            if (res.status === 403) throw new Error('wrong');
            if (!res.ok) throw new Error('failed');
            ['profile-current-password', 'profile-new-password', 'profile-confirm-password'].forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
            notify('Password updated', 'success');
        })
        .catch((err) => {
            if (err.message === 'wrong') notify('Current password is incorrect', 'error');
            else notify('Failed to update password', 'error');
        });
}

export function persistThemeFromToggle(theme) {
    const preferences = {
        ...userPreferences,
        theme: theme === 'dark' ? 'dark' : 'light',
        theme_mode: theme === 'dark' ? 'dark' : 'light'
    };
    fetchWithAuth('/api/me/preferences', { method: 'PUT', body: JSON.stringify(preferences) })
        .then((res) => (res.ok ? res.json() : null))
        .then((prefs) => {
            if (prefs) {
                userPreferences = { ...userPreferences, ...prefs };
                window.__userPreferences = userPreferences;
                syncLocaleFromPreferences(userPreferences);
            }
        })
        .catch(() => {});
}

// Expose for inline onclick handlers
if (typeof window !== 'undefined') {
    window.switchProfileTab = switchProfileTab;
    window.resetProfileFormDefaults = resetProfileFormDefaults;
    window.requestBrowserNotificationPermission = requestBrowserNotificationPermission;
    window.exportProfilePreferences = exportProfilePreferences;
    window.clearLocalProfileData = clearLocalProfileData;
    window.formatUserDateTime = formatUserDateTime;
    window.readProfileFormPreferences = readProfileFormPreferences;
    window.hydrateProfileFormFromPrefs = hydrateProfileFormFromPrefs;
    window.previewThemeAppearance = previewThemeAppearance;
    window.applyPreferences = applyPreferences;
}
