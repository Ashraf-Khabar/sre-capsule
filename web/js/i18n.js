/**
 * Internationalization — locale switching and DOM translation.
 */
import en from './i18n/messages-en.js?v=1.0.88-unowned';
import fr from './i18n/messages-fr.js?v=1.0.88-unowned';
import es from './i18n/messages-es.js?v=1.0.88-unowned';
import zh from './i18n/messages-zh.js?v=1.0.88-unowned';
import de from './i18n/messages-de.js?v=1.0.88-unowned';

const LOCALE_KEY = 'srecapsule-locale';
export const PREF_LANGUAGE_KEY = LOCALE_KEY;
const SUPPORTED = ['en', 'fr', 'es', 'zh', 'de'];

const catalogs = { en, fr, es, zh, de };

let currentLocale = 'en';

function interpolate(str, vars) {
    if (!vars || typeof str !== 'string') return str;
    return str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
}

export function t(key, vars) {
    const catalog = catalogs[currentLocale] || catalogs.en;
    let val = catalog[key];
    if (val == null) val = catalogs.en[key];
    if (val == null) return key;
    return interpolate(val, vars);
}

export function getLocale() {
    return currentLocale;
}

export function getSupportedLocales() {
    return [...SUPPORTED];
}

export function setLocale(locale, { persist = true, apply = true } = {}) {
    const next = SUPPORTED.includes(locale) ? locale : 'en';
    currentLocale = next;
    if (persist) {
        try { localStorage.setItem(LOCALE_KEY, next); } catch (_) { /* quota */ }
    }
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : next;
    if (apply) {
        applyI18n();
        import('./config-presets.js?v=1.0.80-suite-page').then((mod) => {
            if (typeof mod.renderConfigurationPresets === 'function') {
                const prefs = window.__userPreferences;
                if (prefs) mod.renderConfigurationPresets(prefs);
            }
        }).catch(() => {});
    }
    return next;
}

export function initI18n(locale) {
    let stored = locale;
    if (!stored) {
        try { stored = localStorage.getItem(LOCALE_KEY); } catch (_) { /* quota */ }
    }
    setLocale(stored || 'en', { persist: false, apply: false });
    applyI18n();
}

function applyToElement(el, key) {
    if (!key) return;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
        if (el.hasAttribute('data-i18n-placeholder')) {
            el.placeholder = t(key);
        } else {
            el.value = t(key);
        }
        return;
    }
    if (tag === 'OPTION') {
        el.textContent = t(key);
        return;
    }
    if (el.hasAttribute('data-i18n-html')) {
        el.innerHTML = t(key);
        return;
    }
    el.textContent = t(key);
}

export function applyI18n(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => {
        applyToElement(el, el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
        el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
    });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
        el.title = t(el.getAttribute('data-i18n-title'));
    });
    const titleKey = root === document ? document.querySelector('[data-i18n-document-title]') : null;
    if (titleKey || root === document) {
        document.title = t('app.title');
    }
}

export function onProfileLanguageChange() {
    const code = document.getElementById('pref-language')?.value || 'en';
    setLocale(code);
    if (typeof window.notify === 'function') {
        window.notify(t('notify.languageChanged'), 'success');
    }
}

if (typeof window !== 'undefined') {
    window.t = t;
    window.setLocale = setLocale;
    window.applyI18n = applyI18n;
    window.onProfileLanguageChange = onProfileLanguageChange;
}
