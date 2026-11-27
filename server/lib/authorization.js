'use strict';

function normalize(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
}

function strings(value) {
    if (Array.isArray(value)) return value.filter(item => typeof item === 'string' && item.trim());
    if (typeof value === 'string' && value.trim()) return [value];
    return [];
}

// Membership records change rarely but are read on every staff request (and
// several times per request). A short cache makes repeat requests nearly free
// while keeping revocation bound to a few seconds. Reads that must observe a
// brand-new write pass `ttlMs: 0`.
const MEMBERSHIP_CACHE_MS = 5000;

function createAuthorization(options) {
    const db = options.db;
    const authMode = options.authMode || 'firebase';
    const membershipTtlMs = options.membershipTtlMs !== undefined ? options.membershipTtlMs : MEMBERSHIP_CACHE_MS;
    if (!db) throw new Error('createAuthorization requires a database handle.');

    async function resolveSociety(identifier) {
        const target = normalize(identifier);
        if (!target || target.length > 160 || target.includes('/')) return null;

        try {
            const direct = await db.collection('societies').doc(String(identifier).trim()).get();
            if (direct.exists) return societyResult(direct.id, direct.data());
        } catch (_) {
            // A legacy display-name identifier is not a valid document path.
        }

        const snapshot = await db.collection('societies').get();
        const matches = snapshot.docs.filter(doc => {
            const data = doc.data() || {};
            const aliases = [doc.id, data.name, ...strings(data.legacyNames), ...strings(data.aliases)];
            return aliases.some(alias => normalize(alias) === target);
        });
        if (matches.length !== 1) return null;
        return societyResult(matches[0].id, matches[0].data());
    }

    function societyResult(id, rawData) {
        const data = rawData || {};
        const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : id;
        return {
            id,
            name,
            data,
            aliases: [...new Set([id, name, ...strings(data.legacyNames), ...strings(data.aliases)].map(s => s.trim()).filter(Boolean))]
        };
    }

    function identityMatches(doc, email, uid) {
        const data = doc.data() || {};
        const recordEmail = normalize(data.email || doc.id);
        if (!email || recordEmail !== email) return false;
        const boundUid = data.uid || data.userId || data.firebaseUid || null;
        return !boundUid || String(boundUid) === String(uid || '');
    }

    async function membershipRecords(collectionName, user) {
        const email = normalize(user.email);
        const uid = String(user.uid || '');
        if (!email || !uid) return [];

        const found = new Map();
        try {
            const direct = await db.collection(collectionName).doc(email).get({ ttlMs: membershipTtlMs });
            if (direct.exists && identityMatches(direct, email, uid)) found.set(direct.id, direct);
        } catch (_) { /* Continue through compatibility lookup. */ }

        // Older records have a doc ID that preserves the email's original case,
        // or a differently-cased `email` field. This fallback is server-only.
        if (found.size === 0) {
            const snapshot = await db.collection(collectionName).get({ ttlMs: membershipTtlMs });
            snapshot.forEach(doc => {
                if (identityMatches(doc, email, uid)) found.set(doc.id, doc);
            });
        }
        return [...found.values()];
    }

    async function resolveMembership(user) {
        if (!user) return null;

        // This development-only identity is minted only by AUTH_MODE=local,
        // which the server refuses to start in production.
        if (authMode === 'local' && user.type === 'backend_jwt' &&
            user.claims && user.claims.authVersion === 2 && user.claims.role === 'admin' &&
            String(user.uid || '').startsWith('local:')) {
            return { role: 'master', uid: user.uid, email: normalize(user.email), societyId: null, local: true };
        }

        // Membership is bound to a verified Firebase email; when the record has
        // a UID field it must also match. Never authorize from client role claims.
        if (user.emailVerified !== true) return null;
        const email = normalize(user.email);
        if (!email || !user.uid) return null;

        const admins = await membershipRecords('admins', user);
        const master = admins.find(doc => {
            const data = doc.data() || {};
            return data.isMaster === true && data.disabled !== true && data.active !== false;
        });
        if (master) {
            const data = master.data() || {};
            const reference = data.societyId || data.society || data.societyName;
            const society = reference ? await resolveSociety(reference) : null;
            return {
                role: 'master', uid: user.uid, email, membershipId: master.id,
                societyId: society ? society.id : null,
                societyName: society ? society.name : ''
            };
        }

        if (admins.length > 1) return null; // Ambiguous legacy memberships fail closed.
        if (admins.length === 1) {
            const record = admins[0];
            const data = record.data() || {};
            if (data.disabled === true || data.active === false) return null;
            const society = await resolveSociety(data.societyId || data.society || data.societyName);
            if (!society) return null;
            return { role: 'admin', uid: user.uid, email, membershipId: record.id, societyId: society.id, societyName: society.name };
        }

        const guards = await membershipRecords('guards', user);
        if (guards.length !== 1) return null;
        const record = guards[0];
        const data = record.data() || {};
        if (data.disabled === true || data.active === false) return null;
        const society = await resolveSociety(data.societyId || data.society || data.societyName);
        if (!society) return null;
        return { role: 'guard', uid: user.uid, email, membershipId: record.id, societyId: society.id, societyName: society.name };
    }

    // Which staff role does an address have? Used by the sign-in pages to reject
    // a non-admin / non-guard email before the password is even attempted.
    // This is look-up only: it proves nothing, and the token-backed
    // resolveMembership() above stays the real gate after sign-in. Records that
    // are disabled or inactive never count, and an email with ambiguous legacy
    // admin records fails closed.
    async function lookupStaffRole(rawEmail) {
        const email = normalize(rawEmail);
        if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;

        const recordsFor = async collectionName => {
            const found = new Map();
            try {
                const direct = await db.collection(collectionName).doc(email).get({ ttlMs: membershipTtlMs });
                if (direct.exists) found.set(direct.id, direct);
            } catch (_) { /* Fall through to the email-field scan. */ }
            if (found.size === 0) {
                const snapshot = await db.collection(collectionName).get({ ttlMs: membershipTtlMs });
                snapshot.forEach(doc => {
                    const data = doc.data() || {};
                    if (normalize(data.email || doc.id) === email) found.set(doc.id, doc);
                });
            }
            return [...found.values()].filter(doc => {
                const data = doc.data() || {};
                return data.disabled !== true && data.active !== false;
            });
        };

        const admins = await recordsFor('admins');
        const master = admins.find(doc => (doc.data() || {}).isMaster === true);
        if (master) return 'master';
        if (admins.length === 1) return 'admin';
        if (admins.length > 1) return null;

        const guards = await recordsFor('guards');
        return guards.length === 1 ? 'guard' : null;
    }

    function getMembership(req) {
        if (!req._membershipPromise) req._membershipPromise = resolveMembership(req.user);
        return req._membershipPromise;
    }

    function reject(res, status, code, error) {
        return res.status(status).json({ error, code });
    }

    function requireStaff(req, res, next) {
        if (!req.user) return reject(res, 401, 'auth-required', 'Authentication is required.');
        return getMembership(req).then(membership => {
            if (!membership) return reject(res, 403, 'staff-membership-required', 'An active, verified staff membership is required.');
            req.membership = membership;
            return next();
        }).catch(() => reject(res, 503, 'authorization-unavailable', 'Authorization could not be verified.'));
    }

    function requireMaster(req, res, next) {
        return requireStaff(req, res, () => {
            if (req.membership.role !== 'master') return reject(res, 403, 'master-admin-required', 'Master administrator privileges are required.');
            return next();
        });
    }

    function requireSociety(allowedRoles, identifier) {
        return async (req, res, next) => {
            if (!req.user) return reject(res, 401, 'auth-required', 'Authentication is required.');
            try {
                const membership = await getMembership(req);
                if (!membership) return reject(res, 403, 'staff-membership-required', 'An active, verified staff membership is required.');
                if (membership.role !== 'master' && !allowedRoles.includes(membership.role)) {
                    return reject(res, 403, 'role-forbidden', 'This operation is not allowed for your staff role.');
                }
                const requested = typeof identifier === 'function' ? identifier(req) : identifier;
                if (requested === undefined || requested === null || String(requested).trim() === '') {
                    return reject(res, 400, 'society-required', 'A society identifier is required.');
                }
                const society = await resolveSociety(requested);
                if (!society) return reject(res, 404, 'society-not-found', 'Society not found.');
                if (membership.role !== 'master' && membership.societyId !== society.id) {
                    return reject(res, 403, 'society-scope-forbidden', 'Your staff account is not assigned to this society.');
                }
                req.membership = membership;
                req.authorizedSociety = society;
                return next();
            } catch (_) {
                return reject(res, 503, 'authorization-unavailable', 'Authorization could not be verified.');
            }
        };
    }

    return { resolveSociety, resolveMembership, lookupStaffRole, requireStaff, requireMaster, requireSociety };
}

module.exports = { createAuthorization, normalize };
