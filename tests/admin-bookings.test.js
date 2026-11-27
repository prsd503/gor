'use strict';
// Admin portal bookings: the time pickers must stay readable (theme colours,
// not a hardcoded white background) and the active bookings list must show the
// facility name, date and time with a delete action, hiding bookings older than
// the 7-day retention window that maintenance removes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');

function loadAdmin(t, { society = 'Aangan', facilities = { F1: 'Clubhouse', F2: 'Gym' }, bookings = [] } = {}) {
    const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
    const dom = new JSDOM(html, {
        url: 'https://owlwatcher.test/admin.html',
        runScripts: 'outside-only',
        beforeParse(win) {
            win.HTMLCanvasElement.prototype.getContext = () => null;
        }
    });
    const { window } = dom;
    const calls = [];
    window.OWL_API_BASE = 'https://api.test/api';
    window.fetch = async (url, options = {}) => {
        const parsed = new URL(String(url), window.location.href);
        calls.push({ url: parsed, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
        if (parsed.pathname.endsWith('/config')) return { ok: true, json: async () => ({ teamPhone: '917567184961' }) };
        if (parsed.pathname.includes('/facilities/')) return { ok: true, json: async () => facilities };
        if (parsed.pathname.endsWith('/bookings') && (options.method || 'GET') === 'POST') {
            window.__bookingPost = JSON.parse(options.body);
            return { ok: true, json: async () => ({ success: true }) };
        }
        if (/\/bookings\/[^/]+$/.test(parsed.pathname) && (options.method || 'GET') === 'DELETE') {
            window.__bookingDelete = parsed.pathname;
            return { ok: true, json: async () => ({ success: true }) };
        }
        if (parsed.pathname.endsWith('/bookings')) return { ok: true, json: async () => bookings };
        return { ok: true, json: async () => [] };
    };

    const source = fs.readFileSync(path.join(root, 'admin-logic.js'), 'utf8')
        .replace(/^import .*$/gm, '')
        .replace(/^const API_BASE_URL = .*$/m, 'var API_BASE_URL = window.OWL_API_BASE;')
        .replace(/^const NG_HEADERS = .*$/m, "var NG_HEADERS = {};")
        .replace('let assignedSociety = "";', `var assignedSociety = ${JSON.stringify(society)};`);
    window.eval(`
        var authenticatedFetch = window.fetch;
        var auth = { currentUser: { getIdToken: async () => 'test-token' } };
        var signInWithEmailAndPassword = async () => {};
        var signOut = async () => {};
        var onAuthStateChanged = () => {};
        var sendPasswordResetEmail = async () => {};
        var Filesystem = {}; var Directory = {}; var Encoding = {}; var Share = { share: async () => {} };
        ${source}
    `);

    // The page wires its forms and builds the time pickers inside its
    // DOMContentLoaded handler, so run it the way the browser would.
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    // The page starts background requests on load; let them settle before
    // closing the window so nothing runs against a torn-down DOM.
    t.after(async () => {
        await new Promise(resolve => setTimeout(resolve, 60));
        dom.window.close();
    });
    // The page's click handlers await fetches and re-render, so prefer real
    // timer turns over microtasks only.
    const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 10)); };
    return { window, doc: window.document, calls, settle };
}

function daysFromNow(days) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date;
}

function isoAt(days, time) {
    const date = daysFromNow(days);
    return `${date.toISOString().slice(0, 10)}T${time}:00`;
}

test('the booking time pickers do not hardcode a white background', () => {
    const source = fs.readFileSync(path.join(root, 'admin-logic.js'), 'utf8');
    const picker = source.slice(source.indexOf('function buildTimeDropdownHTML'), source.indexOf('function getSelectedTimeString'));
    assert.ok(!/background:\s*#fff/i.test(picker), 'no fixed white background on the time selects');
    assert.ok(!/color:\s*#fff/i.test(picker), 'no fixed white text either');
    assert.match(picker, /class="time-picker"/);

    const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
    assert.match(html, /\.time-picker select \{[^}]*background-color: var\(--ow-surface\)[^}]*color: var\(--ow-text\)/s);
    assert.match(html, /\.time-picker select option \{[^}]*color: var\(--ow-text\)/s);
});

test('active bookings show facility name, date, times and a delete action', async (t) => {
    const view = loadAdmin(t, {
        bookings: [
            { id: 'b2', facilityId: 'F2', start: isoAt(2, '18:00'), end: isoAt(2, '19:30') },
            { id: 'b1', facilityId: 'F1', start: isoAt(1, '10:00'), end: isoAt(1, '12:00') }
        ]
    });
    await view.window.OwAdminBookings.loadActiveBookings();
    await view.settle();

    const list = view.doc.getElementById('active-bookings-list');
    const text = list.textContent;
    assert.match(text, /Clubhouse/, 'facility name is shown');
    assert.match(text, /Gym/);
    assert.match(text, /Active bookings \(2\)/);
    assert.match(text, /10:00 AM to 12:00 PM/, 'times are readable, 12-hour format');
    assert.match(text, /6:00 PM to 7:30 PM/);
    assert.ok(list.querySelectorAll('[data-booking-delete]').length === 2, 'each booking has a delete button');
    // Soonest first.
    assert.ok(text.indexOf('Clubhouse') < text.indexOf('Gym'), 'sorted by start time');
});

test('bookings older than 7 days are not listed, matching the automatic clean-up', async (t) => {
    const view = loadAdmin(t, {});
    const render = view.window.OwAdminBookings.renderActiveBookings;
    assert.ok(render, 'the renderer is exposed for the page and for tests');
    render([
        { id: 'old', facilityId: 'F1', start: isoAt(-9, '10:00'), end: isoAt(-9, '12:00') },
        { id: 'recent', facilityId: 'F1', start: isoAt(-2, '10:00'), end: isoAt(-2, '12:00') }
    ], { F1: 'Clubhouse' });
    const text = view.doc.getElementById('active-bookings-list').textContent;
    assert.match(text, /Active bookings \(1\)/, 'the expired booking is hidden');
    assert.match(text, /Clubhouse/);
    assert.ok(!text.includes(isoAt(-9, '10:00').slice(0, 10)), 'the 9-day-old date is not shown');
});

test('deleting a booking calls the API for that document and refreshes the list', async (t) => {
    const view = loadAdmin(t, {
        bookings: [{ id: 'b1', facilityId: 'F1', start: isoAt(1, '10:00'), end: isoAt(1, '12:00') }]
    });
    const render = view.window.OwAdminBookings.renderActiveBookings;
    render([{ id: 'b1', facilityId: 'F1', start: isoAt(1, '10:00'), end: isoAt(1, '12:00') }], { F1: 'Clubhouse' });
    view.doc.querySelector('[data-booking-delete]').click();
    await view.settle();
    assert.equal(view.doc.getElementById('customModal').style.display, 'block', 'deleting asks for confirmation in the in-page dialog');
    view.window.runConfirmAction(); // the dialog's confirm button
    // The delete path is async (confirm dialog → DELETE → refresh): wait for the call.
    for (let i = 0; i < 40 && !view.window.__bookingDelete; i++) await view.settle();
    await view.settle(); // let the handler finish (message + list refresh)
    assert.equal(view.window.__bookingDelete, '/api/bookings/b1');
    assert.match(view.doc.getElementById('modalMessage').textContent, /Booking deleted/, 'the admin sees a success message');
});

test('a booking whose end is before its start is rejected before the request', async (t) => {
    const view = loadAdmin(t, {});
    view.doc.getElementById('bookingDate').value = isoAt(1, '10:00').slice(0, 10);
    view.doc.getElementById('startHour').value = '10';
    view.doc.getElementById('startMin').value = '00';
    view.doc.getElementById('startAmPm').value = 'AM';
    view.doc.getElementById('endHour').value = '09';
    view.doc.getElementById('endMin').value = '00';
    view.doc.getElementById('endAmPm').value = 'AM';
    view.doc.getElementById('bookFacilityBtn').click();
    await view.settle();
    assert.equal(view.window.__bookingPost, undefined, 'nothing is written');
    assert.match(view.doc.getElementById('modalMessage').textContent, /end time must be after/i, 'the admin sees why it was rejected');
});
