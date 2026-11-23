'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

test('entry UI handles an unbound legacy registration without exposing saved vehicle/contact fields', async () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'entry.html'), 'utf8');
    const dom = new JSDOM(html, {
        url: 'https://owlwatcher.test/entry.html?society=Aangan',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    const calls = [];
    window.OWL_API_BASE = 'https://api.test/api';
    window.localStorage.setItem('mockDeviceId', 'legacy-device');
    window.Device = { getId: async () => ({ identifier: 'legacy-device' }) };
    window.fetch = async (url, options = {}) => {
        const parsed = new URL(String(url), window.location.href);
        calls.push({ url: parsed, method: options.method || 'GET' });
        if (parsed.pathname.endsWith('/auth/token')) {
            return { ok: true, json: async () => ({ token: 'test-token' }) };
        }
        if (parsed.pathname.endsWith('/societies')) {
            return {
                ok: true,
                json: async () => [{
                    id: 'aangan', name: 'Aangan', flatList: ['A-103'], max2Wheeler: 1, max4Wheeler: 1
                }]
            };
        }
        if (parsed.pathname.endsWith('/admin-contact')) {
            return { ok: true, json: async () => ({ societyId: 'aangan', society: 'Aangan', phone: '919033406816' }) };
        }
        if (parsed.pathname.endsWith('/vehicles')) {
            return {
                ok: true,
                json: async () => [{
                    flatNumber: 'A-103', registrationSummary: true, totalRegisteredCount: 1,
                    registered2WheelerCount: 0, registered4WheelerCount: 1
                }]
            };
        }
        throw new Error(`Unexpected test fetch: ${parsed.href}`);
    };

    const moduleScript = [...window.document.querySelectorAll('script[type="module"]')]
        .map(script => script.textContent)
        .find(source => source.includes("document.addEventListener('DOMContentLoaded'"));
    assert.ok(moduleScript, 'entry page module script is present');
    const executable = moduleScript.replace(
        /import\s*\{\s*Device\s*\}\s*from\s*['"][^'"]+['"]\s*;\s*/,
        ''
    );
    window.eval(executable);
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

    const flush = async () => {
        for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    };
    await flush();

    const flatSelect = window.document.getElementById('flatSelect');
    assert.equal(flatSelect.options.length, 2, 'society flats load from the API');
    flatSelect.value = 'A-103';
    flatSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flush();

    // The contact button messages the society admin stored in Firestore `admins`.
    const contactCall = calls.find(call => call.url.pathname.endsWith('/admin-contact'));
    assert.ok(contactCall, 'the admin contact number is loaded from the API');
    assert.equal(contactCall.url.pathname, '/api/societies/Aangan/admin-contact');
    const contactLink = window.document.getElementById('adminWhatsAppLink');
    assert.ok(contactLink.href.startsWith('https://wa.me/919033406816?text='), 'the WhatsApp link uses the stored number');
    assert.match(decodeURIComponent(contactLink.href), /Flat A-103 in Aangan/, 'the chat names the selected flat');

    const vehicleCall = calls.find(call => call.url.pathname.endsWith('/vehicles'));
    assert.ok(vehicleCall, 'flat change queries the API');
    assert.equal(vehicleCall.url.searchParams.get('flatNumber'), 'A-103');
    assert.equal(vehicleCall.url.searchParams.get('deviceId'), 'legacy-device');
    assert.match(window.document.getElementById('dynamicVehicleFields').innerHTML, /Already Registered Vehicles \(1\/2\)/);
    assert.match(window.document.getElementById('dynamicVehicleFields').innerHTML, /details are hidden until this device is linked/i);
    const inputs = window.document.querySelectorAll('.dynamic-vehicle-input');
    assert.equal(inputs.length, 1, 'only the remaining 2-wheeler slot is offered');
    assert.equal(inputs[0].dataset.type, '2-Wheeler');
    assert.equal(window.document.getElementById('mobileNumber').value, '', 'private legacy contact data is not prefetched');
    assert.equal(window.document.getElementById('residentTypeSelect').value, '', 'private legacy resident data is not prefetched');
    assert.equal(window.document.getElementById('submitBtn').style.display, 'inline-block');
    dom.window.close();
});

test('entry keeps a working fallback contact link when the admin number cannot be loaded', async () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'entry.html'), 'utf8');
    const dom = new JSDOM(html, {
        url: 'https://owlwatcher.test/entry.html?society=Aangan',
        runScripts: 'outside-only',
        pretendToBeVisual: true
    });
    const { window } = dom;
    window.OWL_API_BASE = 'https://api.test/api';
    window.localStorage.setItem('mockDeviceId', 'fallback-device');
    window.Device = { getId: async () => ({ identifier: 'fallback-device' }) };
    window.fetch = async (url) => {
        const parsed = new URL(String(url), window.location.href);
        if (parsed.pathname.endsWith('/auth/token')) return { ok: true, json: async () => ({ token: 't' }) };
        if (parsed.pathname.endsWith('/admin-contact')) return { ok: true, json: async () => ({ societyId: 'aangan', society: 'Aangan', phone: null }) };
        if (parsed.pathname.endsWith('/societies')) return { ok: true, json: async () => [{ id: 'aangan', name: 'Aangan', flatList: ['A-103'] }] };
        return { ok: true, json: async () => [] };
    };

    const moduleScript = [...window.document.querySelectorAll('script[type="module"]')]
        .map(script => script.textContent)
        .find(source => source.includes("document.addEventListener('DOMContentLoaded'"));
    window.eval(moduleScript.replace(/import\s*\{\s*Device\s*\}\s*from\s*['"][^'"]+['"]\s*;\s*/, ''));
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));

    const link = window.document.getElementById('adminWhatsAppLink');
    assert.equal(link.dataset.societyPhone, 'fallback', 'the page reports that it fell back');
    assert.ok(link.href.startsWith('https://wa.me/'), 'the contact button stays usable');
    assert.ok(!link.href.includes('null') && !link.href.includes('undefined'), 'no broken number is baked into the link');
    dom.window.close();
});
