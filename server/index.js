/* Owl Watcher API server.
 *
 * The same Express app runs in two supported places:
 *   1. Firebase Cloud Functions  - `server/firebase.js` (restricted deploy target)
 *   2. A MacBook                 - `npm run start:local` (local test/fallback)
 * Former VPS/Hostinger deployment is historical and is not an authorized backend target.
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
const { createAuthorization, normalize: normalizeAuthValue } = require('./lib/authorization');
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
} : IS_FUNCTIONS ? {
    allowNgrok: false, exactOrigins: extraOrigins
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

const { optionalAuth } = createAuthMiddleware({
    projectId: PROJECT_ID,
    verifyIdToken: AUTH_MODE === 'firebase'
        ? token => require('firebase-admin/auth').getAuth().verifyIdToken(token, true)
        : async () => { throw new Error('Firebase ID tokens are not accepted while AUTH_MODE=local.'); },
    verifyJwt: token => jwt.verify(token, JWT_SECRET)
});

const authorization = createAuthorization({ db, authMode: AUTH_MODE });
const requireStaff = authorization.requireStaff;
const requireMaster = authorization.requireMaster;
const requireAdminForSociety = identifier => authorization.requireSociety(['admin'], identifier);
const requireStaffForSociety = identifier => authorization.requireSociety(['admin', 'guard'], identifier);

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
        accessMode: TUNNEL_PREVIEW ? 'tunnel-preview' : (IS_FUNCTIONS ? 'firebase-full' : 'standard'),
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

function requestedSociety(req) {
    const query = req.query || {};
    const body = req.body || {};
    return query.societyId || query.societyName || query.society ||
        body.societyId || body.societyName || body.society || null;
}

function publicSociety(society) {
    const data = society.data || {};
    const flatList = Array.isArray(data.flatList) ? data.flatList : (Array.isArray(data.flats) ? data.flats : []);
    const result = { id: society.id, name: society.name, flatList, flats: flatList };
    for (const field of ['max2Wheeler', 'max4Wheeler']) {
        if (Number.isInteger(data[field]) && data[field] >= 0) result[field] = data[field];
    }
    return result;
}

function isVehicleForSociety(data, society) {
    if (!data || typeof data !== 'object') return false;
    if (data.societyId !== undefined && data.societyId !== null && data.societyId !== '') {
        return String(data.societyId) === society.id;
    }
    const aliases = new Set(society.aliases.map(normalizeAuthValue));
    return [data.societyName, data.society].some(value => aliases.has(normalizeAuthValue(value)));
}

function vehicleSocietyQueries(society) {
    const aliases = society.aliases.slice(0, 30);
    return [
        db.collection('vehicles').where('societyId', '==', society.id),
        db.collection('vehicles').where('societyName', 'in', aliases),
        db.collection('vehicles').where('society', 'in', aliases)
    ];
}

async function collectVehicleSnapshots(snapshots, society) {
    const documents = new Map();
    for (const snapshot of snapshots) {
        snapshot.forEach(doc => {
            if (isVehicleForSociety(doc.data(), society)) documents.set(doc.id, doc);
        });
    }
    return [...documents.values()];
}

async function getVehiclesForSociety(society, fresh = false) {
    const queries = vehicleSocietyQueries(society);
    const snapshots = await Promise.all(queries.map(query => query.get(fresh ? { fresh: true } : undefined)));
    return collectVehicleSnapshots(snapshots, society);
}

// Vehicle types accepted by the admin registry. The resident flow stays limited
// to 2/4-wheelers, but the admin form has always offered 3-Wheeler, so the
// registry must accept it rather than reject a valid admin edit.
const VEHICLE_TYPES = ['2-Wheeler', '3-Wheeler', '4-Wheeler'];

function normalizeVehicleType(value, fallback = '2-Wheeler') {
    let vehicleType = String(value == null ? '' : value).trim();
    if (/^2\s*-?\s*w(heeler)?$/i.test(vehicleType)) return '2-Wheeler';
    if (/^3\s*-?\s*w(heeler)?$/i.test(vehicleType)) return '3-Wheeler';
    if (/^4\s*-?\s*w(heeler)?$/i.test(vehicleType)) return '4-Wheeler';
    return VEHICLE_TYPES.includes(vehicleType) ? vehicleType : fallback;
}

function lookupVariants(value) {
    const raw = String(value == null ? '' : value).trim();
    return [...new Set([raw, raw.toLowerCase(), raw.toUpperCase()].filter(Boolean))];
}

async function getVehiclesMatchingField(society, field, values, fresh = false) {
    const variants = [...new Set(values.flatMap(value => field === 'deviceId'
        ? [String(value == null ? '' : value).trim()]
        : lookupVariants(value)).filter(Boolean))];
    if (!variants.length) return [];
    const query = variants.length === 1
        ? db.collection('vehicles').where(field, '==', variants[0])
        : db.collection('vehicles').where(field, 'in', variants);
    const snapshot = await query.get(fresh ? { fresh: true } : undefined);
    return collectVehicleSnapshots([snapshot], society);
}

function mergeVehicleDocuments(groups) {
    const found = new Map();
    for (const documents of groups) for (const doc of documents) found.set(doc.id, doc);
    return [...found.values()];
}

async function getVehiclesForRegistration(transaction, society, flatNumber, deviceId, vehicleNumbers) {
    const flatVariants = lookupVariants(flatNumber);
    const plateVariants = [...new Set(vehicleNumbers.flatMap(lookupVariants))];
    const queries = [
        db.collection('vehicles').where('flatNumber', flatVariants.length === 1 ? '==' : 'in', flatVariants),
        ...(deviceId ? [db.collection('vehicles').where('deviceId', '==', deviceId)] : []),
        db.collection('vehicles').where('vehicleNumber', plateVariants.length === 1 ? '==' : 'in', plateVariants)
    ];
    const snapshots = await Promise.all(queries.map(query => transaction.get(query)));
    return collectVehicleSnapshots(snapshots, society);
}

async function getVehiclesForDeviceInTransaction(transaction, society, deviceId) {
    const query = db.collection('vehicles').where('deviceId', '==', deviceId);
    const snapshot = await transaction.get(query);
    return collectVehicleSnapshots([snapshot], society);
}

function uniqueVehicleForDevice(documents, deviceId, expectedFlat) {
    const matches = documents.filter(doc => (doc.data() || {}).deviceId === deviceId);
    const flats = new Set(matches.map(doc => normalizeAuthValue((doc.data() || {}).flatNumber)));
    if (flats.size !== 1) return null;
    const linkedFlat = flats.values().next().value;
    if (!linkedFlat || (expectedFlat !== undefined && linkedFlat !== normalizeAuthValue(expectedFlat))) return null;
    return matches.find(doc => normalizeAuthValue((doc.data() || {}).flatNumber) === linkedFlat) || null;
}

function recordMatchesSociety(data, docId, society) {
    if (data && data.societyId) return data.societyId === society.id;
    const aliases = new Set(society.aliases.map(normalizeAuthValue));
    return aliases.has(normalizeAuthValue(docId)) ||
        [data && data.society, data && data.societyName].some(value => aliases.has(normalizeAuthValue(value)));
}

// Public contact projection: the WhatsApp number a resident should message to
// reach the society administrator. This is published on purpose (it is the same
// number the admin wants residents to call) and never exposes anything else from
// the Firestore `admins` documents.
function publicWhatsAppNumber(value) {
    const digits = String(value == null ? '' : value).replace(/\D/g, '').slice(0, 15);
    return digits.length >= 10 ? digits : null;
}

// A society's administrator record(s), looked up in `admins`. Records are keyed
// by admin email and identify their society with `societyId`, `society` or
// `societyName`; older documents may only store the display name.
async function findSocietyAdminRecords(society) {
    // `in` is case-sensitive, so both the document id and the display name are
    // queried as written; duplicates are removed by exact value only.
    const requested = [...new Set([society.id, society.name, ...society.aliases]
        .map(alias => String(alias == null ? '' : alias).trim())
        .filter(Boolean))].slice(0, 30);
    const fields = ['societyId', 'societyName', 'society'];
    const snapshots = await Promise.all(fields.map(field =>
        db.collection('admins').where(field, 'in', requested).get().catch(() => null)));
    const found = new Map();
    for (const snapshot of snapshots) {
        if (!snapshot) continue;
        snapshot.forEach(doc => {
            const data = doc.data() || {};
            if (data.disabled === true || data.active === false) return;
            if (!recordMatchesSociety(data, doc.id, society)) return;
            found.set(doc.id, doc);
        });
    }
    return [...found.values()];
}

function adminContactFor(records) {
    const contacts = records.map(doc => {
        const data = doc.data() || {};
        return {
            id: doc.id,
            isMaster: data.isMaster === true,
            phone: publicWhatsAppNumber(data.phone || data.whatsapp || data.whatsappNumber || data.mobile)
        };
    }).filter(contact => contact.phone);
    if (!contacts.length) return null;
    // A society-scoped administrator is the right first contact; the master
    // account is only the fallback when it is the one that stores a number.
    const chosen = contacts.find(contact => !contact.isMaster) || contacts[0];
    return { phone: chosen.phone };
}

async function getSocietyDocument(collectionName, society) {
    const found = new Map();
    const names = [...new Set([society.id, ...society.aliases])].slice(0, 30);
    for (const id of names) {
        try {
            const doc = await db.collection(collectionName).doc(id).get();
            if (doc.exists && recordMatchesSociety(doc.data() || {}, doc.id, society)) found.set(doc.id, doc);
        } catch (_) { /* Invalid legacy document IDs are skipped. */ }
    }
    const aliases = society.aliases.slice(0, 30);
    const queries = [
        db.collection(collectionName).where('societyId', '==', society.id),
        db.collection(collectionName).where('societyName', 'in', aliases),
        db.collection(collectionName).where('society', 'in', aliases)
    ];
    const snapshots = await Promise.all(queries.map(query => query.get()));
    for (const snapshot of snapshots) snapshot.forEach(doc => {
        if (recordMatchesSociety(doc.data() || {}, doc.id, society)) found.set(doc.id, doc);
    });
    return found.values().next().value || null;
}

function hashValue(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function contestAttemptDocumentId(societyId, date, deviceId, contestId) {
    return hashValue([societyId, date, deviceId, contestId].join('\\0'));
}

function utcDate(date = new Date()) {
    return date.toISOString().slice(0, 10);
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
            { uid: decoded.uid, email: decoded.email || null, email_verified: decoded.email_verified === true, authVersion: 2 },
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
app.post('/api/gift-codes', requireMaster, async (req, res) => {
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
        const data = doc.data() || {};
        return res.set('Cache-Control', 'public, max-age=60').json({ teamPhone: data.teamPhone || null });
    } catch (err) { res.status(500).json({ error: 'Internal server error' }); }
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

app.get('/api/admins', requireStaff, async (req, res) => {
    try {
        const membership = req.membership;
        if (!['admin', 'master'].includes(membership.role)) {
            return res.status(403).json({ error: 'Administrator membership required.', code: 'role-forbidden' });
        }
        return res.json({
            id: membership.membershipId,
            email: membership.email,
            society: membership.societyName || membership.societyId || '',
            societyId: membership.societyId || null,
            isMaster: membership.role === 'master'
        });
    } catch (_) { return res.status(503).json({ error: 'Authorization could not be verified.' }); }
});

// The signed-in administrator's own society, for pages such as the data
// deletion request that need to name it. Works for any staff member (admin or
// guard) and never reveals another member's society.
app.get('/api/admins/me', requireStaff, async (req, res) => {
    const membership = req.membership;
    return res.set('Cache-Control', 'private, no-store').json({
        email: membership.email,
        society: membership.societyName || '',
        societyId: membership.societyId || null,
        isMaster: membership.role === 'master'
    });
});

app.get('/api/admins/verify-society', requireStaff, async (req, res) => {
    try {
        const search = String(req.query.society || '').trim();
        if (!search) return res.status(400).json({ error: 'society is required' });
        if (!['admin', 'master'].includes(req.membership.role)) {
            return res.status(403).json({ error: 'Administrator membership required.', code: 'role-forbidden' });
        }
        const society = await authorization.resolveSociety(search);
        if (!society) return res.status(404).json({ error: 'Society not found' });
        if (req.membership.role !== 'master' && req.membership.societyId !== society.id) {
            return res.status(403).json({ error: 'Your staff account is not assigned to this society.', code: 'society-scope-forbidden' });
        }
        return res.json({ exists: true, id: society.id, society: society.name, name: society.name });
    } catch (_) { return res.status(503).json({ error: 'Authorization could not be verified.' }); }
});

app.get('/api/admins/:email', requireStaff, async (req, res) => {
    try {
        const email = normalizeAuthValue(req.params.email);
        if (req.membership.role !== 'master' && email !== req.membership.email) {
            return res.status(403).json({ error: 'Only the signed-in administrator profile is available.', code: 'self-only' });
        }
        const doc = await db.collection('admins').doc(email).get({ fresh: true });
        if (!doc.exists) return res.status(404).json({ error: 'Admin not found' });
        const data = doc.data() || {};
        const society = await authorization.resolveSociety(data.societyId || data.society || data.societyName);
        return res.json({
            id: doc.id, email: normalizeAuthValue(data.email || doc.id),
            society: society ? society.name : '', societyId: society ? society.id : null,
            isMaster: data.isMaster === true
        });
    } catch (_) { return res.status(503).json({ error: 'Authorization could not be verified.' }); }
});

app.get('/api/guards', requireStaff, async (req, res) => {
    try {
        const membership = req.membership;
        if (!['admin', 'guard', 'master'].includes(membership.role)) {
            return res.status(403).json({ error: 'Guard-directory access is not allowed.', code: 'role-forbidden' });
        }
        const requested = req.query.society || req.query.societyId ||
            (membership.role === 'master' ? '' : (membership.societyName || membership.societyId));
        const email = normalizeAuthValue(req.query.email || '');
        if (membership.role === 'master' && !requested && !email) {
            return res.status(400).json({ error: 'society or email is required.' });
        }
        if (membership.role === 'guard' && email && email !== membership.email) {
            return res.status(403).json({ error: 'Guards may only view their own membership.', code: 'self-only' });
        }

        let society = null;
        if (requested) {
            society = await authorization.resolveSociety(requested);
            if (!society) return res.status(404).json({ error: 'Society not found.' });
            if (membership.role !== 'master' && society.id !== membership.societyId) {
                return res.status(403).json({ error: 'Your staff account is not assigned to this society.', code: 'society-scope-forbidden' });
            }
        } else if (membership.role !== 'master') {
            society = await authorization.resolveSociety(membership.societyId);
        }

        let docs = [];
        if (society) {
            const aliases = society.aliases.slice(0, 30);
            const snapshots = await Promise.all([
                db.collection('guards').where('societyId', '==', society.id).get(),
                db.collection('guards').where('society', 'in', aliases).get(),
                db.collection('guards').where('societyName', 'in', aliases).get()
            ]);
            const found = new Map();
            for (const snapshot of snapshots) snapshot.forEach(doc => found.set(doc.id, doc));
            docs = [...found.values()].filter(doc => {
                const data = doc.data() || {};
                if (data.societyId) return data.societyId === society.id;
                return [data.society, data.societyName].some(value =>
                    society.aliases.some(alias => normalizeAuthValue(alias) === normalizeAuthValue(value)));
            });
        } else {
            const doc = await db.collection('guards').doc(email).get({ fresh: true });
            if (doc.exists && normalizeAuthValue((doc.data() || {}).email || doc.id) === email) docs = [doc];
        }
        const nameLower = normalizeAuthValue(req.query.name_lower || '');
        const guards = docs.filter(doc => {
            const data = doc.data() || {};
            if (email && normalizeAuthValue(data.email || doc.id) !== email) return false;
            if (nameLower && normalizeAuthValue(data.name_lower || data.name) !== nameLower) return false;
            return true;
        }).map(doc => {
            const data = doc.data() || {};
            return {
                id: doc.id, email: data.email || doc.id, name: data.name || '',
                name_lower: data.name_lower || normalizeAuthValue(data.name), phone: data.phone || '',
                society: society ? society.name : (data.society || data.societyName || '')
            };
        });
        return res.json(guards);
    } catch (_) { return res.status(503).json({ error: 'Guard access could not be verified.' }); }
});

app.get('/api/vehicles', async (req, res) => {
    try {
        const requested = requestedSociety(req);
        if (!requested) return res.status(400).json({ error: 'A society is required.' });
        const society = await authorization.resolveSociety(requested);
        if (!society) return res.status(404).json({ error: 'Society not found.' });

        let membership = null;
        if (req.user) membership = await authorization.resolveMembership(req.user);
        const staff = membership && ['admin', 'guard', 'master'].includes(membership.role);
        if (staff && membership.role !== 'master' && membership.societyId !== society.id) {
            return res.status(403).json({ error: 'Your staff account is not assigned to this society.', code: 'society-scope-forbidden' });
        }

        const targetVehicle = String(req.query.vehicleNumber || '').trim().toUpperCase();
        const targetFlat = String(req.query.flatNumber || '').trim();
        const deviceId = String(req.query.deviceId || '').trim();
        if (targetVehicle.length > 32 || targetFlat.length > 80 || deviceId.length > 256) {
            return res.status(400).json({ error: 'Vehicle, flat, or device lookup value is too long.' });
        }
        if (!staff && !targetVehicle && (!targetFlat || !deviceId || deviceId === 'unknown')) {
            return res.status(400).json({ error: 'Public vehicle reads require a plate lookup or a device-and-flat lookup.' });
        }
        let docs;
        if (targetVehicle) {
            docs = await getVehiclesMatchingField(society, 'vehicleNumber', [targetVehicle], true);
        } else if (staff && targetFlat) {
            docs = await getVehiclesMatchingField(society, 'flatNumber', [targetFlat], true);
        } else if (staff) {
            docs = await getVehiclesForSociety(society);
        } else {
            const [flatMatches, deviceMatches] = await Promise.all([
                getVehiclesMatchingField(society, 'flatNumber', [targetFlat], true),
                getVehiclesMatchingField(society, 'deviceId', [deviceId], true)
            ]);
            docs = mergeVehicleDocuments([flatMatches, deviceMatches]);
        }

        // Public plate lookup is the guest flow; return only the fields shown by
        // the vehicle search UI. It must never disclose resident contact data.
        if (!staff && targetVehicle) {
            const matches = docs.filter(doc => String((doc.data() || {}).vehicleNumber || '').trim().toUpperCase() === targetVehicle)
                .map(doc => {
                    const data = doc.data() || {};
                    return { vehicleNumber: data.vehicleNumber || '', flatNumber: data.flatNumber || '' };
                });
            return res.set('Cache-Control', 'private, no-store').json(matches);
        }

        if (!staff) {
            const sameFlat = value => normalizeAuthValue(value) === normalizeAuthValue(targetFlat);
            const deviceRows = docs.filter(doc => (doc.data() || {}).deviceId === deviceId);
            const flatRows = docs.filter(doc => sameFlat((doc.data() || {}).flatNumber));
            const deviceOnOtherFlat = deviceRows.find(doc => !sameFlat((doc.data() || {}).flatNumber));
            if (deviceOnOtherFlat) {
                const data = deviceOnOtherFlat.data() || {};
                // The resident UI needs the linked flat to show its lock message;
                // do not include the other flat's plate or contact details.
                return res.set('Cache-Control', 'private, no-store').json([
                    { flatNumber: data.flatNumber || '', deviceId }
                ]);
            }

            const flatDevices = flatRows.map(doc => (doc.data() || {}).deviceId).filter(Boolean);
            const flatHasOtherDevice = flatDevices.some(registeredDevice => registeredDevice !== deviceId);
            if (flatHasOtherDevice) {
                // This marker is consumed by entry.html to stop a device from
                // reading or modifying another device's registration.
                return res.set('Cache-Control', 'private, no-store').json([
                    { flatNumber: targetFlat, deviceId: { locked: true } }
                ]);
            }

            const deviceMatchesFlat = flatDevices.some(registeredDevice => registeredDevice === deviceId);
            if (deviceMatchesFlat) {
                const vehicles = flatRows.map(doc => {
                    const data = doc.data() || {};
                    return {
                        vehicleNumber: data.vehicleNumber || '', flatNumber: data.flatNumber || '',
                        vehicleType: data.vehicleType || '', residentType: data.residentType || '',
                        mobileNumber: data.mobileNumber || '',
                        deviceId: data.deviceId ? deviceId : null
                    };
                });
                return res.set('Cache-Control', 'private, no-store').json(vehicles);
            }

            // Historic rows without a device binding may be enrolled from the
            // current device, but the API exposes only slot counts until the
            // device is bound; no plate, resident type, or phone number leaks.
            if (flatRows.length) {
                const counts = { '2-Wheeler': 0, '4-Wheeler': 0 };
                for (const doc of flatRows) {
                    const type = (doc.data() || {}).vehicleType;
                    if (Object.hasOwn(counts, type)) counts[type] += 1;
                }
                return res.set('Cache-Control', 'private, no-store').json([{
                    flatNumber: targetFlat, registrationSummary: true,
                    totalRegisteredCount: flatRows.length,
                    registered2WheelerCount: counts['2-Wheeler'],
                    registered4WheelerCount: counts['4-Wheeler']
                }]);
            }
            return res.set('Cache-Control', 'private, no-store').json([]);
        }

        const vehicles = docs.filter(doc => {
            const data = doc.data() || {};
            if (targetVehicle) return String(data.vehicleNumber || '').trim().toUpperCase() === targetVehicle;
            if (targetFlat && String(data.flatNumber || '').trim() !== targetFlat) return false;
            return true;
        }).map(doc => {
            const data = doc.data() || {};
            return {
                id: doc.id,
                vehicleNumber: data.vehicleNumber || '', flatNumber: data.flatNumber || '',
                vehicleType: data.vehicleType || '', residentType: data.residentType || '',
                mobileNumber: data.mobileNumber || '', deviceId: data.deviceId || null
            };
        });
        return res.set('Cache-Control', 'private, no-store').json(vehicles);
    } catch (_) { return res.status(503).json({ error: 'Vehicle access could not be verified.' }); }
});

app.get('/api/verify-device/:deviceId', async (req, res) => {
    try {
        const deviceId = String(req.params.deviceId || '').trim();
        if (!deviceId || deviceId === 'unknown' || deviceId.length > 256) return res.status(400).json({ registered: false, error: 'A valid device ID is required.' });
        const requested = req.query.societyId || req.query.societyName || req.query.society;
        if (requested) {
            const society = await authorization.resolveSociety(requested);
            if (!society) return res.status(404).json({ registered: false });
            const vehicles = await getVehiclesMatchingField(society, 'deviceId', [deviceId], true);
            const record = uniqueVehicleForDevice(vehicles, deviceId);
            return res.set('Cache-Control', 'no-store').json(record
                ? { registered: true, flatNumber: (record.data() || {}).flatNumber || '' }
                : { registered: false });
        }
        const snapshot = await db.collection('vehicles').where('deviceId', '==', deviceId).limit(1).get({ fresh: true });
        return res.set('Cache-Control', 'no-store').json({ registered: !snapshot.empty });
    } catch (_) { return res.status(503).json({ error: 'Device registration could not be verified.' }); }
});

app.get('/api/notices/:societyIdentifier', async (req, res) => {
    try {
        const society = await authorization.resolveSociety(req.params.societyIdentifier);
        if (!society) return res.status(404).json({ error: 'Society not found.' });
        const noticeDoc = await getSocietyDocument('notices', society);
        if (!noticeDoc) return res.status(404).json({ error: 'Notice not found' });
        const data = noticeDoc.data() || {};
        return res.set('Cache-Control', 'no-store').json({
            societyName: society.name,
            date: data.date || '',
            todayMessage: data.todayMessage || '',
            tomorrowMessage: data.tomorrowMessage || ''
        });
    } catch (_) { return res.status(503).json({ error: 'Notice could not be loaded.' }); }
});

app.get('/api/facilities/:societyIdentifier', async (req, res) => {
    try {
        const society = await authorization.resolveSociety(req.params.societyIdentifier);
        if (!society) return res.status(404).json({ error: 'Society not found.' });
        const doc = await getSocietyDocument('facilities', society);
        const raw = doc ? doc.data() || {} : {};
        const safe = {};
        for (const [key, value] of Object.entries(raw)) {
            if (/^F\d{1,2}$/.test(key) && typeof value === 'string') safe[key] = value.slice(0, 120);
        }
        return res.set('Cache-Control', 'public, max-age=30').json(safe);
    } catch (_) { return res.status(503).json({ error: 'Facilities could not be loaded.' }); }
});

// The facility calendar's "contact the admin" button. Public on purpose: the
// page is a guest/resident-facing calendar, and the only field returned is the
// WhatsApp number of the society's administrator, projected from `admins`.
app.get('/api/societies/:societyIdentifier/admin-contact', async (req, res) => {
    try {
        const society = await authorization.resolveSociety(req.params.societyIdentifier);
        if (!society) return res.status(404).json({ error: 'Society not found.' });
        const records = await findSocietyAdminRecords(society);

        const contact = adminContactFor(records);
        return res.set('Cache-Control', 'public, max-age=60').json({
            societyId: society.id,
            society: society.name,
            phone: contact ? contact.phone : null
        });
    } catch (_) { return res.status(503).json({ error: 'Admin contact could not be loaded.' }); }
});

app.get('/api/bookings', async (req, res) => {
    try {
        const requested = requestedSociety(req);
        if (!requested) return res.status(400).json({ error: 'A society is required.' });
        const society = await authorization.resolveSociety(requested);
        if (!society) return res.status(404).json({ error: 'Society not found.' });
        const membership = req.user ? await authorization.resolveMembership(req.user) : null;
        if (membership && ['admin', 'guard'].includes(membership.role) && membership.societyId !== society.id) {
            return res.status(403).json({ error: 'Your staff account is not assigned to this society.', code: 'society-scope-forbidden' });
        }
        const aliases = society.aliases.slice(0, 30);
        const snapshots = await Promise.all([
            db.collection('bookings').where('societyId', '==', society.id).get(),
            db.collection('bookings').where('society', 'in', aliases).get(),
            db.collection('bookings').where('societyName', 'in', aliases).get()
        ]);
        const docs = new Map();
        for (const snapshot of snapshots) snapshot.forEach(doc => {
            if (recordMatchesSociety(doc.data() || {}, doc.id, society)) docs.set(doc.id, doc);
        });
        const bookings = [...docs.values()].map(doc => {
            const data = doc.data() || {};
            return { id: doc.id, facilityId: data.facilityId || '', start: data.start || '', end: data.end || '' };
        });
        return res.set('Cache-Control', 'public, no-store').json(bookings);
    } catch (_) { return res.status(503).json({ error: 'Bookings could not be loaded.' }); }
});

app.get('/api/societies', async (req, res) => {
    try {
        const snapshot = await db.collection('societies').get();
        const societies = snapshot.docs.map(doc => {
            const data = doc.data() || {};
            return publicSociety({ id: doc.id, name: data.name || doc.id, data });
        });
        return res.set('Cache-Control', 'public, max-age=60').json(societies);
    } catch (_) { return res.status(503).json({ error: 'Societies could not be loaded.' }); }
});

app.get('/api/societies/verify', async (req, res) => {
    try {
        const search = String(req.query.name || '').trim();
        if (!search) return res.status(400).json({ error: 'name is required.' });
        const society = await authorization.resolveSociety(search);
        if (!society) return res.status(404).json({ error: 'Society not found' });
        return res.set('Cache-Control', 'public, max-age=60').json(publicSociety(society));
    } catch (_) { return res.status(503).json({ error: 'Society could not be verified.' }); }
});

app.get('/api/societies/:societyIdentifier/active-guard', async (req, res) => {
    try {
        const society = await authorization.resolveSociety(req.params.societyIdentifier);
        if (!society) return res.status(404).json({ error: 'Society not found' });
        return res.set('Cache-Control', 'no-store').json({
            id: society.id, name: society.name,
            activeGuardName: society.data.activeGuardName || null,
            activeGuardPhone: society.data.activeGuardPhone || null
        });
    } catch (_) { return res.status(503).json({ error: 'Society could not be loaded.' }); }
});

app.get('/api/societies/:societyIdentifier', async (req, res) => {
    try {
        const society = await authorization.resolveSociety(req.params.societyIdentifier);
        if (!society) return res.status(404).json({ error: 'Society not found' });
        const membership = req.user ? await authorization.resolveMembership(req.user) : null;
        if (membership && ['admin', 'guard'].includes(membership.role) && membership.societyId !== society.id) {
            return res.status(403).json({ error: 'Your staff account is not assigned to this society.', code: 'society-scope-forbidden' });
        }
        return res.set('Cache-Control', 'private, no-store').json(publicSociety(society));
    } catch (_) { return res.status(503).json({ error: 'Society could not be loaded.' }); }
});

// --- PASSWORD RESET ---
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
    const generic = { success: true, message: 'If an account exists for that email, a password reset link will be sent.' };
    const email = normalizeAuthValue(req.body && req.body.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'A valid email is required.' });
    try {
        if (credential) {
            const accessToken = await credential.getAccessToken();
            await fetch('https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken.access_token}` },
                body: JSON.stringify({ requestType: 'PASSWORD_RESET', email })
            });
        }
        return res.status(202).json(generic);
    } catch (_) {
        // Fail generically as well; do not reveal whether this account exists.
        return res.status(202).json(generic);
    }
});

// --- RESIDENT / PUBLIC WRITES ---
// entry.html registers vehicles without an admin login; keep this reachable but
// never allow it to overwrite an existing document by id.
app.post('/api/vehicles', async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const society = await authorization.resolveSociety(requestedSociety({ query: {}, body }) || 'Aangan');
        if (!society) return res.status(404).json({ error: 'Society not found.' });

        const membership = req.user ? await authorization.resolveMembership(req.user) : null;
        const staff = membership && ['admin', 'master'].includes(membership.role);
        if (membership && membership.role === 'guard') {
            return res.status(403).json({ error: 'Guards cannot register or edit vehicles.', code: 'role-forbidden' });
        }
        if (staff && membership.role !== 'master' && membership.societyId !== society.id) {
            return res.status(403).json({ error: 'Your staff account is not assigned to this society.', code: 'society-scope-forbidden' });
        }

        const docId = body.id == null || body.id === '' ? null : String(body.id);
        if (docId && !staff) {
            return res.status(403).json({ error: 'Editing a vehicle requires a society administrator.', code: 'role-forbidden' });
        }
        if (docId && (body.vehicles && (Array.isArray(body.vehicles) ? body.vehicles.length : 1) !== 1)) {
            return res.status(400).json({ error: 'Exactly one vehicle is required when editing.' });
        }

        let vehiclesToProcess = [];
        if (Array.isArray(body.vehicles)) vehiclesToProcess = body.vehicles;
        else if (typeof body.vehicles === 'string') {
            try { vehiclesToProcess = JSON.parse(body.vehicles); } catch (_) { vehiclesToProcess = []; }
        }
        if (vehiclesToProcess.length === 0 && body.vehicleNumber) {
            vehiclesToProcess = [{ vehicleNumber: body.vehicleNumber, vehicleType: body.vehicleType || '2-Wheeler' }];
        }
        const requestedVehicles = vehiclesToProcess
            .filter(vehicle => vehicle && String(vehicle.vehicleNumber || '').trim())
            .map(vehicle => ({
                vehicleNumber: String(vehicle.vehicleNumber).trim().toUpperCase(),
                vehicleType: normalizeVehicleType(vehicle.vehicleType)
            }));
        if (!requestedVehicles.length) return res.status(400).json({ error: 'At least one vehicle number is required.' });
        if (requestedVehicles.length > 12) return res.status(400).json({ error: 'Too many vehicles in one request.' });
        if (docId && requestedVehicles.length !== 1) return res.status(400).json({ error: 'Exactly one vehicle is required when editing.' });

        const isResident = !staff;
        const flatNumber = String(body.flatNumber || body.flat || '').trim();
        const residentType = String(body.residentType || (isResident ? '' : 'Resident')).trim();
        const mobileNumber = String(body.mobileNumber || body.mobile || '').trim();
        const deviceId = String(body.deviceId || '').trim();
        if (!flatNumber || flatNumber.length > 80) return res.status(400).json({ error: 'A valid flat number is required.' });
        if (isResident && (!deviceId || deviceId === 'unknown' || deviceId.length > 256)) {
            return res.status(400).json({ error: 'A valid device ID is required for resident registration.' });
        }
        if (isResident && !/^\d{10}$/.test(mobileNumber)) {
            return res.status(400).json({ error: 'Mobile number must contain exactly 10 digits.' });
        }
        if (isResident && !['Owner', 'Tenant'].includes(residentType)) {
            return res.status(400).json({ error: 'Resident type must be Owner or Tenant.' });
        }
        for (const vehicle of requestedVehicles) {
            const allowedTypes = isResident ? ['2-Wheeler', '4-Wheeler'] : VEHICLE_TYPES;
            if (!allowedTypes.includes(vehicle.vehicleType)) {
                return res.status(400).json({ error: `Vehicle type must be ${allowedTypes.join(' or ')}.` });
            }
            if (isResident && !/^[A-Z0-9]{10}$/.test(vehicle.vehicleNumber)) {
                return res.status(400).json({ error: 'Vehicle number must contain exactly 10 letters or digits.' });
            }
            if (!isResident && !/^[A-Z0-9 -]{1,20}$/.test(vehicle.vehicleNumber)) {
                return res.status(400).json({ error: 'Vehicle number contains unsupported characters.' });
            }
        }
        const numbers = requestedVehicles.map(vehicle => vehicle.vehicleNumber);
        if (new Set(numbers).size !== numbers.length) {
            return res.status(409).json({ error: 'Duplicate vehicle number in this request.' });
        }

        const fail = (status, message, code = 'vehicle-registration-rejected') => {
            const error = new Error(message);
            error.status = status;
            error.code = code;
            throw error;
        };
        const societyRef = db.collection('societies').doc(society.id);
        // A per-society lock document serializes resident registrations so two
        // concurrent query-based uniqueness/limit checks cannot both commit.
        const registrationLockRef = db.collection('vehicleRegistrationLocks').doc(hashValue(society.id));
        const existingRef = docId ? db.collection('vehicles').doc(docId) : null;
        const newRefs = docId ? [] : requestedVehicles.map(() => db.collection('vehicles').doc());

        await db.runTransaction(async transaction => {
            const [societySnap, existingVehicles, registrationLock] = await Promise.all([
                transaction.get(societyRef),
                getVehiclesForRegistration(transaction, society, flatNumber, isResident ? deviceId : '', numbers),
                transaction.get(registrationLockRef)
            ]);
            if (!societySnap.exists) fail(404, 'Society not found.');
            const societyData = societySnap.data() || {};
            const flatList = Array.isArray(societyData.flatList) ? societyData.flatList :
                (Array.isArray(societyData.flats) ? societyData.flats : []);
            const flatIsKnown = flatList.some(flat => normalizeAuthValue(flat) === normalizeAuthValue(flatNumber));
            if ((isResident || flatList.length > 0) && !flatIsKnown) fail(400, 'Flat is not registered in this society.');

            let oldDoc = null;
            let oldData = null;
            if (existingRef) {
                oldDoc = await transaction.get(existingRef);
                if (!oldDoc.exists) fail(404, 'Vehicle not found.');
                oldData = oldDoc.data() || {};
                if (!isVehicleForSociety(oldData, society)) fail(403, 'Vehicle is outside your society scope.', 'society-scope-forbidden');
                if (oldData.deviceId && normalizeAuthValue(oldData.flatNumber) !== normalizeAuthValue(flatNumber)) {
                    fail(409, 'A device-linked vehicle cannot be reassigned to another flat through this edit.');
                }
            }

            const rows = existingVehicles.filter(doc => doc.id !== (oldDoc && oldDoc.id)).map(doc => ({ id: doc.id, data: doc.data() || {} }));
            if (isResident) {
                const linkedToOtherFlat = rows.find(row => row.data.deviceId === deviceId &&
                    normalizeAuthValue(row.data.flatNumber) !== normalizeAuthValue(flatNumber));
                if (linkedToOtherFlat) fail(409, 'This device is already linked to a different flat.');
                const flatOnOtherDevice = rows.find(row =>
                    normalizeAuthValue(row.data.flatNumber) === normalizeAuthValue(flatNumber) &&
                    row.data.deviceId && row.data.deviceId !== deviceId);
                if (flatOnOtherDevice) fail(409, 'This flat is already linked to another device.');
            }

            for (const vehicle of requestedVehicles) {
                const duplicate = rows.find(row => String(row.data.vehicleNumber || '').trim().toUpperCase() === vehicle.vehicleNumber);
                if (duplicate) fail(409, 'This vehicle number is already registered in this society.');
            }

            if (isResident) {
                const counts = { '2-Wheeler': 0, '4-Wheeler': 0 };
                for (const row of rows) {
                    if (normalizeAuthValue(row.data.flatNumber) === normalizeAuthValue(flatNumber) &&
                        Object.hasOwn(counts, row.data.vehicleType)) counts[row.data.vehicleType] += 1;
                }
                const limit = type => Number.isInteger(societyData[type]) && societyData[type] >= 0 ? societyData[type] : 0;
                for (const vehicle of requestedVehicles) {
                    counts[vehicle.vehicleType] += 1;
                    const max = limit(vehicle.vehicleType === '2-Wheeler' ? 'max2Wheeler' : 'max4Wheeler');
                    if (counts[vehicle.vehicleType] > max) fail(409, `Vehicle limit reached for this flat (${vehicle.vehicleType}).`);
                }
            }

            const stamp = FieldValue.serverTimestamp();
            const lockVersion = registrationLock.exists ? Number((registrationLock.data() || {}).version) || 0 : 0;
            transaction.set(registrationLockRef, {
                societyId: society.id, version: lockVersion + 1, updatedAt: stamp
            });
            if (existingRef) {
                transaction.update(existingRef, {
                    societyId: society.id,
                    societyName: society.name,
                    flatNumber,
                    residentType: residentType || oldData.residentType || 'Resident',
                    mobileNumber: mobileNumber || oldData.mobileNumber || '',
                    vehicleType: requestedVehicles[0].vehicleType,
                    vehicleNumber: requestedVehicles[0].vehicleNumber,
                    deviceId: oldData.deviceId || null,
                    updatedAt: stamp
                });
            } else {
                requestedVehicles.forEach((vehicle, index) => {
                    transaction.set(newRefs[index], {
                        societyId: society.id,
                        societyName: society.name,
                        flatNumber,
                        residentType: residentType || 'Resident',
                        mobileNumber: mobileNumber || '',
                        vehicleType: vehicle.vehicleType,
                        vehicleNumber: vehicle.vehicleNumber,
                        deviceId: isResident ? deviceId : (deviceId || null),
                        createdAt: stamp
                    });
                });
            }
        });
        return res.json({ success: true });
    } catch (err) {
        if (err && Number.isInteger(err.status)) return res.status(err.status).json({ error: err.message, code: err.code });
        console.error('Vehicle API Error:', err);
        return res.status(500).json({ error: 'Could not register the vehicle.' });
    }
});

app.post('/api/contest/spin', async (req, res) => {
    try {
        const body = req.body || {};
        const society = await authorization.resolveSociety(body.societyId || body.societyName || body.society);
        if (!society) return res.status(404).json({ error: 'Society not found.' });
        const deviceId = String(body.deviceId || '').trim();
        const submittedFlat = String(body.flatNumber || '').trim();
        const contestId = String(body.contestId || 'default').trim();
        if (!deviceId || deviceId === 'unknown' || deviceId.length > 256 || !submittedFlat || submittedFlat.length > 80 || !contestId || contestId.length > 2048) {
            return res.status(400).json({ error: 'Registered device, flat number, and contest ID are required.' });
        }

        const today = utcDate();
        const statRef = db.collection('spinStats').doc(`${normalizeAuthValue(society.name)}_${today}`);
        const attemptRef = db.collection('contestAttempts').doc(contestAttemptDocumentId(society.id, today, deviceId, contestId));
        const societyRef = db.collection('societies').doc(society.id);
        const result = await db.runTransaction(async transaction => {
            const [societySnap, statSnap, attemptSnap, vehicles] = await Promise.all([
                transaction.get(societyRef), transaction.get(statRef), transaction.get(attemptRef),
                getVehiclesForDeviceInTransaction(transaction, society, deviceId)
            ]);
            if (!societySnap.exists) {
                const error = new Error('Society not found.'); error.status = 404; throw error;
            }
            const linkedVehicle = uniqueVehicleForDevice(vehicles, deviceId, submittedFlat);
            if (!linkedVehicle) {
                const error = new Error('This device is not linked to the submitted flat in this society.'); error.status = 403; throw error;
            }
            if (attemptSnap.exists) {
                const error = new Error('This device has already spun for this contest today.'); error.status = 409; throw error;
            }

            const societyData = societySnap.data() || {};
            const rawTarget = societyData.spintodayNumber;
            const parsedTarget = rawTarget === undefined || rawTarget === null || rawTarget === '' ? null : Number(rawTarget);
            const target = Number.isFinite(parsedTarget) && parsedTarget > 0 ? parsedTarget : null;
            const current = statSnap.exists ? Number((statSnap.data() || {}).spinCount) || 0 : 0;
            const next = current + 1;
            const won = target !== null && next === target;
            const stamp = FieldValue.serverTimestamp();
            const stat = {
                societyId: society.id, societyName: society.name,
                spinCount: next, date: today, updatedAt: stamp
            };
            if (!statSnap.exists) stat.createdAt = stamp;
            transaction.set(statRef, stat, { merge: true });
            transaction.set(attemptRef, {
                societyId: society.id, contestIdHash: hashValue(contestId),
                deviceIdHash: hashValue(deviceId), flatNumber: linkedVehicle.data().flatNumber,
                date: today, spinCount: next, won, claimed: false, createdAt: stamp
            });
            return { spinCount: next, won };
        });
        return res.json({ success: true, ...result });
    } catch (err) {
        if (err && Number.isInteger(err.status)) return res.status(err.status).json({ error: err.message });
        console.error('Contest spin failed:', err);
        return res.status(500).json({ error: 'Could not complete the spin.' });
    }
});

app.post('/api/contest/winner', async (req, res) => {
    try {
        const body = req.body || {};
        const society = await authorization.resolveSociety(body.societyId || body.societyName || body.society);
        if (!society) return res.status(404).json({ error: 'Society not found.' });
        const deviceId = String(body.deviceId || '').trim();
        const flatNumber = String(body.flatNumber || body.winnerFlatnumber || '').trim();
        const contestId = String(body.contestId || 'default').trim();
        if (!deviceId || deviceId === 'unknown' || deviceId.length > 256 || !flatNumber || flatNumber.length > 80 || !contestId || contestId.length > 2048) {
            return res.status(400).json({ error: 'Registered device, flat number, and contest ID are required.' });
        }

        const dates = [utcDate(), utcDate(new Date(Date.now() - 24 * 60 * 60 * 1000))];
        const attemptRefs = dates.map(date => ({
            date,
            ref: db.collection('contestAttempts').doc(contestAttemptDocumentId(society.id, date, deviceId, contestId))
        }));
        const winnerRef = db.collection('winners').doc();
        await db.runTransaction(async transaction => {
            const [attemptSnaps, vehicles] = await Promise.all([
                Promise.all(attemptRefs.map(attempt => transaction.get(attempt.ref))),
                getVehiclesForDeviceInTransaction(transaction, society, deviceId)
            ]);
            const index = attemptSnaps.findIndex(snap => snap.exists && (snap.data() || {}).won === true);
            if (index < 0) {
                const error = new Error('No winning spin is available for this device and contest.'); error.status = 403; throw error;
            }
            const attempt = attemptSnaps[index];
            const attemptData = attempt.data() || {};
            if (attemptData.claimed === true) {
                const error = new Error('This winning spin has already been claimed.'); error.status = 409; throw error;
            }
            const linkedVehicle = uniqueVehicleForDevice(vehicles, deviceId, flatNumber);
            if (!linkedVehicle || normalizeAuthValue(attemptData.flatNumber) !== normalizeAuthValue(flatNumber)) {
                const error = new Error('The submitted flat does not match the winning device registration.'); error.status = 403; throw error;
            }

            const stamp = FieldValue.serverTimestamp();
            transaction.update(attemptRefs[index].ref, { claimed: true, claimedAt: stamp });
            transaction.set(winnerRef, {
                societyId: society.id, societyName: society.name,
                flatNumber: linkedVehicle.data().flatNumber,
                winnerFlatnumber: linkedVehicle.data().flatNumber,
                contestIdHash: hashValue(contestId), createdAt: stamp
            });
        });
        return res.json({ success: true });
    } catch (err) {
        if (err && Number.isInteger(err.status)) return res.status(err.status).json({ error: err.message });
        console.error('Contest winner claim failed:', err);
        return res.status(500).json({ error: 'Could not register the winning flat.' });
    }
});

app.get('/api/contest/winners', async (req, res) => {
    try {
        const snapshot = await db.collection('winners').orderBy('createdAt', 'desc').limit(10).get();
        const winners = [];
        snapshot.forEach(doc => {
            const data = doc.data() || {};
            winners.push({
                societyName: data.societyName || '',
                flatNumber: data.flatNumber || data.winnerFlatnumber || '',
                createdAt: data.createdAt || null
            });
        });
        return res.json(winners);
    } catch (_) { return res.status(503).json({ error: 'Contest results could not be loaded.' }); }
});

app.get('/api/contest/spinstats', requireMaster, async (req, res) => {
    try {
        const requested = String(req.query.societyName || req.query.society || '').trim();
        if (!requested) return res.status(400).json({ error: 'Society name is required.' });
        const society = await authorization.resolveSociety(requested);
        if (!society) return res.status(404).json({ error: 'Society not found.' });
        const today = utcDate();
        const statDoc = await db.collection('spinStats').doc(`${normalizeAuthValue(society.name)}_${today}`).get();
        const data = statDoc.exists ? statDoc.data() || {} : {};
        const snapshot = await db.collection('winners').where('societyId', '==', society.id).get();
        const winners = snapshot.docs.map(doc => doc.data() || []).sort((a, b) => {
            const time = value => value && typeof value.toMillis === 'function' ? value.toMillis() : new Date(value || 0).getTime();
            return time(b.createdAt) - time(a.createdAt);
        });
        const winnerFlat = winners.length ? (winners[0].flatNumber || winners[0].winnerFlatnumber || 'None yet') : 'None yet';
        const spinCount = Number(data.spinCount) || 0;
        return res.json({
            societyName: society.name, totalSpins: spinCount, totalDaySpins: spinCount,
            totalMonthSpins: 0, winnerFlat
        });
    } catch (_) { return res.status(503).json({ error: 'Spin statistics could not be loaded.' }); }
});

// --- ADMIN WRITES (require a verified admin identity) ---
app.post('/api/config', requireMaster, async (req, res) => {
    try {
        const teamPhone = String((req.body && req.body.teamPhone) || '').trim();
        if (!/^\+?[0-9 ()-]{7,24}$/.test(teamPhone)) return res.status(400).json({ error: 'A valid team phone is required.' });
        await db.collection('configs').doc('owlwatcher').set({ teamPhone }, { merge: true });
        return res.json({ success: true });
    } catch (_) { return res.status(500).json({ error: 'Could not update configuration.' }); }
});

app.post('/api/notices/:societyId', requireAdminForSociety(req => req.params.societyId), async (req, res) => {
    try {
        const { todayMessage = '', tomorrowMessage = '', date = '' } = req.body || {};
        if (typeof todayMessage !== 'string' || todayMessage.length > 5000 ||
            typeof tomorrowMessage !== 'string' || tomorrowMessage.length > 5000 ||
            (date && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)))) {
            return res.status(400).json({ error: 'Invalid notice fields.' });
        }
        const society = req.authorizedSociety;
        await db.collection('notices').doc(society.id).set({
            societyId: society.id, societyName: society.name,
            todayMessage, tomorrowMessage, date, updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        return res.json({ success: true });
    } catch (_) { return res.status(500).json({ error: 'Could not update the notice.' }); }
});

app.delete('/api/notices/:societyId', requireAdminForSociety(req => req.params.societyId), async (req, res) => {
    try {
        await db.collection('notices').doc(req.authorizedSociety.id).delete();
        return res.json({ success: true });
    } catch (_) { return res.status(500).json({ error: 'Could not delete the notice.' }); }
});

app.post('/api/guards', requireAdminForSociety(req => requestedSociety(req)), async (req, res) => {
    try {
        const { targetDocId, email, name, phone } = req.body || {};
        const normalizedEmail = normalizeAuthValue(email);
        const cleanName = String(name || '').trim();
        const cleanPhone = String(phone || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || cleanName.length < 1 || cleanName.length > 120 || cleanPhone.length > 40) {
            return res.status(400).json({ error: 'A valid guard email, name, and phone are required.' });
        }
        const society = req.authorizedSociety;
        const docId = String(targetDocId || normalizedEmail).trim();
        if (!docId || docId.length > 180 || docId.includes('/')) return res.status(400).json({ error: 'Invalid guard record ID.' });
        const ref = db.collection('guards').doc(docId);
        const existing = await ref.get({ fresh: true });
        if (existing.exists && !recordMatchesSociety(existing.data() || {}, existing.id, society)) {
            return res.status(403).json({ error: 'Guard record is outside your society scope.', code: 'society-scope-forbidden' });
        }
        await ref.set({
            email: normalizedEmail, name: cleanName, name_lower: cleanName.toLowerCase(), phone: cleanPhone,
            societyId: society.id, society: society.name, updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        return res.json({ success: true });
    } catch (_) { return res.status(500).json({ error: 'Could not save the guard record.' }); }
});

app.delete('/api/guards/:id', requireStaff, async (req, res) => {
    try {
        if (!['admin', 'master'].includes(req.membership.role)) {
            return res.status(403).json({ error: 'Only a society administrator may delete guards.', code: 'role-forbidden' });
        }
        const ref = db.collection('guards').doc(req.params.id);
        const doc = await ref.get({ fresh: true });
        if (!doc.exists) return res.status(404).json({ error: 'Guard not found.' });
        const data = doc.data() || {};
        const society = await authorization.resolveSociety(data.societyId || data.society || data.societyName);
        if (!society || (req.membership.role !== 'master' && society.id !== req.membership.societyId)) {
            return res.status(403).json({ error: 'Guard record is outside your society scope.', code: 'society-scope-forbidden' });
        }
        await ref.delete();
        return res.json({ success: true });
    } catch (_) { return res.status(500).json({ error: 'Could not delete the guard record.' }); }
});

app.delete('/api/vehicles/:id', requireStaff, async (req, res) => {
    try {
        if (!['admin', 'master'].includes(req.membership.role)) {
            return res.status(403).json({ error: 'Only a society administrator may delete vehicles.', code: 'role-forbidden' });
        }
        const ref = db.collection('vehicles').doc(req.params.id);
        const doc = await ref.get({ fresh: true });
        if (!doc.exists) return res.status(404).json({ error: 'Vehicle not found.' });
        const data = doc.data() || {};
        const society = await authorization.resolveSociety(data.societyId || data.societyName || data.society);
        if (!society || (req.membership.role !== 'master' && society.id !== req.membership.societyId)) {
            return res.status(403).json({ error: 'Vehicle is outside your society scope.', code: 'society-scope-forbidden' });
        }
        await ref.delete();
        return res.json({ success: true });
    } catch (_) { return res.status(500).json({ error: 'Could not delete the vehicle.' }); }
});

app.post('/api/facilities/:societyIdentifier', requireAdminForSociety(req => req.params.societyIdentifier), async (req, res) => {
    try {
        const updates = {};
        for (const [key, value] of Object.entries(req.body || {})) {
            if (!/^F\d{1,2}$/.test(key) || typeof value !== 'string' || value.length > 120) {
                return res.status(400).json({ error: 'Facility updates may contain only short F1-F99 text labels.' });
            }
            updates[key] = value.trim();
        }
        const society = req.authorizedSociety;
        await db.collection('facilities').doc(society.id).set({
            societyId: society.id, societyName: society.name, ...updates,
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        return res.json({ success: true });
    } catch (_) { return res.status(500).json({ error: 'Could not update facilities.' }); }
});

app.post('/api/bookings', requireAdminForSociety(req => requestedSociety(req)), async (req, res) => {
    try {
        const { facilityId, start, end } = req.body || {};
        if (typeof facilityId !== 'string' || !/^F\d{1,2}$/.test(facilityId) || typeof start !== 'string') {
            return res.status(400).json({ error: 'A facility and start time are required.' });
        }
        const startDate = new Date(start);
        const endDate = new Date(end || start);
        if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate < startDate) {
            return res.status(400).json({ error: 'Invalid booking date range.' });
        }
        const society = req.authorizedSociety;
        await db.collection('bookings').add({
            societyId: society.id, society: society.name, societyName: society.name,
            facilityId, start: startDate.toISOString(), end: endDate.toISOString(),
            expireAt: new Date(endDate.getTime() + 7 * 24 * 60 * 60 * 1000)
        });
        return res.json({ success: true });
    } catch (_) { return res.status(500).json({ error: 'Could not create the booking.' }); }
});

app.delete('/api/bookings/:id', requireStaff, async (req, res) => {
    try {
        if (!['admin', 'master'].includes(req.membership.role)) {
            return res.status(403).json({ error: 'Only a society administrator may delete bookings.', code: 'role-forbidden' });
        }
        const ref = db.collection('bookings').doc(req.params.id);
        const doc = await ref.get({ fresh: true });
        if (!doc.exists) return res.status(404).json({ error: 'Booking not found.' });
        const data = doc.data() || {};
        const society = await authorization.resolveSociety(data.societyId || data.society || data.societyName);
        if (!society || (req.membership.role !== 'master' && society.id !== req.membership.societyId)) {
            return res.status(403).json({ error: 'Booking is outside your society scope.', code: 'society-scope-forbidden' });
        }
        await ref.delete();
        return res.json({ success: true });
    } catch (_) { return res.status(500).json({ error: 'Could not delete the booking.' }); }
});

app.patch('/api/societies/:societyId/active-guard', requireStaffForSociety(req => req.params.societyId), async (req, res) => {
    try {
        const society = req.authorizedSociety;
        const activeGuardName = String((req.body && req.body.activeGuardName) || '').trim();
        let activeGuardPhone = null;
        if (activeGuardName) {
            const aliases = society.aliases.slice(0, 30);
            const snapshots = await Promise.all([
                db.collection('guards').where('societyId', '==', society.id).get(),
                db.collection('guards').where('society', 'in', aliases).get(),
                db.collection('guards').where('societyName', 'in', aliases).get()
            ]);
            const guard = snapshots.flatMap(snapshot => snapshot.docs).find(doc => {
                const data = doc.data() || {};
                return recordMatchesSociety(data, doc.id, society) && normalizeAuthValue(data.name) === normalizeAuthValue(activeGuardName);
            });
            if (!guard) return res.status(400).json({ error: 'Selected guard is not registered in this society.' });
            activeGuardPhone = (guard.data() || {}).phone || null;
        }
        await db.collection('societies').doc(society.id).set({
            activeGuardName: activeGuardName || null,
            activeGuardPhone,
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        return res.json({ success: true });
    } catch (_) { return res.status(500).json({ error: 'Could not update the active guard.' }); }
});

app.patch('/api/societies/:societyId/limits', requireAdminForSociety(req => req.params.societyId), async (req, res) => {
    try {
        const max4Wheeler = Number(req.body && req.body.max4Wheeler);
        const max2Wheeler = Number(req.body && req.body.max2Wheeler);
        if (!Number.isInteger(max4Wheeler) || !Number.isInteger(max2Wheeler) || max4Wheeler < 0 || max2Wheeler < 0 || max4Wheeler > 100 || max2Wheeler > 100) {
            return res.status(400).json({ error: 'Vehicle limits must be integers between 0 and 100.' });
        }
        await db.collection('societies').doc(req.authorizedSociety.id).set({
            max4Wheeler, max2Wheeler, updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        return res.json({ success: true });
    } catch (_) { return res.status(500).json({ error: 'Could not update society limits.' }); }
});

app.patch('/api/societies/:societyId/flats', requireAdminForSociety(req => req.params.societyId), async (req, res) => {
    try {
        const supplied = req.body && (req.body.flatList || req.body.flats);
        if (!Array.isArray(supplied) || supplied.length > 1000 || supplied.some(flat => typeof flat !== 'string' || !flat.trim() || flat.trim().length > 80)) {
            return res.status(400).json({ error: 'flatList must contain up to 1000 non-empty flat identifiers.' });
        }
        const flatList = [...new Set(supplied.map(flat => flat.trim()))];
        const society = req.authorizedSociety;
        await db.collection('societies').doc(society.id).set({
            societyId: society.id, flatList, flats: flatList,
            updatedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        return res.json({ success: true });
    } catch (_) { return res.status(500).json({ error: 'Could not update society flats.' }); }
});

app.patch('/api/ads/:adKey', requireMaster, async (req, res) => {
    try {
        const adKey = String(req.params.adKey || '').trim();
        const body = req.body || {};
        if (!/^[A-Za-z0-9_-]{1,120}$/.test(adKey) || Object.keys(body).length !== 1 || typeof body.societyApproved !== 'boolean') {
            return res.status(400).json({ error: 'Only the societyApproved boolean may be changed.' });
        }
        const ref = db.collection('ads').doc(adKey);
        const doc = await ref.get({ fresh: true });
        if (!doc.exists) return res.status(404).json({ error: 'Advertisement not found.' });
        await ref.set({ societyApproved: body.societyApproved, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        return res.json({ success: true });
    } catch (_) { return res.status(500).json({ error: 'Could not update the advertisement.' }); }
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
