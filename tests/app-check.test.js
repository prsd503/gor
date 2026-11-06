const test = require('node:test');
const assert = require('node:assert/strict');
const apiPromise = import('../app-check.mjs');

const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

class MockCustomProvider {
    constructor(options) { this.options = options; }
}

function logger() {
    const errors = [];
    return { errors, error: (...args) => errors.push(args.map(String).join(' ')) };
}

test('debug mode requires an explicit native true signal', async () => {
    const { detectNativeDebugBuild } = await apiPromise;
    assert.equal(detectNativeDebugBuild(undefined), false);
    assert.equal(detectNativeDebugBuild({}), false);
    assert.equal(detectNativeDebugBuild({ NativeConfig: { isDebug: () => false } }), false);
    assert.equal(detectNativeDebugBuild({ NativeConfig: { isDebug: () => 'true' } }), false);
    assert.equal(detectNativeDebugBuild({ NativeConfig: { isDebug: () => 1 } }), false);
    assert.equal(detectNativeDebugBuild({ NativeConfig: { isDebug: () => { throw new Error('no bridge'); } } }), false);
    assert.equal(detectNativeDebugBuild({ __OWL_NATIVE_DEBUG__: 'true' }), false);
    assert.equal(detectNativeDebugBuild({ location: { href: 'http://localhost?debug=1' }, navigator: { userAgent: 'Debug' } }), false);

    assert.equal(detectNativeDebugBuild({ NativeConfig: { isDebug: () => true } }), true);
    assert.equal(detectNativeDebugBuild({ NativeConfig: { isDebug: true } }), true);
    assert.equal(detectNativeDebugBuild({ NativeConfig: { debug: true } }), true);
    assert.equal(detectNativeDebugBuild({ Capacitor: { Plugins: { NativeConfig: { isDebug: () => true } } } }), true);
    assert.equal(detectNativeDebugBuild({ __OWL_NATIVE_DEBUG__: true }), true);
});

test('native bridge initializes with debugToken and no web provider option', async () => {
    const { createNativeAppCheckBridge } = await apiPromise;
    const init = deferred();
    const calls = { initialize: [], getToken: [] };
    const plugin = {
        initialize: options => { calls.initialize.push(options); return init.promise; },
        getToken: async options => { calls.getToken.push(options); return { token: 'native-token', expireTimeMillis: 42 }; }
    };
    const log = logger();
    const bridge = createNativeAppCheckBridge({
        app: { name: 'app' }, plugin, initializeAppCheck: (app, options) => ({ app, provider: options.provider }),
        CustomProvider: MockCustomProvider, debug: true, logger: log, now: () => 1000
    });
    await tick();
    assert.deepEqual(calls.initialize, [{ debugToken: true, isTokenAutoRefreshEnabled: true }]);
    const tokenPromise = bridge.appCheckInstance.provider.options.getToken();
    await tick();
    assert.equal(calls.getToken.length, 0, 'token request must wait for native initialize');
    init.resolve();
    assert.deepEqual(await tokenPromise, { token: 'native-token', expireTimeMillis: 42 });
    assert.deepEqual(calls.getToken, [{ forceRefresh: false }]);
    assert.equal(bridge.isDebug, true);
    await bridge.ready;
    assert.equal(log.errors.length, 0);
});

test('release bridge sends debugToken false and falls back to a 30 minute expiry', async () => {
    const { createNativeAppCheckBridge } = await apiPromise;
    const calls = { initialize: [], getToken: [] };
    const plugin = {
        initialize: async options => { calls.initialize.push(options); },
        getToken: async options => { calls.getToken.push(options); return { token: 'release-token' }; }
    };
    const bridge = createNativeAppCheckBridge({
        app: {}, plugin, initializeAppCheck: (app, options) => ({ provider: options.provider }),
        CustomProvider: MockCustomProvider, debug: false, now: () => 1000
    });
    await tick();
    assert.deepEqual(calls.initialize, [{ debugToken: false, isTokenAutoRefreshEnabled: true }]);
    assert.deepEqual(await bridge.appCheckInstance.provider.options.getToken(), {
        token: 'release-token', expireTimeMillis: 1000 + 30 * 60 * 1000
    });
});

test('initialization failure is logged and later token requests reject without unhandled rejection', async () => {
    const { createNativeAppCheckBridge } = await apiPromise;
    const failure = new Error('Too many attempts');
    const plugin = { initialize: async () => { throw failure; }, getToken: async () => ({ token: 'should-not-run' }) };
    const log = logger();
    const bridge = createNativeAppCheckBridge({
        app: {}, plugin, initializeAppCheck: (app, options) => ({ provider: options.provider }),
        CustomProvider: MockCustomProvider, debug: true, logger: log
    });
    await bridge.ready;
    await assert.rejects(bridge.appCheckInstance.provider.options.getToken(), /Too many attempts/);
    assert.ok(log.errors.some(line => /Native App Check Init Error/.test(line)));
    assert.ok(log.errors.some(line => /DEBUG TIP/.test(line)));
});

test('attestation failure logs actionable release guidance', async () => {
    const { createNativeAppCheckBridge } = await apiPromise;
    const plugin = {
        initialize: async () => {},
        getToken: async () => { throw new Error('Error returned from API. code: 403 body: App attestation failed.'); }
    };
    const log = logger();
    const bridge = createNativeAppCheckBridge({
        app: {}, plugin, initializeAppCheck: (app, options) => ({ provider: options.provider }),
        CustomProvider: MockCustomProvider, debug: false, logger: log
    });
    await assert.rejects(bridge.appCheckInstance.provider.options.getToken(), /attestation failed/);
    assert.ok(log.errors.some(line => /RELEASE TIP/.test(line)));
});

test('empty native tokens are rejected', async () => {
    const { createNativeAppCheckBridge } = await apiPromise;
    const plugin = { initialize: async () => {}, getToken: async () => ({ token: '' }) };
    const bridge = createNativeAppCheckBridge({
        app: {}, plugin, initializeAppCheck: (app, options) => ({ provider: options.provider }),
        CustomProvider: MockCustomProvider, logger: logger()
    });
    await assert.rejects(bridge.appCheckInstance.provider.options.getToken(), /empty token/);
});

test('missing native plugin methods fail fast', async () => {
    const { createNativeAppCheckBridge } = await apiPromise;
    assert.throws(() => createNativeAppCheckBridge({
        app: {}, plugin: {}, initializeAppCheck: () => {}, CustomProvider: MockCustomProvider
    }), /missing initialize\/getToken/);
});

test('ready resolves true after successful initialization and false after failure', async () => {
    const { createNativeAppCheckBridge } = await apiPromise;
    const ok = createNativeAppCheckBridge({
        app: {}, plugin: { initialize: async () => {}, getToken: async () => ({ token: 't' }) },
        initializeAppCheck: (app, options) => ({ provider: options.provider }), CustomProvider: MockCustomProvider
    });
    assert.equal(await ok.ready, true);
    const bad = createNativeAppCheckBridge({
        app: {}, plugin: { initialize: async () => { throw new Error('init failed'); }, getToken: async () => ({ token: 't' }) },
        initializeAppCheck: (app, options) => ({ provider: options.provider }), CustomProvider: MockCustomProvider,
        logger: logger()
    });
    assert.equal(await bad.ready, false);
});
