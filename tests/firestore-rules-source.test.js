'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'firebase.rules.json'), 'utf8'));
const rules = fs.readFileSync(path.join(root, config.firestore.rules), 'utf8');

test('Rules deployment config is isolated from Functions and Hosting', () => {
    assert.deepEqual(Object.keys(config), ['firestore']);
    assert.deepEqual(Object.keys(config.firestore), ['rules']);
    assert.equal(config.firestore.rules, 'firestore.rules');
    assert.ok(fs.existsSync(path.join(root, config.firestore.rules)));
});

test('candidate client Rules deny by default and never permit writes', () => {
    assert.match(rules, /match \/\{document=\*\*\}\s*\{\s*allow read, write: if false;/);
    assert.doesNotMatch(rules, /allow\s+(?:create|update|delete|write)\s*:\s*if\s+true\s*;/);
    assert.match(rules, /match \/app_config\/appVersion\s*\{\s*allow get: if true;/);
    assert.match(rules, /match \/ads\/Aangan\s*\{\s*allow get: if true;/);
    assert.match(rules, /match \/settings\/contact\s*\{\s*allow get: if true;/);
});
