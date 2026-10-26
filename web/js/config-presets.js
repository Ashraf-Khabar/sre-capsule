/**
 * Named workspace configurations (SRE presets) - UI + API helpers.
 */
import { fetchWithAuth, parseApiJson } from './api.js';
import { notify } from './ui.js';
import { t } from './i18n.js?v=1.0.101-workflow-page';

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
}

export function renderConfigurationPresets(prefs) {
    const list = document.getElementById('config-preset-list');
    const activeEl = document.getElementById('config-preset-active-label');
    if (!list) return;

    const presets = Array.isArray(prefs?.configuration_presets) ? prefs.configuration_presets : [];
    const activeId = prefs?.active_preset_id || 'sre-default';
    const active = presets.find((p) => p.id === activeId);

    if (activeEl) {
        activeEl.textContent = active ? active.name : 'SRE Default';
    }

    if (!presets.length) {
        list.innerHTML = '<p class="form-field-hint">No configurations loaded.</p>';
        return;
    }

    list.innerHTML = presets.map((preset) => {
        const isActive = preset.id === activeId;
        const badge = preset.built_in
            ? `<span class="config-preset-badge">${t('common.builtIn')}</span>`
            : `<span class="config-preset-badge config-preset-badge--custom">${t('common.custom')}</span>`;
        const deleteBtn = preset.built_in
            ? ''
            : `<button type="button" class="btn-secondary btn-sm config-preset-delete" data-preset-id="${escapeAttr(preset.id)}">${t('common.delete')}</button>`;
        return `
        <div class="config-preset-row${isActive ? ' config-preset-row--active' : ''}" data-preset-id="${escapeAttr(preset.id)}">
            <div class="config-preset-row__stripe" aria-hidden="true"></div>
            <div class="config-preset-row__main">
                <div class="config-preset-row__title">
                    <span class="config-preset-name">${escapeHtml(preset.name)}</span>
                    ${badge}
                    ${isActive ? `<span class="config-preset-active-pill">${t('common.active')}</span>` : ''}
                </div>
                <p class="config-preset-desc">${escapeHtml(preset.description || 'Workspace profile')}</p>
                <div class="config-preset-meta">
                    <span>${escapeHtml(preset.settings?.theme_palette || 'default')} · ${escapeHtml(preset.settings?.theme_mode || preset.settings?.theme || 'dark')}</span>
                    <span>${escapeHtml(preset.settings?.default_time_range || '15m')} window</span>
                </div>
            </div>
            <div class="config-preset-row__actions">
                <button type="button" class="btn-primary btn-sm config-preset-activate" data-preset-id="${escapeAttr(preset.id)}" ${isActive ? 'disabled' : ''}>${t('common.apply')}</button>
                <button type="button" class="btn-secondary btn-sm config-preset-clone" data-preset-id="${escapeAttr(preset.id)}">${t('common.duplicate')}</button>
                ${deleteBtn}
            </div>
        </div>`;
    }).join('');

    list.querySelectorAll('.config-preset-activate').forEach((btn) => {
        btn.addEventListener('click', () => activateConfigurationPreset(btn.dataset.presetId));
    });
    list.querySelectorAll('.config-preset-clone').forEach((btn) => {
        btn.addEventListener('click', () => duplicateConfigurationPreset(btn.dataset.presetId));
    });
    list.querySelectorAll('.config-preset-delete').forEach((btn) => {
        btn.addEventListener('click', () => deleteConfigurationPreset(btn.dataset.presetId));
    });
}

export async function activateConfigurationPreset(presetId) {
    if (!presetId) return;
    try {
        const res = await fetchWithAuth('/api/me/preferences/presets/activate', {
            method: 'POST',
            body: JSON.stringify({ preset_id: presetId })
        });
        const { ok, data } = await parseApiJson(res);
        if (!ok || !data) throw new Error('activate failed');
        if (typeof window.applyPreferences === 'function') window.applyPreferences(data);
        if (typeof window.hydrateProfileFormFromPrefs === 'function') window.hydrateProfileFormFromPrefs(data);
        renderConfigurationPresets(data);
        renderThemePickers(data);
        notify(t('notify.configApplied'), 'success');
    } catch {
        notify(t('notify.configApplyError'), 'error');
    }
}

export async function createConfigurationFromCurrent() {
    const nameInput = document.getElementById('config-preset-new-name');
    const descInput = document.getElementById('config-preset-new-desc');
    const name = nameInput?.value?.trim();
    if (!name) return notify(t('notify.configNameRequired'), 'error');

    const settings = typeof window.readProfileFormPreferences === 'function'
        ? window.readProfileFormPreferences()
        : {};

    try {
        const res = await fetchWithAuth('/api/me/preferences/presets', {
            method: 'POST',
            body: JSON.stringify({
                name,
                description: descInput?.value?.trim() || '',
                settings
            })
        });
        const { ok } = await parseApiJson(res);
        if (!ok) throw new Error('create failed');
        const prefsRes = await fetchWithAuth('/api/me/preferences');
        const prefsJson = await parseApiJson(prefsRes);
        if (prefsJson.ok && prefsJson.data) renderConfigurationPresets(prefsJson.data);
        if (nameInput) nameInput.value = '';
        if (descInput) descInput.value = '';
        notify(t('notify.configSaved', { name }), 'success');
    } catch {
        notify(t('notify.configSaveError'), 'error');
    }
}

async function duplicateConfigurationPreset(presetId) {
    const prefsRes = await fetchWithAuth('/api/me/preferences');
    const { ok, data } = await parseApiJson(prefsRes);
    if (!ok || !data) return notify('Could not load configurations', 'error');
    const source = (data.configuration_presets || []).find((p) => p.id === presetId);
    if (!source) return notify('Configuration not found', 'error');
    const name = `${source.name} (copy)`;
    try {
        const res = await fetchWithAuth('/api/me/preferences/presets', {
            method: 'POST',
            body: JSON.stringify({
                name,
                description: source.description || '',
                settings: source.settings || {}
            })
        });
        const created = await parseApiJson(res);
        if (!created.ok) throw new Error('duplicate failed');
        const refresh = await parseApiJson(await fetchWithAuth('/api/me/preferences'));
        if (refresh.ok && refresh.data) renderConfigurationPresets(refresh.data);
        notify(t('notify.configDuplicated', { name }), 'success');
    } catch {
        notify(t('notify.configDuplicateError'), 'error');
    }
}

async function deleteConfigurationPreset(presetId) {
    if (!window.confirm('Delete this custom configuration?')) return;
    try {
        const res = await fetchWithAuth(`/api/me/preferences/presets?id=${encodeURIComponent(presetId)}`, { method: 'DELETE' });
        const { ok, data } = await parseApiJson(res);
        if (!ok) throw new Error('delete failed');
        if (data) {
            if (typeof window.applyPreferences === 'function') window.applyPreferences(data);
            if (typeof window.hydrateProfileFormFromPrefs === 'function') window.hydrateProfileFormFromPrefs(data);
            renderConfigurationPresets(data);
        }
        notify(t('notify.configDeleted'), 'success');
    } catch {
        notify(t('notify.configDeleteError'), 'error');
    }
}

export function renderThemePickers(prefs) {
    const mode = prefs?.theme_mode || prefs?.theme || 'dark';
    const palette = prefs?.theme_palette || 'default';

    document.querySelectorAll('.theme-mode-chip').forEach((chip) => {
        chip.classList.toggle('active', chip.dataset.themeMode === mode);
    });
    document.querySelectorAll('.theme-palette-chip').forEach((chip) => {
        chip.classList.toggle('active', chip.dataset.themePalette === palette);
    });

    const modeSelect = document.getElementById('pref-theme-mode');
    if (modeSelect) modeSelect.value = mode;

    const paletteSelect = document.getElementById('pref-theme-palette');
    if (paletteSelect) paletteSelect.value = palette;
}

export function bindThemePickerEvents() {
    document.querySelectorAll('.theme-mode-chip').forEach((chip) => {
        if (chip.dataset.bound) return;
        chip.dataset.bound = '1';
        chip.addEventListener('click', () => {
            document.querySelectorAll('.theme-mode-chip').forEach((c) => c.classList.remove('active'));
            chip.classList.add('active');
            const modeSelect = document.getElementById('pref-theme-mode');
            if (modeSelect) modeSelect.value = chip.dataset.themeMode;
            if (typeof window.previewThemeAppearance === 'function') window.previewThemeAppearance();
        });
    });
    document.querySelectorAll('.theme-palette-chip').forEach((chip) => {
        if (chip.dataset.bound) return;
        chip.dataset.bound = '1';
        chip.addEventListener('click', () => {
            document.querySelectorAll('.theme-palette-chip').forEach((c) => c.classList.remove('active'));
            chip.classList.add('active');
            const paletteSelect = document.getElementById('pref-theme-palette');
            if (paletteSelect) paletteSelect.value = chip.dataset.themePalette;
            if (typeof window.previewThemeAppearance === 'function') window.previewThemeAppearance();
        });
    });
}

export function initConfigurationPresetsUI() {
    const createBtn = document.getElementById('config-preset-create-btn');
    if (createBtn && !createBtn.dataset.bound) {
        createBtn.dataset.bound = '1';
        createBtn.addEventListener('click', createConfigurationFromCurrent);
    }
    bindThemePickerEvents();
}

if (typeof window !== 'undefined') {
    window.activateConfigurationPreset = activateConfigurationPreset;
    window.createConfigurationFromCurrent = createConfigurationFromCurrent;
}
