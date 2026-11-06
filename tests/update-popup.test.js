const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const popupApi = require('../update-popup.js');

const ANDROID_URL = 'https://play.google.com/store/apps/details?id=com.example.owlwatcher';
const IOS_URL = 'https://apps.apple.com/in/app/owl-watcher/id1234567890';
const root = path.join(__dirname, '..');
const tick = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function policy(platform = 'android', minimumVersion = '1.2.0') {
    return {
        android: { minimumVersion, storeUrl: ANDROID_URL },
        ios: { minimumVersion, storeUrl: IOS_URL }
    };
}

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function harness(t, overrides = {}) {
    const dom = new JSDOM('<!doctype html><html><head></head><body><main><button id="app-button">Search</button><input id="query"></main></body></html>', {
        url: 'https://localhost/', pretendToBeVisual: true
    });
    const prompt = popupApi.createUpdatePrompt({
        document: dom.window.document, window: dom.window, platform: 'android',
        timeoutMs: 80, checkIntervalMs: 100000,
        loadPolicy: async () => policy(),
        getInstalledVersion: async () => '1.1.0',
        openStore: async () => {},
        ...overrides
    });
    t.after(() => { prompt.destroy(); dom.window.close(); });
    return { prompt, doc: dom.window.document, win: dom.window };
}

function mockImports(reads) {
    return async url => {
        if (url === './app.js') return { db: { name: 'existing-db' } };
        return {
            doc: (...args) => ({ path: args.slice(1).join('/') }),
            getDocFromServer: async ref => {
                assert.equal(ref.path, 'app_config/appVersion');
                return reads.shift();
            }
        };
    };
}

function nativeWindow(t, platform = 'android', version = '1.1.0') {
    const dom = new JSDOM('<!doctype html><html><head></head><body><button>App action</button></body></html>', {
        url: platform === 'ios' ? 'capacitor://localhost/' : 'https://localhost/', pretendToBeVisual: true
    });
    const events = {}, opened = [];
    dom.window.Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => platform,
        Plugins: {
            App: {
                getInfo: async () => ({ version, build: '99' }),
                addListener: async (name, callback) => { events[name] = callback; return { remove() {} }; },
                minimizeApp: async () => { events.minimized = true; }
            },
            Browser: { open: async options => { opened.push(options.url); } }
        }
    };
    t.after(() => dom.window.close());
    return { win: dom.window, events, opened };
}

test('numeric version comparison is not lexicographic', () => {
    assert.equal(popupApi.compareVersions('1.10.0', '1.9.9'), 1);
    assert.equal(popupApi.compareVersions('2.0.0', '10.0.0'), -1);
    assert.equal(popupApi.compareVersions('1.2.3', '1.2.3'), 0);
    assert.deepEqual(popupApi.parseVersion('0.0.0'), [0, 0, 0]);
});

test('invalid or unsafe versions are rejected', () => {
    for (const value of [undefined, null, 1, '', '1.2', 'v1.2.3', '1.2.3-beta', '1.2.3.4', '1.-2.3', '1.2.9007199254740992']) {
        assert.equal(popupApi.parseVersion(value), null, String(value));
    }
    assert.throws(() => popupApi.compareVersions('bad', '1.0.0'));
});

test('older versions offer an update; equal and newer versions do not', () => {
    for (const platform of ['android', 'ios']) {
        const config = popupApi.validatePolicy(policy(platform, '1.10.0'), platform);
        assert.equal(popupApi.evaluateVersion(config, '1.9.9').status, 'available');
        assert.equal(popupApi.evaluateVersion(config, '1.10.0').status, 'current');
        assert.equal(popupApi.evaluateVersion(config, '2.0.0').status, 'current');
        assert.throws(() => popupApi.evaluateVersion(config, undefined));
    }
});

test('store links must be HTTPS official links for the correct platform', () => {
    assert.equal(popupApi.validStoreUrl(ANDROID_URL, 'android'), true);
    assert.equal(popupApi.validStoreUrl(IOS_URL, 'ios'), true);
    for (const url of ['', 'javascript:alert(1)', 'http://play.google.com/store/apps/details?id=com.example.app',
        'https://play.google.com.evil.example/store/apps/details?id=com.example.app',
        'https://user@play.google.com/store/apps/details?id=com.example.app',
        'https://play.google.com/store/apps/details?id=bad', IOS_URL]) {
        assert.equal(popupApi.validStoreUrl(url, 'android'), false, url);
    }
    assert.equal(popupApi.validStoreUrl(ANDROID_URL, 'ios'), false);
    assert.equal(popupApi.validStoreUrl('https://apps.apple.com.evil.example/app/id123', 'ios'), false);
});

test('malformed Firestore policies fail validation', () => {
    for (const data of [null, {}, { android: {} }, { android: { minimumVersion: 120, storeUrl: ANDROID_URL } },
        { android: { minimumVersion: '1.2.0', storeUrl: '' } },
        { ...policy(), message: '<img src=x onerror=alert(1)>'.repeat(30) }]) {
        assert.throws(() => popupApi.validatePolicy(data, 'android'));
    }
    assert.throws(() => popupApi.validatePolicy(policy(), 'unknown'));
    assert.throws(() => popupApi.validatePolicy({ ...policy(), message: 42 }, 'android'));
});

test('only native Capacitor platforms activate the prompt', () => {
    assert.equal(popupApi.getNativePlatform({ location: { protocol: 'https:' } }), null);
    assert.equal(popupApi.getNativePlatform({ location: { protocol: 'http:' }, Capacitor: { isNativePlatform: () => false } }), null);
    assert.equal(popupApi.getNativePlatform({ location: { protocol: 'https:' }, Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } }), 'android');
    assert.equal(popupApi.getNativePlatform({ location: { protocol: 'capacitor:' }, Capacitor: { getPlatform: () => 'ios' } }), 'ios');
    assert.equal(popupApi.getNativePlatform({ location: { protocol: 'capacitor:' } }), 'unknown');
});

test('checking never blocks the app; an outdated version then shows a dismissible popup', async t => {
    const pending = deferred();
    const { prompt, doc } = harness(t, { loadPolicy: () => pending.promise });
    const starting = prompt.start();
    assert.equal(prompt.getState(), 'checking');
    assert.equal(prompt.isVisible(), false);
    assert.ok(!doc.getElementById('owl-update-popup') || doc.getElementById('owl-update-popup').hidden);
    let clicked = 0;
    doc.getElementById('app-button').addEventListener('click', () => clicked++);
    doc.getElementById('app-button').click();
    assert.equal(clicked, 1);
    assert.equal(doc.querySelector('main').hasAttribute('inert'), false);
    pending.resolve(policy());
    assert.equal(await starting, 'available');
    assert.equal(prompt.isVisible(), true);
    assert.equal(doc.getElementById('owl-update-title').textContent, 'Update available');
    assert.equal(doc.querySelector('.owl-update-store').textContent, 'Update on Google Play');
    assert.equal(doc.querySelector('.owl-update-later').textContent, 'Later');
    assert.match(doc.querySelector('.owl-update-versions').textContent, /1\.1\.0.*1\.2\.0/);
});

test('Later closes the popup and restores normal app interaction', async t => {
    const { prompt, doc } = harness(t);
    await prompt.start();
    let clicked = 0;
    doc.getElementById('app-button').addEventListener('click', () => clicked++);
    doc.querySelector('.owl-update-later').click();
    assert.equal(prompt.isVisible(), false);
    assert.equal(prompt.getState(), 'dismissed');
    assert.equal(doc.getElementById('owl-update-popup').hidden, true);
    assert.equal(doc.querySelector('main').hasAttribute('inert'), false);
    assert.equal(doc.querySelector('main').hasAttribute('aria-hidden'), false);
    doc.getElementById('app-button').click();
    assert.equal(clicked, 1);
});

test('Later suppresses the same offer during the session but a newer offer appears', async t => {
    let minimum = '1.2.0';
    const { prompt, win } = harness(t, { loadPolicy: async () => policy('android', minimum) });
    await prompt.start();
    prompt.dismiss();
    assert.equal(await prompt.check(), 'dismissed');
    assert.equal(prompt.isVisible(), false);
    win.dispatchEvent(new win.Event('focus'));
    assert.equal(await prompt.check(), 'dismissed');
    minimum = '1.3.0';
    assert.equal(await prompt.check(), 'available');
    assert.equal(prompt.isVisible(), true);
});

test('dismissal does not use permanent localStorage', async t => {
    const { prompt, win } = harness(t);
    await prompt.start();
    prompt.dismiss();
    assert.ok(win.sessionStorage.getItem('owl-update-popup:dismissed:android'));
    assert.equal(win.localStorage.length, 0);
    win.sessionStorage.clear();
    const fresh = popupApi.createUpdatePrompt({
        document: win.document, window: win, platform: 'android', checkIntervalMs: 100000,
        loadPolicy: async () => policy(), getInstalledVersion: async () => '1.1.0', openStore: async () => {}
    });
    assert.equal(await fresh.start(), 'available');
    fresh.destroy();
});

test('storage denial still allows Later without breaking the app', async t => {
    const { prompt, win } = harness(t);
    Object.defineProperty(win, 'sessionStorage', { get() { throw new Error('denied'); } });
    await prompt.start();
    prompt.dismiss();
    assert.equal(await prompt.check(), 'dismissed');
    assert.equal(prompt.isVisible(), false);
});

test('close button, Escape and backdrop all dismiss the popup', async t => {
    const { prompt, doc } = harness(t);
    await prompt.start();
    doc.querySelector('.owl-update-close').click();
    assert.equal(prompt.isVisible(), false);
    assert.equal(await prompt.check(), 'dismissed');

    const second = harness(t, { platform: 'ios', loadPolicy: async () => policy('ios'), getInstalledVersion: async () => '1.0.0' });
    await second.prompt.start();
    second.doc.dispatchEvent(new second.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(second.prompt.isVisible(), false);

    const third = harness(t);
    await third.prompt.start();
    third.doc.getElementById('owl-update-popup').click();
    assert.equal(third.prompt.isVisible(), false);
});

test('current and newer versions never show the popup', async t => {
    for (const version of ['1.2.0', '2.0.0']) {
        const { prompt, doc } = harness(t, { getInstalledVersion: async () => version });
        assert.equal(await prompt.start(), 'current');
        assert.equal(prompt.isVisible(), false);
        assert.ok(!doc.getElementById('owl-update-popup') || doc.getElementById('owl-update-popup').hidden);
    }
});

test('network, timeout, plugin and policy errors fail open without an error popup', async t => {
    const cases = [
        { loadPolicy: async () => { throw new Error('offline'); } },
        { timeoutMs: 10, loadPolicy: () => new Promise(() => {}) },
        { getInstalledVersion: async () => { throw new Error('App plugin missing'); } },
        { loadPolicy: async () => ({ android: { minimumVersion: '1.0.0', storeUrl: 'javascript:alert(1)' } }) }
    ];
    for (const overrides of cases) {
        const { prompt, doc } = harness(t, overrides);
        assert.equal(await prompt.start(), 'unavailable');
        assert.equal(prompt.isVisible(), false);
        assert.ok(!doc.getElementById('owl-update-popup') || doc.getElementById('owl-update-popup').hidden);
        let clicked = 0;
        doc.getElementById('app-button').addEventListener('click', () => clicked++);
        doc.getElementById('app-button').click();
        assert.equal(clicked, 1);
    }
});

test('resume rechecks and hides the popup after the app becomes current', async t => {
    let version = '1.1.0', reads = 0;
    const { prompt, win } = harness(t, {
        getInstalledVersion: async () => version,
        loadPolicy: async () => { reads++; return policy(); }
    });
    await prompt.start();
    assert.equal(prompt.isVisible(), true);
    version = '1.2.0';
    win.dispatchEvent(new win.Event('focus'));
    assert.equal(await prompt.check(), 'current');
    assert.equal(prompt.isVisible(), false);
    assert.equal(reads, 2);
});

test('periodic check can offer an update without blocking the app first', async t => {
    let minimum = '1.1.0';
    const { prompt } = harness(t, { checkIntervalMs: 10, loadPolicy: async () => policy('android', minimum) });
    await prompt.start();
    assert.equal(prompt.isVisible(), false);
    minimum = '1.2.0';
    for (let i = 0; i < 50 && !prompt.isVisible(); i++) await wait(5);
    assert.equal(prompt.isVisible(), true);
    assert.equal(prompt.getState(), 'available');
});

test('store action opens the platform URL and leaves Later available', async t => {
    const urls = [];
    const { prompt, doc } = harness(t, { openStore: async url => { urls.push(url); } });
    await prompt.start();
    doc.querySelector('.owl-update-store').click();
    await tick();
    assert.deepEqual(urls, [ANDROID_URL]);
    assert.equal(prompt.isVisible(), true);
    doc.querySelector('.owl-update-later').click();
    assert.equal(prompt.isVisible(), false);
});

test('failed store navigation reports inline and still allows Later', async t => {
    const { prompt, doc } = harness(t, { openStore: async () => { throw new Error('blocked'); } });
    await prompt.start();
    await prompt.openStore();
    assert.match(doc.querySelector('.owl-update-status').textContent, /Could not open the store/);
    assert.equal(doc.querySelector('.owl-update-store').disabled, false);
    doc.querySelector('.owl-update-later').click();
    assert.equal(prompt.isVisible(), false);
});

test('Tab and Shift+Tab stay inside the open popup', async t => {
    const { prompt, doc } = harness(t);
    await prompt.start();
    const close = doc.querySelector('.owl-update-close');
    const later = doc.querySelector('.owl-update-later');
    const store = doc.querySelector('.owl-update-store');
    later.focus();
    later.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.ok(doc.activeElement === close);
    close.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    assert.ok(doc.activeElement === later);
    store.focus();
    assert.ok(doc.getElementById('owl-update-popup').contains(doc.activeElement));
});

test('remote update messages are plain text, not HTML', async t => {
    const config = { ...policy(), message: '<img src=x onerror=alert(1)>' };
    const { prompt, doc } = harness(t, { loadPolicy: async () => config });
    await prompt.start();
    assert.equal(doc.getElementById('owl-update-message').textContent, config.message);
    assert.equal(doc.querySelector('#owl-update-message img'), null);
});

test('result before body exists mounts when the parser creates body', async t => {
    const dom = new JSDOM('<!doctype html><html><head></head></html>');
    dom.window.document.body.remove();
    const prompt = popupApi.createUpdatePrompt({
        document: dom.window.document, window: dom.window, platform: 'ios',
        loadPolicy: async () => policy('ios'), getInstalledVersion: async () => '1.0.0', checkIntervalMs: 100000
    });
    t.after(() => { prompt.destroy(); dom.window.close(); });
    assert.equal(await prompt.start(), 'available');
    const body = dom.window.document.createElement('body');
    dom.window.document.documentElement.appendChild(body);
    await tick();
    assert.equal(body.querySelector('#owl-update-popup').hidden, false);
    assert.equal(body.querySelector('.owl-update-store').textContent, 'Update on the App Store');
    prompt.dismiss();
    assert.equal(body.querySelector('#owl-update-popup').hidden, true);
});

test('Firestore loader reads the configured document from the server on every check', async () => {
    let reads = 0, imports = 0;
    const load = popupApi.createFirestorePolicyLoader(async url => {
        imports++;
        if (url === './app.js') return { db: {} };
        return {
            doc: (...args) => { assert.deepEqual(args.slice(1), ['app_config', 'appVersion']); return 'version-ref'; },
            getDocFromServer: async ref => { assert.equal(ref, 'version-ref'); reads++; return { exists: () => true, data: () => policy() }; }
        };
    });
    await load(); await load();
    assert.equal(reads, 2);
    assert.equal(imports, 2);
    const missing = popupApi.createFirestorePolicyLoader(mockImports([{ exists: () => false }]));
    await assert.rejects(missing(), /not been configured/);
});

test('Firestore module import failure can be retried', async () => {
    let attempts = 0;
    const load = popupApi.createFirestorePolicyLoader(async url => {
        if (url === './app.js' && ++attempts === 1) throw new Error('CDN unavailable');
        if (url === './app.js') return { db: {} };
        return { doc: () => ({}), getDocFromServer: async () => ({ exists: () => true, data: () => policy() }) };
    });
    await assert.rejects(load(), /CDN unavailable/);
    assert.deepEqual(await load(), policy());
    assert.equal(attempts, 2);
});

test('native bootstrap wires iOS store and foreground checks', async t => {
    const { win, events, opened } = nativeWindow(t, 'ios', '1.0.0');
    let reads = 0;
    const prompt = popupApi.startNativeUpdatePrompt(win, mockImports([
        { exists: () => true, data: () => { reads++; return policy('ios'); } },
        { exists: () => true, data: () => { reads++; return policy('ios'); } }
    ]));
    t.after(() => prompt.destroy());
    assert.equal(await prompt.check(), 'available');
    await events.appStateChange({ isActive: true });
    await prompt.check();
    assert.equal(reads, 2);
    await prompt.openStore();
    assert.deepEqual(opened, [IOS_URL]);
    prompt.dismiss();
    assert.equal(prompt.isVisible(), false);
});

test('Android Back dismisses an open update popup', async t => {
    const { win, events } = nativeWindow(t);
    const prompt = popupApi.startNativeUpdatePrompt(win, mockImports([{ exists: () => true, data: () => policy() }]));
    t.after(() => prompt.destroy());
    await prompt.check();
    await tick();
    assert.equal(prompt.isVisible(), true);
    events.backButton({ canGoBack: true });
    assert.equal(prompt.isVisible(), false);
    assert.equal(prompt.getState(), 'dismissed');
});

test('website bootstrap does not import Firebase or insert a popup', t => {
    const dom = new JSDOM('<!doctype html><body><button>Website</button></body>', { url: 'https://owlwatcher.tech/' });
    t.after(() => dom.window.close());
    let imported = false;
    const prompt = popupApi.startNativeUpdatePrompt(dom.window, () => { imported = true; });
    assert.equal(prompt, null);
    assert.equal(imported, false);
    assert.equal(dom.window.document.getElementById('owl-update-popup'), null);
});

test('every HTML page loads the bridge and optional prompt in head before app logic', () => {
    const pages = fs.readdirSync(root).filter(name => name.endsWith('.html'));
    assert.equal(pages.length, 11);
    for (const name of pages) {
        const html = fs.readFileSync(path.join(root, name), 'utf8');
        const head = html.slice(0, html.indexOf('</head>'));
        assert.equal((html.match(/src="capacitor\.js"/g) || []).length, 1, name);
        assert.equal((html.match(/src="update-popup\.js"/g) || []).length, 1, name);
        assert.equal(html.includes('force-update.js'), false, name);
        assert.ok(head.indexOf('src="capacitor.js"') < head.indexOf('src="update-popup.js"'), name);
        assert.ok(head.indexOf('src="update-popup.js"') < html.indexOf('<body'), name);
    }
});

test('example policy is valid once real store URLs are supplied', () => {
    const example = JSON.parse(fs.readFileSync(path.join(root, 'firebase/app-version.example.json'), 'utf8'));
    assert.throws(() => popupApi.validatePolicy(example, 'android'), /storeUrl/);
    example.android.storeUrl = ANDROID_URL;
    example.ios.storeUrl = IOS_URL;
    assert.equal(popupApi.validatePolicy(example, 'android').minimumVersion, '1.0.0');
    assert.equal(popupApi.validatePolicy(example, 'ios').minimumVersion, '1.0.0');
});

test('Firestore loader waits for native App Check readiness before reading the policy', async () => {
    const ready = deferred();
    let reads = 0;
    const load = popupApi.createFirestorePolicyLoader(async url => {
        if (url === './app.js') return { db: {}, appCheckReady: ready.promise };
        return {
            doc: (...args) => ({ path: args.slice(1).join('/') }),
            getDocFromServer: async () => { reads += 1; return { exists: () => true, data: () => policy() }; }
        };
    });
    const pending = load();
    await tick();
    assert.equal(reads, 0);
    ready.resolve(true);
    assert.deepEqual(await pending, policy());
    assert.equal(reads, 1);
});

test('fail-open warning includes Firebase error codes', async t => {
    const warnings = [];
    const { prompt, win } = harness(t, {
        loadPolicy: async () => { throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }); }
    });
    win.console.warn = (...args) => warnings.push(args.map(String).join(' '));
    assert.equal(await prompt.check(), 'unavailable');
    assert.ok(warnings.some(line => /permission-denied: Missing or insufficient permissions\./.test(line)));
});

test('policy loader prefers the backend API and skips Firestore entirely', async () => {
    let firestoreCalls = 0;
    const win = { fetch: async url => {
        assert.equal(url, 'https://api.owlwatcher.tech/api/app-version');
        return { ok: true, json: async () => policy('android', '2.8.0') };
    }, console: { warn() {} } };
    const load = popupApi.createPolicyLoader(win, async () => { firestoreCalls += 1; return {}; });
    assert.deepEqual(await load(), policy('android', '2.8.0'));
    assert.equal(firestoreCalls, 0, 'API success must not touch Firestore or App Check');
});

test('policy loader falls back to Firestore when the API fails', async () => {
    const warnings = [];
    const win = { fetch: async () => ({ ok: false, status: 503 }), console: { warn: (...a) => warnings.push(a.join(' ')) } };
    const load = popupApi.createPolicyLoader(win, mockImports([{ exists: () => true, data: () => policy() }]));
    assert.deepEqual(await load(), policy());
    assert.ok(warnings.some(w => /Version API unavailable/.test(w)));
});

test('policy loader falls back when fetch rejects or is unavailable', async () => {
    const rejecting = { fetch: async () => { throw new Error('offline'); }, console: { warn() {} } };
    assert.deepEqual(await popupApi.createPolicyLoader(rejecting, mockImports([{ exists: () => true, data: () => policy() }]))(), policy());
    const noFetch = { console: { warn() {} } };
    assert.deepEqual(await popupApi.createPolicyLoader(noFetch, mockImports([{ exists: () => true, data: () => policy() }]))(), policy());
});
