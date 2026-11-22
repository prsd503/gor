'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');

for (const manifest of ['package.json', 'server/package.json']) {
    test(manifest + ': production SDKs load without install scripts or cloud requests', () => {
        // Imports only: no app initialization, ADC access, requests or live data.
        const localRequire = createRequire(path.resolve(__dirname, '..', manifest));
        assert.equal(typeof localRequire('firebase-admin/app').initializeApp, 'function');
        assert.equal(typeof localRequire('firebase-admin/auth').getAuth, 'function');
        assert.equal(typeof localRequire('firebase-admin/firestore').getFirestore, 'function');
        assert.equal(typeof localRequire('firebase-admin/app-check').getAppCheck, 'function');
        assert.equal(typeof localRequire('node-cron').schedule, 'function');
        if (manifest.startsWith('server/')) {
            assert.equal(typeof localRequire('firebase-functions/v2/https').onRequest, 'function');
        }
    });
}
