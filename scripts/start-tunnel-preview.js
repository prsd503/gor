'use strict';
// Use ngrok only with this restricted profile for the first public connection.
const path = require('node:path');
process.chdir(path.resolve(__dirname, '..'));
process.env.ENV_FILE = process.env.ENV_FILE || '.env.macbook';
require('dotenv').config({ path: process.env.ENV_FILE, quiet: true });
Object.assign(process.env, {
    NODE_ENV: 'production',
    DATA_BACKEND: 'firestore',
    AUTH_MODE: 'firebase',
    TUNNEL_PREVIEW: '1',
    QUOTA_SOURCE: 'monitoring',
    QUOTA_ACTION: 'stop',
    SERVE_STATIC: '0',
    ENABLE_CRON: '0',
    TRUST_PROXY_HOPS: '1',
    // monitor is acceptable only for this restricted public-content preview;
    // it must not be used as a substitute for identity/authorization checks.
    APP_CHECK_MODE: process.env.APP_CHECK_MODE || 'monitor'
});
console.log('RESTRICTED TUNNEL PREVIEW: only health, app-version and public ads are enabled.');
console.log('Vehicle search, admin/guard records, login, gift redemption and all writes return 403.');
console.log('Firewall/proxy access control and quota monitoring are still required; this is not a billing cap.');
require('../server/index').start();
