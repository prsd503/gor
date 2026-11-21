'use strict';
const fs = require('node:fs');
const path = require('node:path');

function normalizePublicApi(value) {
    let url;
    try { url = new URL(value); } catch (_) { throw new Error('Supply your own absolute HTTPS tunnel URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new Error('Use HTTPS, with no credentials, query string or fragment.');
    }
    if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') ||
        url.hostname === '[::1]' || url.hostname.startsWith('127.')) {
        throw new Error('GitHub Pages visitors cannot use your MacBook localhost. Supply the public tunnel hostname.');
    }
    if (!['/', '/api', '/api/'].includes(url.pathname)) {
        throw new Error('Supply the tunnel origin or a base ending exactly in /api.');
    }
    return url.origin + '/api';
}

function apiConfigSource(value) {
    const base = normalizePublicApi(value);
    return '/* Public API address only. NEVER put passwords, tokens or private keys in this file.\n' +
        ' * Generated with npm run api:configure. Only use a hostname you control.\n' +
        ' * The MacBook must remain awake with its API and HTTPS tunnel running.\n' +
        ' */\nwindow.OWL_API_CONFIG = ' + JSON.stringify({primary:base, local:'', fallbacks:[]}, null, 4) + ';\n';
}

function main(argv) {
    if (!argv[0] || argv.some((arg, i) => i > 0 && arg !== '--write') || argv.length > 2) {
        throw new Error('Usage: npm run api:configure -- https://YOUR_TUNNEL_HOST [--write]');
    }
    const source = apiConfigSource(argv[0]);
    if (argv.includes('--write')) {
        const file = path.resolve(__dirname, '..', 'api-env.js');
        // Reading first also makes a wrong/missing checkout fail without writing.
        fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, source);
        console.log('Updated api-env.js. Review the diff and publish ONLY this public configuration.');
        console.log('This command does not deploy GitHub Pages or alter your private .env files.');
    } else {
        console.log('Preview only; no files changed. Add --write to update api-env.js.\n');
        console.log(source);
    }
}

if (require.main === module) {
    try { main(process.argv.slice(2)); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { normalizePublicApi, apiConfigSource, main };
