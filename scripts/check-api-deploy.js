'use strict';

// Read-only local preflight. Never contacts Firebase, writes an env file, prints
// a secret, changes IAM, or runs a deployment itself.
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { prepareFirebaseApi } = require('../server/lib/firebase-release');

function checkApiDeploy(root, shell = process.env) {
    const source = path.join(root, 'server');
    const file = path.join(source, '.env');
    if (!fs.existsSync(file)) throw new Error('Create server/.env from server/.env.firebase.example and configure it privately first.');
    if (shell.ENV_FILE) throw new Error('Unset ENV_FILE before deploying; do not use the MacBook environment.');
    const extra = fs.readdirSync(source).filter(name => /^\.env(?:\.|$)/.test(name) && name !== '.env' && !name.endsWith('.example'));
    if (extra.length) throw new Error('Remove or back up additional server/.env.* files outside server/ to avoid Firebase CLI environment overrides.');
    const env = dotenv.parse(fs.readFileSync(file));
    for (const key of ['JWT_SECRET', 'NODE_ENV', 'OWL_FIREBASE_PROJECT_ID', 'DATA_BACKEND', 'AUTH_MODE', 'SERVE_STATIC', 'ENABLE_CRON', 'QUOTA_ACTION', 'QUOTA_SOURCE', 'QUOTA_THRESHOLD', 'ALLOWED_ORIGINS', 'API_RUNTIME_SERVICE_ACCOUNT']) {
        if (!env[key]) throw new Error(`Configure ${key} in server/.env.`);
    }
    if (env.JWT_SECRET.length < 32 || env.JWT_SECRET.startsWith('REPLACE_WITH_')) throw new Error('Replace JWT_SECRET with a private random secret of at least 32 characters.');
    if (env.OWL_FIREBASE_PROJECT_ID !== 'finder-owl') throw new Error('These deployment scripts target finder-owl only.');
    if (env.ENABLE_CRON !== '0') throw new Error('Initial API deployment requires ENABLE_CRON=0.');
    for (const key of ['ENV_FILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'SERVICE_ACCOUNT_JSON', 'LOCAL_ADMIN_EMAIL', 'LOCAL_ADMIN_PASSWORD', 'LOCAL_DB_FILE']) {
        if (Object.hasOwn(env, key)) throw new Error(`Do not include ${key} in the Cloud Functions environment file.`);
    }
    for (const key of Object.keys(env)) {
        if (shell[key] !== undefined && shell[key] !== env[key]) {
            throw new Error(`Unset exported ${key} before deploying; it conflicts with server/.env.`);
        }
    }
    prepareFirebaseApi(env);
    // Do not accidentally upload renamed Admin SDK/ADC JSON credentials.
    function inspect(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const name = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) throw new Error('Remove symbolic links from server/ before deploying.');
            if (entry.isDirectory()) inspect(name);
            else if (entry.name.endsWith('.json')) {
                let data;
                try { data = JSON.parse(fs.readFileSync(name, 'utf8')); } catch (_) { continue; }
                if (data.private_key || data.refresh_token || data.type === 'service_account' || data.type === 'authorized_user') {
                    throw new Error('A credential JSON file is inside server/. Move it outside the deployment source.');
                }
            }
        }
    }
    inspect(source);
    return { project: env.OWL_FIREBASE_PROJECT_ID, profile: 'firebase-read-only' };
}

if (require.main === module) {
    try {
        const result = checkApiDeploy(path.resolve(__dirname, '..'));
        console.log(`Local API preflight passed: ${result.project}, ${result.profile}, API only, no maintenance. IAM, live Monitoring and route checks are still required.`);
    } catch (error) {
        console.error('API preflight failed:', error.message);
        process.exitCode = 1;
    }
}

module.exports = { checkApiDeploy };
