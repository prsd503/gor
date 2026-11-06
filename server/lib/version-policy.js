/* Pure app-version policy helpers shared by the API and its tests.
 * Mirrors the validation rules in update-popup.js so both paths agree.
 */
'use strict';

const PLATFORMS = ['android', 'ios'];
const MAX_MESSAGE = 500;

function parseVersion(value) {
    if (typeof value !== 'string' || value.length > 64 || !/^\d+\.\d+\.\d+$/.test(value)) return null;
    const parts = value.split('.').map(Number);
    return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (!a || !b) throw new Error('Invalid version.');
    for (let i = 0; i < 3; i += 1) {
        if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
    }
    return 0;
}

function validStoreUrl(value, platform) {
    if (typeof value !== 'string' || !value || value.length > 2048) return false;
    let url;
    try { url = new URL(value); } catch (_) { return false; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    if (platform === 'android') {
        if (url.hostname !== 'play.google.com') return false;
        if (url.pathname !== '/store/apps/details') return false;
        return /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(url.searchParams.get('id') || '');
    }
    if (platform === 'ios') {
        if (url.hostname !== 'apps.apple.com') return false;
        return /\/id\d+(?:[?#]|$)/.test(url.pathname + url.search + url.hash);
    }
    return false;
}

/* Drops invalid platform blocks instead of failing the whole response, so one
 * misconfigured platform (e.g. ios.storeUrl = "www") cannot hide the other. */
function normalizePolicy(data) {
    if (!data || typeof data !== 'object') throw new Error('Version policy is missing.');
    const out = {};
    for (const platform of PLATFORMS) {
        const block = data[platform];
        if (!block || typeof block !== 'object') continue;
        if (!parseVersion(block.minimumVersion)) continue;
        if (!validStoreUrl(block.storeUrl, platform)) continue;
        out[platform] = { minimumVersion: block.minimumVersion, storeUrl: block.storeUrl };
    }
    if (typeof data.message === 'string' && data.message.trim()) {
        out.message = data.message.slice(0, MAX_MESSAGE);
    }
    return out;
}

function buildVersionResponse(data, query = {}) {
    const policy = normalizePolicy(data);
    const platform = typeof query.platform === 'string' ? query.platform.toLowerCase() : '';
    const version = typeof query.version === 'string' ? query.version : '';
    if (!platform && !version) return policy;

    if (!PLATFORMS.includes(platform)) {
        const error = new Error('platform must be android or ios.');
        error.status = 400;
        throw error;
    }
    if (!parseVersion(version)) {
        const error = new Error('version must use the x.y.z numeric format.');
        error.status = 400;
        throw error;
    }
    const block = policy[platform];
    if (!block) {
        return { platform, installedVersion: version, configured: false, updateAvailable: false };
    }
    return {
        platform,
        installedVersion: version,
        configured: true,
        minimumVersion: block.minimumVersion,
        storeUrl: block.storeUrl,
        updateAvailable: compareVersions(version, block.minimumVersion) < 0,
        message: policy.message || ''
    };
}

module.exports = {
    PLATFORMS, MAX_MESSAGE, parseVersion, compareVersions, validStoreUrl, normalizePolicy, buildVersionResponse
};
