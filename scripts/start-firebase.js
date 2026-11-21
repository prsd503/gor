'use strict';
// Run the Node server on a MacBook against REAL Firebase (not offline mode).
const path = require('node:path');
process.chdir(path.resolve(__dirname, '..'));
process.env.ENV_FILE = process.env.ENV_FILE || '.env';
require('dotenv').config({ path: process.env.ENV_FILE, quiet: true });
process.env.DATA_BACKEND = 'firestore';
process.env.AUTH_MODE = 'firebase';
process.env.QUOTA_SOURCE = 'monitoring';
process.env.QUOTA_ACTION = process.env.QUOTA_ACTION || 'stop';
process.env.SERVE_STATIC = '1';
require('../server/index').start();
