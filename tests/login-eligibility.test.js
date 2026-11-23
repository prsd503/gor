'use strict';
// Sign-in eligibility: an email may only sign in to a portal when Firestore
// registers it for that role. The role is checked before the password is sent,
// and the token-backed membership check after sign-in stays the real gate.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createLocalStore } = require('../server/lib/local-store');

const root = path.join(__dirname, '..');

async function startApi(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-staff-role-'));
    const file = path.join(dir, 'db.json');
    const db = createLocalStore({ file });
    await db.collection('societies').doc('aangan').set({ name: 'Aangan', flatList: ['A1-103'] });
    await db.collection('admins').doc('admin@aangan.in').set({ email: 'admin@aangan.in', society: 'Aangan', phone: '919033406816' });
    await db.collection('admins').doc('master@owl.test').set({ email: 'master@owl.test', society: 'Aangan', isMaster: true });
    await db.collection('admins').doc('gone@aangan.in').set({ email: 'gone@aangan.in', society: 'Aangan', disabled: true });
    await db.collection('guards').doc('guard@aangan.in').set({ email: 'guard@aangan.in', society: 'Aangan', name: 'Ramesh' });
    await db.collection('guards').doc('gone-guard@aangan.in').set({ email: 'gone-guard@aangan.in', society: 'Aangan', active: false });

    Object.assign(process.env, {
        ENV_FILE: path.join(dir, 'no-env'), JWT_SECRET: 'staff-role-secret-'.repeat(4),
        DATA_BACKEND: 'local', AUTH_MODE: 'local',
        LOCAL_ADMIN_EMAIL: 'admin@local.test', LOCAL_ADMIN_PASSWORD: 'a-long-testing-password',
        LOCAL_DB_FILE: file, QUOTA_STATE_FILE: '', QUOTA_ACTION: 'off', QUOTA_SOURCE: 'local',
        APP_CHECK_MODE: 'off', SERVE_STATIC: '0', ENABLE_CRON: '0', READ_CACHE_TTL_MS: '0'
    });
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function (name, ...args) {
        if (name.startsWith('firebase-admin')) throw new Error('Firebase must not load locally');
        return original.call(this, name, ...args);
    };
    for (const key of Object.keys(require.cache)) {
        if (key.includes(`${path.sep}server${path.sep}`)) delete require.cache[key];
    }
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
    return {
        base,
        async role(email) {
            const res = await fetch(base + '/api/auth/staff-role', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email })
            });
            return { status: res.status, body: await res.json().catch(() => null), cache: res.headers.get('cache-control') };
        }
    };
}

test('the staff-role pre-check reports admin, master, guard or nothing', async (t) => {
    const api = await startApi(t);

    assert.deepEqual((await api.role('admin@aangan.in')).body, { success: true, role: 'admin' });
    assert.equal((await api.role('ADMIN@Aangan.IN')).body.role, 'admin', 'email match is case-insensitive');
    assert.equal((await api.role('master@owl.test')).body.role, 'master');
    assert.equal((await api.role('guard@aangan.in')).body.role, 'guard');
    assert.equal((await api.role('stranger@aangan.in')).body.role, null, 'unknown email');
    assert.equal((await api.role('gone@aangan.in')).body.role, null, 'disabled admin record does not count');
    assert.equal((await api.role('gone-guard@aangan.in')).body.role, null, 'inactive guard record does not count');

    const anonymous = await api.role('stranger@aangan.in');
    assert.equal(anonymous.status, 200, 'a non-member is a 200 with role null, not an error');
    assert.match(anonymous.cache, /no-store/, 'the answer is never cached');
});

test('the staff-role pre-check needs an email and does not leak on bad input', async (t) => {
    const api = await startApi(t);
    assert.equal((await api.role('')).status, 400);
    assert.equal((await api.role('not-an-email')).body.role, null);
    assert.equal((await api.role('a'.repeat(300) + '@x.com')).body.role, null);
});

test('the pre-check grants nothing: it cannot read a directory by itself', async (t) => {
    const api = await startApi(t);
    const res = await fetch(api.base + '/api/admins?email=admin@aangan.in');
    assert.equal(res.status, 401, 'the admin directory still needs a token');
    const guards = await fetch(api.base + '/api/guards?email=guard@aangan.in');
    assert.equal(guards.status, 401, 'the guard directory still needs a token');
});

// --- Browser side ---------------------------------------------------------
function loadPage(t, page, { role = null, roleStatus = 200, failLookup = false, signInError = null } = {}) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    const dom = new JSDOM(html, {
        url: 'https://owlwatcher.test/' + page,
        runScripts: 'outside-only',
        beforeParse(win) { win.HTMLCanvasElement.prototype.getContext = () => null; }
    });
    const { window } = dom;
    const calls = { lookups: [], signIns: [], signsOut: 0 };
    window.OWL_API_BASE = 'https://api.test/api';
    window.fetch = async (url, options = {}) => {
        const parsed = new URL(String(url), window.location.href);
        if (parsed.pathname.endsWith('/auth/staff-role')) {
            calls.lookups.push(JSON.parse(options.body));
            if (failLookup) throw new TypeError('Failed to fetch');
            return { ok: roleStatus === 200, status: roleStatus, json: async () => ({ success: true, role }) };
        }
        // A guard profile for the directory calls (the guard page loads its own
        // record and its society's guard list after signing in).
        return { ok: true, status: 200, json: async () => [{ id: 'guard@example.com', name: 'Ramesh', phone: '9000000000', society: 'Aangan' }] };
    };
    const source = fs.readFileSync(path.join(root, page === 'admin.html' ? 'admin-logic.js' : 'guard-logic.js'), 'utf8')
        .replace(/^import .*$/gm, '')
        .replace(/^const API_BASE_URL = .*$/m, 'var API_BASE_URL = window.OWL_API_BASE;')
        .replace(/^const API_BASE = .*$/m, 'var API_BASE = window.OWL_API_BASE;')
        .replace(/^const NG_HEADERS = .*$/m, 'var NG_HEADERS = {};');
    const prelude = `
        var authenticatedFetch = function () { return window.fetch.apply(window, arguments); };
        var auth = { currentUser: null };
        var __authHandlers = [];
        var signInWithEmailAndPassword = async (a, email, pass) => {
            window.__signIns = window.__signIns || [];
            window.__signIns.push({ email, pass });
            if (window.__signInError) { var err = new Error('bad'); err.code = window.__signInError; throw err; }
            // Like the real SDK: the auth listener fires with the signed-in user.
            var user = { email, getIdToken: async () => 't' };
            auth.currentUser = user;
            __authHandlers.forEach(function (cb) { setTimeout(function () { cb(user); }, 0); });
            return { user };
        };
        var signOut = async () => {};
        var onAuthStateChanged = (a, cb) => { __authHandlers.push(cb); };
        var sendPasswordResetEmail = async () => {};
        var Filesystem = {}; var Directory = {}; var Encoding = {}; var Share = { share: async () => {} };
    `;
    window.__signInError = signInError;
    window.eval(prelude + source);
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    t.after(async () => {
        await new Promise(resolve => setTimeout(resolve, 60));
        dom.window.close();
    });
    return { window, doc: window.document, calls };
}

async function submitLogin(doc) {
    doc.getElementById('email').value = 'someone@example.com';
    doc.getElementById('pass').value = 'secret123';
    doc.getElementById('loginBtn').click();
    await new Promise(resolve => setTimeout(resolve, 60));
}

for (const [page, labels] of [['admin.html', { other: 'admin', message: /not registered as a society admin/ }],
                              ['guard.html', { other: 'guard', message: /not registered as a security guard/ }]]) {
    test(`${page}: an unregistered email is refused before any password is sent`, async (t) => {
        const { window, doc, calls } = loadPage(t, page, { role: null });
        await submitLogin(doc);

        assert.equal(calls.lookups.length, 1, 'the email was checked');
        assert.equal(calls.lookups[0].email, 'someone@example.com');
        assert.deepEqual(window.__signIns || [], [], 'no sign-in attempt was made');
        assert.match(doc.getElementById('modalMessage').textContent, labels.message);
        assert.equal(doc.getElementById('login-section').style.display !== 'none', true, 'stays on the sign-in card');
    });

    test(`${page}: a lookup failure says so instead of pretending the email is invalid`, async (t) => {
        const { window, doc } = loadPage(t, page, { failLookup: true });
        await submitLogin(doc);
        assert.match(doc.getElementById('modalMessage').textContent, /Could not check whether this email/);
        assert.deepEqual(window.__signIns || [], []);
    });

    test(`${page}: a malformed email is caught before the lookup`, async (t) => {
        const { doc, calls } = loadPage(t, page, { role: null });
        doc.getElementById('email').value = 'nope';
        doc.getElementById('pass').value = 'secret123';
        doc.getElementById('loginBtn').click();
        await new Promise(resolve => setTimeout(resolve, 40));
        assert.match(doc.getElementById('modalMessage').textContent, /valid email/);
        assert.equal(calls.lookups.length, 0, 'no request for an unparseable address');
    });
}

test('admin.html: a guard account is sent to the guard portal', async (t) => {
    const { window, doc } = loadPage(t, 'admin.html', { role: 'guard' });
    await submitLogin(doc);
    assert.match(doc.getElementById('modalMessage').textContent, /registered as a guard, not a society admin/);
    assert.deepEqual(window.__signIns || [], [], 'a guard never signs in here');
});

test('guard.html: an admin account is sent to the admin portal', async (t) => {
    const { window, doc } = loadPage(t, 'guard.html', { role: 'admin' });
    await submitLogin(doc);
    assert.match(doc.getElementById('modalMessage').textContent, /registered as a society admin, not a guard/);
    assert.deepEqual(window.__signIns || [], []);
});

test('admin.html: a registered admin still signs in normally', async (t) => {
    const { window, doc } = loadPage(t, 'admin.html', { role: 'admin' });
    await submitLogin(doc);
    assert.deepEqual([...window.__signIns].map(call => ({ ...call })), [{ email: 'someone@example.com', pass: 'secret123' }]);
    assert.match(doc.getElementById('modalMessage').textContent, /Login successful/);
});

test('guard.html: a registered guard still signs in normally', async (t) => {
    const { window, doc } = loadPage(t, 'guard.html', { role: 'guard' });
    await submitLogin(doc);
    assert.deepEqual([...window.__signIns].map(call => ({ ...call })), [{ email: 'someone@example.com', pass: 'secret123' }]);
    assert.match(doc.getElementById('modalMessage').textContent, /Login successful/);
});

test('a wrong password still reports a credential error after a valid role check', async (t) => {
    const { doc } = loadPage(t, 'admin.html', { role: 'admin', signInError: 'auth/invalid-credential' });
    await submitLogin(doc);
    assert.match(doc.getElementById('modalMessage').textContent, /Wrong email or password/);
});

test('the membership check after sign-in still refuses a removed admin', async (t) => {
    const { window, doc } = loadPage(t, 'admin.html', { role: 'admin' });
    // The pre-check passes and Firebase signs in, but /api/admins now says no:
    // the record was removed between the two checks.
    const baseFetch = window.fetch;
    window.fetch = async (url, options = {}) => {
        const parsed = new URL(String(url), window.location.href);
        if (parsed.pathname.includes('/admins')) return { ok: false, status: 403, json: async () => ({ error: 'nope' }) };
        return baseFetch(url, options);
    };
    window.eval('signOut = async () => { window.__signedOut = true; };');
    await submitLogin(doc);
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.match(doc.getElementById('modalMessage').textContent, /not registered as a society admin/);
    assert.equal(window.__signedOut, true, 'the stale session is dropped');
});
