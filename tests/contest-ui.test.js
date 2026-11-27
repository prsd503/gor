'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync('contest.html', 'utf8');
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
    .replace(/import \{ Device \} from [^;]+;/, 'const Device = { getId: async () => ({ identifier: "device-test" }) };');
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
function harness(handler) {
    const dom = new JSDOM(html, { url: 'https://owl.test/contest.html?adImg=https%3A%2F%2Fexample.com%2Fad.png', runScripts: 'outside-only' });
    const { window } = dom;
    window.fetch = async (url, init = {}) => {
        const result = await handler(new URL(url), init);
        return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.body };
    };
    window.eval(script);
    return window;
}
const ok = body => ({ status: 200, body });
const ads = () => ok([{ imageUrl: 'https://example.com/ad.png', question: 'Question?', options: ['Yes', 'No'], correctIndex: 0 }]);
test('guest winner sees configured WhatsApp link and code; failed spin can retry', async () => {
    let spinCalls = 0;
    const win = harness((url, init) => {
        if (url.pathname.includes('/verify-device/')) return ok({ registered: false });
        if (url.pathname.endsWith('/ads/global')) return ads();
        if (url.pathname.endsWith('/guest/spin')) {
            spinCalls++;
            if (spinCalls === 1) return { status: 503, body: { error: 'Retry please' } };
            return ok({ won: true, winningCode: '123456789', attemptId: 'attempt123' });
        }
        if (url.pathname.endsWith('/config')) return ok({ teamPhone: '+91 90334 06816' });
        throw new Error(url.pathname);
    });
    await win.onload();
    assert.match(win.document.querySelector('#participationNotice').textContent, /guest/);
    win.document.querySelector('#optionsContainer button').click(); await tick();
    assert.equal(win.document.querySelector('#spinSection').style.display, 'block');
    await win.executeSpin();
    assert.equal(win.document.querySelector('#spinBtn').disabled, false);
    assert.match(win.document.querySelector('#spinNotice').textContent, /Retry please/);
    await win.executeSpin();
    assert.match(win.document.querySelector('#winningCode').textContent, /123456789/);
    const link = new URL(win.document.querySelector('#winnerWhatsApp').href);
    assert.equal(link.host, 'wa.me');
    assert.equal(link.pathname, '/919033406816');
    assert.match(link.searchParams.get('text'), /123456789/);
    win.close();
});
test('registered winner WhatsApp uses API-verified society and flat, not entered text', async () => {
    const win = harness(url => {
        if (url.pathname.includes('/verify-device/')) return ok(url.search ? { registered: true, flatNumber: 'A-101' } : { registered: true });
        if (url.pathname.endsWith('/ads/global')) return ads();
        if (url.pathname.endsWith('/societies/verify')) return ok({ name: 'Aangan' });
        if (url.pathname.endsWith('/contest/spin')) return ok({ won: true });
        if (url.pathname.endsWith('/contest/winner')) return ok({ societyName: 'Aangan', flatNumber: 'A-101' });
        if (url.pathname.endsWith('/config')) return ok({ teamPhone: '919033406816' });
        throw new Error(url.pathname);
    });
    await win.onload();
    win.document.querySelector('#optionsContainer button').click();
    win.document.querySelector('#societyInput').value = 'aangan';
    await win.verifySocietyAndProceed();
    await win.executeSpin();
    const link = new URL(win.document.querySelector('#winnerWhatsApp').href);
    assert.match(link.searchParams.get('text'), /Society: Aangan/);
    assert.match(link.searchParams.get('text'), /Flat number\/name: A-101/);
    win.close();
});
test('device lookup failure never starts a guest contest', async () => {
    let calls = 0;
    const win = harness(() => { calls++; return { status: 503, body: { error: 'Unavailable' } }; });
    await win.onload();
    assert.equal(calls, 1);
    assert.match(win.document.querySelector('#contestArea').textContent, /Could not check/);
    assert.equal(win.document.querySelector('#spinSection').style.display, 'none');
    win.close();
});

test('both guest and registered answer attempts persist only in device storage', async () => {
    for (const registered of [false, true]) {
        const calls = [];
        const handler = (url, init) => {
            calls.push({ path: url.pathname, method: init.method || 'GET' });
            if (url.pathname.includes('/verify-device/')) return ok({ registered });
            if (url.pathname.endsWith('/ads/global')) return ads();
            throw new Error(url.pathname);
        };
        const first = harness(handler);
        await first.onload();
        first.document.querySelectorAll('#optionsContainer button')[1].click();
        assert.equal(first.localStorage.getItem('attempts_ad_https://example.com/ad.png'), '1');
        assert.match(first.document.querySelector('#attemptsNotice').textContent, /1 attempt/);
        const second = harness(handler);
        second.localStorage.setItem('attempts_ad_https://example.com/ad.png', first.localStorage.getItem('attempts_ad_https://example.com/ad.png'));
        await second.onload();
        assert.match(second.document.querySelector('#attemptsNotice').textContent, /1 attempt/);
        second.document.querySelectorAll('#optionsContainer button')[1].click();
        assert.equal(second.localStorage.getItem('attempts_ad_https://example.com/ad.png'), '2');
        assert.equal(second.localStorage.getItem('failed_ad_https://example.com/ad.png'), 'true');
        assert.match(second.document.querySelector('#contestArea').textContent, /used your 2 attempts/);
        await second.onload();
        assert.match(second.document.querySelector('#contestArea').textContent, /used your 2 attempts/);
        assert.equal(calls.some(c => c.method === 'POST'), false, 'answers are never sent to the server');
        first.close(); second.close();
    }
});

test('guest can restore its device-cached winning code after another winner overwrites the server code', async () => {
    const win = harness(url => {
        if (url.pathname.includes('/verify-device/')) return ok({ registered: false });
        if (url.pathname.endsWith('/guest/spin')) return ok({ won: true, winningCode: null, attemptId: 'attempt123', alreadyPlayed: true });
        if (url.pathname.endsWith('/config')) return ok({ teamPhone: '919033406816' });
        throw new Error(url.pathname);
    });
    win.localStorage.setItem('passed_ad_https://example.com/ad.png', 'true');
    win.localStorage.setItem('guest_winning_code_attempt123', '123456789');
    await win.onload();
    await win.executeSpin();
    assert.match(win.document.querySelector('#winningCode').textContent, /123456789/);
    assert.match(new URL(win.document.querySelector('#winnerWhatsApp').href).searchParams.get('text'), /123456789/);
    win.close();
});

test('a device that already won the contest reopens it in a restricted state, not a spin', async () => {
    const adUrl = 'https://example.com/ad.png';
    const win = harness(url => {
        if (url.pathname.includes('/verify-device/')) return ok({ registered: false });
        throw new Error(url.pathname);
    });
    win.localStorage.setItem(`won_ad_${adUrl}`, 'true');
    win.localStorage.setItem(`won_code_ad_${adUrl}`, '882419573');
    win.localStorage.setItem(`passed_ad_${adUrl}`, 'true');
    win.localStorage.setItem(`attempts_ad_${adUrl}`, '2');
    await win.onload();

    assert.equal(win.document.querySelector('#spinSection').style.display, 'block', 'the guest goes straight to the result section');
    assert.match(win.document.querySelector('#rollerDisplay').textContent, /Already won/);
    assert.match(win.document.querySelector('#spinNotice').textContent, /already won/i, 'the restricted state is explained');
    const button = win.document.querySelector('#spinBtn');
    assert.equal(button.style.display, 'inline-flex', 'the button offers the record, not another spin');
    assert.match(button.textContent, /View winning details/);

    button.click();
    await tick();
    assert.equal(win.document.querySelector('#resultModal').style.display, 'block', 'the winning details open');
    assert.match(win.document.querySelector('#winningCode').textContent, /882419573/, 'the saved code is restored for the record');
    assert.match(win.document.querySelector('#winnerDetails').textContent, /registered/);
    win.close();
});

test('an incorrect answer with one attempt left is an in-page modal, not a browser alert', async () => {
    const win = harness(url => {
        if (url.pathname.includes('/verify-device/')) return ok({ registered: false });
        if (url.pathname.endsWith('/ads/global')) return ads();
        throw new Error(url.pathname);
    });
    await win.onload();
    win.document.querySelectorAll('#optionsContainer button')[1].click(); // the wrong option
    await tick();
    assert.equal(win.document.querySelector('#noticeModal').style.display, 'block', 'the notice is an in-page modal');
    assert.match(win.document.querySelector('#noticeModalTitle').textContent, /Incorrect answer/);
    assert.match(win.document.querySelector('#noticeModalText').textContent, /1 attempt left/);
    assert.match(win.document.querySelector('#attemptsNotice').textContent, /1 attempt/, 'the remaining attempt is still playable');
    win.close();
});
