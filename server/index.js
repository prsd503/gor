/* Owl Watcher API server.
 *
 * Deploy this file plus server/lib/ to the backend host. It is intentionally separate
 * from the static web app so the frontend bundle stays deployable to GitHub Pages.
 *
 * Required environment:
 *   JWT_SECRET            - strong random secret (no hardcoded fallback)
 *   FIREBASE_PROJECT_ID   - e.g. finder-owl
 *   GOOGLE_APPLICATION_CREDENTIALS or SERVICE_ACCOUNT_JSON - Admin SDK credentials
 * Optional:
 *   APP_CHECK_MODE        - off | monitor (default) | enforce
 *   ALLOWED_ORIGINS       - comma-separated extra origins
 *   PORT                  - default 3000
 */
'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { rateLimit } = require('express-rate-limit');
const cron = require('node-cron');

const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getAppCheck } = require('firebase-admin/app-check');

const { buildVersionResponse } = require('./lib/version-policy');
const { createAuthMiddleware } = require('./lib/auth');
const { createOriginChecker, createAppCheckMiddleware } = require('./lib/security');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be set to a random value of at least 32 characters.');
}
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'finder-owl';

const credential = process.env.SERVICE_ACCOUNT_JSON
    ? cert(JSON.parse(process.env.SERVICE_ACCOUNT_JSON))
    : (process.env.GOOGLE_APPLICATION_CREDENTIALS ? cert(require(process.env.GOOGLE_APPLICATION_CREDENTIALS)) : applicationDefault());

initializeApp({ credential, projectId: PROJECT_ID });

const db = getFirestore();
const app = express();

// Set to the exact hop count in front of this app (1 behind ngrok/nginx).
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.disable('x-powered-by');

const extraOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const isAllowedOrigin = createOriginChecker(extraOrigins);

app.use(cors({
    origin(origin, callback) {
        if (isAllowedOrigin(origin)) return callback(null, true);
        console.log('CORS blocked for origin:', origin);
        return callback(new Error('Blocked by CORS: Unauthorized Origin'));
    },
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning', 'X-Firebase-AppCheck'],
    credentials: true
}));

app.use(express.json({ limit: '1mb', type: ['application/json', 'text/plain'] }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// App Check is verified cryptographically; Origin is never treated as authentication.
app.use(createAppCheckMiddleware({
    mode: process.env.APP_CHECK_MODE || 'monitor',
    verifyToken: token => getAppCheck().verifyToken(token)
}));

const { optionalAuth, requireAuth, requireAdmin } = createAuthMiddleware({
    projectId: PROJECT_ID,
    verifyIdToken: token => getAuth().verifyIdToken(token, true),
    verifyJwt: token => jwt.verify(token, JWT_SECRET)
});

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

// --- HEALTH ---
app.get('/health', (req, res) => res.json({ status: 'ok' }));

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
        const { idToken } = req.body || {};
        if (!idToken) return res.status(400).json({ error: 'Firebase ID token is required' });
        const decoded = await getAuth().verifyIdToken(idToken, true);
        const token = jwt.sign(
            { uid: decoded.uid, email: decoded.email || null, role: 'admin' },
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
        await checkAndShiftNotices();
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

// --- BACKGROUND ROUTINES ---
async function cleanupOldBookings() {
    try {
        const threshold = new Date();
        threshold.setDate(threshold.getDate() - 7);
        const snapshot = await db.collection('bookings').where('end', '<', threshold.toISOString()).get();
        if (snapshot.empty) return;
        const batch = db.batch();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        console.log(`Cleaned up ${snapshot.size} expired bookings.`);
    } catch (err) { console.error('Error cleaning up old bookings:', err); }
}

async function checkAndShiftNotices() {
    try {
        const noticesSnapshot = await db.collection('notices').get();
        if (noticesSnapshot.empty) return;
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const batch = db.batch();
        let updateCount = 0;
        noticesSnapshot.forEach(doc => {
            const data = doc.data();
            if (data.date && data.date !== todayStr) {
                batch.update(doc.ref, {
                    todayMessage: data.tomorrowMessage || '', tomorrowMessage: '',
                    date: todayStr, updatedAt: FieldValue.serverTimestamp()
                });
                updateCount += 1;
            }
        });
        if (updateCount > 0) {
            await batch.commit();
            console.log(`Auto-shifted ${updateCount} notices for ${todayStr}.`);
        }
    } catch (err) { console.error('Error in checkAndShiftNotices:', err); }
}

cleanupOldBookings();
checkAndShiftNotices();

cron.schedule('0 0 * * *', async () => {
    console.log('Running scheduled midnight notice update (IST)...');
    await checkAndShiftNotices();
    await cleanupOldBookings();
}, { scheduled: true, timezone: 'Asia/Kolkata' });

// Express 5 forwards rejected async handlers here automatically.
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err && /CORS/.test(err.message || '')) return res.status(403).json({ error: 'Blocked by CORS: Unauthorized Origin' });
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Owl Watcher API server running on port ${PORT}`));

module.exports = app;
