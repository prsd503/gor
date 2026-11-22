'use strict';

function parseAdminUids(value) {
    return new Set(String(value || '').split(',').map(uid => uid.trim()).filter(Boolean));
}

// Kept as a compatibility helper for older callers. Firebase claims and UID
// allowlists do not grant app authorization; active membership is resolved
// from admins/guards documents by server/lib/authorization.js.
function firebaseRole() {
    return 'user';
}

module.exports = { parseAdminUids, firebaseRole };
