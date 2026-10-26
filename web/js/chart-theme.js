/**
 * Chart.js theme helpers - colors from CSS design tokens (light/dark).
 */
export function cssVar(name, fallback = '') {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
}

/** Theme for on-screen Chart.js (follows data-theme). */
export function getChartTheme() {
    return {
        legend: cssVar('--text-main', '#1c2434'),
        title: cssVar('--text-main', '#1c2434'),
        tick: cssVar('--text-muted', '#5e6b7c'),
        border: cssVar('--bg-elevated', '#ffffff'),
        grid: cssVar('--border-main', '#d8dee6'),
        background: cssVar('--bg-elevated', '#ffffff'),
    };
}

/** Fixed light theme for PDF export (print-friendly). */
export function getExportChartTheme() {
    return {
        legend: '#5e6b7c',
        title: '#1c2434',
        tick: '#5e6b7c',
        border: '#ffffff',
        grid: '#d8dee6',
        background: '#ffffff',
    };
}

export function applyChartThemeDefaults() {
    if (typeof Chart === 'undefined') return;
    const t = getChartTheme();
    Chart.defaults.color = t.tick;
    Chart.defaults.font.family = "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    Chart.defaults.font.size = 11;
}

/** Shared scale + legend styling for Chart.js options merge. */
export function withChartTheme(baseOptions = {}, theme = getChartTheme()) {
    const opts = { ...baseOptions };
    opts.plugins = { ...(baseOptions.plugins || {}) };
    if (baseOptions.plugins?.legend) {
        opts.plugins.legend = {
            ...baseOptions.plugins.legend,
            labels: {
                ...(baseOptions.plugins.legend.labels || {}),
                color: theme.legend,
            },
        };
    }
    if (baseOptions.scales) {
        opts.scales = {};
        for (const [key, scale] of Object.entries(baseOptions.scales)) {
            opts.scales[key] = {
                ...scale,
                ticks: {
                    ...(scale.ticks || {}),
                    color: scale.ticks?.color || theme.tick,
                },
                grid: scale.grid
                    ? { ...scale.grid, color: scale.grid.color ?? (scale.grid.display === false ? undefined : theme.grid) }
                    : scale.grid,
                title: scale.title
                    ? { ...scale.title, color: scale.title.color || theme.tick }
                    : scale.title,
            };
        }
    }
    return opts;
}
