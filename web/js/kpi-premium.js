/**
 * Premium executive KPI card helpers (DORA / FinOps).
 */

/**
 * @param {string} valueId - element id of .kpi-card-premium__value
 * @param {string} text - display value
 * @param {{ tone?: string, trend?: 'up'|'down'|'', trendText?: string }} [opts]
 */
export function setPremiumKpi(valueId, text, opts = {}) {
    const valueEl = document.getElementById(valueId);
    if (!valueEl) return;
    valueEl.textContent = text;

    valueEl.classList.remove('kpi-tone-info', 'kpi-tone-warn', 'kpi-tone-danger', 'kpi-tone-success', 'kpi-tone-neutral');
    if (opts.tone) {
        valueEl.classList.add(`kpi-tone-${opts.tone}`);
    }

    const card = valueEl.closest('.kpi-card-premium');
    if (!card) return;

    const trendEl = card.querySelector('.kpi-card-premium__trend');
    if (!trendEl) return;

    if (opts.trend === 'up' || opts.trend === 'down') {
        trendEl.hidden = false;
        trendEl.className = `kpi-card-premium__trend kpi-trend-${opts.trend}`;
        trendEl.textContent = opts.trendText || (opts.trend === 'up' ? '↑ Improving' : '↓ Watch');
    } else {
        trendEl.hidden = true;
        trendEl.textContent = '';
    }
}

export function premiumKpiSkeleton(label, valueId, trendId, extraClass = '') {
    return `
        <article class="kpi-card-premium ${extraClass}">
            <span class="kpi-card-premium__label">${label}</span>
            <span class="kpi-card-premium__value kpi-tone-neutral" id="${valueId}">-</span>
            <span class="kpi-card-premium__trend kpi-trend-up" id="${trendId}" hidden></span>
        </article>
    `;
}
