/* Full-feature Firebase HTTP API entry point.
 * See docs/firebase-api-full-release.md. All private routes remain protected
 * by verified Firebase identity and Firestore-backed membership/society checks.
 * No scheduled function is exported; process maintenance remains disabled.
 */
'use strict';

require('dotenv').config({ path: process.env.ENV_FILE || '.env', quiet: true });
const { prepareFirebaseApi } = require('./lib/firebase-release');
const release = prepareFirebaseApi(process.env);
const { setGlobalOptions } = require('firebase-functions/v2');
const { onRequest } = require('firebase-functions/v2/https');
const app = require('./index');

setGlobalOptions({
    region: 'us-central1',
    serviceAccount: release.serviceAccount,
    maxInstances: Number(process.env.MAX_INSTANCES),
    concurrency: Number(process.env.CONCURRENCY),
    memory: '256MiB',
    timeoutSeconds: 60,
    minInstances: 0
});

// Hosting preserves /api/...; the direct Function URL strips its /api name.
// Normalize once so both transports use the same gated Express routes.
exports.api = onRequest({ cors: false, invoker: 'public' }, (req, res) => {
    if (!/^\/api(?:[/?]|$)/.test(req.url)) req.url = '/api' + req.url;
    return app(req, res);
});
