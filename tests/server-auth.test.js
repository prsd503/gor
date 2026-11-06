const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { bearerToken, looksLikeFirebaseIdToken, createAuthMiddleware } = require('../server/lib/auth');

const SECRET = 'x'.repeat(48);
const PROJECT = 'finder-owl';

function fakeFirebaseToken(payload = {}) {
    const body = { iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: 'uid-1', email: 'a@b.com', ...payload };
    const enc = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
    return `${enc({ alg: 'RS256' })}.${enc(body)}.signature`;
}

function res() {
    return {
        statusCode: null, body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; }
    };
}

function middleware(overrides = {}) {
    return createAuthMiddleware({
        projectId: PROJECT,
        verifyIdToken: async () => ({ uid: 'uid-1', email: 'a@b.com' }),
        verifyJwt: token => jwt.verify(token, SECRET),
        logger: { warn() {} },
        ...overrides
    });
}

test('bearer parsing rejects missing and malformed headers', () => {
    const req = h => ({ header: () => h });
    assert.equal(bearerToken(req(undefined)), null);
    assert.equal(bearerToken(req('Basic abc')), null);
    assert.equal(bearerToken(req('Bearer ')), null);
    assert.equal(bearerToken(req('Bearer abc')), 'abc');
});

test('Firebase ID tokens are routed by issuer, not by string length', () => {
    assert.equal(looksLikeFirebaseIdToken(fakeFirebaseToken(), PROJECT), true);
    assert.equal(looksLikeFirebaseIdToken(fakeFirebaseToken({ aud: 'other' }), PROJECT), false);
    assert.equal(looksLikeFirebaseIdToken('not-a-jwt', PROJECT), false);
    assert.equal(looksLikeFirebaseIdToken(jwt.sign({ uid: 1 }, SECRET), PROJECT), false);
});

test('REGRESSION: a Firebase ID token from authenticatedFetch is accepted', async () => {
    const { requireAuth } = middleware();
    const response = res();
    let reached = false;
    const request = { header: () => `Bearer ${fakeFirebaseToken()}` };
    await requireAuth(request, response, () => { reached = true; });
    assert.equal(reached, true, 'admin writes must not 403 on a valid Firebase ID token');
    assert.equal(request.user.uid, 'uid-1');
    assert.equal(request.user.type, 'firebase_user');
    assert.equal(response.statusCode, null);
});

test('backend-issued JWTs are still accepted', async () => {
    const { requireAuth } = middleware();
    const token = jwt.sign({ uid: 'u2', role: 'admin' }, SECRET, { expiresIn: '1h' });
    const request = { header: () => `Bearer ${token}` };
    const response = res();
    let reached = false;
    await requireAuth(request, response, () => { reached = true; });
    assert.equal(reached, true);
    assert.equal(request.user.type, 'backend_jwt');
});

test('SECURITY: the old short-token bypass no longer authenticates', async () => {
    const { requireAuth } = middleware();
    for (const token of ['x', 'owl-watcher-session-token', 'a'.repeat(49)]) {
        const response = res();
        let reached = false;
        await requireAuth({ header: () => `Bearer ${token}` }, response, () => { reached = true; });
        assert.equal(reached, false, token);
        assert.equal(response.statusCode, 401);
    }
});

test('missing, expired, and forged tokens are rejected', async () => {
    const { requireAuth } = middleware();
    const expired = jwt.sign({ uid: 'u' }, SECRET, { expiresIn: -10 });
    const forged = jwt.sign({ uid: 'u', role: 'admin' }, 'wrong-secret');
    for (const header of [undefined, `Bearer ${expired}`, `Bearer ${forged}`]) {
        const response = res();
        let reached = false;
        await requireAuth({ header: () => header }, response, () => { reached = true; });
        assert.equal(reached, false, String(header));
        assert.equal(response.statusCode, 401);
    }
});

test('a revoked Firebase account is rejected', async () => {
    const { requireAuth } = middleware({
        verifyIdToken: async () => { const e = new Error('revoked'); e.code = 'auth/id-token-revoked'; throw e; }
    });
    const response = res();
    await requireAuth({ header: () => `Bearer ${fakeFirebaseToken()}` }, response, () => { throw new Error('must not pass'); });
    assert.equal(response.statusCode, 401);
});

test('requireAdmin blocks non-admin roles and anonymous callers', () => {
    const { requireAdmin } = middleware();
    const anon = res();
    requireAdmin({}, anon, () => { throw new Error('must not pass'); });
    assert.equal(anon.statusCode, 401);

    const guard = res();
    requireAdmin({ user: { role: 'guard' } }, guard, () => { throw new Error('must not pass'); });
    assert.equal(guard.statusCode, 403);

    let reached = false;
    requireAdmin({ user: { role: 'admin' } }, res(), () => { reached = true; });
    assert.equal(reached, true);
});

test('optionalAuth identifies admins but never blocks residents', async () => {
    const { optionalAuth } = middleware();
    const anonymous = {};
    let reached = false;
    await optionalAuth(anonymous, res(), () => { reached = true; });
    assert.equal(reached, true);
    assert.equal(anonymous.user, undefined);

    const invalid = { header: () => 'Bearer garbage' };
    reached = false;
    await optionalAuth(invalid, res(), () => { reached = true; });
    assert.equal(reached, true, 'invalid tokens must not break public resident flows');
    assert.equal(invalid.user, undefined);
});
