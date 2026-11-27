const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'api-config.js'), 'utf8');

const FIREBASE = 'https://us-central1-finder-owl.cloudfunctions.net/api';
const MACBOOK = 'https://owl-mac.example.com/api';
// The permanent public API base: a custom domain on the Function, so the
// frontend never changes when the backend moves to another cloud provider.
const DOMAIN = 'https://api.owlwatcher.tech/api';

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

function harness({ config = {}, url = 'https://owlwatcher.tech/', fetchImpl, initialStorage = {}, publishedConfig = false } = {}) {
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
    for (const [key, value] of Object.entries(initialStorage)) window.localStorage.setItem(key, value);
    if (publishedConfig) window.eval(fs.readFileSync(path.join(__dirname, '..', 'api-env.js'), 'utf8'));
    else window.OWL_API_CONFIG = { primary: FIREBASE, local: MACBOOK, fallbacks: [], ...config };
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

test('the published frontend config is fixed to the permanent custom domain', () => {
    const envSource = fs.readFileSync(path.join(__dirname, '..', 'api-env.js'), 'utf8');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously' });
    dom.window.eval(envSource);
    const config = dom.window.OWL_API_CONFIG;
    assert.equal(config.primary, 'https://api.owlwatcher.tech/api', 'the frontend URL never changes when the backend moves');
    assert.ok((config.fallbacks || []).includes('https://us-central1-finder-owl.cloudfunctions.net/api'), 'the Firebase function stays a failover during a backend move');
    dom.window.close();
});

test('a page whose config is invalid or missing still targets the permanent domain', async () => {
    const { window, calls } = harness({ config: { primary: 'not a url', fallbacks: [] }, fetchImpl: async () => response(200) });
    await window.fetch('https://api.owlwatcher.tech/api/config');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.owlwatcher.tech/api/config', 'the domain is the last-resort primary, not the provider URL');
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

const PILOT = 'https://unloving-limit-ferry.ngrok-free.dev/api';
const PILOT_PAGE = 'https://prsd503.github.io/gor/index.html?api=' + encodeURIComponent(PILOT);

function routingStorage(window) {
    return Object.fromEntries(['owl:api:active', 'owl:api:drained'].map(key => [key, window.localStorage.getItem(key)]));
}

test('published config is fixed to the permanent domain with the function as failover', async () => {
    const {window,api,calls}=harness({publishedConfig:true,fetchImpl:async()=>response(200)});
    assert.equal(window.OWL_API_CONFIG.primary,DOMAIN);
    assert.equal(window.OWL_API_CONFIG.local,'');
    assert.deepEqual([...window.OWL_API_CONFIG.fallbacks],[FIREBASE]);
    assert.deepEqual([...api.status().testBases],[PILOT]);
    assert.deepEqual([...api.bases()],[DOMAIN,FIREBASE]);
    await window.fetch(DOMAIN+'/ads/global');
    assert.equal(calls[0].url,DOMAIN+'/ads/global');
});

test('normal visitors never fail over to the test-only tunnel, even on drain', async () => {
    const {window,calls}=harness({publishedConfig:true,fetchImpl:async()=>response(503,{headers:{'x-owl-drain':'1'}})});
    assert.equal((await window.fetch(DOMAIN+'/ads/global')).status,503);
    assert.deepEqual(calls.map(call=>call.url),[DOMAIN+'/ads/global',FIREBASE+'/ads/global']);
    assert.ok(calls.every(call=>!call.url.startsWith(PILOT)),'the test-only tunnel is never a failover candidate');
});

test('verified pilot link selects only the tunnel and injects ngrok bypass header', async () => {
    const {window,api,calls}=harness({publishedConfig:true,url:PILOT_PAGE,fetchImpl:async()=>response(200)});
    assert.equal(api.base(),PILOT);
    assert.equal(window.OWL_API_BASE,PILOT);
    assert.deepEqual([...api.bases()],[PILOT]);
    await window.fetch(FIREBASE+'/ads/global');
    assert.equal(calls[0].url,PILOT+'/ads/global');
    assert.equal(calls[0].init.headers.get('ngrok-skip-browser-warning'),'true');
});

test('pilot override wins over remembered primary and drain state without modifying either', async () => {
    const initialStorage={
        'owl:api:active':JSON.stringify({base:FIREBASE,at:Date.now()}),
        'owl:api:drained':JSON.stringify({[PILOT]:Date.now()+3600000})
    };
    const {window,api,calls}=harness({publishedConfig:true,url:PILOT_PAGE,initialStorage,fetchImpl:async()=>response(200)});
    const before=routingStorage(window);
    assert.equal(api.base(),PILOT);
    await window.fetch(FIREBASE+'/ads/global');
    assert.equal(calls[0].url,PILOT+'/ads/global');
    assert.deepEqual(routingStorage(window),before);
});

test('successful pilot selection is not remembered for the next ordinary page load', async () => {
    const pilot=harness({publishedConfig:true,url:PILOT_PAGE,fetchImpl:async()=>response(200)});
    await pilot.window.fetch(FIREBASE+'/ads/global');
    assert.equal(pilot.window.localStorage.getItem('owl:api:active'),null);
    const normal=harness({publishedConfig:true,fetchImpl:async()=>response(200)});
    assert.equal(normal.api.base(),DOMAIN);
});

test('a stale remembered pilot cannot select it on an ordinary page without api query', () => {
    const {api}=harness({publishedConfig:true,initialStorage:{'owl:api:active':JSON.stringify({base:PILOT,at:Date.now()})},fetchImpl:async()=>response(200)});
    assert.equal(api.base(),DOMAIN);
});

test('pilot drain responses never retry GETs or writes on the primary and do not persist routing', async () => {
    for(const method of ['GET','POST']){
        const {window,calls}=harness({publishedConfig:true,url:PILOT_PAGE,fetchImpl:async()=>response(503,{headers:{'x-owl-drain':'1'}})});
        const before=routingStorage(window);
        const result=await window.fetch(FIREBASE+'/ads/global',{method,...(method==='POST'?{body:'{}'}:{})});
        assert.equal(result.status,503);
        assert.deepEqual(calls.map(call=>call.url),[PILOT+'/ads/global']);
        assert.deepEqual(routingStorage(window),before);
    }
});

test('pilot network failure never silently reads from the primary or changes storage', async () => {
    const {window,calls}=harness({publishedConfig:true,url:PILOT_PAGE,fetchImpl:async()=>{throw new Error('tunnel offline');}});
    const before=routingStorage(window);
    await assert.rejects(window.fetch(FIREBASE+'/ads/global'),/tunnel offline/);
    assert.deepEqual(calls.map(call=>call.url),[PILOT+'/ads/global']);
    assert.deepEqual(routingStorage(window),before);
});

test('restricted pilot 403 stays on the tunnel and is not retried elsewhere', async () => {
    const {window,calls}=harness({publishedConfig:true,url:PILOT_PAGE,fetchImpl:async()=>response(403)});
    assert.equal((await window.fetch(FIREBASE+'/vehicles')).status,403);
    assert.deepEqual(calls.map(call=>call.url),[PILOT+'/vehicles']);
});

test('an unconfigured ngrok hostname in a pilot link is rejected', async () => {
    const {window,api,calls}=harness({publishedConfig:true,url:'https://prsd503.github.io/gor/index.html?api=https://attacker.ngrok-free.dev/api',fetchImpl:async()=>response(200)});
    assert.equal(api.status().pageOverride,null);
    await window.fetch(FIREBASE+'/ads/global');
    assert.equal(calls[0].url,DOMAIN+'/ads/global');
});
