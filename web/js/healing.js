/**
 * Self-Healing Hub
 */
import { fetchWithAuth, parseApiJson, parseJwt } from './api.js';
import { notify, showConfirmModal } from './ui.js';
import { canManageHealing, canDeleteIncidents } from './roles.js?v=1.0.101-workflow-page';

let currentRole = '';
const selected = new Set(); // kept for bulk helpers that other views may call
let failures = [];
let activeId = 0;
let listMode = 'open';
const ANALYSIS_KEY = 'sre-healing-analyses';
const ACTIVE_KEY = 'sre-healing-active';
const analyses = new Map();

function loadStoredAnalyses() {
    try {
        const raw = sessionStorage.getItem(ANALYSIS_KEY);
        if (!raw) return;
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object') return;
        Object.entries(obj).forEach(([id, payload]) => {
            const n = Number(id);
            if (n && payload) analyses.set(n, payload);
        });
    } catch (_) { /* private mode or a corrupt cache */ }
}

function persistAnalyses() {
    try {
        const obj = {};
        analyses.forEach((payload, id) => { obj[id] = payload; });
        sessionStorage.setItem(ANALYSIS_KEY, JSON.stringify(obj));
    } catch (_) { /* quota: the in-memory copy still covers this tab */ }
}

function rememberActive(id) {
    activeId = id;
    try { sessionStorage.setItem(ACTIVE_KEY, String(id)); } catch (_) { /* ignore */ }
}

function storedActiveId() {
    try { return Number(sessionStorage.getItem(ACTIVE_KEY) || 0); } catch (_) { return 0; }
}

loadStoredAnalyses();

/* ── Framework / category metadata ─────────────────────────────────────── */
const FW = {
    robotframework: { label: 'Robot',      color: '#e67e22' },
    playwright:     { label: 'Playwright', color: '#7c5cfc' },
    cypress:        { label: 'Cypress',    color: '#17a974' },
    selenium:       { label: 'Selenium',   color: '#2e86c1' },
    pytest:         { label: 'Pytest',     color: '#0097a7' },
    newman:         { label: 'Newman',     color: '#c0392b' },
    jest:           { label: 'Jest',       color: '#c77b00' },
    junit:          { label: 'JUnit',      color: '#6d4c41' },
};
const FW_DEF = { label: 'Unknown', color: '#7f8c8d' };

const CAT = {
    timeout:        { label: 'Timeout',       mcp: 'Timeout',       color: '#d4a017' },
    locator:        { label: 'Locator',       mcp: 'Locator',       color: '#c0392b' },
    assertion:      { label: 'Assertion',     mcp: 'Assertion',     color: '#e67e22' },
    network:        { label: 'Network',       mcp: 'Network',       color: '#2980b9' },
    stale_element:  { label: 'Stale element', mcp: 'Stale element', color: '#6d28d9' },
    script_failure: { label: 'Script',        mcp: 'Script',        color: '#8e44ad' },
    unknown:        { label: 'Unknown',       mcp: 'Script',        color: '#95a5a6' },
};

const SPECIALISTS = [
    { id: 'locator', label: 'Locator' },
    { id: 'stale_element', label: 'Stale element' },
    { id: 'timeout', label: 'Timeout' },
    { id: 'assertion', label: 'Assertion' },
    { id: 'network', label: 'Network' },
    { id: 'script_failure', label: 'Script' },
];

const fw  = r => FW[(r || '').toLowerCase().replace(/[^a-z]/g, '')] || FW_DEF;
const cat = r => CAT[(r || '').toLowerCase().replace(/[^a-z_]/g, '')] || CAT.unknown;

function activeSpecialistId(category) {
    const id = String(category || '').toLowerCase().replace(/[^a-z_]/g, '');
    if (id === 'script_failure' || id === 'unknown' || !CAT[id]) return 'script_failure';
    return id;
}

function specialistGraph(category) {
    const active = activeSpecialistId(category);
    const nodes = SPECIALISTS.map(spec => {
        const on = spec.id === active;
        return `<span class="hc-spec${on ? ' is-active' : ''}" data-spec="${spec.id}" role="listitem"${on ? ' aria-current="true"' : ''}>${esc(spec.label)}</span>`;
    }).join('<span class="hc-spec__link" aria-hidden="true"></span>');
    return `<div class="hc-specs" role="list" aria-label="Specialists">${nodes}</div>`;
}

function syncSpecialistGraph(category) {
    const active = activeSpecialistId(category);
    document.querySelectorAll('#healing-stage .hc-spec').forEach(el => {
        const on = el.dataset.spec === active;
        el.classList.toggle('is-active', on);
        if (on) el.setAttribute('aria-current', 'true');
        else el.removeAttribute('aria-current');
    });
}
const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const ago = s => { if (!s) return ''; const m = Math.floor((Date.now() - new Date(s)) / 60000); return m < 2 ? 'just now' : m < 60 ? `${m}m ago` : Math.floor(m / 60) < 24 ? `${Math.floor(m/60)}h ago` : `${Math.floor(m/1440)}d ago`; };

/** Build search variants for the healed locator (Robot, Playwright, quoted forms). */
function locatorHighlightVariants(healed) {
    if (!healed) return [];
    const v = new Set([healed]);
    v.add(`'${healed}'`);
    v.add(`"${healed}"`);
    if (healed.startsWith('#')) {
        const id = healed.slice(1);
        v.add(`css=${healed}`);
        v.add(`id=${id}`);
    }
    return [...v].sort((a, b) => b.length - a.length);
}

const LOCATOR_TOKEN_RE = /^(#[\w-]+|css=[^\s,]+|id=[^\s,]+|xpath=[^\s,]+|\$\{?\w+\}?|\$[A-Z_]+|[\w-]+=[^\s,]+)$/;

function looksLikeLocatorToken(s) {
    if (!s) return false;
    return LOCATOR_TOKEN_RE.test(s.trim());
}

/** Extract healed selector from AI explanation text (backticks, quotes, plain). */
function extractHealedFromExplanation(explanation) {
    if (!explanation) return '';
    const patterns = [
        /replaced with(?:\s+the correct(?:\s+one|\s+locator|\s+selector)?)?\s+`([^`]+)`/i,
        /replaced with(?:\s+the correct(?:\s+one|\s+locator|\s+selector)?)?\s+'([^']+)'/i,
        /replaced with(?:\s+the correct(?:\s+one|\s+locator|\s+selector)?)?\s+"([^"]+)"/i,
        /replaced with(?:\s+the correct(?:\s+one|\s+locator|\s+selector)?)?\s+(#[\w-]+|css=[^\s,.]+|id=[^\s,.]+)/i,
        /changed to(?:\s+the correct(?:\s+one|\s+locator|\s+selector)?)?\s+`([^`]+)`/i,
        /changed to(?:\s+the correct(?:\s+one|\s+locator|\s+selector)?)?\s+'([^']+)'/i,
        /changed to(?:\s+the correct(?:\s+one|\s+locator|\s+selector)?)?\s+"([^"]+)"/i,
        /changed to(?:\s+the correct(?:\s+one|\s+locator|\s+selector)?)?\s+(#[\w-]+|css=[^\s,.]+|id=[^\s,.]+)/i,
        /correct selector\s+`([^`]+)`/i,
        /(?:fixed|healed)\s+selector:?\s*[`'"]([^`'"]+)[`'"]/i,
        /(?:use|using)\s+[`'"]([^`'"]+)[`'"]\s+instead/i,
        /selector\s+`([^`]+)`/i,
    ];
    for (const re of patterns) {
        const m = explanation.match(re);
        if (m?.[1]?.trim() && looksLikeLocatorToken(m[1].trim())) return m[1].trim();
    }
    for (const m of explanation.matchAll(/`([^`]+)`/g)) {
        const s = m[1].trim();
        if (!s || s.startsWith('${')) continue;
        if (looksLikeLocatorToken(s)) return s;
    }
    return '';
}

/** Extract broken selector from AI explanation when API omits original_locator. */
function extractOriginalFromExplanation(explanation) {
    if (!explanation) return '';
    const patterns = [
        /which was\s+(\$\{?\w+\}?|\$[A-Z_]+|#[\w-]+|css=[^\s,.]+|id=[^\s,.]+)/i,
        /incorrect locator(?:\s+for[^,.]+)?\s*,?\s*which was\s+(\$\{?\w+\}?|\$[A-Z_]+|#[\w-]+|css=[^\s,.]+|id=[^\s,.]+)/i,
        /broken locator[^.]*?\bwas\s+(\$\{?\w+\}?|\$[A-Z_]+|#[\w-]+|css=[^\s,.]+|id=[^\s,.]+)/i,
        /(?:from|replaced)\s+`([^`]+)`\s+(?:to|with)/i,
    ];
    for (const re of patterns) {
        const m = explanation.match(re);
        if (m?.[1]?.trim() && looksLikeLocatorToken(m[1].trim())) return m[1].trim();
    }
    return '';
}

function extractLocatorFromChangeLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return '';
    const action = trimmed.match(/^\s*(?:Click|Fill Text|Get Element|Tap|Type Text|Wait For Elements State)\s+(\S+)/i);
    if (action?.[1] && looksLikeLocatorToken(action[1])) return action[1];
    const tokens = trimmed.split(/\s+/);
    const last = tokens[tokens.length - 1];
    return looksLikeLocatorToken(last) ? last : trimmed;
}

const LOCATOR_ACTION_RE = /^\s*(Click|Get Element|Tap|Wait For Elements State)\s+(\S+)/i;
const FILL_ACTION_RE = /^\s*(Fill Text|Type Text)\s+(\S+)/i;

function robotVarName(token) {
    const m = String(token || '').trim().match(/^\$[\{]?([A-Za-z_]\w*)\}?$/);
    return m ? m[1] : '';
}

/** All spellings of a Robot variable reference (${X}, $X, $IX typo). */
function originalLocatorVariants(original) {
    if (!original) return [];
    const out = new Set([original]);
    const name = robotVarName(original);
    if (name) {
        out.add(`\${${name}}`);
        out.add(`$${name}`);
        out.add(`$I${name}`);
    } else if (/^\$I([A-Z_]+)$/.test(original)) {
        const n = original.slice(2);
        out.add(`\${${n}}`);
        out.add(`$${n}`);
    }
    return [...out];
}

function lineIncludesAny(line, terms) {
    return terms.some(t => t && line.includes(t));
}

function normalizeChangeLine(line) {
    return String(line || '').replace(/\s+/g, ' ').trim();
}

function linesEquivalent(a, b) {
    return normalizeChangeLine(a) === normalizeChangeLine(b);
}

function locatorTokensOnActionLine(line) {
    const m = line.match(LOCATOR_ACTION_RE) || line.match(FILL_ACTION_RE);
    return m?.[2]?.trim() || '';
}

function isFormFieldLocator(tok) {
    return /^id=(username|password|email|user|pass|login)$/i.test(tok || '');
}

function diffActionLocators(before, after) {
    const oldTok = locatorTokensOnActionLine(before);
    const newTok = locatorTokensOnActionLine(after);
    if (oldTok && newTok && oldTok !== newTok) return { oldTok, newTok };
    return { oldTok: oldTok || '', newTok: newTok || '' };
}

function findClickLocatorInCode(code) {
    for (const line of (code || '').split('\n')) {
        const m = line.match(LOCATOR_ACTION_RE);
        if (m && /^\$\{?[A-Za-z_]\w*\}?$/.test(m[2].trim())) return m[2].trim();
    }
    return '';
}

function shouldReplaceRobotVar(varTok, original, explanation) {
    const name = robotVarName(varTok);
    if (!name) return false;
    const expl = explanation || '';
    if (original && originalLocatorVariants(original).some(v => v === varTok || robotVarName(v) === name)) return true;
    if (expl.includes(varTok) || expl.includes(`\${${name}}`) || expl.includes(`$${name}`)) return true;
    if (new RegExp(`\\b${name}\\b`, 'i').test(expl)) return true;
    if (/broken|incorrect|outdated|wrong/i.test(expl) && /submit|click|button|locator|selector/i.test(expl)) {
        return /submit|broken|btn|click/i.test(name);
    }
    return false;
}

function findOriginalInCode(code, fallback, explanation) {
    if (fallback) {
        for (const v of originalLocatorVariants(fallback)) {
            if (code.includes(v)) return v;
        }
    }
    const clickVar = findClickLocatorInCode(code);
    if (clickVar && shouldReplaceRobotVar(clickVar, fallback, explanation)) return clickVar;
    return fallback || extractOriginalFromExplanation(explanation);
}

function applyFixPreview(code, original, healed, explanation) {
    if (!code || !healed || original === healed) return code || '';

    return code.split('\n').map(line => {
        const m = line.match(LOCATOR_ACTION_RE);
        if (!m) return line;

        const tok = m[2].trim();
        if (line.includes(healed)) return line;

        for (const t of originalLocatorVariants(original).sort((a, b) => b.length - a.length)) {
            if (t && line.includes(t)) return line.split(t).join(healed);
        }

        if (/^\$\{?[A-Za-z_]\w*\}?$/.test(tok) && shouldReplaceRobotVar(tok, original, explanation)) {
            return line.split(tok).join(healed);
        }
        return line;
    }).join('\n');
}

function highlightFixToken(line, token, precise) {
    if (!token || !line.includes(token)) return esc(line);
    return line.split(token).map(esc).join(fixHighlightSpan(token, precise ? 'verified' : 'fix'));
}

function highlightGreen(text) {
    if (!text) return '';
    return `<span class="hc-change-hl" style="background:#86efac;color:#052e16;font-weight:800;padding:0 4px;border-radius:3px">${esc(text)}</span>`;
}

/* Green-highlight only the slice of the new line that differs from the old one. */
function highlightUpdatedLine(before, after) {
    before = String(before ?? '');
    after = String(after ?? '');
    if (after === before) return esc(after);
    let start = 0;
    const max = Math.min(before.length, after.length);
    while (start < max && before[start] === after[start]) start++;
    let endBefore = before.length;
    let endAfter = after.length;
    while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
        endBefore--;
        endAfter--;
    }
    const mid = after.slice(start, endAfter);
    if (!mid) return esc(after);
    return esc(after.slice(0, start)) + highlightGreen(mid) + esc(after.slice(endAfter));
}

function quoteSelector(healed) {
    const s = String(healed || '');
    if (s.includes("'") && !s.includes('"')) return `"${s}"`;
    return `'${s}'`;
}

function applyAssignmentPreview(code, original, healed) {
    if (!code || !original || !healed || original === healed) return code || '';
    const quoted = quoteSelector(healed);
    const lines = String(code).replace(/\r\n/g, '\n').split('\n');
    const names = [];
    for (const line of lines) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(['"])(.*)\2\s*$/);
        if (m && m[3] === original) names.push(m[1]);
    }
    return lines.map(line => {
        let next = line.split(`'${original}'`).join(quoted).split(`"${original}"`).join(quoted);
        for (const name of names) {
            const q = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            next = next
                .replace(new RegExp(`(find_element(?:s)?\\s*\\(\\s*By\\.\\w+\\s*,\\s*)${q}(\\s*\\))`), `$1${quoted}$2`)
                .replace(new RegExp(`((?:page\\.)?locator\\s*\\(\\s*)${q}(\\s*\\))`), `$1${quoted}$2`)
                .replace(new RegExp(`(cy\\.get\\s*\\(\\s*)${q}(\\s*\\))`), `$1${quoted}$2`);
        }
        return next;
    }).join('\n');
}

function overlayChangeLines(display, changeLines) {
    const lines = String(display || '').replace(/\r\n/g, '\n').split('\n');
    for (const r of (Array.isArray(changeLines) ? changeLines : [])) {
        const before = String(r?.before || '');
        const after = String(r?.after || '');
        if (!before.trim() || !after.trim() || before.trim() === after.trim()) continue;
        let idx = Number(r.line) > 0 ? Number(r.line) - 1 : -1;
        if (idx < 0 || !lines[idx] || lines[idx].trim() !== before.trim()) {
            idx = lines.findIndex(l => l.trim() === before.trim());
        }
        if (idx < 0) continue;
        const indent = (lines[idx].match(/^\s*/) || [''])[0];
        lines[idx] = after.startsWith(' ') || after.startsWith('\t') ? after : indent + after.trim();
    }
    return lines.join('\n');
}

function beforeForLine(i, line, srcLines, changeLines) {
    for (const r of (Array.isArray(changeLines) ? changeLines : [])) {
        if (Number(r?.line) === i + 1 && r.before && r.after && String(r.after).trim() === line.trim()) {
            return String(r.before);
        }
    }
    for (const r of (Array.isArray(changeLines) ? changeLines : [])) {
        if (r?.after && String(r.after).trim() === line.trim() && r.before) return String(r.before);
    }
    return srcLines[i] ?? '';
}
function changedLineIndexes(sourceCode, displayCode) {
    const src = String(sourceCode || '').replace(/\r\n/g, '\n').split('\n');
    const dst = String(displayCode || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    if (!String(sourceCode || '').trim()) {
        dst.forEach((_, i) => out.push(i));
        return out;
    }
    const n = Math.max(src.length, dst.length);
    for (let i = 0; i < n; i++) {
        if ((src[i] ?? '') !== (dst[i] ?? '')) out.push(i);
    }
    return out;
}

function renderHighlightedLines(displayCode, sourceCode, changeLines) {
    const srcLines = String(sourceCode || '').replace(/\r\n/g, '\n').split('\n');
    const dstLines = String(displayCode || '').replace(/\r\n/g, '\n').split('\n');
    return dstLines.map((line, i) => {
        const oldLine = beforeForLine(i, line, srcLines, changeLines);
        const isChange = oldLine !== line;
        const rowCls = isChange ? 'hc-code-line hc-code-line--verified' : 'hc-code-line';
        const content = isChange ? highlightUpdatedLine(oldLine, line) : esc(line);
        return `<div class="${rowCls}"><span class="hc-code-line__n">${i + 1}</span><span class="hc-code-line__t">${content}</span></div>`;
    }).join('');
}

function renderFixCodeBlock(code, data, id) {
    if (!code && !data?.source_code && !data?.change_lines) return '';
    data = normalizeFixResponse(data);
    const expl = data?.explanation || '';
    const locs = resolveFixLocators(data);
    const sourceCode = String(data?.source_code || '').replace(/\r\n/g, '\n');
    const base = sourceCode.trim() ? sourceCode : String(code || '');
    let displayCode = applyAssignmentPreview(
        applyFixPreview(base, locs.original, locs.healed, expl),
        locs.original,
        locs.healed,
    );
    if (code && locs.healed && String(code).includes(locs.healed) && changedLineIndexes(base, code).length) {
        displayCode = String(code).replace(/\r\n/g, '\n');
    }
    displayCode = overlayChangeLines(displayCode, data.change_lines);
    const changed = changedLineIndexes(sourceCode || base, displayCode);
    if (!changed.length) return '';
    const lines = renderHighlightedLines(displayCode, sourceCode || base, data.change_lines);
    const path = String(data.source_path || '').trim();
    return `<div class="hc-panel__code hc-panel__code--updated">
        <div class="hc-panel__code-head"><strong>Code updated</strong>${path ? `<span>${esc(path)}</span>` : ''}</div>
        <div class="hc-code-lines" role="presentation">${lines}</div>
    </div>`;
}

function inferHealedLocatorFromCode(code, original) {
    if (!code || !original) return '';
    const origTerms = originalLocatorVariants(original);
    if (lineIncludesAny(code, origTerms)) return '';

    const counts = new Map();
    for (const line of code.split('\n')) {
        const m = line.match(LOCATOR_ACTION_RE);
        if (!m) continue;
        const tok = m[2].trim();
        if (!looksLikeLocatorToken(tok)) continue;
        if (lineIncludesAny(tok, origTerms)) continue;
        if (/^\$\{?\w+\}?$/.test(tok)) continue;
        if (isFormFieldLocator(tok)) continue;
        counts.set(tok, (counts.get(tok) || 0) + 1);
    }
    let best = '';
    let bestScore = -1;
    for (const [tok, n] of counts) {
        let score = n * 10;
        if (tok.startsWith('#')) score += 5;
        if (tok.startsWith('css=')) score += 4;
        if (score > bestScore || (score === bestScore && tok.length > best.length)) {
            best = tok;
            bestScore = score;
        }
    }
    return best;
}

function buildHealedSearchTerms(healed) {
    if (!healed) return [];
    const terms = [healed];
    if (healed.startsWith('#')) {
        terms.push(`css=${healed}`, `id=${healed.slice(1)}`);
    }
    for (const v of [...terms]) {
        terms.push(`Click    ${v}`, `Click\t${v}`, `Click ${v}`, `Get Element    ${v}`, `Get Element ${v}`);
    }
    return [...new Set(terms)];
}

function isDarkTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark'
        || document.body.getAttribute('data-theme') === 'dark';
}

function isPreciseFix(data) {
    return data?.precision === 'high' && !!data?.dom_verified;
}

function fixHighlightSpan(term, kind) {
    const dark = isDarkTheme();
    const verified = kind === 'verified';
    const cls = kind === 'old'
        ? 'hc-tok hc-tok--old hc-code-fix-old'
        : (verified ? 'hc-tok hc-tok--verified hc-code-fix-hl' : 'hc-tok hc-tok--fix hc-code-fix-hl');
    const style = kind === 'old'
        ? (dark ? 'background:rgba(251,146,60,0.25);color:#fdba74;text-decoration:line-through;padding:1px 4px;border-radius:3px'
            : 'background:#ffedd5;color:#c2410c;text-decoration:line-through;padding:1px 4px;border-radius:3px')
        : (dark ? 'background:rgba(34,197,94,0.45);color:#dcfce7;font-weight:800;padding:1px 5px;border-radius:3px'
            : (verified
                ? 'background:#bbf7d0;color:#14532d;font-weight:800;padding:1px 5px;border-radius:3px'
                : 'background:#fde68a;color:#92400e;font-weight:800;padding:1px 5px;border-radius:3px'));
    return `<span class="${cls}" style="${style}">${esc(term)}</span>`;
}

function codeIncludesAnyVariant(code, locator) {
    if (!code || !locator) return false;
    return locatorHighlightVariants(locator).some(v => code.includes(v));
}

function normalizeFixResponse(data) {
    if (!data || typeof data !== 'object') return data || {};
    const out = { ...data };
    const rawCode = String(out.code || '').trim();
    if (rawCode.startsWith('{') || rawCode.startsWith('[')) {
        try {
            const parsed = JSON.parse(rawCode);
            if (parsed && typeof parsed === 'object') {
                if (parsed.code && typeof parsed.code === 'string') out.code = parsed.code;
                if (parsed.explanation && typeof parsed.explanation === 'string') out.explanation = parsed.explanation;
                if (typeof parsed.confidence === 'number') out.confidence = parsed.confidence;
                if (parsed.healed_locator && typeof parsed.healed_locator === 'string') out.healed_locator = parsed.healed_locator;
                if (parsed.original_locator && typeof parsed.original_locator === 'string') out.original_locator = parsed.original_locator;
            }
        } catch { /* keep raw */ }
    }
    if (out.explanation === 'LLM returned non-JSON; raw output used as code.') {
        const locs = resolveFixLocators(out);
        if (locs.healed || (out.code && !String(out.code).trim().startsWith('{'))) {
            out.explanation = '';
        }
    }
    return out;
}

function resolveFixLocators(data) {
    let original = (data?.original_locator || '').trim();
    let healed = (data?.healed_locator || '').trim();
    const expl = data?.explanation || '';
    const code = data?.code || '';
    if (!healed) healed = extractHealedFromExplanation(expl);
    if (!original) original = extractOriginalFromExplanation(expl);
    const changeRows = Array.isArray(data?.change_lines) ? data.change_lines : [];
    if (!healed) {
        for (const row of changeRows) {
            const after = extractLocatorFromChangeLine(row?.after);
            if (after) { healed = after; break; }
        }
    }
    if (!original) {
        for (const row of changeRows) {
            const before = extractLocatorFromChangeLine(row?.before);
            if (before) { original = before; break; }
        }
    }
    if (code) original = findOriginalInCode(code, original, expl);
    if (!healed && code && original) healed = inferHealedLocatorFromCode(code, original);
    if (!healed) healed = extractHealedFromExplanation(expl);
    return { original, healed };
}

function highlightLineTerms(line, planEntry) {
    if (!planEntry?.terms?.length) return esc(line);
    let out = esc(line);
    const sorted = [...planEntry.terms].sort((a, b) => b.length - a.length);
    for (const term of sorted) {
        if (!line.includes(term)) continue;
        const span = fixHighlightSpan(term, planEntry.kind === 'old' ? 'old' : 'fix');
        out = line.split(term).map(esc).join(span);
        return out;
    }
    return out;
}

function renderChangeLines(changeLines, original, healed, precise, sourcePath) {
    let rows = Array.isArray(changeLines) ? changeLines.filter(r => r?.before && r?.after) : [];
    if (!rows.length && original && healed && original !== healed) {
        rows = [{ before: original, after: healed }];
    }
    if (!rows.length) return '';
    const callRe = /find_element|locator\s*\(|cy\.get|^\s*Click\b/i;
    rows = [...rows].sort((a, b) => {
        const sa = callRe.test(a.after || a.before || '') ? 0 : 1;
        const sb = callRe.test(b.after || b.before || '') ? 0 : 1;
        return sa - sb;
    });
    const where = String(sourcePath || '').trim();
    return `<div class="hc-fix-changes">
        <div class="hc-fix-changes__head">What changes${where ? ` · ${esc(where)}` : ''}</div>
        ${rows.map(r => {
            const lineNo = Number(r.line) > 0 ? `Line ${Number(r.line)}` : 'Change';
            const after = healed && String(r.after).includes(healed)
                ? highlightFixToken(r.after, healed, precise)
                : esc(r.after);
            return `
        <div class="hc-fix-change">
            <div class="hc-fix-change__row hc-fix-change__row--old">
                <span class="hc-fix-change__tag">${esc(lineNo)} before</span>
                <code>${esc(r.before)}</code>
            </div>
            <div class="hc-fix-change__row hc-fix-change__row--verified">
                <span class="hc-fix-change__tag">${esc(lineNo)} after</span>
                <code>${after}</code>
            </div>
        </div>`;
        }).join('')}
    </div>`;
}

/* ── Icons SVG ────────────────────────────────────────────────────────── */
const ICON = {
    fix:     `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`,
    context: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
    copy:    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
    trash:   `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M9 6V4h6v2"/></svg>`,
    refresh: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.08-1.96"/></svg>`,
    arrow:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`,
    close:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    check:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    star:    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></svg>`,
};

/* ── Init ─────────────────────────────────────────────────────────────── */
window.loadHealingView = loadHealingView;
export function loadHealingView() {
    if (!document.getElementById('healing-insights-body')) return;
    currentRole = parseJwt(localStorage.getItem('sre-jwt'))?.role || '';
    const sel = document.getElementById('healing-project-filter');
    loadHealingProjects(sel);
    const list = document.getElementById('healing-insights-body');
    if (list && !list.dataset.bound) {
        list.dataset.bound = '1';
        list.addEventListener('click', (event) => {
            if (event.target.closest('.hc-row-check')) return;
            const row = event.target.closest('.hc-row');
            if (!row) return;
            selectFailure(Number(row.dataset.id));
        });
        list.addEventListener('change', (event) => {
            const cb = event.target.closest?.('.hc-cb');
            if (!cb) return;
            window._onCardCheck(Number(cb.value), cb.checked);
        });
    }
    const selectBar = document.getElementById('hc-list-select');
    if (selectBar) selectBar.hidden = !canDeleteIncidents(currentRole);
    if (selectBar && !selectBar.dataset.bound) {
        selectBar.dataset.bound = '1';
        document.getElementById('hc-select-all')?.addEventListener('change', (event) => window._selectAll(event.target.checked));
        document.getElementById('hc-bulk-delete')?.addEventListener('click', () => window.bulkDelete());
        document.getElementById('hc-bulk-archive')?.addEventListener('click', () => window.bulkArchive());
    }
    if (!document.body.dataset.hcListModeBound) {
        document.body.dataset.hcListModeBound = '1';
        document.querySelectorAll('.hc-list-switch__btn').forEach(btn => {
            btn.addEventListener('click', () => setListMode(btn.dataset.mode));
        });
    }
    syncListModeChrome();
    loadHealingInsights();
    _loadAIChip();
    if (sel && !sel.dataset.bound) {
        sel.dataset.bound = '1';
        sel.addEventListener('change', () => loadHealingInsights());
    }
}

async function _loadAIChip() {
    const chip = document.getElementById('healing-ai-chip');
    if (!chip) return;
    try {
        const { ok, data } = await parseApiJson(await fetchWithAuth('/api/ai/status'));
        if (ok && data?.enabled && data.provider !== 'disabled') {
            chip.innerHTML = `<span class="hc-dot hc-dot--live"></span>${esc(data.provider.toUpperCase())} · ${esc(data.model || '-')}`;
            chip.className = 'hc-chip hc-chip--on';
        } else {
            chip.innerHTML = `<span class="hc-dot"></span>AI off`;
            chip.className = 'hc-chip hc-chip--off';
        }
    } catch { if (chip) { chip.textContent = 'AI -'; chip.className = 'hc-chip hc-chip--off'; } }
}

async function loadHealingProjects(sel) {
    if (!sel) return;
    const { ok, data } = await parseApiJson(await fetchWithAuth('/api/my-projects'));
    sel.innerHTML = '<option value="">All gateways</option>';
    if (ok) (Array.isArray(data) ? data : []).forEach(p =>
        sel.innerHTML += `<option value="${esc(p.name)}">${esc(p.name)}</option>`
    );
}

/* ── Load failures ────────────────────────────────────────────────────── */
export async function loadHealingInsights() {
    const body = document.getElementById('healing-insights-body');
    if (!body) return;
    const project = document.getElementById('healing-project-filter')?.value || '';
    const params = new URLSearchParams({ limit: '100' });
    if (project) params.set('project', project);
    if (listMode === 'archive') params.set('archived', '1');
    const q = `?${params.toString()}`;

    body.innerHTML = `<div class="hc-loading">Loading…</div>`;

    const { ok, data } = await parseApiJson(await fetchWithAuth(`/api/healing/insights${q}`));
    if (!ok) { body.innerHTML = `<div class="hc-empty">Failed to load failures.</div>`; updateStats([]); return; }
    const rows = Array.isArray(data) ? data : [];
    updateStats(rows);
    selected.clear();
    _updateBulkBar();
    const selectAll = document.getElementById('hc-select-all');
    if (selectAll) { selectAll.checked = false; selectAll.indeterminate = false; }

    if (!rows.length) {
        body.innerHTML = `<div class="hc-empty">${listMode === 'archive' ? 'No archived failures.' : 'No open failures - all tests are passing.'}</div>`;
        return;
    }
    failures = rows;
    body.innerHTML = rows.map(r => renderRow(r)).join('');
    const pending = Number(window.__pendingProposeId || 0);
    if (pending) {
        window.__pendingProposeId = 0;
        selectFailure(pending, true);
        return;
    }
    if (!activeId) {
        const saved = storedActiveId();
        if (saved && analyses.has(saved) && failures.some(r => Number(r.incident_id) === saved)) {
            selectFailure(saved, false);
            return;
        }
    }
    if (activeId && failures.some(r => Number(r.incident_id) === activeId)) {
        document.querySelectorAll('.hc-row-wrap, .hc-row').forEach(el => el.classList.toggle('is-active', Number(el.dataset.id) === activeId));
        const stage = document.getElementById('healing-stage');
        if (stage && !stage.querySelector('.hc-panel__inner') && analyses.has(activeId)) selectFailure(activeId, false);
        return;
    }
    activeId = 0;
    const stage = document.getElementById('healing-stage');
    if (stage && !stage.querySelector('.hc-stage__empty')) stage.innerHTML = emptyStage();
}
window.loadHealingInsights = loadHealingInsights;

function updateStats(rows) {
    _count('healing-stat-total', rows.length);
}

function emptyStage() {
    return `<div class="hc-stage__empty">
        <h2>Select a failure</h2>
        <p>The analysis stays on that test. A confirmed locator can be written into the file, then the test is re-run.</p>
    </div>`;
}

function shortTestName(name) {
    const raw = String(name || 'Unknown test');
    const parts = raw.split('>');
    const last = parts[parts.length - 1].trim();
    return last || raw;
}

function selectFailure(id, autoAnalyze) {
    const row = failures.find(item => Number(item.incident_id) === id);
    const stage = document.getElementById('healing-stage');
    if (!row || !stage) return;
    rememberActive(id);
    document.querySelectorAll('.hc-row-wrap, .hc-row').forEach(el => el.classList.toggle('is-active', Number(el.dataset.id) === id));
    const cause = cat(row.error_category);
    const framework = fw(row.framework || row.project_name);
    const causeStyle = `color:${cause.color};border-color:${cause.color}30;background:${cause.color}18`;
    const role = currentRole || parseJwt(localStorage.getItem('sre-jwt'))?.role || '';
    const canMgr = canManageHealing(role);
    const canDel = canDeleteIncidents(role);
    const fullName = row.test_name || 'Unknown test';
    const shortName = shortTestName(fullName);
    stage.innerHTML = `
        <header class="hc-stage__top">
            <div class="hc-stage__identity">
                <p class="hc-stage__kicker">#${id} · ${esc(framework.label)}</p>
                <h2 title="${esc(fullName)}">${esc(shortName)}</h2>
                <div class="hc-stage__pills">
                    <span class="hc-badge" style="${causeStyle}">${esc(cause.label)}</span>
                    ${row.mcp_healed ? `<span class="hc-badge hc-badge--healed">${ICON.check}&nbsp;Saved</span>` : ''}
                </div>
                ${specialistGraph(row.error_category)}
            </div>
            <div class="hc-stage__actions">
                ${canMgr ? `<button type="button" class="btn btn-primary" id="hc-analyze">${analyses.has(id) ? 'Analyze again' : 'Analyze'}</button>` : `<p class="hc-stage__note">A lead or manager can analyze this failure.</p>`}
                ${canDel ? `<button type="button" class="hc-quiet" id="hc-delete">Delete</button>` : ''}
            </div>
        </header>
        <ol class="hc-steps" aria-label="Healing steps">
            <li class="is-current"><span>1</span> Analyze</li>
            <li><span>2</span> Review</li>
            <li><span>3</span> Apply and re-run</li>
        </ol>
        <p class="hc-stage__error">${esc(row.summary || row.error_message || 'No description available.')}</p>
        <p class="hc-stage__hint">Analyze reads this failure and the captured page. The test file changes only when you apply a confirmed selector.</p>
        <div id="healing-stage-result" class="hc-stage__result"></div>`;
    stage.querySelector('#hc-analyze')?.addEventListener('click', () => openProposeFix(id));
    stage.querySelector('#hc-delete')?.addEventListener('click', () => deleteHealingFailure(id));
    if (analyses.has(id)) paintAnalysis(id, analyses.get(id));
    else if (autoAnalyze) openProposeFix(id);
}

function markSteps(current) {
    document.querySelectorAll('#healing-stage .hc-steps li').forEach((li, index) => {
        li.classList.toggle('is-done', index + 1 < current);
        li.classList.toggle('is-current', index + 1 === current);
    });
}

function _count(id, n) {
    const el = document.getElementById(id);
    if (!el) return;
    const from = parseInt(el.textContent) || 0;
    if (from === n) { el.textContent = n; return; }
    const t0 = performance.now();
    const tick = now => { const p = Math.min((now - t0) / 500, 1); el.textContent = Math.round(from + (n - from) * p); if (p < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
}

/* ── Render one card ──────────────────────────────────────────────────── */
function renderRow(r) {
    const id = Number(r.incident_id) || 0;
    const framework = fw(r.framework || r.project_name);
    const cause = cat(r.error_category);
    const active = id === activeId ? ' is-active' : '';
    const analyzed = analyses.has(id) ? ' · analyzed' : '';
    const check = canDeleteIncidents(currentRole)
        ? `<label class="hc-row-check"><input type="checkbox" class="hc-cb" value="${id}" aria-label="Select failure ${id}"${selected.has(id) ? ' checked' : ''}></label>`
        : '';
    return `
<div class="hc-row-wrap${active}" id="hc-card-${id}" data-id="${id}" role="listitem">
    ${check}
    <button type="button" class="hc-row${active}" data-id="${id}">
        <span class="hc-row__top">
            <span class="hc-row__cause" style="color:${cause.color}">${esc(cause.label)}</span>
            <span class="hc-row__id">#${id}</span>
        </span>
        <span class="hc-row__name">${esc(shortTestName(r.test_name))}</span>
        <span class="hc-row__meta">${esc(framework.label)}${r.mcp_healed ? ' · saved' : ''}${analyzed}</span>
    </button>
</div>`;
}

/* ── Checkbox / bulk select ───────────────────────────────────────────── */
window._onCardCheck = (id, checked) => {
    if (checked) selected.add(id); else selected.delete(id);
    _updateBulkBar();
    _syncSelectAll();
};

window._selectAll = checked => {
    const sa = document.getElementById('hc-select-all');
    if (sa) { sa.checked = !!checked; sa.indeterminate = false; }
    document.querySelectorAll('.hc-cb').forEach(cb => {
        cb.checked = checked;
        const id = parseInt(cb.value);
        if (checked) selected.add(id); else selected.delete(id);
    });
    _updateBulkBar();
};

function _updateBulkBar() {
    const bar = document.getElementById('hc-bulk-bar');
    const cnt = document.getElementById('hc-bulk-count');
    if (!bar) return;
    bar.hidden = selected.size === 0;
    if (cnt) cnt.textContent = `${selected.size} selected`;
}

function _syncSelectAll() {
    const allCbs = document.querySelectorAll('.hc-cb');
    const sa = document.getElementById('hc-select-all');
    if (!sa || !allCbs.length) return;
    const allChecked = [...allCbs].every(cb => cb.checked);
    const someChecked = [...allCbs].some(cb => cb.checked);
    sa.checked = allChecked;
    sa.indeterminate = someChecked && !allChecked;
}

window.bulkDelete = async () => {
    if (!selected.size) return;
    if (!canDeleteIncidents(currentRole)) { notify('Manager or Lead role required.', 'error'); return; }
    const ids = [...selected];
    window.showConfirmModal('Delete failures?', `Delete ${ids.length} selected failure(s)?`, 'danger', async () => {
        const { ok } = await parseApiJson(await fetchWithAuth(`/api/incidents?ids=${ids.join(',')}`, { method: 'DELETE' }));
        if (!ok) { notify('Failed to delete.', 'error'); return; }
        forgetFailures(ids);
        notify(`${ids.length} failure(s) deleted.`, 'success');
        loadHealingInsights();
    });
};

window.bulkArchive = async () => {
    if (!selected.size) return;
    if (!canDeleteIncidents(currentRole)) { notify('Manager or Lead role required.', 'error'); return; }
    const restoring = listMode === 'archive';
    const ids = [...selected];
    const title = restoring ? 'Restore failures?' : 'Archive failures?';
    const message = restoring
        ? `Restore ${ids.length} selected failure(s) to Open failures?`
        : `Archive ${ids.length} selected failure(s)? They leave this list and stay stored.`;
    window.showConfirmModal(title, message, 'warning', async () => {
        const { ok } = await parseApiJson(await fetchWithAuth('/api/incidents', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, archived: !restoring }),
        }));
        if (!ok) { notify(restoring ? 'Failed to restore.' : 'Failed to archive.', 'error'); return; }
        forgetFailures(ids);
        notify(`${ids.length} failure(s) ${restoring ? 'restored' : 'archived'}.`, 'success');
        loadHealingInsights();
    });
};

function setListMode(mode) {
    listMode = mode === 'archive' ? 'archive' : 'open';
    syncListModeChrome();
    loadHealingInsights();
}

function syncListModeChrome() {
    const title = document.getElementById('healing-list-title');
    if (title) title.textContent = listMode === 'archive' ? 'Archive' : 'Open failures';
    document.getElementById('hc-tab-open')?.classList.toggle('is-active', listMode === 'open');
    document.getElementById('hc-tab-archive')?.classList.toggle('is-active', listMode === 'archive');
    const action = document.getElementById('hc-bulk-archive');
    if (action) action.textContent = listMode === 'archive' ? 'Restore' : 'Archive';
}

function forgetFailures(ids) {
    ids.forEach(id => {
        analyses.delete(Number(id));
        selected.delete(Number(id));
        if (activeId === Number(id)) {
            activeId = 0;
            const stage = document.getElementById('healing-stage');
            if (stage) stage.innerHTML = emptyStage();
        }
    });
    persistAnalyses();
    _updateBulkBar();
}

/* ── Delete single ────────────────────────────────────────────────────── */
export function deleteHealingFailure(id) {
    if (!canDeleteIncidents(currentRole)) { notify('Manager or Lead role required.', 'error'); return; }
    window.showConfirmModal('Delete failure?', `Delete INC #${id}?`, 'danger', async () => {
        const { ok } = await parseApiJson(await fetchWithAuth(`/api/incidents?ids=${id}`, { method: 'DELETE' }));
        if (!ok) { notify('Failed to delete.', 'error'); return; }
        forgetFailures([id]);
        notify(`INC #${id} deleted.`, 'success');
        loadHealingInsights();
    });
}
window.deleteHealingFailure = deleteHealingFailure;

window.openProposeFromSheet = (id) => {
    window.__pendingProposeId = id;
    if (typeof window.closeExecutionSheet === 'function') window.closeExecutionSheet();
    const nav = document.querySelector('.nav-item[onclick*="healing"]');
    if (typeof window.switchView === 'function') window.switchView('healing', nav);
};

const HEAL_METHOD_LABEL = {
    html_scan: 'Matched on the page DOM',
    ai_dom:    'AI read the test and the page',
    ai:        'AI analysis',
    rules:     'Rules (no DOM)',
    comments:  'Test file comments',
    unconfirmed: 'Not confirmed on the page',
    no_dom:    'Page HTML was not stored',
};

function formatConfidenceBadge(data, locs) {
    const pct = data.confidence ? Math.round(data.confidence * 100) : 0;
    const domOk = data.dom_used;
    const methodLbl = HEAL_METHOD_LABEL[data.heal_method] || (domOk ? 'DOM analyzed' : 'No DOM snapshot');
    const sameSelector = locs.original && locs.healed && locs.original === locs.healed;
    const noFix = !locs.healed || sameSelector;
    if (noFix) {
        const why = data.heal_method === 'no_dom'
            ? 'Not confirmed - the page HTML was not stored with this failure'
            : 'Not confirmed - the model will not guess a selector';
        return { conf: 'low', precise: false, label: why, pct: 0 };
    }
    if (isPreciseFix(data)) {
        return { conf: 'high', precise: true, label: `Verified on the page (${pct}%)`, pct };
    }
    if (data.heal_method === 'comments') {
        return { conf: 'mid', precise: false, label: 'Named in the test file · not verified on the failure page', pct };
    }
    if (data.precision === 'medium') {
        return { conf: 'mid', precise: false, label: `Possible match (${pct}%) · not unique enough to apply blindly`, pct };
    }
    const conf = pct >= 70 ? 'high' : pct >= 45 ? 'mid' : 'low';
    const tier = pct >= 70 ? 'High confidence' : pct >= 45 ? 'Medium confidence' : 'Low confidence';
    return { conf, precise: false, label: `${tier} (${pct}%) · ${methodLbl}`, pct };
}

function resolveDisplayCode(data) {
    data = normalizeFixResponse(data);
    const locs = resolveFixLocators(data);
    const sourceCode = (data?.source_code || '').trim() || (data?.code || '');
    let displayCode = data?.code || '';
    if (locs.healed && displayCode) {
        if (sourceCode === displayCode || !displayCode.includes(locs.healed)) {
            displayCode = applyFixPreview(sourceCode, locs.original, locs.healed, data?.explanation || '') || displayCode;
        }
    }
    return displayCode;
}

function markRowAnalyzed(id) {
    const meta = document.querySelector(`.hc-row[data-id="${id}"] .hc-row__meta`);
    if (meta && !meta.textContent.includes('analyzed')) meta.textContent = `${meta.textContent} · analyzed`;
    const btn = document.getElementById('hc-analyze');
    if (btn && Number(document.querySelector('.hc-row.is-active')?.dataset.id) === id) btn.textContent = 'Analyze again';
}

/* Paint a stored or fresh proposal into the open failure. Does not call the model. */
function paintAnalysis(id, data) {
    const panel = document.getElementById('healing-stage-result');
    if (!panel || activeId !== id) return;
    document.querySelector('#healing-stage .hc-stage__hint')?.remove();
    const fix = normalizeFixResponse(data);
        const locs = resolveFixLocators(fix);
        const badge = formatConfidenceBadge(fix, locs);
        const domOk = fix.dom_used;
        const mcpId = fix.active_mcp || fix.error_category || '';
        syncSpecialistGraph(mcpId);
        const locatorMCP = mcpId === 'locator' || (!mcpId && !!(locs.original || locs.healed));
        const mcpLabel = fix.active_mcp_label || (CAT[mcpId] && CAT[mcpId].mcp) || '';
        const problem = (fix.problem || '').trim();

        // Locator diff only when the locator MCP is the one that ran.
        let locRow = '';
        if (locatorMCP && (locs.original || locs.healed)) {
            const fixedDisplay = (locs.healed && locs.healed !== locs.original) ? locs.healed : '-';
            const fixedClass = badge.precise ? 'hc-loc hc-loc--ok' : 'hc-loc hc-loc--hold';
            locRow = `
            <div class="hc-locrow">
                <div class="hc-locrow__col">
                    <span class="hc-loclbl">Broken selector</span>
                    <code class="hc-loc hc-loc--bad">${esc(locs.original || '-')}</code>
                </div>
                <span class="hc-arrow">${ICON.arrow}</span>
                <div class="hc-locrow__col">
                    <span class="hc-loclbl">Fixed selector</span>
                    <code class="${fixedClass}">${esc(fixedDisplay)}</code>
                </div>
                <span class="hc-conf hc-conf--${badge.conf}">${esc(badge.label)}</span>
            </div>`;
        }

        const intent = locatorMCP ? (fix.intent || '').trim() : '';
        const intentBlock = intent
            ? `<div class="hc-intent${badge.precise ? ' hc-intent--ok' : ''}"><strong>What the test is doing</strong><p>${esc(intent)}</p></div>`
            : '';

        const mcpBlock = (mcpLabel || problem)
            ? `<div class="hc-mcp"><div class="hc-mcp__top"><span class="hc-mcp__dot" aria-hidden="true"></span><strong>${esc(mcpLabel || 'Cause')}</strong></div>${problem ? `<p>${esc(problem)}</p>` : ''}</div>`
            : '';

        const domNote = locatorMCP && !domOk
            ? `<p class="hc-panel__dom-note">${esc(fix.dom_capture_hint || 'This run did not store the page HTML, so a replacement cannot be verified.')}</p>`
            : '';

        const explText = (fix.explanation || '').trim();
        const expl = explText && explText !== problem
            ? `<div class="hc-panel__expl"><strong>Explanation</strong><p>${esc(explText)}</p></div>`
            : '';

        const code = (locatorMCP || fix.code) && fix.code ? renderFixCodeBlock(fix.code, fix, id) : '';
        const saved = '';
        const role = currentRole || parseJwt(localStorage.getItem('sre-jwt'))?.role || '';
        const canApply = badge.precise && locs.healed && locs.healed !== locs.original
            && fix.source_path && canManageHealing(role);
        const canRerun = badge.precise && String(fix.source_path || '').endsWith('.py') && canManageHealing(role);
        const applyBlock = (canApply || canRerun)
            ? `<div class="hc-panel__actions">
                ${canApply ? `<button type="button" class="btn btn-primary btn-sm" id="hc-apply-${id}">Apply to test</button>` : ''}
                ${canRerun ? `<button type="button" class="btn btn-sm" id="hc-rerun-${id}">Re-run test</button>` : ''}
                <p class="hc-panel__dom-note" id="hc-apply-note-${id}"></p>
                <pre class="hc-rerun-out" id="hc-rerun-out-${id}" hidden></pre>
            </div>`
            : '';
        window[`__fixCode_${id}`] = resolveDisplayCode(fix);

        markSteps(badge.precise ? 3 : 2);
        panel.innerHTML = `
        <div class="hc-panel__inner">
            <div class="hc-panel__head">
                <span class="hc-panel__title">${esc(mcpLabel || 'Result')}</span>
            </div>
            ${mcpBlock}
            ${locRow}
            ${intentBlock}
            ${domNote}
            ${expl}
            ${saved}
            ${code}
            ${applyBlock}
        </div>`;
        const analyzeBtn = document.getElementById('hc-analyze');
        if (analyzeBtn) analyzeBtn.disabled = false;
        const applyBtn = panel.querySelector(`#hc-apply-${id}`);
        if (applyBtn) {
            applyBtn.addEventListener('click', () => {
                showConfirmModal(
                    'Apply to test',
                    `Write ${locs.healed} into ${fix.source_path}?`,
                    'warning',
                    () => writeConfirmedLocator(id, locs.healed, applyBtn),
                );
            });
        }
        const rerunBtn = panel.querySelector(`#hc-rerun-${id}`);
        if (rerunBtn) {
            rerunBtn.addEventListener('click', () => {
                showConfirmModal(
                    'Re-run test',
                    'Run this test again? The incident is resolved only if it passes.',
                    'warning',
                    () => rerunHealedTest(id, rerunBtn),
                );
            });
        }
        const changedRow = panel.querySelector('.hc-code-line--verified');
        const box = panel.querySelector('.hc-code-lines');
        if (box && changedRow) box.scrollTop = Math.max(0, changedRow.offsetTop - 8);
}

/* ── Propose fix ──────────────────────────────────────────────────────── */
export async function openProposeFix(id) {
    if (activeId !== id || !document.getElementById('healing-stage-result')) selectFailure(id, false);
    const panel = document.getElementById('healing-stage-result');
    if (!panel) return;
    markSteps(1);
    document.querySelector('#healing-stage .hc-stage__hint')?.remove();
    const analyzeBtn = document.getElementById('hc-analyze');
    if (analyzeBtn) analyzeBtn.disabled = true;
    panel.innerHTML = `<div class="hc-panel__loading"><span class="hc-panel__loading-icon" aria-hidden="true">${ICON.refresh}</span><span>Reading the failure and the page…</span></div>`;

    try {
        const { ok, data } = await parseApiJson(await fetchWithAuth(`/api/incidents/${id}/healing/propose`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file_content: '' }),
        }));

        if (activeId !== id) {
            if (ok && data) {
                analyses.set(id, data);
                persistAnalyses();
            }
            return;
        }
        if (!ok || !data) {
            if (analyzeBtn) analyzeBtn.disabled = false;
            panel.innerHTML = `<div class="hc-panel__error">Analysis failed. Check AI Configuration, then try again.</div>`;
            return;
        }
        analyses.set(id, data);
        persistAnalyses();
        markRowAnalyzed(id);
        paintAnalysis(id, data);
        if (analyzeBtn) analyzeBtn.disabled = false;
    } catch (e) {
        if (activeId !== id) return;
        if (analyzeBtn) analyzeBtn.disabled = false;
        panel.innerHTML = `<div class="hc-panel__error">${esc(String(e))}</div>`;
    }
}
window.openProposeFix = openProposeFix;

async function rerunHealedTest(id, btn) {
    const note = document.getElementById(`hc-apply-note-${id}`);
    const out = document.getElementById(`hc-rerun-out-${id}`);
    btn.disabled = true;
    btn.textContent = 'Re-running…';
    if (note) note.textContent = 'Running the test. This can take a minute.';
    if (out) { out.hidden = true; out.textContent = ''; }
    try {
        const { ok, data } = await parseApiJson(await fetchWithAuth(`/api/incidents/${id}/healing/verify`, {
            method: 'POST',
            body: '{}',
            timeoutMs: 150000,
        }));
        if (!ok) {
            const message = (data && data.error) || 'Could not re-run the test.';
            notify(message, 'error');
            if (note) note.textContent = message;
            btn.disabled = false;
            btn.textContent = 'Re-run test';
            return;
        }
        if (data.passed && data.resolved) {
            notify('Test passed. Incident resolved.', 'success');
            if (note) note.textContent = 'Passed. This incident is resolved.';
            btn.textContent = 'Passed';
            if (typeof window.loadHealingView === 'function') window.loadHealingView();
            return;
        }
        notify('The test still fails. The incident stays open.', 'error');
        if (note) note.textContent = 'Still failing. The incident stays open.';
        if (out && data.output) {
            out.hidden = false;
            out.textContent = data.output;
        }
        btn.disabled = false;
        btn.textContent = 'Re-run test';
    } catch (e) {
        notify(String(e), 'error');
        btn.disabled = false;
        btn.textContent = 'Re-run test';
    }
}

async function writeConfirmedLocator(id, healed, btn) {
    btn.disabled = true;
    const note = document.getElementById(`hc-apply-note-${id}`);
    try {
        const { ok, data } = await parseApiJson(await fetchWithAuth(`/api/incidents/${id}/healing/apply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ healed_locator: healed }),
        }));
        if (!ok) {
            const message = (data && data.error) || 'Could not write the test file.';
            notify(message, 'error');
            if (note) note.textContent = message;
            btn.disabled = false;
            return;
        }
        const path = data.path || 'the test file';
        if (data.already) {
            notify(`Already applied in ${path}`, 'info');
            if (note) note.textContent = `Already in ${path}`;
            btn.textContent = 'Already applied';
            return;
        }
        notify(`Applied in ${path}`, 'success');
        if (note) note.textContent = `Written to ${path}`;
        btn.textContent = 'Applied';
    } catch (e) {
        notify(String(e), 'error');
        btn.disabled = false;
    }
}

/* ── Locator interventions ────────────────────────────────────────────── */
export async function loadLocatorInterventions() {
    const el = document.getElementById('healing-interventions-body');
    if (!el) return;
    const project = document.getElementById('healing-project-filter')?.value || '';
    const q = project ? `?project=${encodeURIComponent(project)}&limit=50` : '?limit=50';
    el.innerHTML = `<div class="hc-loading">Loading…</div>`;

    const { ok, data } = await parseApiJson(await fetchWithAuth(`/api/healing/locator-interventions${q}`));
    if (!ok) { el.innerHTML = `<div class="hc-empty">Failed to load.</div>`; return; }
    const rows = Array.isArray(data) ? data : [];
    _count('healing-stat-interventions', rows.length);

    if (!rows.length) { el.innerHTML = `<div class="hc-empty">No confirmed locators yet. Propose Fix saves a selector here when it is unique on the page.</div>`; return; }
    el.innerHTML = rows.map(h => renderItv(h)).join('');
}
window.loadLocatorInterventions = loadLocatorInterventions;

function renderItv(h) {
    const f   = fw(h.framework);
    const pct = h.confidence ? Math.round(h.confidence * 100) : 0;
    const conf = pct >= 70 ? 'high' : pct >= 40 ? 'mid' : 'low';

    return `
<article class="hc-itv">
    <div class="hc-itv__head">
        <span class="hc-badge" style="color:${f.color};border-color:${f.color}20;background:${f.color}14">${esc(f.label)}</span>
        <span class="hc-itv__name">${esc(h.test_name || `INC #${h.incident_id}`)}</span>
        <span class="hc-conf hc-conf--${conf}">${pct}% confidence</span>
        <span class="hc-ago">${ago(h.created_at)}</span>
    </div>
    <div class="hc-locrow">
        <div class="hc-locrow__col">
            <span class="hc-loclbl">Broken</span>
            <code class="hc-loc hc-loc--bad">${esc(h.original_locator || '-')}</code>
        </div>
        <span class="hc-arrow">${ICON.arrow}</span>
        <div class="hc-locrow__col">
            <span class="hc-loclbl">Healed</span>
            <code class="hc-loc hc-loc--ok">${esc(h.healed_locator || 'pending')}</code>
        </div>
    </div>
    ${h.explanation ? `<p class="hc-itv__note">${esc(h.explanation)}</p>` : ''}
</article>`;
}
