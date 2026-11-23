'use strict';
// The facility calendar's "Contact Admin via WhatsApp" button must use the
// number stored on the society's administrator record in Firestore `admins`,
// not a number baked into the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLocalStore } = require('../server/lib/local-store');

const root = path.join(__dirname, '..');

// Boots the real Express app on the local JSON store and returns a GET helper.
async function startApi(t, seed) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-admin-contact-'));
    const file = path.join(dir, 'db.json');
    const db = createLocalStore({ file });
    await seed(db);
    Object.assign(process.env, {
        ENV_FILE: path.join(dir, 'no-env'), JWT_SECRET: 'admin-contact-secret-'.repeat(3),
        DATA_BACKEND: 'local', AUTH_MODE: 'local',
        LOCAL_ADMIN_EMAIL: 'admin@local.test', LOCAL_ADMIN_PASSWORD: 'a-long-testing-password',
        LOCAL_DB_FILE: file, QUOTA_STATE_FILE: '', QUOTA_ACTION: 'stop', QUOTA_SOURCE: 'local',
        APP_CHECK_MODE: 'off', SERVE_STATIC: '0', ENABLE_CRON: '0', READ_CACHE_TTL_MS: '0'
    });
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function (name, ...args) {
        if (name.startsWith('firebase-admin')) throw new Error('Firebase must not load locally');
        return original.call(this, name, ...args);
    };
    let app;
    try { app = require('../server/index'); } finally { Module._load = original; }
    const server = app.listen(0, '0.0.0.0');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => {
        app.quota.close();
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    return async (url) => {
        const res = await fetch(base + url);
        return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
    };
}

async function seedSociety(db) {
    await db.collection('societies').doc('aangan').set({ name: 'Aangan' });
    await db.collection('societies').doc('nophone').set({ name: 'No Phone' });
    await db.collection('societies').doc('gone').set({ name: 'Gone' });
    // Shaped like the live document: keyed by admin email and identifying its
    // society by display name. The formatted number is normalised to digits.
    await db.collection('admins').doc('prsd1@aangan.in').set({
        email: 'prsd1@aangan.in', phone: '+91 90334 06816', society: 'Aangan'
    });
    await db.collection('admins').doc('someone@other.in').set({
        email: 'someone@other.in', phone: '919999999999', society: 'Other Society'
    });
    await db.collection('admins').doc('b@nophone.in').set({
        email: 'b@nophone.in', society: 'No Phone'
    });
    await db.collection('admins').doc('c@gone.in').set({
        email: 'c@gone.in', phone: '919111111111', society: 'Gone', disabled: true
    });
}

test('the facility admin contact comes only from the society admin document in Firestore', async (t) => {
    const get = await startApi(t, seedSociety);

    const byName = await get('/api/societies/Aangan/admin-contact');
    assert.equal(byName.status, 200);
    assert.deepEqual(byName.body, { societyId: 'aangan', society: 'Aangan', phone: '919033406816' });
    assert.match(byName.headers.get('cache-control'), /max-age=60/);

    // The document id resolves to the same administrator, never another society's.
    const byId = await get('/api/societies/aangan/admin-contact');
    assert.equal(byId.body.phone, '919033406816');
    assert.ok(!JSON.stringify(byId.body).includes('prsd1@'), 'no admin email is exposed');

    const missing = await get('/api/societies/No%20Phone/admin-contact');
    assert.equal(missing.status, 200);
    assert.equal(missing.body.phone, null, 'no stored number, no invented contact');

    const disabled = await get('/api/societies/Gone/admin-contact');
    assert.equal(disabled.body.phone, null, 'a disabled admin is not published');

    const unknown = await get('/api/societies/Unknown%20Society/admin-contact');
    assert.equal(unknown.status, 404);
});

test('facility.html asks the API for the society admin contact instead of /admins', () => {
    const html = fs.readFileSync(path.join(root, 'facility.html'), 'utf8');
    assert.match(html, /\/societies\/\$\{encodeURIComponent\(societyId\)\}\/admin-contact/);
    assert.ok(!/fetch\(`\$\{API_BASE_URL\}\/admins\?society=/.test(html), 'the staff-only /admins route is not used');
    assert.match(html, /wa\.me\/\$\{formattedPhone\}/, 'the WhatsApp link is built from the fetched number');
    assert.match(html, /Admin contact not available\./, 'the page still degrades when no number is stored');
});
