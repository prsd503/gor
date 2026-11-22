'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cors = require('cors');
const { createPreviewGate, previewAllowed, validatePreviewConfig } = require('../server/lib/tunnel-preview');
const { createOriginChecker } = require('../server/lib/security');
const { normalizePublicApi, apiConfigSource } = require('../scripts/configure-api');

const valid = {
    DATA_BACKEND:'firestore', AUTH_MODE:'firebase', QUOTA_SOURCE:'monitoring',
    QUOTA_ACTION:'stop', SERVE_STATIC:'0', ENABLE_CRON:'0', TRUST_PROXY_HOPS:'1',
    APP_CHECK_MODE:'monitor', QUOTA_THRESHOLD:'0.8'
};

test('preview configuration rejects unsafe combinations and a higher cutoff', () => {
    assert.doesNotThrow(() => validatePreviewConfig(valid));
    for (const key of Object.keys(valid)) {
        assert.throws(() => validatePreviewConfig({...valid, [key]:'unsafe'}), /Tunnel preview requires/, key);
    }
    assert.throws(() => validatePreviewConfig({...valid, QUOTA_THRESHOLD:'0.9'}));
    assert.throws(() => validatePreviewConfig({...valid, AUTH_MODE:'local'}));
    assert.throws(() => validatePreviewConfig({...valid, QUOTA_ACTION:'off'}));
    assert.throws(() => validatePreviewConfig({...valid, ENABLE_CRON:'1'}));
    assert.doesNotThrow(() => validatePreviewConfig({...valid, APP_CHECK_MODE:'enforce'}));
});

test('preview allows only exact public GET/HEAD paths', () => {
    for (const url of ['/api/health','/health','/api/app-version','/api/ads/global','/api/ads/local/Aangan','/api/ads/greeting/society_1-hello']) {
        assert.equal(previewAllowed('GET',url),true,url);
        assert.equal(previewAllowed('HEAD',url),true,url);
        for (const method of ['POST','PUT','PATCH','DELETE','TRACE']) assert.equal(previewAllowed(method,url),false);
    }
    for (const url of ['/','/api/quota','/api/config','/api/admins','/api/guards','/api/vehicles','/api/bookings','/api/notices/Aangan','/api/auth/token','/api/gift-codes/validate','/api/gift-codes/redeem','/server/index.js','/.env.macbook','/api/%61ds/global','/api/ads/global/private','/api/ads/local/a%2Fb','/api/ads/local/a.b','/api/ads/local/../global']) {
        assert.equal(previewAllowed('GET',url),false,url);
    }
});

test('preview gate blocks private endpoints before downstream Firebase/auth/handlers', async t => {
    const app=express(); let downstream=0;
    const allowed=createOriginChecker([], {allowNgrok:false,exactOrigins:['https://prsd503.github.io']});
    app.use(cors({origin:(origin,cb)=>cb(null,allowed(origin)),allowedHeaders:['Authorization','Content-Type','ngrok-skip-browser-warning']}));
    app.use(createPreviewGate());
    app.use((req,res)=>{downstream++;res.json({ok:true});});
    const server=app.listen(0,'0.0.0.0');await new Promise(resolve=>server.once('listening',resolve));
    t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
    const base=`http://127.0.0.1:${server.address().port}`;
    const good=await fetch(base+'/api/ads/global',{headers:{Origin:'https://prsd503.github.io'}});
    assert.equal(good.status,200);assert.equal(good.headers.get('access-control-allow-origin'),'https://prsd503.github.io');
    for(const [method,url] of [['GET','/api/vehicles'],['POST','/api/config'],['POST','/api/auth/token'],['GET','/api/notices/Test'],['GET','/.env.macbook']]) {
        const response=await fetch(base+url,{method,headers:{Authorization:'Bearer some-token'}});
        assert.equal(response.status,403,url);
        assert.equal((await response.json()).code,'tunnel-preview-restricted');
    }
    assert.equal(downstream,1);
    const preflight=await fetch(base+'/api/ads/global',{method:'OPTIONS',headers:{Origin:'https://prsd503.github.io','Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'ngrok-skip-browser-warning'}});
    assert.equal(preflight.status,204);
});

test('tunnel preview exact CORS does not trust arbitrary ngrok origins', () => {
    const allowed=createOriginChecker(['https://evil.example'],{allowNgrok:false,exactOrigins:['https://prsd503.github.io']});
    assert.equal(allowed('https://prsd503.github.io'),true);
    assert.equal(allowed(),true); // CORS is not authentication; curl has no Origin.
    for(const origin of ['https://evil.example','https://elsewhere.ngrok-free.dev','https://prsd503.github.io.evil.example','http://localhost']) assert.equal(allowed(origin),false);
});

test('endpoint helper normalizes HTTPS origin, never embeds credentials', () => {
    assert.equal(normalizePublicApi('https://owl-test.ngrok-free.dev'),'https://owl-test.ngrok-free.dev/api');
    assert.equal(normalizePublicApi('https://owl-test.ngrok-free.dev/api/'),'https://owl-test.ngrok-free.dev/api');
    for(const url of ['http://owl.example','https://user:password@owl.example','https://owl.example/?token=secret','https://owl.example/#token','https://owl.example/other','https://localhost','https://127.0.0.1','https://[::1]','not a URL']) assert.throws(()=>normalizePublicApi(url),undefined,url);
    const vm=require('node:vm');const context={window:{}};
    vm.runInNewContext(apiConfigSource('https://owl.example'),context);
    assert.equal(context.window.OWL_API_CONFIG.primary,'https://owl.example/api');
    assert.equal(context.window.OWL_API_CONFIG.local,'');
    assert.equal(context.window.OWL_API_CONFIG.fallbacks.length,0);
});
