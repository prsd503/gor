'use strict';
// The "Bulk data delete" request page must name the society of the signed-in
// administrator and message the Owl Watcher team number stored in Firestore.
// Opening it from the admin portal's Danger zone hands the society over, so a
// tab whose Firebase session has not been restored yet still names it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');

function page(t, { user, teamPhone, society, societyId, handOff }) {
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

    if (handOff) {
        window.localStorage.setItem('owl:requestContext', JSON.stringify(handOff));
    }
    // The admin portal's hand-off module is a plain script in the page.
    window.eval(fs.readFileSync(path.join(root, 'request-context.js'), 'utf8'));

    const calls = [];
    window.fetch = async (url, options = {}) => {
        const parsed = new URL(String(url));
        calls.push({ path: parsed.pathname, headers: options.headers || {} });
        if (parsed.pathname.endsWith('/config')) {
            return { ok: true, json: async () => ({ teamPhone }) };
        }
        if (parsed.pathname.endsWith('/admins/me')) {
            return { ok: true, json: async () => ({ society, societyId, email: user && user.email }) };
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
    assert.equal(view.doc.getElementById('deleteModal').style.display, 'block', 'the missing number is an in-page modal, not a browser alert');
    assert.match(view.doc.getElementById('deleteModalText').textContent, /vehicle number/i);
});

test('the page falls back safely when the number or the society cannot be loaded', async (t) => {
    const html = fs.readFileSync(path.join(root, 'deletedata.html'), 'utf8');
    assert.match(html, /id="societyLabel"/);
    assert.match(html, /src="deletedata-logic.js"/);
    assert.match(html, /src="request-context\.js"/, 'the hand-off module is loaded before the page logic');

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

test('a ten-digit team number is given the country code so the wa.me link is valid', async (t) => {
    const view = page(t, { user: { email: 'a@b.in', getIdToken: async () => 't' }, teamPhone: '7567184961', society: 'Aangan', societyId: 'aangan' });
    await view.window.__authCallback({ email: 'a@b.in', getIdToken: async () => 't' });
    await settle();
    assert.equal(view.window.OwDeleteRequest.normalisePhone('7567184961'), '917567184961');
    assert.equal(view.window.OwDeleteRequest.normalisePhone('+91 75671 84961'), '917567184961');
    view.doc.getElementById('deleteOption').value = 'All Data';
    view.doc.getElementById('submitDeleteReq').click();
    await settle();
    assert.ok(view.window.__opened[0].startsWith('https://wa.me/917567184961?text='));
});

test('the button opens WhatsApp once, even when auth state fires again', async (t) => {
    const view = page(t, { user: { email: 'a@b.in', getIdToken: async () => 't' }, teamPhone: '917567184961', society: 'Aangan', societyId: 'aangan' });
    const user = { email: 'a@b.in', getIdToken: async () => 't' };
    await view.window.__authCallback(user);
    await view.window.__authCallback(user);
    await settle();
    view.doc.getElementById('deleteOption').value = 'All Data';
    view.doc.getElementById('submitDeleteReq').click();
    await settle();
    assert.equal(view.window.__opened.length, 1, 'one click, one chat');
});

test('a tab opened from the admin portal names the society even before the session is restored', async (t) => {
    const view = page(t, {
        user: null,
        teamPhone: '917567184961',
        society: 'Aangan',
        societyId: 'aangan',
        handOff: { society: 'Aangan', societyId: 'aangan', email: 'prsd1@aangan.in', isMaster: false }
    });
    await view.window.__authCallback(null);
    await settle();

    const label = view.doc.getElementById('societyLabel');
    assert.equal(label.dataset.society, 'Aangan', 'the hand-off society is shown');
    assert.match(label.textContent, /Aangan/);
    assert.equal(view.doc.getElementById('submitDeleteReq').disabled, false, 'the request stays one click away');

    view.doc.getElementById('deleteOption').value = 'All Data';
    view.doc.getElementById('submitDeleteReq').click();
    await settle();

    const navigated = view.window.__opened[0];
    assert.ok(navigated.startsWith('https://wa.me/917567184961?text='), 'the Owl Watcher team number is the destination');
    const text = decodeURIComponent(navigated.split('text=')[1]);
    assert.match(text, /Society: Aangan/);
    assert.match(text, /Requested by: prsd1@aangan\.in/);
});

test('the live session replaces the hand-off society', async (t) => {
    const view = page(t, {
        user: { email: 'new@bloom.in', getIdToken: async () => 'id-token' },
        teamPhone: '917567184961',
        society: 'Bloom',
        societyId: 'bloom',
        handOff: { society: 'Aangan', societyId: 'aangan', email: 'old@aangan.in', isMaster: false }
    });
    await view.window.__authCallback({ email: 'new@bloom.in', getIdToken: async () => 'id-token' });
    await settle();

    assert.equal(view.doc.getElementById('societyLabel').dataset.society, 'Bloom');
    view.doc.getElementById('deleteOption').value = 'All Data';
    view.doc.getElementById('submitDeleteReq').click();
    await settle();
    const text = decodeURIComponent(view.window.__opened[0].split('text=')[1]);
    assert.match(text, /Society: Bloom/);
    assert.match(text, /Requested by: new@bloom\.in/);
});

test('a visitor with no session and no hand-off cannot send a request', async (t) => {
    const view = page(t, { user: null, teamPhone: '917567184961', society: 'Aangan', societyId: 'aangan' });
    await view.window.__authCallback(null);
    await settle();
    assert.equal(view.doc.getElementById('submitDeleteReq').disabled, true);
    assert.match(view.doc.getElementById('societyLabel').textContent, /log in/i);
    assert.equal(view.calls.length, 0, 'no request is made without a session or a hand-off');
    assert.equal(view.window.__opened.length, 0);
});
