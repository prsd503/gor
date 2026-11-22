'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire, Module } = require('node:module');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server/lib/maintenance.js'), 'utf8');
const silent = { log() {}, error() {} };

function maintenanceWith(cron, options = {}) {
    // Keep callbacks in the same realm as cron: v4 uses instanceof Function
    // to distinguish an inline callback from a background-task filename.
    const module = new Module(path.join(root, 'server/lib/maintenance.js'));
    module.require = name => { assert.equal(name, 'node-cron'); return cron; };
    module._compile(source, module.id);
    return module.exports.createMaintenance({ db: {}, logger: silent, ...options });
}

test('v4 scheduler starts via schedule(), keeps midnight/timezone, and enables asynchronous overlap protection', async () => {
    let registered;
    const marker = {};
    const maintenance = maintenanceWith({ schedule(expression, callback, options) {
        registered = { expression, callback, options };
        return marker;
    } }, { beforeRun: async () => false });
    assert.equal(maintenance.schedule(), marker, 'caller retains task lifecycle controls');
    assert.equal(registered.expression, '0 0 * * *');
    assert.equal(registered.options.timezone, 'Asia/Kolkata');
    assert.equal(registered.options.noOverlap, true);
    assert.equal('scheduled' in registered.options, false, 'removed v3 option is not passed');
    const work = registered.callback();
    assert.equal(typeof work.then, 'function', 'v4 must receive the complete asynchronous job');
    assert.equal((await work).skipped, 'quota-drain');
});

test('scheduled callback stays pending until quota/job work finishes and catches rejected runs', async () => {
    let callback, release;
    const maintenance = maintenanceWith({ schedule(_expression, fn) { callback = fn; } }, {
        beforeRun: () => new Promise(resolve => { release = resolve; })
    });
    maintenance.schedule();
    let settled = false;
    const work = callback().then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    release(false);
    await work;
    assert.equal(settled, true);

    const failing = maintenanceWith({ schedule(_expression, fn) { callback = fn; } }, {
        db: { collection() { throw new Error('test database failure'); } }
    });
    failing.schedule();
    await assert.doesNotReject(() => callback());
});

for (const [name, manifest] of [['MacBook/test install', 'package.json'], ['deployed backend install', 'server/package.json']]) {
    test(name + ': actual node-cron v4 supports start/stop/destroy, timezone and quota-skip execution', async t => {
        const localRequire = createRequire(path.join(root, manifest));
        const cron = localRequire('node-cron');
        assert.equal(typeof cron.createTask, 'function', 'uses the v4 API');
        let runs = 0;
        const maintenance = maintenanceWith(cron, {
            beforeRun: async () => { runs++; return false; }
        });
        const task = maintenance.schedule();
        t.after(async () => { await task.destroy(); });
        assert.equal(task.getStatus(), 'idle', 'schedule automatically starts');
        assert.equal(runs, 0, 'scheduling does not immediately mutate data');
        const next = task.getNextRun();
        assert.ok(next instanceof Date);
        assert.equal(new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Kolkata', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit'
        }).format(next), '00:00:00');
        await task.stop();
        assert.equal(task.getStatus(), 'stopped');
        await task.start();
        assert.equal(task.getStatus(), 'idle');
        await task.execute();
        assert.equal(runs, 1, 'manual test uses the real task callback, with quota preventing DB work');
        await task.destroy();
        assert.equal(task.getStatus(), 'destroyed');
        assert.throws(() => maintenance.schedule('not-a-cron'));
    });
}

test('custom schedule expression and timezone are preserved by the adapter', () => {
    let registered;
    const maintenance = maintenanceWith({ schedule(expression, _callback, options) {
        registered = { expression, options };
    } }, { timeZone: 'UTC' });
    maintenance.schedule('30 4 * * *');
    assert.equal(registered.expression, '30 4 * * *');
    assert.equal(registered.options.timezone, 'UTC');
});
