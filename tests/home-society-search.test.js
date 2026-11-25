'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const delay = () => new Promise(resolve => setTimeout(resolve, 15));
const enrollmentMessage = 'Request your society/group to enroll in Owl Watcher Vehicle Management';

function setup(verifyResponse) {
    const dom = new JSDOM(html, { url: 'https://owl.test/index.html', runScripts: 'outside-only' });
    const { window } = dom;
    const calls = [];
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: (target, key) => target[key] || (() => {}), set: (target, key, value) => { target[key] = value; return true; } });
    window.fetch = async (url, options = {}) => {
        const parsed = new URL(url);
        calls.push({ parsed, options });
        if (parsed.pathname.endsWith('/societies/verify')) {
            if (verifyResponse instanceof Error) throw verifyResponse;
            return { ok: verifyResponse.status === 200, status: verifyResponse.status, json: async () => verifyResponse.body || {} };
        }
        if (parsed.pathname.endsWith('/ads/global') || parsed.pathname.includes('/ads/local/')) return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
        if (parsed.pathname.endsWith('/auth/token')) return { ok: false, status: 401, json: async () => ({}) };
        return { ok: false, status: 404, json: async () => ({}) };
    };
    window.eval(script);
    return { window, calls, async submit(value) {
        window.document.getElementById('societyInput').value = value;
        window.document.getElementById('verifyBtn').click();
        await delay();
    } };
}

test('unknown society opens the requested enrollment message without changing the search screen', async () => {
    const page = setup({ status: 404 });
    await page.submit('  Unknown / Group  ');
    assert.equal(page.window.document.getElementById('resultModal').style.display, 'block');
    assert.equal(page.window.document.getElementById('result').textContent, enrollmentMessage);
    assert.notEqual(page.window.document.getElementById('society-verification').style.display, 'none');
    assert.equal(page.window.localStorage.getItem('savedSocietyName'), null);
    const request = page.calls.find(call => call.parsed.pathname.endsWith('/societies/verify'));
    assert.equal(request.parsed.searchParams.get('name'), 'Unknown / Group');
    page.window.close();
});

test('connection failures and server errors are not presented as missing societies', async () => {
    for (const response of [{ status: 503 }, new Error('Network down')]) {
        const page = setup(response);
        await page.submit('Aangan');
        const result = page.window.document.getElementById('result').textContent;
        assert.match(result, /Error connecting to server/);
        assert.notEqual(result, enrollmentMessage);
        page.window.close();
    }
});

test('empty input still asks for a name and verified societies enter the dashboard', async () => {
    const empty = setup({ status: 404 });
    await empty.submit('   ');
    assert.match(empty.window.document.getElementById('result').textContent, /Please enter a society name/);
    assert.equal(empty.calls.some(call => call.parsed.pathname.endsWith('/societies/verify')), false);
    empty.window.close();

    const found = setup({ status: 200, body: { id: 'aangan', name: 'Aangan' } });
    await found.submit('aangan');
    assert.equal(found.window.localStorage.getItem('savedSocietyName'), 'Aangan');
    assert.equal(found.window.document.getElementById('society-verification').style.display, 'none');
    assert.equal(found.window.document.getElementById('vehicle-search').style.display, 'block');
    found.window.close();
});
