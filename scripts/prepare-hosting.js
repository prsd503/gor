'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { ROOT_FILES } = require('../server/lib/public-files');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.firebase-public');
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const name of ROOT_FILES.filter(name => name !== 'local-test.html')) {
    fs.copyFileSync(path.join(root, name), path.join(output, name));
}
fs.cpSync(path.join(root, 'assets'), path.join(output, 'assets'), { recursive: true, dereference: true });
console.log('Prepared public files in .firebase-public (no server code, credentials or local data).');
