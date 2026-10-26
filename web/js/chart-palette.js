/**
 * SRE Capsule chart colors - enterprise SRE palette (navy / slate, no AI neon).
 */
import { cssVar } from './chart-theme.js';

/** Static fallbacks for PDF export and first paint (light theme). */
export const CHART_PALETTE_LIGHT = {
    brand: '#1e3a5f',
    series: [
        '#1e3a5f',
        '#4a7c59',
        '#9a7b4f',
        '#b54a4a',
        '#3d6b8c',
        '#6b7785',
        '#5c6b7a',
        '#8a96a8'
    ],
    semantic: {
        info: '#3d6b8c',
        success: '#4a7c59',
        warning: '#9a7b4f',
        danger: '#b54a4a',
        neutral: '#6b7785'
    },
    doughnut: ['#b54a4a', '#9a7b4f', '#1e3a5f', '#4a7c59'],
    metricPresets: [
        { label: 'Navy', value: '#1e3a5f' },
        { label: 'Sage', value: '#4a7c59' },
        { label: 'Ochre', value: '#9a7b4f' },
        { label: 'Brick', value: '#b54a4a' },
        { label: 'Steel', value: '#3d6b8c' },
        { label: 'Slate', value: '#6b7785' }
    ]
};

/** @deprecated Use getChartPalette() for theme-aware colors. */
export const CHART_PALETTE = CHART_PALETTE_LIGHT;

/** Reads chart tokens from CSS (follows data-theme). */
export function getChartPalette() {
    return {
        brand: cssVar('--chart-brand', CHART_PALETTE_LIGHT.brand),
        series: [
            cssVar('--chart-brand', CHART_PALETTE_LIGHT.series[0]),
            cssVar('--chart-pass', CHART_PALETTE_LIGHT.series[1]),
            cssVar('--chart-warn', CHART_PALETTE_LIGHT.series[2]),
            cssVar('--chart-fail', CHART_PALETTE_LIGHT.series[3]),
            cssVar('--chart-info', CHART_PALETTE_LIGHT.series[4]),
            cssVar('--chart-neutral', CHART_PALETTE_LIGHT.series[5]),
            '#5c6b7a',
            '#8a96a8'
        ],
        semantic: {
            info: cssVar('--chart-info', CHART_PALETTE_LIGHT.semantic.info),
            success: cssVar('--chart-pass', CHART_PALETTE_LIGHT.semantic.success),
            warning: cssVar('--chart-warn', CHART_PALETTE_LIGHT.semantic.warning),
            danger: cssVar('--chart-fail', CHART_PALETTE_LIGHT.semantic.danger),
            neutral: cssVar('--chart-neutral', CHART_PALETTE_LIGHT.semantic.neutral)
        },
        doughnut: [
            cssVar('--chart-fail', CHART_PALETTE_LIGHT.doughnut[0]),
            cssVar('--chart-warn', CHART_PALETTE_LIGHT.doughnut[1]),
            cssVar('--chart-brand', CHART_PALETTE_LIGHT.doughnut[2]),
            cssVar('--chart-pass', CHART_PALETTE_LIGHT.doughnut[3])
        ],
        metricPresets: CHART_PALETTE_LIGHT.metricPresets
    };
}

export function paletteColor(index) {
    const p = getChartPalette();
    return p.series[index % p.series.length];
}

export function defaultWidgetColors(type, index = 0) {
    const p = getChartPalette();
    if (type === 'doughnut') {
        return { color: p.doughnut[0], color2: p.doughnut[1] };
    }
    if (type === 'evolution') {
        return {
            color: p.series[0],
            color2: p.series[2],
            color3: p.series[1]
        };
    }
    return { color: paletteColor(index) };
}
