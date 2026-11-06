/* Authentication helpers.
 *
 * Fixes two defects in the original server:
 *  1. `token.length < 50` accepted ANY short string as an authenticated society user.
 *  2. Firebase ID tokens (sent by app.js authenticatedFetch) were verified with
 *     jwt.verify(..., JWT_SECRET), which can never succeed because Google signs them.
 *
 * Both token types are now accepted explicitly: Firebase ID tokens via the Admin SDK,
 * and backend-issued JWTs via JWT_SECRET. Everything else is rejected.
 */
'use strict';

function bearerToken(req) {
    const header = req.header ? req.header('Authorization') : (req.headers || {}).authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
    const token = header.slice(7).trim();
    return token || null;
}

/* A Firebase ID token is a JWT whose payload carries `iss = https://securetoken.google.com/<project>`
 * and an `aud` equal to the project id. Decode only to ROUTE the token; never to trust it. */
function looksLikeFirebaseIdToken(token, projectId) {
    try {
        const parts = String(token).split('.');
        if (parts.length !== 3) return false;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (!payload || typeof payload !== 'object') return false;
        if (projectId && payload.aud !== projectId) return false;
        return typeof payload.iss === 'string' && payload.iss.startsWith('https://securetoken.google.com/');
    } catch (_) {
        return false;
    }
}

function createAuthMiddleware(options) {
    const verifyIdToken = options.verifyIdToken;
    const verifyJwt = options.verifyJwt;
    const projectId = options.projectId;
    const logger = options.logger || console;
    if (typeof verifyIdToken !== 'function' || typeof verifyJwt !== 'function') {
        throw new Error('verifyIdToken and verifyJwt are required.');
    }

    async function resolveUser(token) {
        if (looksLikeFirebaseIdToken(token, projectId)) {
            const decoded = await verifyIdToken(token);
            return {
                type: 'firebase_user',
                uid: decoded.uid,
                email: decoded.email || null,
                role: decoded.role || decoded.adminRole || 'admin',
                claims: decoded
            };
        }
        const decoded = verifyJwt(token);
        return {
            type: 'backend_jwt',
            uid: decoded.uid || null,
            email: decoded.email || null,
            role: decoded.role || 'admin',
            claims: decoded
        };
    }

    // Populates req.user when a valid token is present; never rejects on its own.
    async function optionalAuth(req, res, next) {
        const token = bearerToken(req);
        if (!token) return next();
        try {
            req.user = await resolveUser(token);
        } catch (error) {
            req.authError = error;
            if (logger && typeof logger.warn === 'function') {
                logger.warn('[auth] Ignoring invalid bearer token:', error.message);
            }
        }
        return next();
    }

    async function requireAuth(req, res, next) {
        const token = bearerToken(req);
        if (!token) {
            return res.status(401).json({ error: 'Unauthorized: Missing bearer token.' });
        }
        try {
            req.user = await resolveUser(token);
            return next();
        } catch (error) {
            if (logger && typeof logger.warn === 'function') {
                logger.warn('[auth] Token verification failed:', error.message);
            }
            return res.status(401).json({ error: 'Unauthorized: Invalid or expired token.' });
        }
    }

    function requireAdmin(req, res, next) {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized: Authentication required.' });
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden: Admin privileges required.' });
        }
        return next();
    }

    return { optionalAuth, requireAuth, requireAdmin, resolveUser };
}

module.exports = { bearerToken, looksLikeFirebaseIdToken, createAuthMiddleware };
