'use strict';
// "Delete full account" must name the society of the signed-in administrator
// and message the Owl Watcher team number stored in Firestore. Opened from the
// admin portal's Danger zone it also works while the new tab is still
// restoring the Firebase session.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');

function page(t, { teamPhone, society, societyId, meStatus = 200, handOff, user = null }) {
    const html = fs.readFileSync(path.join(root, 'delete.html'), 'utf8');
    const dom = new JSDOM(html, {
        url: 'https://owlwatcher.test/delete.html',
        runScripts: 'outside-only',
        beforeParse(win) {
            win.__opened = [];
            win.open = (url) => { win.__opened.push(url); return null; };
        }
    });
    const { window } = dom;
    window.OWL_API_BASE = 'https://api.test/api';
    window.__authCallback = null;

    if (handOff) window.localStorage.setItem('owl:requestContext', JSON.stringify(handOff));
    window.eval(fs.readFileSync(path.join(root, 'request-context.js'), 'utf8'));

    const calls = [];
    window.fetch = async (url, options = {}) => {
        const parsed = new URL(String(url));
        calls.push({ path: parsed.pathname, headers: options.headers || {} });
        if (parsed.pathname.endsWith('/config')) return { ok: true, json: async () => ({ teamPhone }) };
        if (parsed.pathname.endsWith('/admins/me')) {
            return { ok: meStatus === 200, json: async () => ({ society, societyId, email: user && user.email }) };
        }
        return { ok: false, json: async () => ({}) };
    };

    const logic = fs.readFileSync(path.join(root, 'delete-logic.js'), 'utf8').replace(/^import .*$/gm, '');
    window.eval(`
        var initializeApp = function () { return {}; };
        var getAuth = function () { return {}; };
        var onAuthStateChanged = function (auth, callback) { window.__authCallback = callback; };
        ${logic}
    `);
    t.after(() => dom.window.close());
    return { window, doc: window.document, calls };
}

const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
};

test('the account deletion request names the society and messages the Firestore team number', async (t) => {
    const user = { email: 'prsd1@aangan.in', getIdToken: async () => 'id-token' };
    const view = page(t, { teamPhone: '+91 75671 84961', society: 'Aangan', societyId: 'aangan', user });
    await view.window.__authCallback(user);
    await settle();

    const meCall = view.calls.find(call => call.path.endsWith('/admins/me'));
    assert.ok(meCall, 'the society is read for the signed-in admin');
    assert.equal(meCall.headers.Authorization, 'Bearer id-token', 'the lookup is authenticated');

    const label = view.doc.getElementById('societyLabel');
    assert.equal(label.dataset.society, 'Aangan');
    assert.match(label.textContent, /Aangan/);
    assert.equal(view.doc.getElementById('submitDeleteBtn').disabled, false);

    view.doc.getElementById('submitDeleteBtn').click();
    await settle();

    const navigated = view.window.__opened[0];
    assert.ok(navigated, 'the button opens WhatsApp');
    assert.ok(navigated.startsWith('https://wa.me/917567184961?text='), 'the Firestore number is used, not the fallback');
    const text = decodeURIComponent(navigated.split('text=')[1]);
    assert.match(text, /Society: Aangan/, 'the society name is filled in automatically');
    assert.match(text, /Society ID: aangan/);
    assert.match(text, /Account email: prsd1@aangan\.in/);
});

test('the account page falls back safely when config or the society lookup fails', async (t) => {
    const view = page(t, { teamPhone: null, society: '', societyId: null, meStatus: 503, user: { email: 'a@b.in' } });
    await view.window.__authCallback({ email: 'a@b.in', getIdToken: async () => 't' });
    await settle();

    assert.equal(view.doc.getElementById('societyLabel').dataset.society, '', 'no society is invented');
    view.doc.getElementById('submitDeleteBtn').click();
    await settle();

    const navigated = view.window.__opened[0];
    assert.ok(navigated.startsWith('https://wa.me/919033406816?text='), 'the built-in team number keeps the page usable');
    assert.match(decodeURIComponent(navigated.split('text=')[1]), /Society: \(not loaded\)/);
});

test('a tab opened from the Danger zone names the society before the session is restored', async (t) => {
    const view = page(t, {
        teamPhone: '917567184961', society: '', societyId: null, meStatus: 503,
        handOff: { society: 'Aangan', societyId: 'aangan', email: 'prsd1@aangan.in', isMaster: false }
    });
    await view.window.__authCallback(null);
    await settle();

    const label = view.doc.getElementById('societyLabel');
    assert.equal(label.dataset.society, 'Aangan');
    assert.match(label.textContent, /Aangan/);
    assert.equal(view.doc.getElementById('submitDeleteBtn').disabled, false);

    view.doc.getElementById('submitDeleteBtn').click();
    await settle();

    const navigated = view.window.__opened[0];
    assert.ok(navigated.startsWith('https://wa.me/917567184961?text='));
    const text = decodeURIComponent(navigated.split('text=')[1]);
    assert.match(text, /Society: Aangan/);
    assert.match(text, /Account email: prsd1@aangan\.in/);
});

test('repeated auth callbacks do not open WhatsApp twice', async (t) => {
    const user = { email: 'a@b.in', getIdToken: async () => 't' };
    const view = page(t, { teamPhone: '917567184961', society: 'Aangan', societyId: 'aangan', user });
    await view.window.__authCallback(user);
    await view.window.__authCallback(user);
    await settle();
    view.doc.getElementById('submitDeleteBtn').click();
    await settle();
    assert.equal(view.window.__opened.length, 1);
});

test('a signed-out visitor cannot send an account deletion request', async (t) => {
    const view = page(t, { teamPhone: '917567184961', society: 'Aangan', societyId: 'aangan' });
    await view.window.__authCallback(null);
    await settle();
    assert.equal(view.doc.getElementById('submitDeleteBtn').disabled, true);
    assert.match(view.doc.getElementById('societyLabel').textContent, /log in/i);
    assert.equal(view.calls.length, 0, 'no request is made without a session');
});

test('the nav contact link is not the request destination', () => {
    const html = fs.readFileSync(path.join(root, 'delete.html'), 'utf8');
    assert.match(html, /id="societyLabel"/);
    assert.match(html, /src="delete-logic\.js"/);
    assert.match(html, /src="request-context\.js"/);
    // The button starts disabled until the page knows whose request it is.
    assert.match(html, /id="submitDeleteBtn"[^>]*disabled/);
});
