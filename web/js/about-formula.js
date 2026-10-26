/**
 * Help Center - formula blocks (light background + copy)
 */
import { notify } from './ui.js';

export function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Renders a copyable formula block with white background (readable in all themes). */
export function formulaBlock(text) {
    const plain = String(text).trim();
    return `<div class="formula-block">
  <pre class="formula-code">${escapeHtml(plain)}</pre>
  <button type="button" class="formula-copy-btn" data-copy="${escapeHtml(plain)}" title="Copy to clipboard">Copy</button>
</div>`;
}

export function bindAboutFormulaCopy(root) {
    if (!root) return;
    root.querySelectorAll('.formula-copy-btn').forEach(btn => {
        if (btn.dataset.bound) return;
        btn.dataset.bound = '1';
        btn.addEventListener('click', async () => {
            const text = btn.getAttribute('data-copy') || btn.previousElementSibling?.textContent || '';
            try {
                await navigator.clipboard.writeText(text);
                const prev = btn.textContent;
                btn.textContent = 'Copied!';
                btn.classList.add('copied');
                setTimeout(() => {
                    btn.textContent = prev;
                    btn.classList.remove('copied');
                }, 2000);
            } catch {
                notify('Could not copy - check browser permissions', 'error');
            }
        });
    });
}
