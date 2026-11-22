/* Owl Watcher API server.
 *
 * The same Express app runs in three places:
 *   1. Firebase Cloud Functions  - `server/firebase.js` (deploy target)
 *   2. A MacBook                 - `npm run start:local` (free fallback + testing)
 *   3. Any VPS                   - `npm start` (the old Hostinger setup)
 *
 * The Firebase copy is wrapped in a quota guard: once any free-tier meter
 * (Firestore reads/writes/deletes, function invocations, egress) reaches
 * QUOTA_THRESHOLD of its free allowance - 80% by default - it answers 503 with
 * `code: "quota-threshold-reached"`. This is NOT a guaranteed billing cap. The
 * website (api-config.js) then retries the request against the MacBook copy.
 *
 * Required environment:
 *   JWT_SECRET            - random secret, 32+ characters (no fallback)
 * Optional data/auth:
 *   DATA_BACKEND          - firestore (default) | local   (local = JSON file, no Firebase)
 *   LOCAL_DB_FILE         - path for DATA_BACKEND=local (default .local-data/db.json)
 *   AUTH_MODE             - firebase (default) | local    (local = dev admin credentials)
 *   LOCAL_ADMIN_EMAIL / LOCAL_ADMIN_PASSWORD (AUTH_MODE=local, password 12+ chars)
 * Firebase:
 *   FIREBASE_PROJECT_ID   - e.g. finder-owl
 *   GOOGLE_APPLICATION_CREDENTIALS or SERVICE_ACCOUNT_JSON - Admin SDK credentials
 *   APP_CHECK_MODE        - off | monitor (default) | enforce
 * Quota guard:
 *   QUOTA_ACTION          - stop (default) | monitor | off
 *   QUOTA_SOURCE          - local (default) | monitoring  (monitoring = authoritative)
 *   QUOTA_THRESHOLD       - 0.8 by default
 *   QUOTA_FALLBACK_URLS   - comma-separated URLs advertised to clients in the 503
 * Server / web:
 *   PORT, HOST, ALLOWED_ORIGINS, TRUST_PROXY_HOPS
 *   SERVE_STATIC=1        - also serve the static site (handy on the MacBook)
 *   READ_CACHE_TTL_MS     - read cache TTL, default 20000 (0 disables)
 *   ENV_FILE              - dotenv file to load, default .env
 */
'use strict';

const path = require('path');
const os = require('os');
const crypto = require('crypto');

require('dotenv').config({ path: process.env.ENV_FILE || '.env', quiet: true });

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { rateLimit } = require('express-rate-limit');

const { buildVersionResponse } = require('./lib/version-policy');
const { createAuthMiddleware } = require('./lib/auth');
const { parseAdminUids, firebaseRole } = require('./lib/admin-policy');
const { validatePreviewConfig, createPreviewGate } = require('./lib/tunnel-preview');
const { createGiftCodeService } = require('./lib/gift-codes');
const { createOriginChecker, createAppCheckMiddleware } = require('./lib/security');
const { createQuotaGuard } = require('./lib/quota-guard');
const { readLimits, normalizeAction, normalizeSource } = require('./lib/quota-policy');
const { createMonitoringUsageFetcher } = require('./lib/gcp-monitoring');
const { createDbLayer } = require('./lib/db-layer');
const { createLocalStore, createFieldValue } = require('./lib/local-store');
const { createMaintenance } = require('./lib/maintenance');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32 || JWT_SECRET.startsWith('REPLACE_WITH_')) {
    throw new Error('JWT_SECRET must be set to a random value of at least 32 characters.');
}

const PROJECT_ID = process.env.OWL_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'finder-owl';
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const IS_FUNCTIONS = Boolean(process.env.FUNCTION_TARGET || process.env.FUNCTIONS_TARGET);

function lower(value, fallback) {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized || fallback;
}

function flag(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

const DATA_BACKEND = lower(process.env.DATA_BACKEND, 'firestore');
const AUTH_MODE = lower(process.env.AUTH_MODE, 'firebase');
const APP_CHECK_MODE = lower(process.env.APP_CHECK_MODE, AUTH_MODE === 'local' ? 'off' : 'monitor');
const SERVE_STATIC = flag(process.env.SERVE_STATIC);
const TUNNEL_PREVIEW = flag(process.env.TUNNEL_PREVIEW);
const ADMIN_UIDS = parseAdminUids(process.env.ADMIN_UIDS);
const ENABLE_CRON = !IS_FUNCTIONS && String(process.env.ENABLE_CRON || '1') !== '0';

if (!['firestore', 'local'].includes(DATA_BACKEND)) {
    throw new Error(`DATA_BACKEND must be "firestore" or "local" (got "${DATA_BACKEND}").`);
}
if (!['firebase', 'local'].includes(AUTH_MODE)) {
    throw new Error(`AUTH_MODE must be "firebase" or "local" (got "${AUTH_MODE}").`);
}
if (!['off', 'monitor', 'enforce'].includes(APP_CHECK_MODE)) {
    throw new Error(`APP_CHECK_MODE must be "off", "monitor" or "enforce" (got "${APP_CHECK_MODE}").`);
}
if (DATA_BACKEND === 'local' && IS_PRODUCTION && !flag(process.env.ALLOW_LOCAL_BACKEND)) {
    throw new Error('DATA_BACKEND=local is a single-machine store. Set ALLOW_LOCAL_BACKEND=1 to allow it with NODE_ENV=production.');
}
if (AUTH_MODE === 'local' && IS_PRODUCTION) {
    throw new Error('AUTH_MODE=local accepts a dev username/password and is refused with NODE_ENV=production.');
}
if (AUTH_MODE === 'local' && APP_CHECK_MODE !== 'off') {
    throw new Error('AUTH_MODE=local cannot be combined with App Check. Set APP_CHECK_MODE=off.');
}

const LOCAL_ADMIN_EMAIL = String(process.env.LOCAL_ADMIN_EMAIL || '').trim().toLowerCase();
const LOCAL_ADMIN_PASSWORD = String(process.env.LOCAL_ADMIN_PASSWORD || '');
if (AUTH_MODE === 'local') {
    if (!LOCAL_ADMIN_EMAIL) throw new Error('AUTH_MODE=local requires LOCAL_ADMIN_EMAIL.');
    if (LOCAL_ADMIN_PASSWORD.length < 12) throw new Error('AUTH_MODE=local requires LOCAL_ADMIN_PASSWORD of 12+ characters.');
}

if (process.env.QUOTA_SOURCE && !['auto', 'local', 'monitoring'].includes(process.env.QUOTA_SOURCE)) {
    throw new Error('QUOTA_SOURCE must be auto, local or monitoring.');
}

const quotaSource = normalizeSource(!process.env.QUOTA_SOURCE || process.env.QUOTA_SOURCE === 'auto' ? (IS_FUNCTIONS ? 'monitoring' : 'local') : process.env.QUOTA_SOURCE);

if (TUNNEL_PREVIEW) validatePreviewConfig({ ...process.env, DATA_BACKEND, AUTH_MODE, SERVE_STATIC: SERVE_STATIC ? '1' : '0' });

// ---------------------------------------------------------------------------
// Firebase (skipped entirely for a fully local run)
// ---------------------------------------------------------------------------

let firebaseApp = null;
let credential = null;
let rawDb = null;
let FieldValue = null;

function initFirebase() {
    const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
    if (process.env.SERVICE_ACCOUNT_JSON) {
        credential = cert(JSON.parse(process.env.SERVICE_ACCOUNT_JSON));
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        credential = cert(require(path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS)));
    } else if (DATA_BACKEND === 'firestore') {
        credential = applicationDefault();
    }
    return initializeApp(credential ? { credential, projectId: PROJECT_ID } : { projectId: PROJECT_ID });
}

if (DATA_BACKEND === 'firestore' || AUTH_MODE === 'firebase') {
    firebaseApp = initFirebase();
}

if (DATA_BACKEND === 'local') {
    const localFile = process.env.LOCAL_DB_FILE || path.join(process.cwd(), '.local-data', 'db.json');
    rawDb = createLocalStore({ file: localFile, logger: console });
    FieldValue = createFieldValue();
    console.log(`[data] Using the local JSON store at ${localFile} (no Firebase operations).`);
} else {
    const { getFirestore, FieldValue: FirestoreFieldValue } = require('firebase-admin/firestore');
    rawDb = getFirestore();
    FieldValue = FirestoreFieldValue;
}

const cacheTtl = process.env.READ_CACHE_TTL_MS !== undefined && process.env.READ_CACHE_TTL_MS !== ''
    ? Number(process.env.READ_CACHE_TTL_MS)
    : undefined;
const dataLayer = createDbLayer(rawDb, { ttlMs: cacheTtl, counters: { reads: 0, writes: 0, deletes: 0 } });
const db = dataLayer.db;

// ---------------------------------------------------------------------------
// Quota guard
// ---------------------------------------------------------------------------

let fetchUsage = null;
if (quotaSource === 'monitoring') {
    if (!credential) {
        console.warn('[quota] QUOTA_SOURCE=monitoring needs Admin SDK credentials; stop mode will fail closed.');
    } else {
        fetchUsage = createMonitoringUsageFetcher({
            projectId: PROJECT_ID,
            getAccessToken: () => credential.getAccessToken(),
            logger: console
        });
    }
}

// Guarding Firebase is the point. A MacBook running the local JSON store has no
// Firebase allowance to protect, so its guard defaults to "off".
const defaultQuotaAction = DATA_BACKEND === 'firestore' ? 'stop' : 'off';

const quota = createQuotaGuard({
    env: process.env,
    limits: readLimits(process.env),
    action: normalizeAction(process.env.QUOTA_ACTION || defaultQuotaAction),
    source: quotaSource,
    fetchUsage,
    // Only Firestore operations count against the Firebase allowance.
    counters: DATA_BACKEND === 'firestore' ? () => dataLayer.counters : null,
    stateFile: process.env.QUOTA_STATE_FILE !== undefined
        ? process.env.QUOTA_STATE_FILE
        : (DATA_BACKEND === 'local' ? path.join(process.cwd(), '.local-data', 'quota.json') : ''),
    logger: console
});

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

// Set to the exact hop count in front of this app (1 behind ngrok/nginx/tunnel).
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.disable('x-powered-by');

// Serve the static web app too when running on the MacBook, so Safari can use
// relative URLs with no CORS and no mixed-content problems.
if (SERVE_STATIC) {
    const staticRoot = path.resolve(process.env.STATIC_ROOT || path.join(__dirname, '..'));
    const { isPublicPath } = require('./lib/public-files');
    app.use((req, res, next) => {
        if (/^\/api(?:[/?]|$)/.test(req.path) || req.path === '/health') return next();
        return isPublicPath(req.path) ? next() : res.status(404).end();
    });
    // Local pages always use this server, not a baked-in production hostname.
    app.get('/api-env.js', (req, res) => res.type('js').set('Cache-Control', 'no-store').send(
        "window.OWL_API_CONFIG = {primary: location.origin + '/api', fallbacks: []};"
    ));
    app.use(express.static(staticRoot, {
        dotfiles: 'ignore',
        extensions: ['html'],
        index: 'index.html',
        maxAge: 0
    }));
}

const extraOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
if (SERVE_STATIC) extraOrigins.push(`http://localhost:${process.env.PORT || 3000}`, `http://127.0.0.1:${process.env.PORT || 3000}`);
const isAllowedOrigin = createOriginChecker(extraOrigins, TUNNEL_PREVIEW ? {
    allowNgrok: false,
    exactOrigins: ['https://prsd503.github.io']
} : {});

app.use((req, res, next) => cors({
    origin(origin, callback) {
        if (isAllowedOrigin(origin) || (SERVE_STATIC && origin === `${req.protocol}://${req.get('host')}`)) return callback(null, true);
        console.log('CORS blocked for origin:', origin);
        return callback(new Error('Blocked by CORS: Unauthorized Origin'));
    },
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning', 'X-Firebase-AppCheck'],
    exposedHeaders: ['X-Owl-Drain', 'X-Owl-Quota-Level', 'X-Owl-Quota-Used', 'X-Owl-Fallback-Url', 'Retry-After'],
    credentials: true
})(req, res, next));

if (TUNNEL_PREVIEW) {
    // Cap requests before monitoring/auth work. This is per process, not a
    // distributed abuse/billing control. Unknown/private routes fail closed.
    app.use(rateLimit({
        windowMs: 60000, limit: 60, standardHeaders: true, legacyHeaders: false,
        message: { error: 'Too many preview requests; try again shortly.' }
    }));
    app.use(createPreviewGate());
}

app.use(express.json({ limit: '1mb', type: ['application/json', 'text/plain'] }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Stop before doing any Firebase work once the free-tier safety limit is hit.
// /health and /api/quota stay reachable so clients and you can see why.
app.use(quota.middleware);

// Diagnostics do not touch Firebase, and remain available during a drain.
app.get('/health', (req, res) => res.set('Cache-Control', 'no-store').json(healthPayload()));
app.get('/api/health', (req, res) => res.set('Cache-Control', 'no-store').json(healthPayload()));
app.get('/api/quota', quota.handler);

// App Check is verified cryptographically; Origin is never treated as authentication.
app.use(createAppCheckMiddleware({
    mode: APP_CHECK_MODE,
    verifyToken: APP_CHECK_MODE === 'off'
        ? undefined
        : token => require('firebase-admin/app-check').getAppCheck().verifyToken(token)
}));

const { optionalAuth, requireAuth, requireAdmin } = createAuthMiddleware({
    projectId: PROJECT_ID,
    adminUids: ADMIN_UIDS,
    verifyIdToken: AUTH_MODE === 'firebase'
        ? token => require('firebase-admin/auth').getAuth().verifyIdToken(token, true)
        : async () => { throw new Error('Firebase ID tokens are not accepted while AUTH_MODE=local.'); },
    verifyJwt: token => jwt.verify(token, JWT_SECRET)
});

const giftCodes = createGiftCodeService({ db, FieldValue });
const maintenance = createMaintenance({ db, FieldValue, logger: console, timeZone: process.env.CRON_TIMEZONE, beforeRun: async () => {
    await quota.refresh();
    return !quota.isDraining();
} });

// Identify the caller when credentials are supplied, without blocking public reads.
app.use(optionalAuth);

app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' }
}));

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts, please try again later.' }
});

function healthPayload() {
    const snap = quota.snapshot();
    return {
        status: 'ok',
        accessMode: TUNNEL_PREVIEW ? 'tunnel-preview' : 'standard',
        target: IS_FUNCTIONS ? 'firebase-functions' : 'node',
        dataBackend: DATA_BACKEND,
        authMode: AUTH_MODE,
        quota: {
            level: snap.level,
            draining: snap.draining,
            ratio: snap.ratio,
            threshold: snap.threshold,
            source: snap.source,
            action: snap.action
        },
        uptimeSeconds: Math.round(process.uptime())
    };
}

// --- APP VERSION POLICY ---
// Read with the Admin SDK, which bypasses Firestore rules AND App Check enforcement.
// This lets the update popup work even when native attestation is still misconfigured.
app.get('/api/app-version', async (req, res) => {
    try {
        const snap = await db.collection('app_config').doc('appVersion').get();
        if (!snap.exists) return res.status(404).json({ error: 'Version policy not configured.' });
        const payload = buildVersionResponse(snap.data(), req.query);
        res.set('Cache-Control', 'public, max-age=60').json(payload);
    } catch (err) {
        if (err.status === 400) return res.status(400).json({ error: err.message });
        console.error('app-version error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// --- AUTH TOKEN EXCHANGE ---
app.post('/api/auth/token', authLimiter, async (req, res) => {
    try {
        const { idToken, email, password } = req.body || {};

        if (AUTH_MODE === 'local') {
            if (!email || !password) {
                return res.status(400).json({ error: 'email and password are required while AUTH_MODE=local.' });
            }
            const emailMatches = String(email).trim().toLowerCase() === LOCAL_ADMIN_EMAIL;
            if (!emailMatches || !safeCompare(password, LOCAL_ADMIN_PASSWORD)) {
                return res.status(401).json({ error: 'Unauthorized: invalid local admin credentials.' });
            }
            const token = jwt.sign(
                { uid: `local:${LOCAL_ADMIN_EMAIL}`, email: LOCAL_ADMIN_EMAIL, role: 'admin', authVersion: 2 },
                JWT_SECRET,
                { expiresIn: '1h' }
            );
            return res.json({ token, expiresin: 3600 });
        }

        if (!idToken) return res.status(400).json({ error: 'Firebase ID token is required' });
        const decoded = await require('firebase-admin/auth').getAuth().verifyIdToken(idToken, true);
        const token = jwt.sign(
            { uid: decoded.uid, email: decoded.email || null, role: firebaseRole(decoded, ADMIN_UIDS), authVersion: 2 },
            JWT_SECRET,
            { expiresIn: '1h' }
        );
        res.json({ token, expiresin: 3600 });
    } catch (err) {
        console.error('Firebase token verification failed:', err.code || '', err.message);
        res.status(401).json({ error: 'Unauthorized: Invalid Firebase ID token.', code: err.code || 'unknown_auth_error' });
    }
});

// --- PUBLIC READS ---
/* ---- E-Bouquet premium codes -------------------------------------------------
 * A 9 digit code unlocks the premium themes for one bouquet. Codes are created
 * by Owl Watcher staff and redeemed exactly once; the transaction in
 * lib/gift-codes.js is what makes "used once" true rather than hopeful.
 */
// The code itself is the credential; both routes are covered by the /api/
// rate limiter, App Check and quota guard. Unlocking is read-only. Only the
// Share GIF action redeems, rechecking availability in an atomic transaction.
app.post('/api/gift-codes/validate', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const result = await giftCodes.validate(req.body && req.body.code);
        if (!result.ok) return res.status(result.status).json({ error: result.error });
        return res.json({ unlocked: true, code: result.code, price: result.price });
    } catch (err) {
        console.error('gift code validation failed:', err);
        return res.status(500).json({ error: 'Could not check that code right now.' });
    }
});

app.post('/api/gift-codes/redeem', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const result = await giftCodes.redeem(req.body && req.body.code, 'guest');
        if (!result.ok) return res.status(result.status).json({ error: result.error });
        return res.json({ unlocked: true, consumed: true, code: result.code, price: result.price });
    } catch (err) {
        console.error('gift code redemption failed:', err);
        return res.status(500).json({ error: 'Could not redeem that code right now.' });
    }
});

// Staff only: mint a batch of codes to hand out after payment.
app.post('/api/gift-codes', requireAuth, requireAdmin, async (req, res) => {
    try {
        const created = await giftCodes.create(req.body && req.body.count, req.user.email || req.user.uid);
        return res.json({ created, price: giftCodes.PRICE_INR, count: created.length });
    } catch (err) {
        console.error('gift code creation failed:', err);
        return res.status(500).json({ error: 'Could not create codes right now.' });
    }
});

app.get('/api/config', async (req, res) => {
    try {
        const doc = await db.collection('configs').doc('owlwatcher').get();
        if (!doc.exists) return res.status(404).json({ error: 'Config not found' });
        res.json(doc.data());
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ads/global', async (req, res) => {
    try {
        const snap = await db.collection('ads').doc('global').get();
        const data = snap.exists ? snap.data() : {};
        const items = data.items || data.ads || [];
        res.json(Array.isArray(items) ? items : []);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ads/local/:deviceId', async (req, res) => {
    try {
        const requestedId = req.params.deviceId.trim().toLowerCase();
        const snapshot = await db.collection('ads').get();
        let matchedDoc = null;
        snapshot.forEach(doc => { if (doc.id.trim().toLowerCase() === requestedId) matchedDoc = doc; });
        if (!matchedDoc) return res.status(200).json([]);
        const data = matchedDoc.data();
        let items = [];
        if (data.items) {
            items = Array.isArray(data.items) ? data.items : Object.values(data.items);
        } else {
            items = Object.entries(data)
                .filter(([, val]) => val && typeof val === 'object' && (val.greetingId || val.imageUrl))
                .map(([key, val]) => ({ id: key, ...val }));
        }
        res.status(200).json(items);
    } catch (err) { console.error(err); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/ads/greeting/:id', async (req, res) => {
    try {
        const targetId = req.params.id;
        const adsSnapshot = await db.collection('ads').get();
        let foundItem = null, foundDocId = null;
        adsSnapshot.forEach(doc => {
            if (foundItem) return;
            const data = doc.data();
            if (data[targetId] && typeof data[targetId] === 'object') {
                foundItem = data[targetId]; foundDocId = doc.id;
            } else {
                const matched = Object.values(data).find(item =>
                    item && typeof item === 'object' && (item.greetingId === targetId || item.id === targetId));
                if (matched) { foundItem = matched; foundDocId = doc.id; }
            }
        });
        if (!foundItem) return res.status(404).json({ error: `Greeting with ID '${targetId}' not found.` });
        res.json({ ...foundItem, societyId: foundDocId });
    } catch (err) { console.error('Greeting fetch error:', err); res.status(500).json({ error: err.message }); }
});

app.get('/api/admins', async (req, res) => {
    try {
        const { society, societyName, email } = req.query;
        const targetSociety = (society || societyName || '').trim().toLowerCase();
        const snapshot = await db.collection('admins').get();
        const admins = [];
        snapshot.forEach(doc => admins.push({ id: doc.id, ...doc.data() }));
        const matched = admins.find(a => {
            if (email && a.email && a.email.toLowerCase() === String(email).toLowerCase()) return true;
            if (targetSociety && a.society && a.society.toLowerCase() === targetSociety) return true;
            return false;
        });
        if (!matched) return res.status(404).json({ error: 'Admin not found' });
        res.json(matched);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admins/verify-society', async (req, res) => {
    try {
        const search = String(req.query.society || '').trim().toLowerCase();
        if (!search) return res.status(400).json({ error: 'society is required' });
        const snapshot = await db.collection('admins').get();
        let matched = null;
        snapshot.forEach(doc => {
            const data = doc.data();
            if (doc.id.toLowerCase() === search || (data.society || '').toLowerCase() === search) {
                matched = { id: doc.id, society: data.society || doc.id };
            }
        });
        if (!matched) return res.status(404).json({ error: 'Society not found' });
        res.json(matched);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admins/:email', async (req, res) => {
    try {
        const doc = await db.collection('admins').doc(req.params.email).get();
        if (!doc.exists) return res.status(404).json({ error: 'Admin not found' });
        res.json({ id: doc.id, ...doc.data() });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/guards', async (req, res) => {
    try {
        const { society, email, name_lower } = req.query;
        let query = db.collection('guards');
        if (society) query = query.where('society', '==', society);
        if (email) query = query.where('email', '==', email);
        if (name_lower) query = query.where('name_lower', '==', name_lower);
        const snapshot = await query.get();
        const guards = [];
        snapshot.forEach(doc => guards.push({ id: doc.id, ...doc.data() }));
        res.json(guards);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/vehicles', async (req, res) => {
    try {
        const { societyName, society, vehicleNumber, flatNumber } = req.query;
        const targetSociety = (societyName || society || '').trim();
        let query = db.collection('vehicles');
        if (targetSociety) query = query.where('societyName', '==', targetSociety);
        if (vehicleNumber) query = query.where('vehicleNumber', '==', String(vehicleNumber).toUpperCase());
        if (flatNumber) query = query.where('flatNumber', '==', flatNumber);
        const snapshot = await query.get();
        const vehicles = [];
        snapshot.forEach(doc => vehicles.push({ id: doc.id, ...doc.data() }));
        res.json(vehicles);
    } catch (err) { console.error('Vehicle fetch error:', err); res.status(500).json({ error: err.message }); }
});

app.get('/api/verify-device/:deviceId', async (req, res) => {
    try {
        const { deviceId } = req.params;
        if (!deviceId) return res.status(400).json({ registered: false, error: 'Device ID is required' });
        const snapshot = await db.collection('vehicles').where('deviceId', '==', deviceId).limit(1).get();
        if (snapshot.empty) return res.json({ registered: false });
        res.json({ registered: true, data: snapshot.docs[0].data() });
    } catch (err) { console.error('Device verification error:', err); res.status(500).json({ error: err.message }); }
});

app.get('/api/notices/:societyIdentifier', async (req, res) => {
    try {
        await maintenance.checkAndShiftNotices();
        const identifier = req.params.societyIdentifier;
        let noticeDoc = await db.collection('notices').doc(identifier).get();
        if (!noticeDoc.exists) {
            const snapshot = await db.collection('notices').get();
            const matched = snapshot.docs.find(doc => {
                const data = doc.data();
                return doc.id.toLowerCase() === identifier.toLowerCase() ||
                    (data.societyName && data.societyName.toLowerCase() === identifier.toLowerCase());
            });
            if (matched) noticeDoc = matched;
        }
        if (!noticeDoc.exists) return res.status(404).json({ error: 'Notice not found' });
        res.json(noticeDoc.data());
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/facilities/:societyIdentifier', async (req, res) => {
    try {
        const identifier = req.params.societyIdentifier;
        let docSnap = await db.collection('facilities').doc(identifier).get();
        if (!docSnap.exists) {
            const snapshot = await db.collection('facilities').get();
            const matched = snapshot.docs.find(doc => {
                const data = doc.data();
                return doc.id.toLowerCase() === identifier.toLowerCase() ||
                    (data.societyName && data.societyName.toLowerCase() === identifier.toLowerCase());
            });
            if (matched) docSnap = matched;
        }
        res.json(docSnap.exists ? docSnap.data() : {});
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/bookings', async (req, res) => {
    try {
        const snapshot = await db.collection('bookings').where('society', '==', req.query.society).get();
        const bookings = [];
        snapshot.forEach(doc => bookings.push({ id: doc.id, ...doc.data() }));
        res.json(bookings);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/societies', async (req, res) => {
    try {
        const snapshot = await db.collection('societies').get();
        const societies = [];
        snapshot.forEach(doc => societies.push({ id: doc.id, name: doc.id, ...doc.data() }));
        res.json(societies);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/societies/verify', async (req, res) => {
    try {
        const searchName = String(req.query.name || '').trim().toLowerCase();
        const snapshot = await db.collection('societies').get();
        let matched = null;
        snapshot.forEach(doc => {
            const data = doc.data();
            if (doc.id.toLowerCase() === searchName || (data.name || '').toLowerCase() === searchName) {
                matched = { id: doc.id, name: data.name || doc.id, ...data };
            }
        });
        if (!matched) return res.status(404).json({ error: 'Society not found' });
        res.json(matched);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Specific subroutes must be declared before the generic /:identifier reader.
app.get('/api/societies/:societyIdentifier/active-guard', async (req, res) => {
    try {
        const doc = await findSocietyDoc(req.params.societyIdentifier);
        if (!doc || !doc.exists) return res.status(404).json({ error: 'Society not found' });
        const data = doc.data();
        res.json({
            id: doc.id, name: data.name || doc.id,
            activeGuardName: data.activeGuardName || null,
            activeGuardPhone: data.activeGuardPhone || null
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/societies/:societyIdentifier', async (req, res) => {
    try {
        const doc = await findSocietyDoc(req.params.societyIdentifier);
        if (!doc || !doc.exists) return res.status(404).json({ error: 'Society not found' });
        res.json({ id: doc.id, name: doc.id, ...doc.data() });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

async function findSocietyDoc(identifier) {
    let doc = await db.collection('societies').doc(identifier).get();
    if (doc.exists) return doc;
    const snapshot = await db.collection('societies').get();
    return snapshot.docs.find(d => {
        const data = d.data();
        return d.id.toLowerCase() === identifier.toLowerCase() ||
            (data.name && data.name.toLowerCase() === identifier.toLowerCase());
    }) || null;
}

// --- PASSWORD RESET ---
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
    try {
        const { email, role } = req.body || {};
        if (!email) return res.status(400).json({ error: 'Email is required' });
        if (!credential) {
            return res.status(501).json({ error: 'Password reset needs Firebase Admin credentials and is disabled in local mode.' });
        }
        const emailLower = String(email).trim().toLowerCase();
        const isGuard = role === 'guard';

        let exists = false;
        if (isGuard) {
            const snapshot = await db.collection('guards').where('email', '==', emailLower).get();
            exists = !snapshot.empty;
        } else {
            const adminDoc = await db.collection('admins').doc(emailLower).get();
            exists = adminDoc.exists;
            if (!exists) {
                const snapshot = await db.collection('admins').where('email', '==', emailLower).get();
                exists = !snapshot.empty;
            }
        }
        if (!exists) {
            return res.status(404).json({
                error: isGuard ? 'No guard registered with entered emailid' : 'No admin registered with this entered email id'
            });
        }

        // Administrative reset bypasses client App Check enforcement intentionally.
        const accessToken = await credential.getAccessToken();
        const response = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken.access_token}` },
            body: JSON.stringify({ requestType: 'PASSWORD_RESET', email: emailLower })
        });
        const parsed = await response.json().catch(() => ({}));
        if (!response.ok) {
            console.error('Firebase reset error:', parsed);
            return res.status(response.status).json({ error: (parsed.error && parsed.error.message) || 'Failed to send reset email' });
        }
        res.json({ success: true, message: 'Password reset link sent to your email!' });
    } catch (err) {
        console.error('[Forgot Password] Error:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- RESIDENT / PUBLIC WRITES ---
// entry.html registers vehicles without an admin login; keep this reachable but
// never allow it to overwrite an existing document by id.
app.post('/api/vehicles', async (req, res) => {
    try {
        let body = req.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
        body = body || {};

        const isAdmin = Boolean(req.user && req.user.role === 'admin');
        const deviceId = body.deviceId || null;
        const societyName = (body.societyName || body.society || '').trim();
        const flatNumber = (body.flatNumber || body.flat || '').trim();
        const residentType = (body.residentType || '').trim();
        const mobileNumber = (body.mobileNumber || body.mobile || '').trim();
        const docId = body.id;

        let vehiclesToProcess = [];
        if (Array.isArray(body.vehicles)) vehiclesToProcess = body.vehicles;
        else if (typeof body.vehicles === 'string') { try { vehiclesToProcess = JSON.parse(body.vehicles); } catch (_) {} }
        if (vehiclesToProcess.length === 0 && body.vehicleNumber) {
            vehiclesToProcess = [{ vehicleNumber: body.vehicleNumber, vehicleType: body.vehicleType || '2-Wheeler' }];
        }
        const valid = vehiclesToProcess.filter(v => v && String(v.vehicleNumber || '').trim() !== '');
        if (valid.length === 0) {
            return res.status(400).json({ error: 'Vehicle number is required. Please fill in at least one vehicle number.' });
        }

        // Editing an existing record is an admin action.
        if (docId) {
            if (!isAdmin) return res.status(403).json({ error: 'Forbidden: Admin privileges required to edit a vehicle.' });
            if (valid.length !== 1) return res.status(400).json({ error: 'Exactly one vehicle is required when editing.' });
            await db.collection('vehicles').doc(docId).set({
                flatNumber: flatNumber || 'Unknown',
                residentType: residentType || 'Resident',
                mobileNumber: mobileNumber || '',
                vehicleType: String(valid[0].vehicleType || '2-Wheeler').trim(),
                vehicleNumber: String(valid[0].vehicleNumber).trim().toUpperCase(),
                deviceId,
                updatedAt: FieldValue.serverTimestamp()
            }, { merge: true });
            return res.json({ success: true });
        }

        const batch = db.batch();
        for (const v of valid) {
            batch.set(db.collection('vehicles').doc(), {
                vehicleNumber: String(v.vehicleNumber).trim().toUpperCase(),
                vehicleType: String(v.vehicleType || '2-Wheeler').trim(),
                flatNumber: flatNumber || 'Unknown',
                residentType: residentType || 'Resident',
                mobileNumber: mobileNumber || '',
                societyName: societyName || 'Aangan',
                deviceId,
                createdAt: FieldValue.serverTimestamp()
            });
        }
        await batch.commit();
        res.json({ success: true });
    } catch (err) { console.error('Vehicle API Error:', err); res.status(500).json({ error: err.message }); }
});

app.post('/api/contest/spin', async (req, res) => {
    try {
        const { societyName, flatNumber, winnerFlat } = req.body || {};
        const resolvedFlat = flatNumber || winnerFlat;
        if (!societyName) return res.status(400).json({ error: 'Society name is required' });
        const searchName = String(societyName).trim().toLowerCase();

        const societiesSnapshot = await db.collection('societies').get();
        let matchedDocId = null, societyData = {};
        societiesSnapshot.forEach(doc => {
            const data = doc.data();
            if (doc.id.toLowerCase() === searchName || (data.name || '').toLowerCase() === searchName) {
                matchedDocId = doc.id; societyData = data;
            }
        });
        if (!matchedDocId) return res.status(404).json({ error: 'Society not found' });

        const raw = societyData.spintodayNumber;
        const target = (raw !== undefined && raw !== null && raw !== '') ? Number(raw) : null;
        const todayStr = new Date().toISOString().split('T')[0];
        const statRef = db.collection('spinStats').doc(`${searchName}_${todayStr}`);

        // Atomic increment avoids the read-then-write race in the original handler.
        const currentCount = await db.runTransaction(async tx => {
            const snap = await tx.get(statRef);
            const next = snap.exists ? (snap.data().spinCount || 0) + 1 : 1;
            const payload = { spinCount: next };
            if (resolvedFlat) payload.winnerFlat = String(resolvedFlat).trim();
            if (!snap.exists) {
                payload.societyName = matchedDocId;
                payload.date = todayStr;
                payload.createdAt = FieldValue.serverTimestamp();
                tx.set(statRef, payload);
            } else {
                tx.update(statRef, payload);
            }
            return next;
        });

        res.json({ success: true, spinCount: currentCount, won: target !== null && currentCount === target });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contest/winner', async (req, res) => {
    try {
        const { societyName, flatNumber, winnerFlatnumber } = req.body || {};
        const resolvedFlat = flatNumber || winnerFlatnumber;
        if (!societyName || !resolvedFlat) {
            return res.status(400).json({ error: 'Society name and flat number are required' });
        }
        const trimmed = String(societyName).trim();
        await db.collection('winners').add({
            societyName: trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase(),
            winnerFlatnumber: String(resolvedFlat).trim(),
            flatNumber: String(resolvedFlat).trim(),
            createdAt: FieldValue.serverTimestamp()
        });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/contest/winners', async (req, res) => {
    try {
        const snapshot = await db.collection('winners').orderBy('createdAt', 'desc').limit(10).get();
        const winners = [];
        snapshot.forEach(doc => winners.push({ id: doc.id, ...doc.data() }));
        res.json(winners);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/contest/spinstats', async (req, res) => {
    try {
        const { societyName } = req.query;
        if (!societyName) return res.status(400).json({ error: 'Society name is required' });
        const searchName = String(societyName).trim().toLowerCase();
        const todayStr = new Date().toISOString().split('T')[0];
        const statDoc = await db.collection('spinStats').doc(`${searchName}_${todayStr}`).get();
        const data = statDoc.exists ? statDoc.data() : {};
        const spinCount = data.spinCount || 0;

        const winnersSnapshot = await db.collection('winners')
            .where('societyName', '==', String(societyName).trim()).get();
        let latestWinnerFlat = 'None yet';
        if (!winnersSnapshot.empty) {
            const docs = winnersSnapshot.docs.map(d => d.data())
                .filter(d => (d.societyName || '').trim().toLowerCase() === searchName);
            docs.sort((a, b) => {
                const t = v => (v && v.toMillis) ? v.toMillis() : new Date(v || 0).getTime();
                return t(b.createdAt) - t(a.createdAt);
            });
            if (docs.length) latestWinnerFlat = docs[0].flatNumber || docs[0].winnerFlatnumber || 'None yet';
        }
        res.json({
            societyName, totalSpins: spinCount, totalDaySpins: spinCount,
            totalMonthSpins: 0, winnerFlat: latestWinnerFlat
        });
    } catch (err) { console.error('Spin Stats API Error:', err); res.status(500).json({ error: err.message }); }
});

// --- ADMIN WRITES (require a verified admin identity) ---
app.post('/api/config', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { teamPhone } = req.body || {};
        await db.collection('configs').doc('owlwatcher').set({ teamPhone }, { merge: true });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/notices/:societyId', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { todayMessage, tomorrowMessage, date } = req.body || {};
        await db.collection('notices').doc(req.params.societyId).set({
            todayMessage, tomorrowMessage, date, updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/notices/:societyId', requireAuth, requireAdmin, async (req, res) => {
    try {
        await db.collection('notices').doc(req.params.societyId).delete();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/guards', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { targetDocId, email, name, name_lower, phone, society } = req.body || {};
        const docId = targetDocId || email;
        if (!docId) return res.status(400).json({ error: 'email or targetDocId is required' });
        await db.collection('guards').doc(docId).set({
            email, name, name_lower, phone, society, updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/guards/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await db.collection('guards').doc(req.params.id).delete();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/vehicles/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await db.collection('vehicles').doc(req.params.id).delete();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/facilities/:societyIdentifier', requireAuth, requireAdmin, async (req, res) => {
    try {
        await db.collection('facilities').doc(req.params.societyIdentifier).set(req.body || {}, { merge: true });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/bookings', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { society, facilityId, start, end } = req.body || {};
        const bookingEndDate = new Date(end || start);
        if (Number.isNaN(bookingEndDate.getTime())) return res.status(400).json({ error: 'Invalid booking date.' });
        await db.collection('bookings').add({
            society, facilityId, start, end,
            expireAt: new Date(bookingEndDate.getTime() + 7 * 24 * 60 * 60 * 1000)
        });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/bookings/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await db.collection('bookings').doc(req.params.id).delete();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/societies/:societyId/active-guard', requireAuth, async (req, res) => {
    try {
        const { activeGuardName, activeGuardPhone } = req.body || {};
        await db.collection('societies').doc(req.params.societyId).set({
            activeGuardName: activeGuardName || null,
            activeGuardPhone: activeGuardPhone || null
        }, { merge: true });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/societies/:societyId/limits', requireAuth, requireAdmin, async (req, res) => {
    try {
        const max4Wheeler = Number(req.body && req.body.max4Wheeler);
        const max2Wheeler = Number(req.body && req.body.max2Wheeler);
        if (!Number.isInteger(max4Wheeler) || !Number.isInteger(max2Wheeler) || max4Wheeler < 0 || max2Wheeler < 0) {
            return res.status(400).json({ error: 'max4Wheeler and max2Wheeler must be non-negative integers.' });
        }
        await db.collection('societies').doc(req.params.societyId).set({ max4Wheeler, max2Wheeler }, { merge: true });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/societies/:societyId/flats', requireAuth, requireAdmin, async (req, res) => {
    try {
        await db.collection('societies').doc(req.params.societyId).set({
            flats: (req.body && req.body.flats) || [], updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/ads/:adKey', requireAuth, requireAdmin, async (req, res) => {
    try {
        await db.collection('ads').doc(req.params.adKey).set(req.body || {}, { merge: true });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- FALLBACKS ---
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Express 5 forwards rejected async handlers here automatically.
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err && /CORS/.test(err.message || '')) return res.status(403).json({ error: 'Blocked by CORS: Unauthorized Origin' });
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function safeCompare(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function lanAddresses(port) {
    const addresses = [];
    for (const interfaces of Object.values(os.networkInterfaces())) {
        for (const iface of interfaces || []) {
            if (iface.family === 'IPv4' && !iface.internal) addresses.push(`http://${iface.address}:${port}`);
        }
    }
    return addresses;
}

function start(port = Number(process.env.PORT) || 3000, host = process.env.HOST || '0.0.0.0') {
    const server = app.listen(port, host, () => {
        const snap = quota.snapshot();
        console.log(`Owl Watcher API listening on http://${host}:${port}`);
        if (SERVE_STATIC) console.log(`  Static site:  http://localhost:${port}/`);
        for (const address of lanAddresses(port)) console.log(`  On your LAN:  ${address}`);
        if (TUNNEL_PREVIEW) console.log('  TUNNEL PREVIEW: read-only public content; private routes, sign-in and writes BLOCKED.');
        console.log(`  Data: ${DATA_BACKEND} | Auth: ${AUTH_MODE} | App Check: ${APP_CHECK_MODE}`);
        console.log(`  Quota guard: ${snap.action} at ${Math.round(snap.threshold * 100)}% (source: ${snap.source})`);
        if (snap.fallbackUrls.length) console.log(`  Quota fallback: ${snap.fallbackUrls.join(', ')}`);
    });

    // Prime the authoritative usage numbers at boot; never block startup on them.
    quota.refresh(true).catch(() => {});

    if (ENABLE_CRON) {
        maintenance.runAll().catch(() => {});
        maintenance.schedule(process.env.CRON_SCHEDULE || '0 0 * * *');
    }

    let closing = false;
    const shutdown = signal => {
        if (closing) return;
        closing = true;
        console.log(`\n[${signal}] Shutting down...`);
        quota.close();
        server.close(() => {
            try { if (typeof rawDb.flush === 'function') rawDb.flush(); } catch (_) {}
            process.exit(0);
        });
        setTimeout(() => process.exit(0), 4000).unref();
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

    return server;
}

if (require.main === module) {
    start();
}

module.exports = app;
module.exports.start = start;
module.exports.quota = quota;
module.exports.maintenance = maintenance;
module.exports.dataLayer = dataLayer;
module.exports.config = {
    DATA_BACKEND,
    AUTH_MODE,
    APP_CHECK_MODE,
    PROJECT_ID,
    IS_FUNCTIONS,
    SERVE_STATIC,
    TUNNEL_PREVIEW
};
