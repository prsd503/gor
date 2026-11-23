'use strict';
// The "Bulk data delete" request page must name the society of the signed-in
// administrator and message the Owl Watcher team number stored in Firestore.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');

function page(t, { user, teamPhone, society, societyId }) {
    const html = fs.readFileSync(path.join(root, 'deletedata.html'), 'utf8');
    // jsdom's location.href setter is a no-op; swallowing it would make the
    // "opens WhatsApp" assertions vacuous, so the page navigates via
    // window.open for testability with a location.href fallback.
    const dom = new JSDOM(html, { url: 'https://owlwatcher.test/deletedata.html', runScripts: 'outside-only', beforeParse(win) {
        win.__opened = [];
        win.open = (url) => { win.__opened.push(url); return null; };
    } });
    const { window } = dom;
    window.OWL_API_BASE = 'https://api.test/api';
    window.__authCallback = null;
    window.alert = message => { window.__alert = message; };

    const calls = [];
    window.fetch = async (url, options = {}) => {
        const parsed = new URL(String(url));
        calls.push({ path: parsed.pathname, headers: options.headers || {} });
        if (parsed.pathname.endsWith('/config')) {
            return { ok: true, json: async () => ({ teamPhone }) };
        }
        if (parsed.pathname.endsWith('/admins/me')) {
            return { ok: true, json: async () => ({ society, societyId }) };
        }
        return { ok: false, json: async () => ({}) };
    };

    // Stand in for the Firebase SDK modules the page imports.
    const logic = fs.readFileSync(path.join(root, 'deletedata-logic.js'), 'utf8')
        .replace(/^import .*$/gm, '');
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

test('the deletion request names the administrator society and messages the team number from Firestore', async (t) => {
    const view = page(t, { user: { email: 'prsd1@aangan.in', getIdToken: async () => 'id-token' }, teamPhone: '+91 75671 84961', society: 'Aangan', societyId: 'aangan' });
    await view.window.__authCallback({ email: 'prsd1@aangan.in', getIdToken: async () => 'id-token' });
    await settle();

    assert.ok(view.calls.some(call => call.path.endsWith('/admins/me')), 'society is read for the signed-in admin');
    const meCall = view.calls.find(call => call.path.endsWith('/admins/me'));
    assert.equal(meCall.headers.Authorization, 'Bearer id-token', 'the society lookup is authenticated');

    const label = view.doc.getElementById('societyLabel');
    assert.equal(label.dataset.society, 'Aangan');
    assert.match(label.textContent, /Aangan/);

    view.doc.getElementById('deleteOption').value = 'Specific Vehicle';
    view.doc.getElementById('details').value = 'GJ01AB1234';
    view.doc.getElementById('submitDeleteReq').click();
    await settle();

    const navigated = view.window.__opened[0];
    assert.ok(navigated, 'the button opens WhatsApp');
    assert.ok(navigated.startsWith('https://wa.me/917567184961?text='), 'the Firestore team number is used, not the fallback');
    const text = decodeURIComponent(navigated.split('text=')[1]);
    assert.match(text, /Society: Aangan/);
    assert.match(text, /Society ID: aangan/);
    assert.match(text, /Request Type: Specific Vehicle/);
    assert.match(text, /Details: GJ01AB1234/);
    assert.match(text, /Requested by: prsd1@aangan\.in/);
});

test('a specific-vehicle request without a number asks for it instead of sending', async (t) => {
    const view = page(t, { user: { email: 'a@b.in', getIdToken: async () => 't' }, teamPhone: '917567184961', society: 'Aangan', societyId: 'aangan' });
    await view.window.__authCallback({ email: 'a@b.in', getIdToken: async () => 't' });
    await settle();
    view.doc.getElementById('deleteOption').value = 'Specific Vehicle';
    view.doc.getElementById('details').value = '   ';
    view.doc.getElementById('submitDeleteReq').click();
    await settle();
    assert.equal(view.window.__opened.length, 0, 'nothing is sent');
    assert.match(view.window.__alert, /vehicle number/i);
});

test('the page falls back safely when the number or the society cannot be loaded', async (t) => {
    const html = fs.readFileSync(path.join(root, 'deletedata.html'), 'utf8');
    assert.match(html, /id="societyLabel"/);
    assert.match(html, /src="deletedata-logic.js"/);

    const view = page(t, { user: { email: 'a@b.in', getIdToken: async () => 't' }, teamPhone: null, society: '', societyId: null });
    await view.window.__authCallback({ email: 'a@b.in', getIdToken: async () => 't' });
    await settle();
    assert.equal(view.doc.getElementById('societyLabel').dataset.society, '', 'an empty society is reported, not invented');

    view.doc.getElementById('deleteOption').value = 'All Data';
    view.doc.getElementById('submitDeleteReq').click();
    await settle();
    const navigated = view.window.__opened[0];
    assert.ok(navigated.startsWith('https://wa.me/919033406816?text='), 'the built-in team number keeps the page usable');
    assert.match(decodeURIComponent(navigated.split('text=')[1]), /Society: \(not loaded\)/);
});

test('a signed-out visitor cannot send a request', async (t) => {
    const view = page(t, { user: null, teamPhone: '917567184961', society: 'Aangan', societyId: 'aangan' });
    await view.window.__authCallback(null);
    await settle();
    assert.equal(view.doc.getElementById('submitDeleteReq').disabled, true);
    assert.match(view.doc.getElementById('societyLabel').textContent, /log in/i);
    assert.equal(view.calls.length, 0, 'no request is made without a session');
});
