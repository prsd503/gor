'use strict';
// One process, one local database file. No Firebase credentials are needed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
process.chdir(root);
const file = path.resolve(process.env.ENV_FILE || '.env.local');
if (!fs.existsSync(file)) {
    fs.writeFileSync(file, [
        '# Generated for local testing only. Never commit this file.',
        `JWT_SECRET=${crypto.randomBytes(48).toString('hex')}`,
        'LOCAL_ADMIN_EMAIL=admin@local.test',
        `LOCAL_ADMIN_PASSWORD=${crypto.randomBytes(18).toString('hex')}`,
        'PORT=3000',
        ''
    ].join('\n'), { mode: 0o600, flag: 'wx' });
    console.log(`Created ${file}. The local test login is in that file.`);
}
require('dotenv').config({ path: file, quiet: true });
process.env.ENV_FILE = file;
process.env.NODE_ENV = 'development';
process.env.DATA_BACKEND = 'local';
process.env.AUTH_MODE = 'local';
process.env.APP_CHECK_MODE = 'off';
process.env.SERVE_STATIC = '1';
process.env.QUOTA_SOURCE = 'local';
process.env.QUOTA_ACTION = process.env.QUOTA_ACTION || 'off';
process.env.ENABLE_CRON = process.env.ENABLE_CRON || '1';
console.log('Local testing only. Do not expose this dev login on the public Internet.');
console.log(`Open http://localhost:${process.env.PORT || 3000}/local-test.html`);
require('../server/index').start();
