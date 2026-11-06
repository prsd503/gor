const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseVersion, compareVersions, validStoreUrl, normalizePolicy, buildVersionResponse
} = require('../server/lib/version-policy');

const PLAY = 'https://play.google.com/store/apps/details?id=io.github.prsd503.owl';
const APPLE = 'https://apps.apple.com/in/app/owl-watcher/id1234567890';

function policy(overrides = {}) {
    return {
        android: { minimumVersion: '2.8.0', storeUrl: PLAY },
        ios: { minimumVersion: '2.8.0', storeUrl: APPLE },
        message: 'A newer version is available.',
        ...overrides
    };
}

test('version parsing and numeric comparison match the frontend rules', () => {
    assert.deepEqual(parseVersion('2.7.0'), [2, 7, 0]);
    for (const bad of ['18', '2.7', 'v2.7.0', '2.7.0-beta', '1.2.3.4', '', null, 1]) {
        assert.equal(parseVersion(bad), null, String(bad));
    }
    assert.equal(compareVersions('2.7.0', '2.8.0'), -1);
    assert.equal(compareVersions('2.8.0', '2.8.0'), 0);
    assert.equal(compareVersions('2.10.0', '2.9.0'), 1);
});

test('store URLs must be official HTTPS links for the right platform', () => {
    assert.equal(validStoreUrl(PLAY, 'android'), true);
    assert.equal(validStoreUrl(APPLE, 'ios'), true);
    for (const bad of ['www', '', 'javascript:alert(1)', 'http://play.google.com/store/apps/details?id=a.b',
        'https://play.google.com.evil.com/store/apps/details?id=a.b',
        'https://user@play.google.com/store/apps/details?id=a.b',
        'https://play.google.com/store/apps/details?id=bad', APPLE]) {
        assert.equal(validStoreUrl(bad, 'android'), false, bad);
    }
    assert.equal(validStoreUrl(PLAY, 'ios'), false);
    assert.equal(validStoreUrl('https://apps.apple.com.evil.com/app/id1', 'ios'), false);
});

test('the reported ios storeUrl "www" is dropped without hiding android', () => {
    const normalized = normalizePolicy(policy({ ios: { minimumVersion: '1.0.0', storeUrl: 'www' } }));
    assert.ok(normalized.android, 'android must survive a broken ios block');
    assert.equal(normalized.ios, undefined);
});

test('installed 2.7.0 against minimum 2.8.0 reports an available update', () => {
    const result = buildVersionResponse(policy(), { platform: 'android', version: '2.7.0' });
    assert.equal(result.updateAvailable, true);
    assert.equal(result.minimumVersion, '2.8.0');
    assert.equal(result.storeUrl, PLAY);
    assert.equal(result.configured, true);
});

test('equal and newer installs report no update', () => {
    assert.equal(buildVersionResponse(policy(), { platform: 'android', version: '2.8.0' }).updateAvailable, false);
    assert.equal(buildVersionResponse(policy(), { platform: 'android', version: '2.10.0' }).updateAvailable, false);
});

test('unconfigured platform is reported instead of throwing', () => {
    const result = buildVersionResponse(policy({ ios: { minimumVersion: '1.0.0', storeUrl: 'www' } }),
        { platform: 'ios', version: '1.0.0' });
    assert.equal(result.configured, false);
    assert.equal(result.updateAvailable, false);
});

test('bad query parameters produce a 400-style error', () => {
    assert.throws(() => buildVersionResponse(policy(), { platform: 'windows', version: '1.0.0' }), e => e.status === 400);
    assert.throws(() => buildVersionResponse(policy(), { platform: 'android', version: '18' }), e => e.status === 400);
});

test('no query returns the whole normalized policy and truncates long messages', () => {
    const whole = buildVersionResponse(policy());
    assert.ok(whole.android && whole.ios);
    const long = buildVersionResponse(policy({ message: 'x'.repeat(900) }));
    assert.equal(long.message.length, 500);
    assert.throws(() => normalizePolicy(null));
});
