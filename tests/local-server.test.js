'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

test('real Express app runs without Firebase: login, CRUD, gift code and drain', async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'owl-http-'));
    Object.assign(process.env,{
        ENV_FILE:path.join(dir,'no-env'),JWT_SECRET:'test-secret-'.repeat(6),
        DATA_BACKEND:'local',AUTH_MODE:'local',LOCAL_ADMIN_EMAIL:'admin@local.test',
        LOCAL_ADMIN_PASSWORD:'a-long-testing-password',APP_CHECK_MODE:'off',
        LOCAL_DB_FILE:path.join(dir,'db.json'),QUOTA_STATE_FILE:'',
        QUOTA_ACTION:'stop',QUOTA_SOURCE:'local',SERVE_STATIC:'1',ENABLE_CRON:'0'
    });
    // Throw if the local server attempts to initialize the Admin SDK.
    const Module=require('node:module');const original=Module._load;
    Module._load=function(name,...args){if(name.startsWith('firebase-admin'))throw new Error('Firebase must not load locally');return original.call(this,name,...args);};
    let app;
    try{app=require('../server/index');}finally{Module._load=original;}
    const server=app.listen(0,'0.0.0.0');await new Promise(r=>server.once('listening',r));
    t.after(async()=>{app.quota.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});fs.rmSync(dir,{recursive:true,force:true});});
    const base=`http://127.0.0.1:${server.address().port}`;
    const request=(url,method='GET',data,token)=>fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(data?{body:JSON.stringify(data)}:{})});
    const health=await (await request('/api/health')).json();assert.equal(health.dataBackend,'local');
    assert.equal((await request('/api/config','POST',{teamPhone:'123'})).status,401);
    assert.equal((await request('/api/auth/token','POST',{email:'admin@local.test',password:'wrong'})).status,401);
    const login=await request('/api/auth/token','POST',{email:'admin@local.test',password:'a-long-testing-password'});
    assert.equal(login.status,200);const {token}=await login.json();assert.ok(token);
    assert.equal((await request('/api/config','POST',{teamPhone:'123'},token)).status,200);
    assert.equal((await (await request('/api/config')).json()).teamPhone,'123');
    const codes=await (await request('/api/gift-codes','POST',{count:1},token)).json();
    const code=codes.created[0];
    assert.equal((await request('/api/gift-codes/redeem','POST',{code})).status,200);
    assert.notEqual((await request('/api/gift-codes/redeem','POST',{code})).status,200);
    for(const url of ['/server/index.js','/%73erver/index.js','/.env','/package.json'])assert.equal((await fetch(base+url)).status,404,url);
    const config=await (await fetch(base+'/api-env.js')).text();assert.match(config,/location.origin/);
    const cors=await fetch(base+'/api/config',{headers:{Origin:base}});assert.equal(cors.status,200);
    assert.equal((await fetch(base+'/local-test.html')).status,200);
    app.quota.record({reads:40000});
    assert.equal((await request('/api/config')).status,503);
    assert.equal((await request('/api/health')).status,200);
    assert.equal((await request('/api/quota')).status,200);
    // Auth token exchange is also blocked, before any credentials are verified.
    assert.equal((await request('/api/auth/token','POST',{})).status,503);
});
