/**
 * Theme engine - modes (light/dark/system) and SRE color palettes.
 */
const THEME_STORAGE_KEY = 'sre-theme';
const THEME_MODE_STORAGE_KEY = 'sre-theme-mode';
const THEME_PALETTE_STORAGE_KEY = 'sre-theme-palette';

export const THEME_MODES = [
    { id: 'dark', label: 'Dark', desc: 'Low-glare ops console' },
    { id: 'light', label: 'Light', desc: 'Daytime review & reporting' },
    { id: 'system', label: 'System', desc: 'Follow OS appearance' }
];

export const THEME_PALETTES = [
    { id: 'default', label: 'Enterprise Navy', swatch: ['#1e3a5f', '#f4f5f7'] },
    { id: 'ocean', label: 'Ocean SRE', swatch: ['#0d9488', '#0f172a'] },
    { id: 'graphite', label: 'Graphite Ops', swatch: ['#52525b', '#18181b'] },
    { id: 'ops', label: 'Incident Command', swatch: ['#f59e0b', '#0c1222'] },
    { id: 'terminal', label: 'Terminal', swatch: ['#22c55e', '#0a0f0a'] },
    { id: 'solarized', label: 'Solarized', swatch: ['#268bd2', '#002b36'] },
    { id: 'nord', label: 'Nord', swatch: ['#88c0d0', '#2e3440'] },
    { id: 'aurora', label: 'Aurora', swatch: ['#a78bfa', '#160b24'] },
    { id: 'sand', label: 'Sand', swatch: ['#e7c27a', '#1c1610'] },
    { id: 'crimson', label: 'Crimson', swatch: ['#fb7185', '#1a0b10'] }
];

let systemThemeListenerBound = false;

export function resolveThemeMode(mode) {
    const m = (mode || 'dark').toLowerCase();
    if (m === 'system') {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            return 'dark';
        }
        return 'light';
    }
    return m === 'light' ? 'light' : 'dark';
}

export function normalizeThemePalette(palette) {
    const id = (palette || 'default').toLowerCase();
    return THEME_PALETTES.some((p) => p.id === id) ? id : 'default';
}

/** Apply resolved light/dark + palette to the document. */
export function applyThemeAppearance({ theme_mode, theme_palette, theme } = {}) {
    let mode = theme_mode || theme || 'dark';
    if (!theme_mode && (theme === 'light' || theme === 'dark')) {
        mode = theme;
    }
    const resolved = resolveThemeMode(mode);
    const palette = normalizeThemePalette(theme_palette);

    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.setAttribute('data-theme-mode', mode === 'system' ? 'system' : resolved);
    document.documentElement.setAttribute('data-theme-palette', palette);
    document.body.setAttribute('data-theme', resolved);
    document.body.setAttribute('data-theme-palette', palette);
    document.documentElement.style.colorScheme = resolved;

    try {
        localStorage.setItem(THEME_STORAGE_KEY, resolved);
        localStorage.setItem(THEME_MODE_STORAGE_KEY, mode === 'system' ? 'system' : resolved);
        localStorage.setItem(THEME_PALETTE_STORAGE_KEY, palette);
    } catch (_) { /* quota */ }

    bindSystemThemeListener(mode);

    if (typeof window.reloadDashboardAnalytics === 'function') {
        const view = document.getElementById('analytics-view');
        if (view && view.style.display !== 'none') window.reloadDashboardAnalytics();
    }
    if (typeof window.loadFinOpsWeeklyEvolution === 'function') {
        const finops = document.getElementById('view-finops');
        if (finops?.classList.contains('active')) window.loadFinOpsWeeklyEvolution();
    }
    if (typeof window.refreshDORAMetrics === 'function') {
        const dora = document.getElementById('view-dora');
        if (dora?.classList.contains('active')) window.refreshDORAMetrics();
    }
    return { resolved, palette, mode: mode === 'system' ? 'system' : resolved };
}

export function getStoredThemeAppearance() {
    let mode = 'dark';
    let palette = 'default';
    try {
        mode = localStorage.getItem(THEME_MODE_STORAGE_KEY) || localStorage.getItem(THEME_STORAGE_KEY) || 'dark';
        palette = localStorage.getItem(THEME_PALETTE_STORAGE_KEY) || 'default';
    } catch (_) { /* private mode */ }
    if (mode !== 'system' && mode !== 'light' && mode !== 'dark') {
        mode = mode === 'light' ? 'light' : 'dark';
    }
    return { theme_mode: mode, theme_palette: palette };
}

function bindSystemThemeListener(mode) {
    if (mode !== 'system' || systemThemeListenerBound || !window.matchMedia) return;
    systemThemeListenerBound = true;
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        const activeMode = window.__qaActiveThemeMode || 'system';
        if (activeMode === 'system') {
            applyThemeAppearance({
                theme_mode: 'system',
                theme_palette: window.__qaActiveThemePalette || 'default'
            });
        }
    });
}

export function initThemeFromStorage() {
    const stored = getStoredThemeAppearance();
    window.__qaActiveThemeMode = stored.theme_mode;
    window.__qaActiveThemePalette = stored.theme_palette;
    applyThemeAppearance(stored);
}

/** Legacy single-value theme API (light/dark toggle). */
export function applyTheme(theme) {
    window.__qaActiveThemeMode = theme === 'light' ? 'light' : 'dark';
    return applyThemeAppearance({
        theme_mode: window.__qaActiveThemeMode,
        theme_palette: window.__qaActiveThemePalette || 'default',
        theme
    }).resolved;
}

export function getStoredTheme() {
    return resolveThemeMode(getStoredThemeAppearance().theme_mode);
}

export function initTheme() {
    initThemeFromStorage();
}

export function toggleTheme(e) {
    if (e?.stopPropagation) e.stopPropagation();
    const isDark = resolveThemeMode(window.__qaActiveThemeMode || 'dark') === 'dark';
    const next = isDark ? 'light' : 'dark';
    window.__qaActiveThemeMode = next;
    applyThemeAppearance({
        theme_mode: next,
        theme_palette: window.__qaActiveThemePalette || 'default'
    });
    if (typeof window.persistThemeFromToggle === 'function') {
        window.persistThemeFromToggle(next);
    }
    return next;
}
