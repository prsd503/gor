/* Firebase Cloud Functions entry point.
 *
 * Deploy using the production configuration in server/.env.firebase.example.
 * See docs/deployment.md. Do NOT deploy the MacBook development configuration.
 * Both functions use the same Express/data layer and quota guard.
 * minInstances=0 and maxInstances limit idle/scaling costs, not total spend.
 */
'use strict';

const { setGlobalOptions } = require('firebase-functions/v2');
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');

// Requiring the app builds the Express instance but does not listen (the listen
// call is guarded by `require.main === module`).
process.env.ENABLE_CRON = '0';
process.env.QUOTA_SOURCE = !process.env.QUOTA_SOURCE || process.env.QUOTA_SOURCE === 'auto' ? 'monitoring' : process.env.QUOTA_SOURCE;
const app = require('./index');

setGlobalOptions({
    region: process.env.FUNCTIONS_REGION || 'us-central1',
    maxInstances: Number(process.env.MAX_INSTANCES || 4),
    concurrency: Number(process.env.CONCURRENCY || 40),
    memory: process.env.FUNCTION_MEMORY || '256MiB',
    timeoutSeconds: Number(process.env.FUNCTION_TIMEOUT_SECONDS || 60),
    minInstances: 0
});

// `cors: false` because the Express app owns CORS (server/lib/security.js).
exports.api = onRequest({ cors: false }, (req, res) => {
    // Functions strips its /api function name. Accept /config there as well as
    // /api/config on the generated Cloud Run URL and emulators.
    if (!/^\/api(?:[/?]|$)/.test(req.url)) req.url = '/api' + req.url;
    return app(req, res);
});

// Replaces node-cron, which cannot run between requests on Cloud Functions.
exports.maintenance = onSchedule(
    {
        schedule: process.env.CRON_SCHEDULE || '0 0 * * *',
        timeZone: process.env.CRON_TIMEZONE || 'Asia/Kolkata',
        retryCount: 1
    },
    async () => {
        await app.maintenance.runAll();
    }
);
