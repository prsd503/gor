'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLimits, evaluate, emptyUsage, rollUsage, dayKey, normalizeThreshold } = require('../server/lib/quota-policy');
const { createQuotaGuard } = require('../server/lib/quota-guard');
const { createLocalStore, createFieldValue } = require('../server/lib/local-store');
const { createDbLayer } = require('../server/lib/db-layer');
const { createMaintenance } = require('../server/lib/maintenance');
const { createMonitoringUsageFetcher, METRICS, startOfPacificDay } = require('../server/lib/gcp-monitoring');
const { isPublicPath } = require('../server/lib/public-files');
const silent = { log() {}, warn() {}, error() {} };

function store(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owl-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return createLocalStore({file:path.join(dir, 'db.json'), logger:silent});
}
async function serve(t, app) {
    const server = app.listen(0, '0.0.0.0');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return `http://127.0.0.1:${server.address().port}`;
}

test('cutoff is inclusive at exactly 80% for every configured meter', () => {
    const limits = readLimits();
    for (const [key, limit] of Object.entries({reads:50000,writes:20000,deletes:20000,invocations:2000000,egressBytes:5e9})) {
        const usage = {...emptyUsage(), [key]:limit * 0.8 - 1};
        assert.notEqual(evaluate({usage,limits}).level, 'stop', key);
        usage[key]++;
        assert.equal(evaluate({usage,limits}).level, 'stop', key);
        usage[key]++;
        assert.equal(evaluate({usage,limits}).level, 'stop', key);
    }
});

test('warn at 60%, invalid thresholds default safely, limits can be lowered for tests', () => {
    assert.equal(normalizeThreshold('bad'), 0.8);
    assert.equal(normalizeThreshold(2), 1);
    const limits = readLimits({QUOTA_DAILY_READ_LIMIT:'10'});
    assert.equal(evaluate({usage:{reads:6},limits}).level, 'warn');
    assert.equal(evaluate({usage:{reads:8},limits}).level, 'stop');
});

test('Firestore counters reset at Pacific midnight, not UTC midnight', () => {
    const first = new Date('2026-11-20T23:30:00Z');
    const usage = {...emptyUsage(first), reads:40000, writes:2, invocations:100};
    assert.equal(dayKey(new Date('2026-11-21T07:59:59Z')), '2026-11-20');
    assert.equal(rollUsage(usage,new Date('2026-11-21T07:59:59Z')).reads,40000);
    const next = rollUsage(usage,new Date('2026-11-21T08:00:00Z'));
    assert.equal(next.reads,0);
    assert.equal(next.invocations,100);
    assert.equal(rollUsage(usage,new Date('2026-12-01T08:00:00Z')).invocations,0);
    assert.equal(startOfPacificDay(new Date('2026-06-01T15:00:00Z')).toISOString(),'2026-06-01T07:00:00.000Z');
    assert.equal(startOfPacificDay(new Date('2026-11-21T15:00:00Z')).toISOString(),'2026-11-21T08:00:00.000Z');
});

test('guard blocks before handlers, advertises fallback and keeps diagnostics reachable', async t => {
    const guard = createQuotaGuard({env:{},fallbackUrls:['https://mac.example/api']});
    t.after(guard.close);
    guard.record({reads:40000});
    let calls=0;
    const app=express(); app.use(guard.middleware);
    app.get('/api/config',(req,res)=>{calls++;res.json({ok:true});});
    app.get('/api/quota',guard.handler);
    app.get('/health',(req,res)=>res.json({ok:true}));
    const base=await serve(t,app);
    const response=await fetch(base+'/api/config');
    assert.equal(response.status,503);
    assert.equal(response.headers.get('x-owl-drain'),'1');
    assert.equal(response.headers.get('retry-after'),'3600');
    const data=await response.json();
    assert.equal(data.code,'quota-threshold-reached');
    assert.deepEqual(data.fallback,['https://mac.example/api']);
    assert.equal(calls,0);
    assert.equal((await fetch(base+'/health')).status,200);
    assert.equal((await fetch(base+'/api/quota')).status,200);
});

test('monitor/off report high usage without blocking', () => {
    for (const action of ['monitor','off']) {
        const guard=createQuotaGuard({env:{},action});
        guard.record({writes:16000});
        assert.equal(guard.snapshot().level,'stop');
        assert.equal(guard.isDraining(),false);
        guard.close();
    }
});

test('monitoring source fails closed on cold start and errors, then recovers', async () => {
    let fail=true;
    const guard=createQuotaGuard({env:{},source:'monitoring',logger:silent,fetchUsage:async()=>{
        if(fail) throw new Error('permission denied');
        return {reads:1,writes:0,deletes:0,invocations:0,egressBytes:0};
    }});
    assert.equal(guard.isDraining(),true);
    await guard.refresh();
    assert.equal(guard.snapshot().monitoringUnavailable,true);
    fail=false; await guard.refresh(true);
    assert.equal(guard.isDraining(),false);
    guard.close();
});

test('first protected request waits for monitoring and concurrent refreshes coalesce', async t => {
    let resolveUsage, checks=0;
    const usage=new Promise(resolve=>resolveUsage=resolve);
    const guard=createQuotaGuard({env:{},source:'monitoring',logger:silent,fetchUsage:()=>{checks++;return usage;}});
    t.after(guard.close);
    const app=express();app.use(guard.middleware);app.get('/api/config',(req,res)=>res.json({ok:true}));
    const base=await serve(t,app);
    const first=guard.refresh();const second=guard.refresh();
    assert.equal(first,second);
    resolveUsage({reads:40000});await first;
    const response=await fetch(base+'/api/config');
    assert.equal(response.status,503);
    assert.equal(checks,1);
});

test('remote daily counts expire at reset, while monthly usage still drains', async () => {
    let clock=new Date('2026-11-21T07:59:00Z');
    const guard=createQuotaGuard({env:{},source:'monitoring',now:()=>clock,fetchUsage:async()=>({reads:40000,invocations:10})});
    await guard.refresh();assert.equal(guard.isDraining(),true);
    clock=new Date('2026-11-21T08:01:00Z');
    assert.equal(guard.snapshot().usage.reads,0);
    guard.close();
});

test('local store persists CRUD, filters, timestamps, deletes and snapshot isolation', async t => {
    const db=store(t);const fv=createFieldValue();const ref=db.collection('items').doc('one');
    await ref.set({name:'A', rank:2,createdAt:fv.serverTimestamp()});
    const old=await ref.get();
    await ref.update({rank:3});
    assert.equal(old.data().rank,2);
    assert.match((await ref.get()).data().createdAt,/^\d{4}-/);
    await ref.set({extra:true},{merge:true});
    await ref.update({name:fv.delete()});
    assert.equal((await ref.get()).data().name,undefined);
    await db.collection('items').add({rank:1});
    const query=await db.collection('items').where('rank','>',0).orderBy('rank').limit(1).get();
    assert.equal(query.docs[0].data().rank,1);
    const reloaded=createLocalStore({file:db.file});
    assert.equal((await reloaded.collection('items').doc('one').get()).data().extra,true);
    await ref.delete();assert.equal((await ref.get()).exists,false);
});

test('local transactions serialize concurrent claims and rollback on errors', async t => {
    const db=store(t);const ref=db.collection('codes').doc('123');await ref.set({used:false});
    const claim=()=>db.runTransaction(async tx=>{
        const snap=await tx.get(ref);
        if(snap.data().used)return false;
        tx.update(ref,{used:true});return true;
    });
    assert.deepEqual(await Promise.all([claim(),claim()]),[true,false]);
    await assert.rejects(db.runTransaction(async tx=>{tx.update(ref,{used:false});throw new Error('rollback');}));
    assert.equal((await ref.get()).data().used,true);
});

test('failed local batches rollback all changes', async t => {
    const db=store(t);const ref=db.collection('items').doc('one');
    const batch=db.batch();batch.set(ref,{x:1});batch.update(db.collection('items').doc('missing'),{x:2});
    await assert.rejects(batch.commit());assert.equal((await ref.get()).exists,false);
});

test('a write queued during a failed transaction is not lost', async t => {
    const db=store(t);const ref=db.collection('items').doc('one');await ref.set({value:1});
    let entered;const started=new Promise(r=>entered=r);let release;const gate=new Promise(r=>release=r);
    const transaction=db.runTransaction(async tx=>{tx.update(ref,{value:2});entered();await gate;throw new Error('rollback');});
    await started;
    const write=db.collection('items').doc('two').set({value:3});
    release();await assert.rejects(transaction);await write;
    assert.equal((await db.collection('items').doc('two').get()).data().value,3);
    assert.equal((await ref.get()).data().value,1);
});

test('corrupt local data refuses startup instead of resetting', t => {
    const db=store(t);fs.writeFileSync(db.file,'{oops');
    assert.throws(()=>createLocalStore({file:db.file}),/could not be read/);
});

test('db layer counts minimum query read, caches reads and invalidates after writes/transactions', async t => {
    const raw=store(t);let clock=0;const layer=createDbLayer(raw,{ttlMs:20,now:()=>clock});
    const db=layer.db, ref=db.collection('items').doc('one');
    await db.collection('items').get();assert.equal(layer.counters.reads,1);
    await ref.set({value:1});await ref.get();await ref.get();
    assert.equal(layer.counters.reads,2);assert.equal(layer.counters.writes,1);
    clock=21;await ref.get();assert.equal(layer.counters.reads,3);
    await ref.update({value:2});assert.equal((await ref.get()).data().value,2);
    await db.runTransaction(async tx=>{await tx.get(ref);tx.update(ref,{value:3});});
    assert.equal((await ref.get()).data().value,3);
    const batch=db.batch();batch.delete(ref);await batch.commit();
    assert.equal(layer.counters.deletes,1);assert.equal((await ref.get()).exists,false);
});

test('maintenance skips all work during quota drain', async t => {
    const db=store(t);
    const maintenance=createMaintenance({db,FieldValue:createFieldValue(),beforeRun:async()=>false,logger:silent});
    assert.equal((await maintenance.runAll()).skipped,'quota-drain');
});

test('maintenance shifts yesterday notice once and removes only expired bookings', async t => {
    const db=store(t), fv=createFieldValue();
    await db.collection('notices').doc('society').set({date:'2020-01-01',todayMessage:'old',tomorrowMessage:'new'});
    await db.collection('bookings').doc('old').set({end:'2020-01-01'});
    await db.collection('bookings').doc('future').set({end:'2099-01-01'});
    const maintenance=createMaintenance({db,FieldValue:fv,logger:silent});
    assert.deepEqual(await maintenance.runAll(),{noticesShifted:1,bookingsDeleted:1});
    assert.equal((await db.collection('notices').doc('society').get()).data().todayMessage,'new');
    assert.equal((await maintenance.runAll()).noticesShifted,0);
});

test('Monitoring handles pagination, v2 metrics, auth and Pacific windows', async () => {
    const calls=[];
    const fetchUsage=createMonitoringUsageFetcher({projectId:'test-project',now:()=>new Date('2026-11-21T12:00:00Z'),getAccessToken:async()=>({access_token:'token'}),logger:silent,
        fetchImpl:async (url,init)=>{
            const parsed=new URL(url);calls.push({parsed,init});
            return {ok:true,json:async()=>({timeSeries:[{points:[{value:{int64Value:'3'}}]}],...(parsed.searchParams.has('pageToken')?{}:{nextPageToken:'page2'})})};
        }});
    const result=await fetchUsage();
    assert.equal(result.reads,6);assert.equal(result.egressBytes,6);assert.equal(calls.length,10);
    assert.ok(calls.some(c=>c.parsed.searchParams.get('filter').includes(METRICS.invocations)));
    assert.equal(calls[0].parsed.searchParams.get('interval.startTime'),'2026-11-21T08:00:00.000Z');
    assert.equal(calls[0].init.headers.Authorization,'Bearer token');
});

test('Monitoring HTTP errors propagate to fail-closed guard', async () => {
    const fetchUsage=createMonitoringUsageFetcher({getAccessToken:async()=>'token',fetchImpl:async()=>({ok:false,status:403}),logger:silent});
    await assert.rejects(fetchUsage(),/Monitoring API 403/);
});

test('static allowlist blocks source, credentials, encoded bypasses and traversal', () => {
    for(const value of ['/server/index.js','/%73erver/index.js','/.env','/serviceAccountKey.json','/assets/../server/index.js','/assets/%2e%2e/server/index.js','/package.json','/firebase.json']) assert.equal(isPublicPath(value),false,value);
    for(const value of ['/','/admin','/index.html','/api-env.js','/assets/flowers/rose.png']) assert.equal(isPublicPath(value),true,value);
});
