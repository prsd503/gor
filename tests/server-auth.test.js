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
        verifyIdToken: async () => ({ uid: 'uid-1', email: 'a@b.com', email_verified: true }),
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

test('SECURITY: auth middleware never grants a role from token claims', async () => {
    const { resolveUser } = middleware();
    const idToken = await resolveUser(fakeFirebaseToken({ admin: true, role: 'admin', adminRole: 'guard' }));
    assert.equal(idToken.role, 'user');
    assert.equal(idToken.emailVerified, true);

    for (const claims of [
        { uid: 'u', role: 'admin', authVersion: 2 },
        { uid: 'u', admin: true },
        { uid: 'u', adminRole: 'guard' }
    ]) {
        const user = await resolveUser(jwt.sign(claims, SECRET));
        assert.equal(user.role, 'user');
    }
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

test('SECURITY: a valid sign-in without Firestore membership carries no staff role', async () => {
    const { resolveUser } = middleware();
    const user = await resolveUser(fakeFirebaseToken());
    assert.equal(user.role, 'user');
    assert.equal(user.emailVerified, true);
    assert.equal(user.claims.email, 'a@b.com');
});

test('SECURITY: signed backend token without an explicit role is not admin', async () => {
    const {resolveUser}=middleware();
    const user=await resolveUser(jwt.sign({uid:'ordinary'},SECRET));
    assert.equal(user.role,'user');
});

test('SECURITY: legacy claim/UID role helper cannot grant app authorization', () => {
    const { parseAdminUids, firebaseRole } = require('../server/lib/admin-policy');
    const legacyAllowlist = parseAdminUids('owner-uid, second-uid');
    assert.equal(legacyAllowlist.has('owner-uid'), true);
    for (const decoded of [
        { uid: 'owner-uid', admin: true },
        { uid: 'u', role: 'admin' },
        { uid: 'u', role: 'guard' },
        { uid: 'u', adminRole: 'admin' }
    ]) assert.equal(firebaseRole(decoded, legacyAllowlist), 'user');
});

test('Firebase token routing requires the exact configured issuer', () => {
    assert.equal(looksLikeFirebaseIdToken(fakeFirebaseToken({iss:'https://securetoken.google.com/other'}),PROJECT),false);
    assert.equal(looksLikeFirebaseIdToken(fakeFirebaseToken({iss:`https://securetoken.google.com/${PROJECT}/extra`}),PROJECT),false);
});


test('SECURITY: old and versioned backend JWT role claims are ignored', async () => {
    const { resolveUser } = middleware();
    for (const claims of [
        { uid: 'ordinary', role: 'admin' },
        { uid: 'owner', role: 'admin', authVersion: 2 },
        { uid: 'guard', role: 'guard', authVersion: 2 }
    ]) assert.equal((await resolveUser(jwt.sign(claims, SECRET))).role, 'user');
});
