'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { prepareFirebaseApi } = require('../server/lib/firebase-release');
const { checkApiDeploy } = require('../scripts/check-api-deploy');

const root = path.resolve(__dirname, '..');
function env() {
    return {
        API_RELEASE_PROFILE: 'full',
        OWL_FIREBASE_PROJECT_ID: 'finder-owl',
        API_RUNTIME_SERVICE_ACCOUNT: 'owl-api-runtime@finder-owl.iam.gserviceaccount.com',
        ALLOWED_ORIGINS: 'https://prsd503.github.io,https://app.owlwatcher.tech,https://localhost,http://localhost,capacitor://localhost'
    };
}

test('Firebase entry preparation enables the full authenticated API and keeps safe serverless defaults', () => {
    const configured = { ...env(), FIREBASE_READ_ONLY: '0', ENABLE_CRON: '0' };
    const result = prepareFirebaseApi(configured);
    assert.equal(configured.API_RELEASE_PROFILE, 'full');
    assert.equal(configured.FIREBASE_READ_ONLY, '0', 'the global read-only gate is not enabled');
    assert.equal(configured.ENABLE_CRON, '0', 'maintenance needs a separate scheduled release');
    assert.equal(configured.QUOTA_SOURCE, 'monitoring');
    assert.equal(configured.QUOTA_ACTION, 'stop');
    assert.equal(configured.QUOTA_THRESHOLD, '0.8');
    assert.equal(configured.SERVE_STATIC, '0');
    assert.equal(configured.MAX_INSTANCES, '2');
    assert.equal(result.serviceAccount, env().API_RUNTIME_SERVICE_ACCOUNT);
    assert.equal(result.profile, 'firebase-full');
});

test('full API release refuses the old read-only profile and read-only runtime account', () => {
    assert.throws(() => prepareFirebaseApi({ ...env(), API_RELEASE_PROFILE: 'read-only' }), /API_RELEASE_PROFILE=full/);
    assert.throws(() => prepareFirebaseApi({ ...env(), API_RUNTIME_SERVICE_ACCOUNT: 'owl-api-readonly@finder-owl.iam.gserviceaccount.com' }), /non-read-only service account/);
    assert.throws(() => prepareFirebaseApi({ ...env(), FIREBASE_READ_ONLY: '1' }), /Remove FIREBASE_READ_ONLY/);
});

test('unsafe Firebase configuration fails before app/Firebase initialization', () => {
    const invalid = {
        NODE_ENV: 'development', DATA_BACKEND: 'local', AUTH_MODE: 'local',
        SERVE_STATIC: '1', QUOTA_SOURCE: 'local', QUOTA_ACTION: 'monitor',
        QUOTA_THRESHOLD: '0.9', APP_CHECK_MODE: 'off', MAX_INSTANCES: '3',
        CONCURRENCY: '21', FUNCTIONS_REGION: 'asia-south1',
        QUOTA_FALLBACK_URLS: 'https://unreviewed.example/api', TUNNEL_PREVIEW: '1',
        ALLOWED_ORIGINS: 'https://prsd503.github.io/gor',
        API_RUNTIME_SERVICE_ACCOUNT: 'wrong@other-project.iam.gserviceaccount.com',
        GCLOUD_PROJECT: 'other-project'
    };
    for (const [key, value] of Object.entries(invalid)) {
        assert.throws(() => prepareFirebaseApi({ ...env(), [key]: value }), undefined, key);
    }
    for (const value of ['0', '-1', 'NaN', '', 'Infinity']) {
        assert.throws(() => prepareFirebaseApi({ ...env(), QUOTA_THRESHOLD: value }));
    }
    for (const value of ['', '*', 'https://*.owlwatcher.tech', 'http://public.example', 'null', 'https://site.example/path']) {
        assert.throws(() => prepareFirebaseApi({ ...env(), ALLOWED_ORIGINS: value }));
    }
    assert.throws(() => prepareFirebaseApi({ ...env(), API_RUNTIME_SERVICE_ACCOUNT: '' }));
});

test('full website + API deployment selects Hosting and notice functions, never Firestore Rules', () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json')));
    assert.equal(config.hosting.public, '.firebase-public');
    assert.deepEqual(config.hosting.rewrites, ['/api', '/api/**'].map(source => ({ source, function: { functionId: 'api', region: 'us-central1' } })));
    assert.equal(config.functions[0].source, 'server');
    assert.equal(config.functions[0].runtime, 'nodejs22');
    assert.equal(config.firestore, undefined);
    const exampleEnv = fs.readFileSync(path.join(root, 'server/.env.firebase.example'), 'utf8');
    assert.match(exampleEnv, /^ALLOWED_ORIGINS=.*https:\/\/finder-owl\.web\.app/m);
    assert.match(exampleEnv, /^ALLOWED_ORIGINS=.*https:\/\/finder-owl\.firebaseapp\.com/m);
    const script = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).scripts['deploy:full'];
    assert.equal(script, 'node scripts/check-api-deploy.js && npx firebase-tools deploy --config firebase.json --project finder-owl --only functions:api,functions:noticeRollover,hosting');
    assert.doesNotMatch(script, /firestore:rules/);
});

test('API-only Hosting publishes only landing/404 pages, pins API region, and leaves website config intact', () => {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'firebase.api.json')));
    assert.equal(config.hosting.public, 'firebase/api-public');
    assert.equal(config.hosting.predeploy, undefined, 'never stages the website');
    assert.deepEqual(fs.readdirSync(path.join(root, config.hosting.public)).sort(), ['404.html', 'index.html']);
    assert.deepEqual(config.hosting.rewrites, ['/api', '/api/**'].map(source => ({ source, function: { functionId: 'api', region: 'us-central1' } })));
    assert.equal(config.functions[0].source, 'server');
    assert.equal(config.functions[0].runtime, 'nodejs22');
    assert.ok(config.hosting.headers[0].headers.some(h => h.key === 'Cache-Control' && h.value === 'no-store'));
    const original = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json')));
    assert.equal(original.hosting.public, '.firebase-public');
    const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).scripts;
    assert.match(scripts['deploy:api:functions'], /check-api-deploy\.js && .*--config firebase\.api\.json --project finder-owl --only functions:api,functions:noticeRollover$/);
    assert.match(scripts['deploy:api:hosting'], /check-api-deploy\.js && .*--config firebase\.api\.json --project finder-owl --only hosting$/);
    assert.ok(!scripts['deploy:functions'].endsWith('--only functions'), 'generic command selects only intended functions');
});

function preflightFixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-preflight-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'server'));
    const file = path.join(dir, 'server/.env');
    const contents = fs.readFileSync(path.join(root, 'server/.env.firebase.example'), 'utf8').replace('REPLACE_WITH_A_RANDOM_SECRET_AT_LEAST_32_CHARACTERS', 'a-private-test-only-secret-'.repeat(3));
    return { dir, file, contents };
}

test('preflight reads production settings without mutating env, source or private files', t => {
    const { dir, file, contents } = preflightFixture(t);
    assert.throws(() => checkApiDeploy(dir, {}), /Create server\/\.env/);
    fs.writeFileSync(file, contents);
    const before = fs.readFileSync(file, 'utf8');
    assert.deepEqual(checkApiDeploy(dir, {}), { project: 'finder-owl', profile: 'firebase-full' });
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'server')), ['.env']);
});

test('preflight refuses placeholders, local credentials, conflicting dotenv files and credential JSON', t => {
    const { dir, file, contents } = preflightFixture(t);
    for (const text of [
        contents.replace(/JWT_SECRET=.*/, 'JWT_SECRET=REPLACE_WITH_A_RANDOM_SECRET_AT_LEAST_32_CHARACTERS'),
        contents.replace('ENABLE_CRON=0', 'ENABLE_CRON=1'),
        contents + '\nGOOGLE_APPLICATION_CREDENTIALS=/private/key.json\n',
        contents + '\nSERVICE_ACCOUNT_JSON={}\n',
        contents + '\nENV_FILE=.env.macbook\n',
        contents.replace('QUOTA_SOURCE=monitoring', 'QUOTA_SOURCE=local')
    ]) {
        fs.writeFileSync(file, text);
        assert.throws(() => checkApiDeploy(dir, {}));
    }
    fs.writeFileSync(file, contents);
    assert.throws(() => checkApiDeploy(dir, { ENV_FILE: '.env.macbook' }), /Unset ENV_FILE/);
    assert.throws(() => checkApiDeploy(dir, { NODE_ENV: 'development' }), /Unset exported NODE_ENV/);
    assert.throws(() => checkApiDeploy(dir, { JWT_SECRET: 'SHOULD_NOT_BE_PRINTED' }), error => {
        assert.ok(!error.message.includes('SHOULD_NOT_BE_PRINTED'));
        return /Unset exported JWT_SECRET/.test(error.message);
    });
    const conflicting = path.join(dir, 'server/.env.finder-owl');
    fs.writeFileSync(conflicting, 'SERVE_STATIC=1');
    assert.throws(() => checkApiDeploy(dir, {}), /overrides/);
    fs.unlinkSync(conflicting);
    const credential = path.join(dir, 'server/renamed-credentials.json');
    fs.writeFileSync(credential, JSON.stringify({ type: 'service_account', private_key: 'DO_NOT_PRINT' }));
    assert.throws(() => checkApiDeploy(dir, {}), error => {
        assert.ok(!error.message.includes('DO_NOT_PRINT'));
        return /credential JSON/.test(error.message);
    });
});
