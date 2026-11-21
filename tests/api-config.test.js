const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'api-config.js'), 'utf8');

const FIREBASE = 'https://us-central1-finder-owl.cloudfunctions.net/api';
const MACBOOK = 'https://owl-mac.example.com/api';

// The pure helpers read the same config the browser does, from globalThis.
globalThis.OWL_API_CONFIG = { primary: FIREBASE, local: MACBOOK, fallbacks: [] };

const { apiPath, validBase, urlFor, LEGACY_BASES } = require('../api-config.js');

function response(status, { headers = {}, body = '' } = {}) {
    const lowered = Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
    );
    return {
        status,
        headers: { get: name => lowered[name.toLowerCase()] ?? null },
        text: async () => body
    };
}

function harness({ config = {}, url = 'https://owlwatcher.tech/', fetchImpl } = {}) {
    const calls = [];
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
        url,
        runScripts: 'dangerously',
        pretendToBeVisual: true
    });
    const { window } = dom;
    window.Headers = Headers;
    window.fetch = (input, init) => {
        calls.push({ url: typeof input === 'string' ? input : input.url, init });
        return fetchImpl(input, init);
    };
    window.OWL_API_CONFIG = { primary: FIREBASE, local: MACBOOK, fallbacks: [], ...config };
    window.eval(source);
    return { window, calls, api: window.OWL_API };
}

test('validBase accepts http(s) bases and rejects credentials and other schemes', () => {
    assert.equal(validBase(FIREBASE + '/'), FIREBASE);
    assert.equal(validBase('http://192.168.1.20:3000/api'), 'http://192.168.1.20:3000/api');
    assert.equal(validBase('https://user:pass@example.com/api'), null);
    assert.equal(validBase('ftp://example.com/api'), null);
    assert.equal(validBase('not a url'), null);
    assert.equal(validBase(''), null);
    assert.equal(validBase(null), null);
});

test('apiPath recognises legacy and configured bases and ignores other hosts', () => {
    assert.equal(apiPath(LEGACY_BASES[0] + '/config'), '/config');
    assert.equal(apiPath(FIREBASE + '/vehicles'), '/vehicles');
    assert.equal(apiPath(MACBOOK), '/');
    assert.equal(apiPath('https://www.gstatic.com/firebasejs/10.0.0/firebase-app.js'), null);
    assert.equal(apiPath('https://owlwatcher.tech/index.html'), null);
    assert.equal(apiPath(''), null);
});

test('urlFor joins a base and a path', () => {
    assert.equal(urlFor(FIREBASE, '/config'), FIREBASE + '/config');
    assert.equal(urlFor(FIREBASE, 'config'), FIREBASE + '/config');
    assert.equal(urlFor(FIREBASE, '/'), FIREBASE + '/');
});

test('API requests are rewritten to the configured primary base', async () => {
    const { window, calls } = harness({ fetchImpl: async () => response(200) });
    await window.fetch(LEGACY_BASES[0] + '/config');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, FIREBASE + '/config');
});

test('non-API requests pass through untouched', async () => {
    const { window, calls } = harness({ fetchImpl: async () => response(200) });
    await window.fetch('https://www.gstatic.com/firebasejs/10.0.0/firebase-app.js');
    assert.equal(calls[0].url, 'https://www.gstatic.com/firebasejs/10.0.0/firebase-app.js');
});

test('a drained Firebase response fails over to the MacBook base', async () => {
    const { window, calls } = harness({
        fetchImpl: async input => {
            const url = typeof input === 'string' ? input : input.url;
            if (url.startsWith(FIREBASE)) {
                return response(503, { headers: { 'x-owl-drain': '1' } });
            }
            return response(200, { body: '{"ok":true}' });
        }
    });
    const res = await window.fetch(LEGACY_BASES[0] + '/config');
    assert.equal(res.status, 200);
    assert.deepEqual(calls.map(call => call.url), [FIREBASE + '/config', MACBOOK + '/config']);
});

test('a network failure fails over to the next base', async () => {
    const { window, calls } = harness({
        fetchImpl: async input => {
            const url = typeof input === 'string' ? input : input.url;
            if (url.startsWith(FIREBASE)) throw new TypeError('Failed to fetch');
            return response(200);
        }
    });
    const res = await window.fetch(LEGACY_BASES[0] + '/vehicles');
    assert.equal(res.status, 200);
    assert.equal(calls.length, 2);
});

test('a plain 503 without the drain header also fails over', async () => {
    const { window } = harness({
        fetchImpl: async input => {
            const url = typeof input === 'string' ? input : input.url;
            return url.startsWith(FIREBASE) ? response(503) : response(200);
        }
    });
    const res = await window.fetch(LEGACY_BASES[0] + '/config');
    assert.equal(res.status, 200);
});

test('when every base fails the last response is returned, not thrown', async () => {
    const { window } = harness({
        fetchImpl: async () => response(503, { headers: { 'x-owl-drain': '1' } })
    });
    const res = await window.fetch(LEGACY_BASES[0] + '/config');
    assert.equal(res.status, 503);
});

test('when every base throws, the error propagates', async () => {
    const { window } = harness({
        fetchImpl: async () => { throw new TypeError('Failed to fetch'); }
    });
    await assert.rejects(window.fetch(LEGACY_BASES[0] + '/config'), TypeError);
});

test('a drained base is skipped until its cooldown expires', async () => {
    const { window, calls, api } = harness({
        fetchImpl: async input => {
            const url = typeof input === 'string' ? input : input.url;
            return url.startsWith(FIREBASE) ? response(503, { headers: { 'x-owl-drain': '1' } }) : response(200);
        }
    });
    await window.fetch(LEGACY_BASES[0] + '/config');
    assert.equal(api.base(), MACBOOK);
    calls.length = 0;
    await window.fetch(LEGACY_BASES[0] + '/vehicles');
    assert.deepEqual(calls.map(call => call.url), [MACBOOK + '/vehicles']);
});

test('reset() clears the remembered base so Firebase is tried again', async () => {
    const { window, calls, api } = harness({
        fetchImpl: async input => {
            const url = typeof input === 'string' ? input : input.url;
            return url.startsWith(FIREBASE) ? response(503, { headers: { 'x-owl-drain': '1' } }) : response(200);
        }
    });
    await window.fetch(LEGACY_BASES[0] + '/config');
    assert.equal(api.base(), MACBOOK);
    api.reset();
    assert.equal(api.base(), FIREBASE);
    calls.length = 0;
    await window.fetch(LEGACY_BASES[0] + '/config');
    assert.equal(calls[0].url, FIREBASE + '/config');
});

test('a non-replayable body is only attempted once', async () => {
    const { window, calls } = harness({
        fetchImpl: async input => {
            const url = typeof input === 'string' ? input : input.url;
            return url.startsWith(FIREBASE) ? response(503, { headers: { 'x-owl-drain': '1' } }) : response(200);
        }
    });
    await window.fetch(LEGACY_BASES[0] + '/vehicles', {
        method: 'POST',
        body: { societyName: 'Aangan' }
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, FIREBASE + '/vehicles');
});

test('?api= overrides the base for that page load only', async () => {
    const override = MACBOOK;
    const { window, calls, api } = harness({
        url: 'https://owlwatcher.tech/?api=' + encodeURIComponent(override),
        fetchImpl: async () => response(200)
    });
    assert.equal(api.base(), override);
    await window.fetch(LEGACY_BASES[0] + '/config');
    assert.equal(calls[0].url, override + '/config');
});

test('an invalid ?api= value is ignored', () => {
    const { api } = harness({
        url: 'https://owlwatcher.tech/?api=javascript:alert(1)',
        fetchImpl: async () => response(200)
    });
    assert.equal(api.base(), FIREBASE);
});

test('status() reports bases, the active base and drained markers', async () => {
    const { window, api } = harness({
        fetchImpl: async input => {
            const url = typeof input === 'string' ? input : input.url;
            return url.startsWith(FIREBASE) ? response(503, { headers: { 'x-owl-drain': '1' } }) : response(200);
        }
    });
    await window.fetch(LEGACY_BASES[0] + '/config');
    const status = api.status();
    // Spread into this realm's Array: jsdom arrays fail deepStrictEqual.
    assert.deepEqual([...status.bases], [FIREBASE, MACBOOK]);
    assert.equal(status.active, MACBOOK);
    assert.ok(status.drained[FIREBASE] > Date.now());
});

test('an empty local base leaves a single candidate', () => {
    const { api } = harness({
        config: { local: '' },
        fetchImpl: async () => response(200)
    });
    assert.deepEqual([...api.bases()], [FIREBASE]);
});


test('an untrusted query endpoint cannot receive credentials', async () => {
    const { window, calls } = harness({ url: 'https://owlwatcher.tech/?api=https://evil.example/api', fetchImpl: async () => response(200) });
    await window.fetch(FIREBASE + '/config', { headers: { Authorization: 'Bearer private' } });
    assert.equal(calls[0].url, FIREBASE + '/config');
});

test('network errors on mutations are NOT retried (avoid duplicate writes)', async () => {
    const { window, calls } = harness({ fetchImpl: async () => { throw new Error('connection lost'); } });
    await assert.rejects(window.fetch(FIREBASE + '/contest/spin', { method: 'POST', body: '{}' }));
    assert.equal(calls.length, 1);
});

test('explicit pre-handler drain safely retries a JSON POST', async () => {
    const { window, calls } = harness({ fetchImpl: async input => input.startsWith(FIREBASE)
        ? response(503, { headers: { 'X-Owl-Drain': '1', 'Retry-After': '3600' } }) : response(200) });
    const res = await window.fetch(FIREBASE + '/vehicles', { method: 'POST', body: '{}' });
    assert.equal(res.status, 200);
    assert.equal(calls.length, 2);
    assert.ok(window.OWL_API.status().drained[FIREBASE] >= Date.now() + 3590000);
});


test('configured ngrok calls bypass HTML warning without losing auth or content headers', async () => {
    const base='https://owl-test.ngrok-free.dev/api';
    const {window,calls}=harness({config:{primary:base,local:''},fetchImpl:async()=>response(200)});
    await window.fetch(base+'/ads/global',{headers:{Authorization:'Bearer private','Content-Type':'application/json'}});
    const headers=calls[0].init.headers;
    assert.equal(headers.get('ngrok-skip-browser-warning'),'true');
    assert.equal(headers.get('Authorization'),'Bearer private');
    assert.equal(headers.get('Content-Type'),'application/json');
});

test('non-API ngrok fetch is not rewritten and receives no injected headers', async () => {
    const {window,calls}=harness({fetchImpl:async()=>response(200)});
    await window.fetch('https://unrelated.ngrok-free.dev/somewhere');
    assert.equal(calls[0].init,undefined);
});
