const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const gateApi = require('../force-update.js');

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
    const dom = new JSDOM('<!doctype html><html><head></head><body><main><button id="app-button">Search</button><input id="query"><audio></audio></main></body></html>', {
        url: 'https://localhost/', pretendToBeVisual: true
    });
    // jsdom does not implement media playback; expose pause as a no-op for the gate.
    dom.window.HTMLMediaElement.prototype.pause = function () {};
    const gate = gateApi.createGate({
        document: dom.window.document, window: dom.window, platform: 'android',
        timeoutMs: 80, checkIntervalMs: 100000,
        loadPolicy: async () => policy(),
        getInstalledVersion: async () => '1.1.0',
        openStore: async () => {},
        ...overrides
    });
    t.after(() => { gate.destroy(); dom.window.close(); });
    return { gate, doc: dom.window.document, win: dom.window };
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
    dom.window.HTMLMediaElement.prototype.pause = function () {};
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
    assert.equal(gateApi.compareVersions('1.10.0', '1.9.9'), 1);
    assert.equal(gateApi.compareVersions('2.0.0', '10.0.0'), -1);
    assert.equal(gateApi.compareVersions('1.2.3', '1.2.3'), 0);
    assert.deepEqual(gateApi.parseVersion('0.0.0'), [0, 0, 0]);
});

test('invalid or unsafe versions are rejected rather than allowed', () => {
    for (const value of [undefined, null, 1, '', '1.2', 'v1.2.3', '1.2.3-beta', '1.2.3.4', '1.-2.3', '1.2.9007199254740992']) {
        assert.equal(gateApi.parseVersion(value), null, String(value));
    }
    assert.throws(() => gateApi.compareVersions('bad', '1.0.0'));
});

test('older versions are blocked; equal and newer versions pass on both platforms', () => {
    for (const platform of ['android', 'ios']) {
        const config = gateApi.validatePolicy(policy(platform, '1.10.0'), platform);
        assert.equal(gateApi.evaluateVersion(config, '1.9.9').status, 'required');
        assert.equal(gateApi.evaluateVersion(config, '1.10.0').status, 'allowed');
        assert.equal(gateApi.evaluateVersion(config, '2.0.0').status, 'allowed');
        assert.throws(() => gateApi.evaluateVersion(config, undefined));
    }
});

test('store links must be HTTPS official links for the correct platform', () => {
    assert.equal(gateApi.validStoreUrl(ANDROID_URL, 'android'), true);
    assert.equal(gateApi.validStoreUrl(IOS_URL, 'ios'), true);
    for (const url of ['', 'javascript:alert(1)', 'http://play.google.com/store/apps/details?id=com.example.app',
        'https://play.google.com.evil.example/store/apps/details?id=com.example.app',
        'https://user@play.google.com/store/apps/details?id=com.example.app',
        'https://play.google.com/store/apps/details?id=bad', IOS_URL]) {
        assert.equal(gateApi.validStoreUrl(url, 'android'), false, url);
    }
    assert.equal(gateApi.validStoreUrl(ANDROID_URL, 'ios'), false);
    assert.equal(gateApi.validStoreUrl('https://apps.apple.com.evil.example/app/id123', 'ios'), false);
});

test('malformed Firestore policies fail validation', () => {
    for (const data of [null, {}, { android: {} }, { android: { minimumVersion: 120, storeUrl: ANDROID_URL } },
        { android: { minimumVersion: '1.2.0', storeUrl: '' } },
        { ...policy(), message: '<img src=x onerror=alert(1)>'.repeat(30) }]) {
        assert.throws(() => gateApi.validatePolicy(data, 'android'));
    }
    assert.throws(() => gateApi.validatePolicy(policy(), 'unknown'));
    assert.throws(() => gateApi.validatePolicy({ ...policy(), message: 42 }, 'android'));
});

test('only native Capacitor platforms activate the gate', () => {
    assert.equal(gateApi.getNativePlatform({ location: { protocol: 'https:' } }), null);
    assert.equal(gateApi.getNativePlatform({ location: { protocol: 'http:' }, Capacitor: { isNativePlatform: () => false } }), null);
    assert.equal(gateApi.getNativePlatform({ location: { protocol: 'https:' }, Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' } }), 'android');
    assert.equal(gateApi.getNativePlatform({ location: { protocol: 'capacitor:' }, Capacitor: { getPlatform: () => 'ios' } }), 'ios');
    assert.equal(gateApi.getNativePlatform({ location: { protocol: 'capacitor:' } }), 'unknown');
});

test('checking locks immediately and an outdated app has no continue/dismiss action', async t => {
    const pending = deferred();
    const { gate, doc } = harness(t, { loadPolicy: () => pending.promise });
    const starting = gate.start();
    assert.equal(gate.getState(), 'checking');
    assert.equal(gate.isActive(), true);
    assert.equal(doc.querySelector('.owl-update-retry').hidden, true);
    assert.equal(doc.querySelector('.owl-update-store').hidden, true);
    assert.equal(doc.querySelector('main').getAttribute('aria-hidden'), 'true');
    pending.resolve(policy());
    assert.equal(await starting, 'required');
    assert.equal(doc.getElementById('owl-update-title').textContent, 'Update required');
    assert.equal(doc.querySelector('.owl-update-store').textContent, 'Update on Google Play');
    assert.equal(doc.querySelectorAll('#owl-update-gate button').length, 2);
    assert.match(doc.querySelector('.owl-update-versions').textContent, /1\.1\.0.*1\.2\.0/);
});

test('current version unlocks and restores pre-existing accessibility attributes', async t => {
    const { gate, doc } = harness(t, { getInstalledVersion: async () => '1.2.0' });
    const main = doc.querySelector('main');
    main.setAttribute('aria-hidden', 'false');
    main.setAttribute('inert', '');
    assert.equal(await gate.start(), 'allowed');
    assert.equal(gate.isActive(), false);
    assert.equal(doc.getElementById('owl-update-gate').hidden, true);
    assert.equal(doc.documentElement.hasAttribute('data-owl-update-gate'), false);
    assert.equal(main.getAttribute('aria-hidden'), 'false');
    assert.equal(main.hasAttribute('inert'), true);
});

test('clicks, submits, Escape and focus outside the gate are blocked', async t => {
    const { gate, doc } = harness(t);
    await gate.start();
    let appClicks = 0, submits = 0;
    doc.getElementById('app-button').addEventListener('click', () => appClicks++);
    doc.body.addEventListener('submit', () => submits++);
    doc.getElementById('app-button').click();
    doc.body.dispatchEvent(new doc.defaultView.Event('submit', { bubbles: true, cancelable: true }));
    doc.getElementById('query').dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    doc.getElementById('query').focus();
    assert.equal(appClicks, 0);
    assert.equal(submits, 0);
    assert.equal(gate.isActive(), true);
    assert.ok(doc.getElementById('owl-update-gate').contains(doc.activeElement));
});

test('Tab and Shift+Tab stay inside the update dialog', async t => {
    const { gate, doc } = harness(t);
    await gate.start();
    const store = doc.querySelector('.owl-update-store');
    const retry = doc.querySelector('.owl-update-retry');
    retry.focus();
    retry.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.ok(doc.activeElement === store);
    store.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    assert.ok(doc.activeElement === retry);
    retry.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    assert.ok(doc.activeElement === store);
});

test('concurrent resume events share one request', async t => {
    let reads = 0;
    const pending = deferred();
    const { gate, win } = harness(t, { loadPolicy: () => { reads++; return pending.promise; } });
    const first = gate.start();
    win.dispatchEvent(new win.Event('focus'));
    win.dispatchEvent(new win.Event('online'));
    const second = gate.check();
    await tick();
    assert.equal(reads, 1);
    pending.resolve(policy());
    assert.equal(await first, 'required');
    assert.equal(await second, 'required');
});

test('invalid server policy cannot unlock even when the native version is current', async t => {
    const { gate, doc } = harness(t, {
        getInstalledVersion: async () => '9.0.0',
        loadPolicy: async () => ({ android: { minimumVersion: '1.0.0', storeUrl: 'javascript:alert(1)' } })
    });
    assert.equal(await gate.start(), 'error');
    assert.equal(gate.isActive(), true);
    assert.equal(doc.querySelector('.owl-update-store').hidden, true);
});

test('new page content and modals are inert while the update is required', async t => {
    const { gate, doc } = harness(t);
    await gate.start();
    const modal = doc.createElement('div');
    modal.innerHTML = '<button>Late app modal</button>';
    doc.body.appendChild(modal);
    await tick();
    assert.equal(modal.getAttribute('inert'), '');
    assert.equal(modal.getAttribute('aria-hidden'), 'true');
    assert.equal(doc.body.lastElementChild.id, 'owl-update-gate');
});

test('remote update messages are plain text, not HTML', async t => {
    const config = { ...policy(), message: '<img src=x onerror=alert(1)>' };
    const { gate, doc } = harness(t, { loadPolicy: async () => config });
    await gate.start();
    assert.equal(doc.getElementById('owl-update-message').textContent, config.message);
    assert.equal(doc.querySelector('#owl-update-message img'), null);
});

test('network failure stays locked and Retry can recover without an offline bypass', async t => {
    let attempts = 0;
    const { gate, doc } = harness(t, { loadPolicy: async () => {
        if (++attempts === 1) throw new Error('offline');
        return policy();
    } });
    assert.equal(await gate.start(), 'error');
    assert.equal(gate.isActive(), true);
    assert.equal(doc.getElementById('owl-update-title').textContent, 'Update check unavailable');
    assert.equal(await gate.retry(), 'required');
    assert.equal(attempts, 2);
});

test('a hung request times out, remains locked, and can be retried', async t => {
    let attempts = 0;
    const { gate } = harness(t, { timeoutMs: 15, loadPolicy: () => {
        attempts++;
        return attempts === 1 ? new Promise(() => {}) : Promise.resolve(policy());
    } });
    assert.equal(await gate.start(), 'error');
    assert.equal(gate.isActive(), true);
    assert.equal(await gate.retry(), 'required');
});

test('missing native version plugin is an error, never an allowed version', async t => {
    const { gate, doc } = harness(t, { getInstalledVersion: async () => { throw new Error('App plugin missing'); } });
    assert.equal(await gate.start(), 'error');
    assert.equal(gate.isActive(), true);
    assert.equal(doc.querySelector('.owl-update-store').hidden, false);
    assert.match(doc.querySelector('.owl-update-versions').textContent, /Installed: unavailable/);
});

test('resume rechecks the server and a previously allowed app cannot reuse its old pass', async t => {
    let required = false, reads = 0;
    const { gate, win } = harness(t, {
        getInstalledVersion: async () => '1.2.0',
        loadPolicy: async () => { reads++; return policy('android', required ? '1.3.0' : '1.2.0'); }
    });
    assert.equal(await gate.start(), 'allowed');
    required = true;
    win.dispatchEvent(new win.Event('focus'));
    assert.equal(gate.getState(), 'checking');
    await gate.check();
    assert.equal(gate.getState(), 'required');
    assert.equal(reads, 2);
    win.dispatchEvent(new win.Event('focus'));
    await gate.check();
    assert.equal(reads, 3, 'locked app must also retry on resume');
});

test('periodic background check locks an already-open app when a release becomes mandatory', async t => {
    let required = false;
    const { gate } = harness(t, {
        checkIntervalMs: 10,
        getInstalledVersion: async () => '1.2.0',
        loadPolicy: async () => policy('android', required ? '1.3.0' : '1.2.0')
    });
    await gate.start();
    required = true;
    for (let i = 0; i < 50 && gate.getState() !== 'required'; i++) await wait(5);
    assert.equal(gate.getState(), 'required');
    assert.equal(gate.isActive(), true);
});

test('store action opens the platform URL without unlocking', async t => {
    const urls = [];
    const { gate, doc } = harness(t, { openStore: async url => { urls.push(url); } });
    await gate.start();
    doc.querySelector('.owl-update-store').click();
    await tick();
    assert.deepEqual(urls, [ANDROID_URL]);
    assert.equal(gate.isActive(), true);
});

test('failed store navigation leaves the gate locked and reports the failure', async t => {
    const { gate, doc } = harness(t, { openStore: async () => { throw new Error('blocked'); } });
    await gate.start();
    await gate.openStore();
    assert.equal(gate.isActive(), true);
    assert.match(doc.querySelector('.owl-update-status').textContent, /Could not open the store/);
    assert.equal(doc.querySelector('.owl-update-store').disabled, false);
});

test('head startup mounts the gate as soon as the parser creates body', async t => {
    const dom = new JSDOM('<!doctype html><html><head></head></html>');
    dom.window.document.body.remove();
    const pending = deferred();
    const gate = gateApi.createGate({
        document: dom.window.document, window: dom.window, platform: 'ios',
        loadPolicy: () => pending.promise, getInstalledVersion: async () => '1.0.0', checkIntervalMs: 100000
    });
    t.after(() => { gate.destroy(); dom.window.close(); });
    const starting = gate.start();
    assert.equal(dom.window.document.documentElement.getAttribute('data-owl-update-gate'), 'checking');
    const body = dom.window.document.createElement('body');
    dom.window.document.documentElement.appendChild(body);
    await tick();
    assert.equal(body.querySelector('#owl-update-gate').dataset.state, 'checking');
    pending.resolve(policy('ios'));
    assert.equal(await starting, 'required');
    assert.equal(body.querySelector('.owl-update-store').textContent, 'Update on the App Store');
});

test('Firestore loader reads the configured document from the server on every check', async t => {
    let reads = 0, imports = 0;
    const load = gateApi.createFirestorePolicyLoader(async url => {
        imports++;
        if (url === './app.js') return { db: {} };
        return {
            doc: (...args) => { assert.deepEqual(args.slice(1), ['app_config', 'appVersion']); return 'version-ref'; },
            getDocFromServer: async ref => { assert.equal(ref, 'version-ref'); reads++; return { exists: () => true, data: () => policy() }; }
        };
    });
    await load(); await load();
    assert.equal(reads, 2);
    assert.equal(imports, 2, 'reuse Firebase client modules, not old policy snapshots');
    const missing = gateApi.createFirestorePolicyLoader(mockImports([{ exists: () => false }]));
    await assert.rejects(missing(), /not been configured/);
});

test('Firestore module import failure can be retried', async t => {
    let attempts = 0;
    const load = gateApi.createFirestorePolicyLoader(async url => {
        if (url === './app.js' && ++attempts === 1) throw new Error('CDN unavailable');
        if (url === './app.js') return { db: {} };
        return { doc: () => ({}), getDocFromServer: async () => ({ exists: () => true, data: () => policy() }) };
    });
    await assert.rejects(load(), /CDN unavailable/);
    assert.deepEqual(await load(), policy());
    assert.equal(attempts, 2);
});

test('native bootstrap wires iOS store, foreground checks and foreground coalescing', async t => {
    const { win, events, opened } = nativeWindow(t, 'ios', '1.0.0');
    let reads = 0;
    const gate = gateApi.startNativeGate(win, mockImports([
        { exists: () => true, data: () => { reads++; return policy('ios'); } },
        { exists: () => true, data: () => { reads++; return policy('ios'); } }
    ]));
    t.after(() => gate.destroy());
    assert.equal(await gate.check(), 'required');
    await events.appStateChange({ isActive: true });
    await gate.check();
    assert.equal(reads, 2);
    await gate.openStore();
    assert.deepEqual(opened, [IOS_URL]);
    assert.equal(gate.isActive(), true);
});

test('Android Back cannot dismiss a required update', async t => {
    const { win, events } = nativeWindow(t);
    const gate = gateApi.startNativeGate(win, mockImports([{ exists: () => true, data: () => policy() }]));
    t.after(() => gate.destroy());
    await gate.check();
    await tick();
    const before = win.history.length;
    events.backButton({ canGoBack: true });
    assert.equal(win.history.length, before);
    assert.equal(gate.isActive(), true);
});

test('website bootstrap does not import Firebase or insert a blocking dialog', t => {
    const dom = new JSDOM('<!doctype html><body><button>Website</button></body>', { url: 'https://owlwatcher.tech/' });
    t.after(() => dom.window.close());
    let imported = false;
    const gate = gateApi.startNativeGate(dom.window, () => { imported = true; });
    assert.equal(gate, null);
    assert.equal(imported, false);
    assert.equal(dom.window.document.getElementById('owl-update-gate'), null);
});

test('every HTML page loads the bridge and gate in head before app logic', () => {
    const pages = fs.readdirSync(root).filter(name => name.endsWith('.html'));
    assert.equal(pages.length, 11);
    for (const name of pages) {
        const html = fs.readFileSync(path.join(root, name), 'utf8');
        const head = html.slice(0, html.indexOf('</head>'));
        assert.equal((html.match(/src="capacitor\.js"/g) || []).length, 1, name);
        assert.equal((html.match(/src="force-update\.js"/g) || []).length, 1, name);
        assert.ok(head.indexOf('src="capacitor.js"') < head.indexOf('src="force-update.js"'), name);
        assert.ok(head.indexOf('src="force-update.js"') < html.indexOf('<body'), name);
    }
});

test('example policy is valid once real store URLs are supplied', () => {
    const example = JSON.parse(fs.readFileSync(path.join(root, 'firebase/app-version.example.json'), 'utf8'));
    assert.throws(() => gateApi.validatePolicy(example, 'android'), /storeUrl/, 'blank example URLs must not accidentally enable the gate');
    example.android.storeUrl = ANDROID_URL;
    example.ios.storeUrl = IOS_URL;
    assert.equal(gateApi.validatePolicy(example, 'android').minimumVersion, '1.0.0');
    assert.equal(gateApi.validatePolicy(example, 'ios').minimumVersion, '1.0.0');
});
