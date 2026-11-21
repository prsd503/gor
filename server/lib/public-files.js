'use strict';
// Explicitly public files only. Never publish the repository root wholesale.
const ROOT_FILES = [
    'index.html', 'admin.html', 'bouquet.html', 'contest.html', 'delete.html',
    'deletedata.html', 'entry.html', 'facility.html', 'greet.html', 'guard.html',
    'notice.html', 'studio.html', 'local-test.html',
    'admin-logic.js', 'api-config.js', 'api-env.js', 'app.js', 'app-check.mjs',
    'bouquet-app.js', 'bouquet-engine.js', 'delete-logic.js', 'deletedata-logic.js',
    'gif-encoder.js', 'guard-logic.js', 'menu.js', 'update-popup.js', 'theme.css',
    'animate.mp4', 'game.mp3', 'hit.wav', 'hs.wav', 'jump.wav', 'loading.svg',
    'manifest.json', 'owl.png', 'owl1.png', 'owl2.png', 'real.json', 'tapenter.mp3',
    'test.gif', 'theme.mp3'
];
function isPublicPath(raw) {
    let value;
    try { value = decodeURIComponent(raw); } catch (_) { return false; }
    const parts = value.split('/').filter(Boolean);
    if (parts.some(part => part.startsWith('.') || part.includes('\\'))) return false;
    if (!parts.length) return true;
    if (parts[0] === 'assets') return parts.length > 1;
    return parts.length === 1 && (ROOT_FILES.includes(parts[0]) || ROOT_FILES.includes(parts[0] + '.html'));
}
module.exports = { ROOT_FILES, isPublicPath };
