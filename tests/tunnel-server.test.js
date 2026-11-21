'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createLocalStore,createFieldValue}=require('../server/lib/local-store');

test('real preview server enforces gate/CORS/limiter before Firebase and preserves public ad read',async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'owl-preview-'));
    const db=createLocalStore({file:path.join(dir,'db.json')});
    await db.collection('ads').doc('global').set({items:[{imageUrl:'https://example.com/ad.jpg'}]});
    let collections=0,checks=0,authChecks=0;
    const rawCollection=db.collection;
    db.collection=(...args)=>{collections++;return rawCollection(...args);};
    Object.assign(process.env,{
        ENV_FILE:path.join(dir,'no-env'),JWT_SECRET:'preview-test-secret-'.repeat(4),
        NODE_ENV:'production',DATA_BACKEND:'firestore',AUTH_MODE:'firebase',
        APP_CHECK_MODE:'monitor',QUOTA_ACTION:'stop',QUOTA_SOURCE:'monitoring',
        QUOTA_THRESHOLD:'0.8',QUOTA_STATE_FILE:'',TUNNEL_PREVIEW:'1',
        SERVE_STATIC:'0',ENABLE_CRON:'0',TRUST_PROXY_HOPS:'1',FIREBASE_PROJECT_ID:'finder-owl'
    });
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.SERVICE_ACCOUNT_JSON;
    const Module=require('node:module'),original=Module._load;
    Module._load=function(name,...args){
        if(name==='firebase-admin/app')return {initializeApp:()=>({}),applicationDefault:()=>({getAccessToken:async()=>({access_token:'mock'})})};
        if(name==='firebase-admin/firestore')return {getFirestore:()=>db,FieldValue:createFieldValue()};
        if(name==='firebase-admin/auth')return {getAuth:()=>({verifyIdToken:async()=>{authChecks++;throw new Error('no auth in preview');}})};
        if(name==='./lib/gcp-monitoring')return {createMonitoringUsageFetcher:()=>async()=>{checks++;return {reads:0,writes:0,deletes:0,invocations:0,egressBytes:0};}};
        return original.call(this,name,...args);
    };
    t.after(()=>{Module._load=original;});
    const app=require('../server/index');
    const server=app.listen(0,'0.0.0.0');await new Promise(resolve=>server.once('listening',resolve));
    t.after(async()=>{app.quota.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});fs.rmSync(dir,{recursive:true,force:true});});
    const base=`http://127.0.0.1:${server.address().port}`;
    for(const [method,url] of [['GET','/api/admins'],['GET','/api/vehicles'],['GET','/api/quota'],['GET','/api/notices/Test'],['GET','/.env.macbook'],['GET','/local-test.html'],['POST','/api/auth/token'],['POST','/api/vehicles'],['POST','/api/config']]){
        const response=await fetch(base+url,{method,headers:{Origin:'https://prsd503.github.io',Authorization:'Bearer invalid'}});
        assert.equal(response.status,403,url);
        assert.equal((await response.json()).code,'tunnel-preview-restricted');
    }
    assert.equal(collections,0);assert.equal(checks,0);assert.equal(authChecks,0);
    const cors=await fetch(base+'/api/ads/global',{headers:{Origin:'https://attacker.ngrok-free.dev'}});
    assert.equal(cors.status,403);assert.equal(checks,0);
    const ads=await fetch(base+'/api/ads/global',{headers:{Origin:'https://prsd503.github.io','ngrok-skip-browser-warning':'true'}});
    assert.equal(ads.status,200);
    assert.equal(ads.headers.get('access-control-allow-origin'),'https://prsd503.github.io');
    assert.deepEqual(await ads.json(),[{imageUrl:'https://example.com/ad.jpg'}]);
    assert.equal(collections,1);assert.equal(checks,1);
    const health=await fetch(base+'/api/health');
    assert.equal(health.status,200);
    assert.equal((await health.json()).accessMode,'tunnel-preview');
    let last;
    for(let i=0;i<61;i++) last=await fetch(base+'/api/health');
    assert.equal(last.status,429);
});
