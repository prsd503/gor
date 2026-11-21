'use strict';

function parseAdminUids(value) {
    return new Set(String(value || '').split(',').map(uid => uid.trim()).filter(Boolean));
}

// Only verified Firebase custom claims or an explicit server-side UID allowlist
// grant global administration. An email address or a client profile is not proof.
function firebaseRole(decoded, adminUids = new Set()) {
    if (adminUids.has(decoded.uid) || decoded.admin === true ||
        decoded.role === 'admin' || decoded.adminRole === 'admin') return 'admin';
    return decoded.role === 'guard' || decoded.adminRole === 'guard' ? 'guard' : 'user';
}

module.exports = { parseAdminUids, firebaseRole };
