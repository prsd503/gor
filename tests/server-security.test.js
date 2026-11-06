const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOrigin, createOriginChecker, createAppCheckMiddleware } = require('../server/lib/security');

function res() {
    return {
        statusCode: null, body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; }
    };
}

test('origins are normalized to scheme + host', () => {
    assert.equal(normalizeOrigin('https://app.owlwatcher.tech/some/path'), 'https://app.owlwatcher.tech');
    assert.equal(normalizeOrigin('capacitor://localhost'), 'capacitor://localhost');
    assert.equal(normalizeOrigin('javascript:alert(1)'), null);
    assert.equal(normalizeOrigin('nonsense'), null);
});

test('SECURITY: lookalike origins are rejected (old startsWith/includes bug)', () => {
    const allowed = createOriginChecker();
    assert.equal(allowed('https://app.owlwatcher.tech'), true);
    assert.equal(allowed('https://prsd503.github.io'), true);
    assert.equal(allowed('https://localhost'), true);
    assert.equal(allowed('capacitor://localhost'), true);
    for (const evil of [
        'https://app.owlwatcher.tech.evil.com',
        'https://prsd503.github.io.evil.com',
        'https://localhost.evil.com',
        'https://evil.com/?x=https://app.owlwatcher.tech',
        'http://app.owlwatcher.tech'
    ]) {
        assert.equal(allowed(evil), false, evil);
    }
});

test('SECURITY: ngrok suffix matching cannot be spoofed by substring', () => {
    const allowed = createOriginChecker();
    assert.equal(allowed('https://unloving-limit-ferry.ngrok-free.dev'), true);
    assert.equal(allowed('https://ngrok-free.dev.attacker.com'), false);
    assert.equal(allowed('https://evilngrok-free.dev'), false);
    assert.equal(allowed('https://ngrok-free.dev'), false);
});

test('extra origins can be supplied and ngrok can be disabled', () => {
    assert.equal(createOriginChecker(['https://staging.example.com'])('https://staging.example.com'), true);
    assert.equal(createOriginChecker([], { allowNgrok: false })('https://abc.ngrok-free.dev'), false);
});

test('App Check monitor mode verifies tokens but allows failures through', async () => {
    const warnings = [];
    const mw = createAppCheckMiddleware({
        mode: 'monitor',
        verifyToken: async () => { throw new Error('bad token'); },
        logger: { warn: (...a) => warnings.push(a.join(' ')) }
    });
    const request = { header: () => 'token' };
    let reached = false;
    await mw(request, res(), () => { reached = true; });
    assert.equal(reached, true);
    assert.equal(request.appCheck.verified, false);
    assert.equal(warnings.length, 1);
});

test('App Check enforce mode rejects missing and invalid tokens', async () => {
    const mw = createAppCheckMiddleware({ mode: 'enforce', verifyToken: async () => ({ appId: 'app-1' }) });
    const missing = res();
    await mw({ header: () => undefined }, missing, () => { throw new Error('must not pass'); });
    assert.equal(missing.statusCode, 401);
    assert.equal(missing.body.code, 'app-check-missing');

    const failing = createAppCheckMiddleware({
        mode: 'enforce', verifyToken: async () => { throw new Error('nope'); }, logger: { warn() {} }
    });
    const invalid = res();
    await failing({ header: () => 'bad' }, invalid, () => { throw new Error('must not pass'); });
    assert.equal(invalid.statusCode, 401);
    assert.equal(invalid.body.code, 'app-check-invalid');
});

test('App Check enforce mode accepts a valid token and records the app id', async () => {
    const mw = createAppCheckMiddleware({ mode: 'enforce', verifyToken: async () => ({ appId: 'app-1' }) });
    const request = { header: () => 'good' };
    let reached = false;
    await mw(request, res(), () => { reached = true; });
    assert.equal(reached, true);
    assert.deepEqual(request.appCheck, { appId: 'app-1', verified: true });
});

test('App Check off mode skips verification entirely', async () => {
    const mw = createAppCheckMiddleware({ mode: 'off' });
    let reached = false;
    await mw({ header: () => 'anything' }, res(), () => { reached = true; });
    assert.equal(reached, true);
    assert.throws(() => createAppCheckMiddleware({ mode: 'enforce' }), /verifyToken is required/);
});

test('SECURITY: a spoofed Origin alone never satisfies App Check enforcement', async () => {
    const mw = createAppCheckMiddleware({ mode: 'enforce', verifyToken: async () => ({ appId: 'a' }) });
    const response = res();
    await mw({ header: () => undefined, headers: { origin: 'https://localhost' } }, response,
        () => { throw new Error('Origin must not bypass App Check'); });
    assert.equal(response.statusCode, 401);
});
