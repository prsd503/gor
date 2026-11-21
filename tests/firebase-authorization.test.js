'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const jwt=require('jsonwebtoken');
const {createLocalStore,createFieldValue}=require('../server/lib/local-store');

// Test the actual exchange route with mocked Firebase verification/storage.
// No production accounts, credentials, Google requests or Firestore quota.
test('Firebase exchange does not escalate an ordinary user, including on subsequent backend JWT use',async t=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'owl-auth-'));
    const db=createLocalStore({file:path.join(dir,'db.json')});
    const secret='test-secret-'.repeat(6);
    Object.assign(process.env,{
        ENV_FILE:path.join(dir,'no-env'),JWT_SECRET:secret,NODE_ENV:'development',
        DATA_BACKEND:'firestore',AUTH_MODE:'firebase',APP_CHECK_MODE:'off',
        FIREBASE_PROJECT_ID:'finder-owl',ADMIN_UIDS:'trusted-owner',
        QUOTA_ACTION:'off',QUOTA_SOURCE:'local',SERVE_STATIC:'0',ENABLE_CRON:'0',
        QUOTA_STATE_FILE:'',TUNNEL_PREVIEW:'0'
    });
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.SERVICE_ACCOUNT_JSON;
    const Module=require('node:module'),original=Module._load;
    Module._load=function(name,...args){
        if(name==='firebase-admin/app')return {initializeApp:()=>({}),applicationDefault:()=>({getAccessToken:async()=>({access_token:'mock-only'})})};
        if(name==='firebase-admin/firestore')return {getFirestore:()=>db,FieldValue:createFieldValue()};
        if(name==='firebase-admin/auth')return {getAuth:()=>({verifyIdToken:async token=>{
            if(token==='signed-by-google-owner')return {uid:'trusted-owner',email:'owner@example.com'};
            if(token==='signed-by-google-regular')return {uid:'regular',email:'regular@example.com'};
            throw new Error('invalid');
        }})};
        return original.call(this,name,...args);
    };
    // Keep the mock active while asynchronous route verification runs.
    t.after(()=>{Module._load=original;});
    const app=require('../server/index');
    const server=app.listen(0,'0.0.0.0');await new Promise(r=>server.once('listening',r));
    t.after(async()=>{app.quota.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});fs.rmSync(dir,{recursive:true,force:true});});
    const base=`http://127.0.0.1:${server.address().port}`;
    async function exchange(idToken){
        const response=await fetch(base+'/api/auth/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken})});
        assert.equal(response.status,200);return (await response.json()).token;
    }
    async function write(token){return fetch(base+'/api/config',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({teamPhone:'test'})});}
    const regular=await exchange('signed-by-google-regular');
    assert.equal(jwt.verify(regular,secret).role,'user');
    assert.equal((await write(regular)).status,403);
    assert.equal((await db.collection('configs').doc('owlwatcher').get()).exists,false);
    const owner=await exchange('signed-by-google-owner');
    assert.equal(jwt.verify(owner,secret).role,'admin');
    assert.equal((await write(owner)).status,200);
    assert.equal((await db.collection('configs').doc('owlwatcher').get()).data().teamPhone,'test');
});
