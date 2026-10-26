/**
 * Navigation addresses name the page, then carry the security hash.
 * /dashboard/<hash>  /management/<hash>  /dora/<hash>  /review/id=<hash>
 */
import { fetchWithAuth, parseApiJson } from './api.js';

const minted = new Map();
let navSeq = 0;

const PAGE_SLUG = /^(dashboard|suite|activity|unowned|management|dora|finops|healing|ai|ai-usage|ai-config|workspaces|organizations|gateways|ingestion|plugins|settings|profile|about|review)$/i;

/** Token from /dashboard/<hash>, /review/id=<hash>, or an older address. */
export function secureLinkTokenFromPath(pathname) {
    const path = pathname || '/';
    const review = path.match(/^\/review\/id=([^/]+)$/i);
    if (review) return decodeURIComponent(review[1]);
    const about = path.match(/^\/about\/[a-z0-9_]+\/([^/]+)$/i);
    if (about && !about[1].includes('.')) return decodeURIComponent(about[1]);
    const page = path.match(/^\/([a-z0-9-]+)\/([^/]+)$/i);
    if (page && PAGE_SLUG.test(page[1]) && !page[2].includes('.')) return decodeURIComponent(page[2]);
    const legacy = path.match(/^\/l\/([^/]+)$/);
    if (legacy) return decodeURIComponent(legacy[1]);
    const dynamic = path.match(/^\/([a-z0-9]{4})\/([a-z0-9]{4})\/([^/]+)$/);
    if (dynamic) return decodeURIComponent(dynamic[3]);
    return '';
}

function destKey(dest) {
    return JSON.stringify({
        kind: dest.kind || '',
        view: dest.view || '',
        topic: dest.topic || '',
        project: dest.project || '',
        run_id: dest.run_id || '',
        incident_id: dest.incident_id || 0,
        comment_id: dest.comment_id || 0
    });
}

async function mintToken(dest) {
    const key = destKey(dest);
    if (minted.has(key)) return minted.get(key);
    const pending = fetchWithAuth('/api/links', {
        method: 'POST',
        body: JSON.stringify(dest)
    }).then(async (res) => {
        const { data } = await parseApiJson(res);
        if (!res.ok || !data?.token) {
            minted.delete(key);
            throw new Error((data && data.error) || 'Could not build the link');
        }
        return { token: data.token, path: data.path || `/l/${data.token}` };
    });
    minted.set(key, pending);
    return pending;
}

/** Put the current screen on /<page>/<hash> or /review/id=<hash>. */
export async function publishSecureLink(dest) {
    if (window.__openingSecureLink || !dest?.kind) return;
    const seq = ++navSeq;
    const here = window.location.pathname || '/';
    const replace = !secureLinkTokenFromPath(here);
    try {
        const mintedLink = await mintToken(dest);
        if (seq !== navSeq || window.__openingSecureLink) return;
        const path = mintedLink.path;
        if (!path || window.location.pathname === path) return;
        if (replace) history.replaceState({ sreLink: seq }, '', path);
        else history.pushState({ sreLink: seq }, '', path);
    } catch (_) {
        /* navigation still works if the address cannot be updated */
    }
}

window.addEventListener('popstate', () => {
    const token = secureLinkTokenFromPath(window.location.pathname || '');
    if (token && typeof window.openSecureLink === 'function') {
        window.openSecureLink(token);
    }
});
