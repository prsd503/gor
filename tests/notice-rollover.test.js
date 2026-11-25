'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { istDate, noticeCycle, effectiveNotice } = require('../server/lib/notices');
const { createMaintenance } = require('../server/lib/maintenance');
const { createLocalStore, createFieldValue } = require('../server/lib/local-store');
const at = s => new Date(s);

test('IST calendar date and notice cycle change together at midnight, not UTC or device timezone', () => {
    assert.equal(istDate(at('2026-11-24T18:29:59Z')), '2026-11-24');
    assert.equal(istDate(at('2026-11-24T18:30:00Z')), '2026-11-25');
    assert.equal(noticeCycle(at('2026-11-24T18:29:59Z')), '2026-11-24');
    assert.equal(noticeCycle(at('2026-11-24T18:30:00Z')), '2026-11-25');
    assert.equal(noticeCycle(at('2026-11-25T06:30:00Z')), '2026-11-25', 'no second rollover at noon');
    assert.equal(noticeCycle(at('2026-12-31T18:30:00Z')), '2027-01-01');
});

test('legacy notice remains today until midnight, then tomorrow becomes today and is cleared', () => {
    const data = {date:'2026-11-24', todayMessage:'Monday 24th', tomorrowMessage:'Tuesday 25th'};
    assert.deepEqual(effectiveNotice(data, at('2026-11-24T18:29:59Z')), {
        date:'2026-11-24', noticeCycle:'2026-11-24', todayMessage:'Monday 24th', tomorrowMessage:'Tuesday 25th', due:false
    });
    assert.deepEqual(effectiveNotice(data, at('2026-11-24T18:30:00Z')), {
        date:'2026-11-25', noticeCycle:'2026-11-25', todayMessage:'Tuesday 25th', tomorrowMessage:'', due:true
    });
    assert.equal(effectiveNotice(data, at('2026-11-25T18:30:00Z')).todayMessage, '', 'missed messages must not reappear days later');
    assert.equal(effectiveNotice({ ...data, noticeCycle:'2026-11-25' }, at('2026-11-25T06:30:00Z')).tomorrowMessage, 'Tuesday 25th', 'tomorrow remains queued at noon');
});

test('rollover is persisted once, survives concurrent runs, and keeps same-day admin edits', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notice-test-'));
    t.after(() => fs.rmSync(dir, { recursive:true, force:true }));
    const db = createLocalStore({ file:path.join(dir,'db.json') });
    const ref = db.collection('notices').doc('a');
    await ref.set({ date:'2026-11-24', noticeCycle:'2026-11-24', todayMessage:'today', tomorrowMessage:'tomorrow' });
    let clock = at('2026-11-24T18:29:59Z');
    const maintenance = createMaintenance({db, FieldValue:createFieldValue(), now:()=>clock, logger:{log(){},error(){}}});
    assert.equal(await maintenance.checkAndShiftNotices(), 0);
    clock = at('2026-11-24T18:30:00Z');
    assert.equal((await Promise.all([maintenance.checkAndShiftNotices(), maintenance.checkAndShiftNotices()])).reduce((a,b)=>a+b, 0), 1);
    let data = (await ref.get()).data();
    assert.equal(data.todayMessage, 'tomorrow');
    assert.equal(data.tomorrowMessage, '');
    assert.equal(data.date, '2026-11-25');
    await ref.update({todayMessage:'edited', tomorrowMessage:'next day'});
    assert.equal(await maintenance.checkAndShiftNotices(), 0);
    data = (await ref.get()).data();
    assert.equal(data.tomorrowMessage, 'next day');
    clock = at('2026-11-25T18:30:00Z');
    assert.equal(await maintenance.checkAndShiftNotices(), 1);
    assert.equal((await ref.get()).data().todayMessage, 'next day');
});
