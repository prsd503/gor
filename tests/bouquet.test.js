const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const engine = require('../bouquet-engine.js');
const gif = require('../gif-encoder.js');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'bouquet.html'), 'utf8');

// A minimal 2D context that records calls, so the page logic can run in jsdom
// (which has no canvas implementation) without pulling in a native canvas.
function stubContext(canvas) {
    const gradient = { addColorStop() {} };
    const ctx = {
        canvas,
        save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
        beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
        quadraticCurveTo() {}, bezierCurveTo() {}, arc() {}, arcTo() {}, ellipse() {},
        rect() {}, fill() {}, stroke() {}, clip() {},
        fillRect() {}, clearRect() {}, drawImage() {}, setLineDash() {},
        createLinearGradient: () => gradient,
        createRadialGradient: () => gradient,
        measureText: (text) => ({ width: String(text).length * 7 }),
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        _dead: false,
        putImageData() {},
        fillText() {}, strokeText() {}
    };
    return ctx;
}

function pageDom(t) {
    const dom = new JSDOM(html, { url: 'https://owlwatcher.tech/bouquet.html', pretendToBeVisual: true, runScripts: 'outside-only' });
    const { window } = dom;
    // Canvas stub + an Image that immediately "loads"
    window.HTMLCanvasElement.prototype.getContext = function () { return stubContext(this); };
    class FakeImage {
        constructor() { this.width = 320; this.height = 300; this._src = ''; }
        set src(value) { this._src = value; if (this.onload) setTimeout(() => this.onload(), 0); }
        get src() { return this._src; }
    }
    window.Image = FakeImage;
    window.performance = { now: () => 0 };
    window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
    window.URL.createObjectURL = () => 'blob:stub';
    window.URL.revokeObjectURL = () => {};
    if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

    window.eval(fs.readFileSync(path.join(root, 'bouquet-engine.js'), 'utf8'));
    window.eval(fs.readFileSync(path.join(root, 'gif-encoder.js'), 'utf8'));
    window.eval(fs.readFileSync(path.join(root, 'bouquet-app.js'), 'utf8'));
    t.after(() => { window.__owClosed = true; dom.window.close(); });
    return { dom, window, doc: window.document };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

test('bouquet page keeps the Owl Watcher chrome and loads the shared scripts', () => {
    assert.ok(html.includes('<img src="owl.png" alt="Owl Watcher logo"'));
    assert.ok(html.includes('href="theme.css"'));
    assert.ok(html.includes('src="menu.js"'));
    assert.ok(html.includes('src="bouquet-engine.js"'));
    assert.ok(html.includes('src="gif-encoder.js"'));
    assert.ok(html.includes('src="bouquet-app.js"'));
    assert.ok(html.includes('<title>Owl Watcher | E-Bouquet</title>'));
    // home page gets the entry point right below Owl Jump
    const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const game = home.indexOf('id="gameActionBtn"');
    const link = home.indexOf('href="bouquet.html"');
    assert.ok(game > -1 && link > game, 'E-Bouquet button sits under the game');
});

test('the GIF footer credits Owl Watcher without a web address', () => {
    const drawn = [];
    const canvas = { width: 440, height: 550 };
    const ctx = stubContext(canvas);
    const spy = new Proxy(ctx, {
        get(target, prop) {
            if (prop === 'fillText') return (text) => { drawn.push(String(text)); };
            if (prop === 'measureText') return (text) => ({ width: String(text).length * 7 });
            return target[prop];
        },
        set(target, prop, value) { target[prop] = value; return true; }
    });
    engine.drawCard(spy, {
        width: 440, height: 550,
        images: { 0: { width: 320, height: 300 } },
        owlImg: { width: 516, height: 484 }, seed: 7, time: 0,
        flowers: ['rose'], message: '', from: ''
    });
    // drawSpaced() renders letter-by-letter, so join everything that was drawn
    const allText = drawn.join('');
    assert.match(allText, /MADE WITH OWL WATCHER/i, 'credit line is drawn');
    assert.ok(!/owlwatcher\.(tech|com)/i.test(allText), 'the site address is gone from the card');
    assert.ok(!/https?:|www\./i.test(allText), 'no URL anywhere on the card');
});

test('share is the only transfer action on the bouquet page', () => {
    // Downloading was removed: one GIF action keeps the card simple. The GIF is
    // still saved when the share sheet is unavailable (see the fallback tests).
    assert.ok(doc0(html, 'shareGifBtn'), 'share remains');
    assert.ok(!doc0(html, 'downloadGifBtn'), 'the download button is gone');
    const actions = html.slice(html.indexOf('<div class="share-actions">'), html.indexOf('</div>', html.indexOf('<div class="share-actions">')));
    assert.equal((actions.match(/<button/g) || []).length, 1, 'exactly one action button');
    assert.ok(/id="shareGifBtn"/.test(actions), 'the remaining action is share');
    assert.ok(!/btn-outline/.test(actions), 'share is the primary action, not a secondary one');

    const app = fs.readFileSync(path.join(root, 'bouquet-app.js'), 'utf8');
    assert.ok(!/downloadGifBtn/.test(app), 'no stale reference to the removed button');
});

test('the share button hands the GIF file to the share sheet', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    const click = (id) => doc.getElementById(id).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    ['rose', 'lily', 'daisy', 'tulip', 'peony', 'zinnia'].forEach((id) => {
        doc.querySelector('.flower-btn[data-flower="' + id + '"]')
            .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    click('createBtn');
    for (let i = 0; i < 80 && !page.state.gifBlob; i++) await settle();
    assert.ok(page.state.gifBlob, 'gif was built');

    const shared = [];
    window.navigator.canShare = () => true;
    window.navigator.share = async (payload) => { shared.push(payload); };
    let opened = null;
    window.open = (url) => { opened = url; return null; };

    click('shareGifBtn');
    await settle();
    assert.equal(shared.length, 1, 'share sheet opened once');
    const file = shared[0].files[0];
    assert.equal(file.type, 'image/gif', 'the animation itself is shared');
    assert.match(file.name, /\.gif$/);
    assert.equal(opened, null, 'no chat service is opened');
    assert.ok(!/owlwatcher\.tech/i.test(shared[0].text || ''), 'share text carries no site link');
});

test('sharing without a share sheet downloads the GIF instead', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    const click = (id) => doc.getElementById(id).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    ['rose', 'lily', 'daisy', 'tulip', 'peony', 'zinnia'].forEach((id) => {
        doc.querySelector('.flower-btn[data-flower="' + id + '"]')
            .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    click('createBtn');
    for (let i = 0; i < 80 && !page.state.gifBlob; i++) await settle();

    window.navigator.canShare = undefined;   // desktop browsers without file sharing
    let opened = null;
    window.open = (url) => { opened = url; return null; };
    const downloaded = [];
    window.HTMLAnchorElement.prototype.click = function () { downloaded.push(this.download); };

    click('shareGifBtn');
    await settle();
    assert.equal(downloaded.length, 1, 'the GIF is saved as a fallback');
    assert.match(downloaded[0], /\.gif$/);
    assert.equal(opened, null, 'nothing is opened in a new tab');
});

// The Android/iOS app hosts this page in a WebView, which has no download
// manager and no navigator.share. Both actions must go through Capacitor.
function installCapacitor(window, opts) {
    const platform = (opts && opts.platform) || 'android';
    const writes = [];
    const shares = [];
    const filesystem = {
        async writeFile(options) {
            if (opts && opts.writeFails) throw new Error('write failed');
            writes.push(options);
            return { uri: 'file:///data/user/0/app/files/' + options.path };
        }
    };
    const share = {
        async share(payload) {
            if (opts && opts.shareFails) throw new Error('share failed');
            shares.push(payload);
            return {};
        }
    };
    window.Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => platform,
        Plugins: opts && opts.noPlugins ? {} : { Filesystem: filesystem, Share: share }
    };
    return { writes, shares };
}

async function fillBouquet(doc) {
    ['rose', 'lily', 'daisy', 'tulip', 'peony', 'zinnia'].forEach((id) => {
        doc.querySelector('.flower-btn[data-flower="' + id + '"]')
            .dispatchEvent(new (doc.defaultView.MouseEvent)('click', { bubbles: true }));
    });
    const click = (id) => doc.getElementById(id).dispatchEvent(new (doc.defaultView.MouseEvent)('click', { bubbles: true }));
    click('createBtn');
}

test('in the app, download writes the GIF through the Filesystem plugin', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    await fillBouquet(doc);
    for (let i = 0; i < 80 && !page.state.gifBlob; i++) await settle();
    assert.ok(page.state.gifBlob, 'gif was built');

    const cap = installCapacitor(window);
    // a blob <a download> click does nothing in a WebView; prove we never rely on it
    const downloaded = [];
    window.HTMLAnchorElement.prototype.click = function () { downloaded.push(this.download); };

    const ok = await page.downloadGif();
    assert.equal(ok, true, 'reports success only after writing');
    assert.equal(downloaded.length, 0, 'no blob anchor click in the app');
    assert.equal(cap.writes.length, 1, 'file written once');
    assert.match(cap.writes[0].path, /\.gif$/, 'the GIF is what gets written');
    assert.equal(cap.writes[0].directory, 'DOCUMENTS', 'saved where the user can find it');
    assert.ok(cap.writes[0].data.length > 0, 'base64 payload is present');
    assert.ok(!/^data:/.test(cap.writes[0].data), 'no data: prefix, just base64');
});

test('in the app, share hands the file URI to the Share plugin', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    await fillBouquet(doc);
    for (let i = 0; i < 80 && !page.state.gifBlob; i++) await settle();

    const cap = installCapacitor(window);
    const downloaded = [];
    window.HTMLAnchorElement.prototype.click = function () { downloaded.push(this.download); };

    await page.shareGif();
    assert.equal(cap.writes.length, 1, 'the GIF is written before sharing');
    assert.equal(cap.writes[0].directory, 'CACHE', 'cache needs no storage permission');
    assert.equal(cap.shares.length, 1, 'share sheet invoked once');
    assert.match(cap.shares[0].files[0], /^file:\/\/.*\.gif$/, 'a real file URI is shared');
    assert.equal(downloaded.length, 0, 'never a silent blob download');
    assert.match(doc.getElementById('sendHint').textContent, /Shared/);
});

test('in the app, a failed share says so instead of claiming a download', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    await fillBouquet(doc);
    for (let i = 0; i < 80 && !page.state.gifBlob; i++) await settle();

    // share fails, and the documents fallback fails too
    installCapacitor(window, { shareFails: true, writeFails: true });
    window.HTMLAnchorElement.prototype.click = function () {};

    await page.shareGif();
    const hint = doc.getElementById('sendHint').textContent;
    assert.ok(!/downloaded instead/i.test(hint), 'must not claim a download that never happened');
    assert.ok(/could not/i.test(hint), 'reports the failure, got: ' + hint);
});

test('in the app, a failed save reports failure rather than success', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    await fillBouquet(doc);
    for (let i = 0; i < 80 && !page.state.gifBlob; i++) await settle();

    installCapacitor(window, { writeFails: true });
    const ok = await page.downloadGif();
    assert.equal(ok, false, 'no false success');
    assert.ok(/could not/i.test(doc.getElementById('sendHint').textContent), 'says it failed');
});

test('in the app, missing plugins are reported, not silently ignored', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    await fillBouquet(doc);
    for (let i = 0; i < 80 && !page.state.gifBlob; i++) await settle();

    installCapacitor(window, { noPlugins: true });
    const ok = await page.downloadGif();
    assert.equal(ok, false);
    assert.ok(/could not/i.test(doc.getElementById('sendHint').textContent));
});

test('native detection ignores the plain browser', async (t) => {
    const { window } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    assert.equal(page.nativePlatformName(), null, 'no Capacitor bridge means browser');
    window.Capacitor = { isNativePlatform: () => false };
    assert.equal(page.nativePlatformName(), null, 'a non-native Capacitor context is still the browser');
});

test('WhatsApp is used only to buy a code, never to send the GIF', () => {
    const app = fs.readFileSync(path.join(root, 'bouquet-app.js'), 'utf8');
    // Buying premium credit is a chat with the Owl Watcher team. The bouquet
    // itself must still never be routed through a third-party chat service.
    assert.ok(doc0(html, 'buyCodeLink'), 'a WhatsApp purchase link exists');
    assert.ok(/wa\.me/.test(app), 'the purchase URL is built in the app');
    const sharing = app.slice(app.indexOf('async function shareGif'));
    assert.ok(!/wa\.me/i.test(sharing), 'sharing never opens WhatsApp');
    assert.ok(doc0(html, 'shareGifBtn'), 'share is the transfer action');
    assert.ok(!doc0(html, 'sendGifBtn'), 'the old single send button is gone');
});

test('the buy-a-code link uses the team number stored in Firestore configs/owlwatcher', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    const link = doc.getElementById('buyCodeLink');
    assert.ok(link.href.startsWith('https://wa.me/'), 'a fallback link is ready before the request');

    let asked = null;
    window.fetch = async (url) => {
        asked = url;
        return { ok: true, json: async () => ({ teamPhone: '+91 75671 84961' }) };
    };
    const number = await page.refreshBuyCodeLink();
    assert.ok(/\/config$/.test(asked), 'the public config endpoint is what gets read');
    assert.equal(number, '917567184961', 'the number is normalised to digits');
    assert.equal(link.href, page.codeHelpUrl('917567184961'));
    assert.ok(link.href.startsWith('https://wa.me/917567184961?text='), 'chat opens with the stored number');
    const sharing = fs.readFileSync(path.join(root, 'bouquet-app.js'), 'utf8');
    assert.ok(!/const WA_NUMBER\s*=/.test(sharing), 'no second hardcoded number source');
});

test('the buy-a-code link falls back safely when config cannot be read', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    const link = doc.getElementById('buyCodeLink');

    window.fetch = async () => ({ ok: false, json: async () => ({}) });
    assert.equal(await page.refreshBuyCodeLink(), null);
    assert.ok(link.href.startsWith('https://wa.me/'), 'the fallback link stays usable');

    window.fetch = async () => { throw new Error('offline'); };
    assert.equal(await page.refreshBuyCodeLink(), null);
    assert.ok(link.href.startsWith('https://wa.me/'), 'an offline page still offers a link');
});

test('premium themes and flowers are locked until a code is accepted', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;

    // the free set is untouched
    assert.equal(page.state.theme, 'night', 'midnight sky is the default');
    assert.equal(page.needsCode(), false, 'a plain free bouquet needs no code');

    // picking a premium theme previews it but still needs a code
    page.chooseTheme('birthday');
    assert.equal(page.state.theme, 'birthday');
    assert.equal(page.needsCode(), true, 'premium theme needs a code to share');

    // back to the free theme: no code needed again
    page.chooseTheme('night');
    assert.equal(page.needsCode(), false);
});

test('festival, sorry and new year themes preview as premium and unlock like other themes', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    for (const [id, label] of [['festival', 'Festival Vibe'], ['sorry', 'Sorry'], ['newyear', 'Happy New Year']]) {
        const tile = doc.querySelector(`.theme-tile[data-theme="${id}"]`);
        assert.ok(tile, `${label} tile exists`);
        assert.equal(tile.querySelector('.theme-name').textContent, label);
        assert.equal(tile.dataset.locked, 'true');
        tile.click();
        assert.equal(page.state.theme, id);
        assert.equal(page.needsCode(), true);
        assert.equal(doc.getElementById('messageInput').readOnly, true);
        assert.equal(doc.getElementById('themeChip').textContent, label);
    }
    assert.equal(doc.querySelector('.theme-tile[data-theme="diwali"]'), null);
    page.state.unlocked = true;
    for (const id of ['festival', 'sorry', 'newyear']) {
        page.chooseTheme(id);
        assert.equal(page.needsCode(), false, `${id} shares once unlocked`);
        assert.equal(doc.querySelector(`.theme-tile[data-theme="${id}"]`).dataset.locked, 'false');
        assert.equal(doc.getElementById('messageInput').readOnly, false);
    }
});

test('new theme greetings render on the bouquet and festival has no Diwali-specific wording', () => {
    for (const [id, expected] of [['festival', 'Festival Wishes'], ['sorry', 'I’m Sorry'], ['newyear', 'Happy New Year']]) {
        const theme = engine.THEMES.find(item => item.id === id);
        assert.ok(theme && !theme.free);
        assert.equal(theme.title, expected);
        const ctx = stubContext({ width: 440, height: 550 });
        const text = [];
        ctx.fillText = value => text.push(String(value));
        engine.drawCard(ctx, {
            width: 440, height: 550, images: {}, seed: 7, time: 1,
            flowers: [], flowerCount: 0, theme: id, message: '', from: ''
        });
        assert.ok(text.includes(expected), `${id} greeting is drawn on the card`);
    }
    const festival = engine.themeById('festival');
    assert.doesNotMatch(JSON.stringify(festival), /diwali|diya/i);
    assert.equal(festival.bg, 'festivalLights');
    assert.equal(engine.THEMES.some(theme => theme.id === 'diwali'), false);
    assert.doesNotMatch(html, /diwali/i);
});

test('the note can only be typed on the free theme or after a code is redeemed', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    const msg = doc.getElementById('messageInput');
    const from = doc.getElementById('fromInput');
    const hint = doc.getElementById('messageLock');

    // free theme: typing works, nothing is locked
    assert.equal(page.state.theme, 'night');
    assert.equal(msg.readOnly, false, 'the free theme lets you write');
    assert.equal(from.readOnly, false);
    assert.equal(hint.hidden, true, 'no lock notice on the free theme');

    // premium theme locks both fields and explains why
    page.chooseTheme('birthday');
    assert.equal(msg.readOnly, true, 'premium theme blocks the message');
    assert.equal(from.readOnly, true, 'premium theme blocks the signature too');
    assert.equal(msg.getAttribute('aria-readonly'), 'true');
    assert.equal(hint.hidden, false, 'a lock notice is shown');
    assert.match(hint.textContent, /code/i);

    // going back to the free theme unlocks again
    page.chooseTheme('night');
    assert.equal(msg.readOnly, false);
    assert.equal(hint.hidden, true);

    // redeeming a code unlocks typing on premium themes
    page.chooseTheme('wedding');
    assert.equal(msg.readOnly, true);
    page.state.unlocked = true;
    page.syncMessageLock();
    assert.equal(msg.readOnly, false, 'a redeemed code lets you write');
    assert.equal(from.readOnly, false);
    assert.equal(hint.hidden, true);
});

test('a note typed on the free theme is wiped when a premium theme is picked', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    const msg = doc.getElementById('messageInput');
    const from = doc.getElementById('fromInput');

    // type a note and signature on the free theme
    assert.equal(page.state.theme, 'night');
    msg.value = 'A free-theme note';
    from.value = 'Someone';
    page.state.message = msg.value;
    page.state.from = from.value;
    assert.equal(page.state.message.length > 0, true, 'note is present on the free theme');

    // selecting a locked premium theme wipes both fields
    page.chooseTheme('birthday');
    assert.equal(page.state.message, '', 'the note is wiped');
    assert.equal(page.state.from, '', 'the signature is wiped');
    assert.equal(msg.value, '', 'the message field is cleared');
    assert.equal(from.value, '', 'the signature field is cleared');
    assert.equal(doc.getElementById('charCount').textContent, '0 / 220', 'the counter resets');

    // going back to the free theme leaves it empty (nothing to restore)
    page.chooseTheme('night');
    assert.equal(page.state.message, '');

    // an unlocked premium theme keeps a note that was typed after unlock
    page.chooseTheme('birthday');
    page.state.unlocked = true;
    page.syncMessageLock();
    msg.value = 'An unlocked note';
    page.state.message = msg.value;
    page.chooseTheme('wedding'); // still unlocked -> no wipe
    assert.equal(page.state.message, 'An unlocked note', 'unlocked premium keeps the note');
});

test('the ten original flowers stay free and premium ones stay locked', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    const originals = ['rose', 'peony', 'sunflower', 'tulip', 'lily', 'daisy', 'ranunculus', 'zinnia', 'orchid', 'anemone'];
    originals.forEach((id) => {
        assert.equal(page.isPremiumFlower(id), false, id + ' is free');
        const btn = doc.querySelector('.flower-btn[data-flower="' + id + '"]');
        assert.equal(btn.disabled, false, id + ' can be added');
    });

    const premium = ['dahlia', 'hydrangea', 'magnolia', 'protea', 'hellebore', 'sweetpea'];
    premium.forEach((id) => {
        assert.equal(page.isPremiumFlower(id), true, id + ' is premium');
        const btn = doc.querySelector('.flower-btn[data-flower="' + id + '"]');
        click(btn);
        assert.equal(page.state.counts[id], undefined, id + ' cannot be added while locked');
    });

    // a premium flower in the bouquet needs a code, while still locked
    assert.equal(page.needsCode(), false, 'nothing premium chosen yet');

    // and it becomes available once a code is accepted
    page.state.unlocked = true;
    page.state.counts.dahlia = 1;
    assert.equal(page.needsCode(), false, 'unlocked: premium flower shares freely');

    page.state.unlocked = false;
    assert.equal(page.needsCode(), true, 'locked again: the premium flower needs a code');
});

test('sharing is blocked and explained while a code is still needed', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    ['rose', 'lily', 'daisy', 'tulip', 'peony', 'zinnia'].forEach((id) => {
        click(doc.querySelector('.flower-btn[data-flower="' + id + '"]'));
    });
    // pick the locked theme first: switching themes after export correctly
    // invalidates the GIF, so the order matters here
    page.chooseTheme('champion');
    click(doc.getElementById('createBtn'));
    for (let i = 0; i < 80 && !page.state.gifBlob; i++) await settle();
    assert.ok(page.state.gifBlob, 'gif was built');
    const shared = [];
    window.navigator.canShare = () => true;
    window.navigator.share = async (p) => { shared.push(p); };
    const downloaded = [];
    window.HTMLAnchorElement.prototype.click = function () { downloaded.push(this.download); };

    click(doc.getElementById('shareGifBtn'));
    await settle();
    assert.equal(shared.length, 0, 'nothing is shared while locked');
    assert.equal(downloaded.length, 0, 'nothing is downloaded while locked');
    assert.match(doc.getElementById('sendHint').textContent, /code/i, 'the visitor is told why');
});

test('the unlock lasts for the page session only and is not persisted', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;

    // simulate a successful redemption without touching the network
    page.state.unlocked = true;
    page.state.unlockedCode = '123456789';
    page.chooseTheme('birthday');
    assert.equal(page.needsCode(), false, 'unlocked: premium theme can be shared');

    // Unlocks are not stored locally. The unused code can be validated again
    // after refresh; only server-side consumption makes it one-use.
    assert.equal(window.localStorage.length, 0, 'no localStorage entries written');
    assert.equal(window.sessionStorage.length, 0, 'no sessionStorage entries written');

    const app = fs.readFileSync(path.join(root, 'bouquet-app.js'), 'utf8');
    assert.ok(!/localStorage\.setItem|sessionStorage\.setItem/.test(app),
        'the app never persists an unlock');

    // A fresh page (a reload) starts locked again.
    const fresh = pageDom(t);
    await settle();
    assert.equal(fresh.window.OwBouquetPage.state.unlocked, false, 'a reload starts locked');
    assert.equal(fresh.window.OwBouquetPage.needsCode(), false, 'free theme still needs nothing');
});

test('premium flowers stay in full colour in the picker', () => {
    // The locked state is signalled by the PREMIUM badge, not by draining the
    // colour: people should see the flowers they would be buying.
    assert.ok(!/filter:\s*saturate\(/.test(html), 'no desaturation filter on premium blooms');
    assert.ok(!/grayscale|greyscale/i.test(html), 'no greyscale rule either');
});

test('the page explains that refresh preserves unused codes and only Share GIF spends them', () => {
    const warn = doc0(html, 'sessionWarn') && html.split('id="sessionWarn"')[1].split('</p>')[0];
    assert.match(warn, /Unlocking does not use your code/i);
    assert.match(warn, /refresh.*same unused code/i);
    assert.match(warn, /marked used only when you press Share GIF/i);
    assert.match(warn, /cancelled or fails/i);
    assert.ok(!/marked used the moment it is accepted|Finish and share before refreshing/.test(html));
});

test('a locked bouquet with premium blooms is stamped over the flowers', () => {
    const engine = require('../bouquet-engine.js');
    const calls = [];
    const canvas = { width: 440, height: 550 };
    const ctx = stubContext(canvas);
    const spy = new Proxy(ctx, {
        get(target, prop) {
            if (prop === 'fillText') return (text) => { calls.push(String(text)); };
            if (prop === 'measureText') return (text) => ({ width: String(text).length * 7 });
            return target[prop];
        },
        set(t, k, v) { t[k] = v; return true; }
    });

    const images = {};
    for (let i = 0; i < 4; i++) images[i] = { width: 320, height: 300 };
    const draw = (markPremium) => {
        calls.length = 0;
        engine.drawCard(spy, {
            width: 440, height: 550, images, seed: 7, time: 0, flowers: ['dahlia', 'rose', 'magnolia', 'daisy'],
            flowerCount: 4, message: '', from: '', theme: 'night',
            premiumFlowers: { 0: true, 1: false, 2: true, 3: false },
            markPremium, watermark: markPremium
        });
        return calls.slice();
    };

    const locked = draw(true);
    assert.ok(locked.includes('PREVIEW'), 'locked: the bouquet carries a PREVIEW ribbon');

    const unlocked = draw(false);
    assert.ok(!unlocked.includes('PREVIEW'), 'unlocked: no watermark anywhere');
});

test('a free-only bouquet is never watermarked', () => {
    const engine = require('../bouquet-engine.js');
    const calls = [];
    const ctx = stubContext({ width: 440, height: 550 });
    const spy = new Proxy(ctx, {
        get(target, prop) {
            if (prop === 'fillText') return (text) => { calls.push(String(text)); };
            if (prop === 'measureText') return (text) => ({ width: String(text).length * 7 });
            return target[prop];
        },
        set(t, k, v) { t[k] = v; return true; }
    });
    const images = {};
    for (let i = 0; i < 4; i++) images[i] = { width: 320, height: 300 };

    engine.drawCard(spy, {
        width: 440, height: 550, images, seed: 7, time: 0,
        flowers: ['rose', 'peony', 'daisy', 'tulip'], flowerCount: 4,
        message: 'hi', from: 'me', theme: 'night',
        premiumFlowers: { 0: false, 1: false, 2: false, 3: false },
        markPremium: false, watermark: false
    });
    assert.ok(!calls.includes('PREVIEW'), 'free bouquet stays pristine');
    // drawSpaced() renders the footer letter-by-letter, so join the stream
    assert.ok(/MADE WITH OWL WATCHER/i.test(calls.join('')), 'brand footer still present');
});

test('only the free night theme keeps the moon and stars', () => {
    const themes = engine.THEMES;
    const withMoon = themes.filter((t) => t.moon);
    assert.deepEqual(withMoon.map((t) => t.id), ['night'], 'the moon is the night theme only');
    const withStars = themes.filter((t) => t.stars > 0);
    assert.deepEqual(withStars.map((t) => t.id), ['night'], 'stars are the night theme only');
    themes.filter((t) => t.free === false).forEach((t) => {
        assert.equal(t.moon, false, t.id + ' has no moon');
        assert.equal(t.stars, 0, t.id + ' has no stars');
    });
});

test('every premium theme has its own vibrant palette and backdrop', () => {
    const premium = engine.THEMES.filter((t) => !t.free);
    assert.ok(premium.length >= 8, 'there are several premium themes');

    premium.forEach((t) => {
        assert.ok(t.sky && t.sky.top && t.sky.mid && t.sky.low, t.id + ' has a full palette');
        assert.ok(t.bg, t.id + ' declares a background painter');
        assert.ok(typeof engine.BACKGROUNDS[t.bg] === 'function', t.id + ' background exists');
    });

    // the backdrops are genuinely varied, not one recoloured sky
    const kinds = new Set(premium.map((t) => t.bg));
    assert.ok(kinds.size >= 5, 'at least five distinct backdrop styles, got ' + kinds.size);

    // and no two premium themes share the same three-stop gradient
    const palettes = premium.map((t) => [t.sky.top, t.sky.mid, t.sky.low].join('|'));
    assert.equal(new Set(palettes).size, palettes.length, 'each palette is unique');
});

test('a pre-drawn canvas can render every theme without throwing', () => {
    engine.THEMES.forEach((t) => {
        const ctx = stubContext({ width: 440, height: 550 });
        const images = {};
        for (let i = 0; i < 4; i++) images[i] = { width: 320, height: 300 };
        assert.doesNotThrow(() => engine.drawCard(ctx, {
            width: 440, height: 550, images, seed: 7, time: 1.5,
            flowers: ['rose', 'dahlia', 'peony', 'daisy'], flowerCount: 4,
            message: 'hi', from: 'me', theme: t.id
        }), t.id + ' renders');
    });
});

test('light themes use dark ink so the title stays readable', () => {
    ['wedding', 'newbaby', 'sorry'].forEach((id) => {
        const t = engine.THEMES.find((th) => th.id === id);
        assert.ok(t.ink, id + ' declares a dark ink colour');
        assert.match(t.ink, /^#[0-9a-f]{6}$/i, id + ' ink is a solid colour');
    });
});

test('the price and rules panel opens on click and hides again', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const details = doc.getElementById('premiumDetails');
    const toggle = doc.getElementById('premiumToggle');
    const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    assert.equal(details.hidden, true, 'starts collapsed');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');

    click(toggle);
    assert.equal(details.hidden, false, 'opens on click');
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');

    click(toggle);
    assert.equal(details.hidden, true, 'hides again');
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');

    // the panel states the actual price and the one-use rule
    const text = details.textContent;
    assert.match(text, /30/, 'shows the price');
    assert.match(text, /one/i, 'states the one bouquet rule');
    assert.match(text, /refresh/i, 'warns that a refresh locks it again');
    assert.match(text, /this page only/i, 'says the unlock is page-session only');
});

// tiny presence helper so the markup test stays readable
function doc0(source, id) {
    return source.includes('id="' + id + '"');
}

test('the arrangement buttons are compact, not stretched', () => {
    const css = html.slice(html.indexOf('.preview-actions'), html.indexOf('.preview-actions') + 400);
    assert.ok(css.includes('flex: 0 0 auto'), 'buttons size to their content');
    assert.ok(!/flex:\s*1 1 170px/.test(html), 'no full-width stretching rule remains');
});

test('flower names stay inside their tile', () => {
    // The label is a flex item, so it needs an explicit min-width:0 to shrink
    // into the tile instead of painting its glyphs over the rounded border.
    const nameRule = html.slice(html.indexOf('.flower-btn .flower-name'), html.indexOf('.flower-btn .flower-name') + 400);
    assert.ok(nameRule.includes('min-width: 0'), 'the label may shrink below its longest word');
    assert.ok(nameRule.includes('max-width: 100%'), 'the label is capped at the content box');
    assert.ok(nameRule.includes('overflow-wrap: break-word'), 'a too-narrow tile breaks the word rather than spilling');
});

test('the flower grid tracks are wide enough for the longest name', () => {
    // "RANUNCULUS" is the widest label; a 78px minimum track collapsed to ~73px
    // on a 390px screen and the name overflowed the tile.
    const grid = html.slice(html.indexOf('.flower-grid {'), html.indexOf('.flower-grid {') + 300);
    const base = Number(/minmax\((\d+)px/.exec(grid)[1]);
    assert.ok(base >= 98, 'base track fits "Ranunculus" at 0.72rem, got ' + base);

    const narrow = html.slice(html.indexOf('@media (max-width: 420px)'));
    const small = Number(/minmax\((\d+)px/.exec(narrow)[1]);
    assert.ok(small >= 92, 'narrow track fits "Ranunculus" at 0.64rem, got ' + small);
});

test('the home page entry point is a proper feature card', () => {
    const home = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const dom = new JSDOM(home);
    const link = dom.window.document.getElementById('ebouquetBtn');
    const gameBtnIndex = home.indexOf('id="gameActionBtn"');
    const linkIndex = home.indexOf('id="ebouquetBtn"');
    dom.window.close();

    assert.equal(link.tagName, 'A', 'still a real link');
    assert.equal(link.getAttribute('href'), 'bouquet.html');
    assert.ok(link.className.includes('ebouquet-link'), 'uses its own component class');
    assert.ok(gameBtnIndex > -1 && linkIndex > gameBtnIndex, 'sits under the Owl Jump game');

    // structured content rather than an emoji on a default button
    assert.ok(link.querySelector('.eb-icon svg'), 'has a bouquet glyph');
    assert.ok(link.querySelector('.eb-title'), 'has a title');
    assert.ok(link.querySelector('.eb-sub'), 'has a supporting line');
    assert.ok(link.querySelector('.eb-go svg'), 'has a chevron affordance');
    assert.equal(link.querySelector('.eb-title').textContent.trim(), 'E-Bouquet');
    assert.ok(!/\u{1F490}/u.test(link.textContent), 'no emoji in the label');

    // the old generic button styling is gone
    assert.ok(!/id="ebouquetBtn" class="btn-block"/.test(home), 'not a plain full-width button');
    assert.ok(home.includes('.ebouquet-link {'), 'component styles are defined');
});

test('a single flower can be picked up to ten times', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const tile = (id) => doc.querySelector('.flower-tile[data-flower="' + id + '"]');
    const addBtn = (id) => tile(id).querySelector('.flower-btn');
    const minusBtn = (id) => tile(id).querySelector('.flower-minus');

    // tap the same rose over and over
    for (let i = 0; i < 10; i++) click(addBtn('rose'));
    assert.equal(page.totalBlooms(), 10, 'ten of the same flower');
    assert.equal(page.state.counts.rose, 10);
    assert.equal(tile('rose').dataset.count, '10');
    assert.equal(tile('rose').querySelector('.flower-count').textContent, '10');

    // an eleventh tap is refused
    click(addBtn('rose'));
    assert.equal(page.totalBlooms(), 10, 'never more than ten blooms');

    // every other flower is now blocked because the bouquet is full
    assert.equal(addBtn('lily').disabled, true);
    assert.equal(addBtn('sunflower').disabled, true);

    // the minus takes one back and frees a slot
    click(minusBtn('rose'));
    assert.equal(page.totalBlooms(), 9);
    assert.equal(page.state.counts.rose, 9);
    assert.equal(addBtn('lily').disabled, false, 'space again after removing');
});

test('flowers can be mixed and removed down to nothing', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const addBtn = (id) => doc.querySelector('.flower-tile[data-flower="' + id + '"] .flower-btn');
    const minusBtn = (id) => doc.querySelector('.flower-tile[data-flower="' + id + '"] .flower-minus');

    for (let i = 0; i < 4; i++) click(addBtn('rose'));
    for (let i = 0; i < 3; i++) click(addBtn('lily'));
    assert.equal(page.totalBlooms(), 7);
    assert.equal(page.state.counts.rose, 4);
    assert.equal(page.state.counts.lily, 3);

    // the minus is hidden for flowers that are not in the bouquet
    assert.equal(minusBtn('daisy').hidden, true);
    assert.equal(minusBtn('rose').hidden, false);

    // draining a flower removes it entirely
    for (let i = 0; i < 4; i++) click(minusBtn('rose'));
    assert.equal(page.state.counts.rose, undefined);
    assert.equal(page.totalBlooms(), 3);
    assert.equal(minusBtn('rose').hidden, true, 'minus hides once the flower is gone');

    // tapping minus on an empty flower does nothing
    click(minusBtn('rose'));
    assert.equal(page.totalBlooms(), 3);
});

test('the bouquet holds at most ten blooms in total', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const addBtn = (id) => doc.querySelector('.flower-tile[data-flower="' + id + '"] .flower-btn');

    // fill with a mix: 5 rose + 5 lily is exactly ten
    for (let i = 0; i < 5; i++) { click(addBtn('rose')); click(addBtn('lily')); }
    assert.equal(page.totalBlooms(), 10);
    assert.equal(page.state.counts.rose, 5);
    assert.equal(page.state.counts.lily, 5);

    // a flower not in the bouquet cannot be added
    assert.equal(addBtn('zinnia').disabled, true);
    // a flower already in it stays tappable
    assert.equal(addBtn('rose').disabled, false);
});

test('clear all empties the bouquet', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const addBtn = (id) => doc.querySelector('.flower-tile[data-flower="' + id + '"] .flower-btn');

    click(addBtn('rose')); click(addBtn('rose')); click(addBtn('lily'));
    assert.equal(page.totalBlooms(), 3);

    const clear = doc.getElementById('clearBloomsBtn');
    assert.equal(clear.hidden, false, 'clear is offered while blooms are picked');
    click(clear);
    assert.equal(page.totalBlooms(), 0);
    assert.deepEqual(Object.keys(page.state.counts), []);
    assert.equal(clear.hidden, true, 'clear hides on an empty bouquet');
});

test('the counter warns until the minimum number of blooms is chosen', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const counter = doc.getElementById('pickCounter');
    const notice = doc.getElementById('pickNotice');
    assert.match(counter.textContent, /^0 \/ 6–10$/);
    assert.equal(notice.hidden, false);
    assert.match(notice.textContent, /Add 6 more blooms/);

    const buttons = Array.from(doc.querySelectorAll('.flower-btn'));
    for (let i = 0; i < 6; i++) buttons[i].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.match(counter.textContent, /^6 \/ 6–10$/);
    assert.equal(notice.hidden, true);
});

test('arrangement is stable for a seed and changes when shuffled', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    const buttons = Array.from(doc.querySelectorAll('.flower-btn'));
    for (let i = 0; i < 7; i++) buttons[i].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    const layoutA = page.drawCardTo(doc.getElementById('previewCanvas').getContext('2d'), 440, 550, 0);
    const layoutB = page.drawCardTo(doc.getElementById('previewCanvas').getContext('2d'), 440, 550, 0);
    assert.equal(layoutA.slots.length, 7);
    assert.deepEqual(
        layoutA.slots.map(s => [Math.round(s.x), Math.round(s.y)]),
        layoutB.slots.map(s => [Math.round(s.x), Math.round(s.y)]),
        'same seed, same arrangement'
    );

    const seedBefore = page.state.arrangementSeed;
    doc.getElementById('shuffleBtn').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.notEqual(page.state.arrangementSeed, seedBefore, 'shuffle advances the seed');
    const layoutC = page.drawCardTo(doc.getElementById('previewCanvas').getContext('2d'), 440, 550, 0);
    assert.notDeepEqual(layoutA.slots.map(s => Math.round(s.x)), layoutC.slots.map(s => Math.round(s.x)));
});

test('the preview and the exported card use the same layout', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    const buttons = Array.from(doc.querySelectorAll('.flower-btn'));
    for (let i = 0; i < 8; i++) buttons[i].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    const canvas = doc.getElementById('previewCanvas');
    const preview = page.drawCardTo(canvas.getContext('2d'), 440, 550, 0);
    const exported = page.drawCardTo(canvas.getContext('2d'), 440, 550, 0);
    const round = (s) => [Math.round(s.x), Math.round(s.y), Math.round(s.size)];
    assert.deepEqual(preview.slots.map(round), exported.slots.map(round));

    // the export canvas is the same size as the preview, so the picture matches
    assert.equal(preview.slots.length, 8);
    const big = page.drawCardTo(canvas.getContext('2d'), 880, 1100, 0);
    assert.equal(big.slots.length, 8, 'same blooms at any canvas size');
    assert.ok(big.slots[0].size > preview.slots[0].size, 'blooms scale with the canvas');
});

test('a shared link restores the bouquet, seed and note', async (t) => {
    const dom = new JSDOM(html, {
        url: 'https://owlwatcher.tech/bouquet.html?b=rose,lily,daisy&s=987654&m=Happy%20birthday&f=Meera',
        pretendToBeVisual: true, runScripts: 'outside-only'
    });
    const { window } = dom;
    window.HTMLCanvasElement.prototype.getContext = function () { return stubContext(this); };
    class FakeImage { set src(v) { if (this.onload) setTimeout(() => this.onload(), 0); } }
    window.Image = FakeImage;
    window.performance = { now: () => 0 };
    window.requestAnimationFrame = (fn) => setTimeout(fn, 0);
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    window.eval(fs.readFileSync(path.join(root, 'bouquet-engine.js'), 'utf8'));
    window.eval(fs.readFileSync(path.join(root, 'gif-encoder.js'), 'utf8'));
    window.eval(fs.readFileSync(path.join(root, 'bouquet-app.js'), 'utf8'));
    t.after(() => { window.__owClosed = true; dom.window.close(); });
    await settle();

    const page = window.OwBouquetPage;
    assert.deepEqual(Array.from(page.selectedFlowerIds()), ['rose', 'lily', 'daisy']);
    assert.equal(page.state.arrangementSeed, 987654);
    assert.equal(window.document.getElementById('messageInput').value, 'Happy birthday');
    assert.equal(window.document.getElementById('fromInput').value, 'Meera');
});

test('manual nudges move a bloom and can bring it to the front', () => {
    const plain = engine.layoutBouquet({ count: 6, seed: 42, width: 440, height: 550 });
    const moved = engine.layoutBouquet({ count: 6, seed: 42, width: 440, height: 550, nudges: { 2: { dx: 2, dy: -1 } } });
    const a = plain.slots.find(s => s.index === 2);
    const b = moved.slots.find(s => s.index === 2);
    assert.ok(b.x > a.x, 'nudged right');
    assert.ok(b.y < a.y, 'nudged up');

    const front = engine.layoutBouquet({ count: 6, seed: 42, width: 440, height: 550, nudges: { 2: { front: true } } });
    assert.equal(front.slots[front.slots.length - 1].index, 2, 'drawn last, so on top');
});

test('bouquet layout keeps every bloom inside the card', () => {
    for (const count of [6, 7, 8, 9, 10]) {
        for (const seed of [1, 42, 99991]) {
            const layout = engine.layoutBouquet({ count, seed, width: 440, height: 550 });
            assert.equal(layout.slots.length, count);
            for (const slot of layout.slots) {
                const half = slot.size / 2;
                assert.ok(slot.x - half > -20, 'left edge clear');
                assert.ok(slot.x + half < 440 + 20, 'right edge clear');
                assert.ok(slot.y - half > 40, 'below the header');
                assert.ok(slot.y < 550 * 0.72, 'above the message panel');
            }
        }
    }
});

test('card renders a full frame at several sizes without throwing', () => {
    // A recording context verifies the drawing API usage end to end.
    const calls = [];
    const canvas = { width: 0, height: 0 };
    const ctx = stubContext(canvas);
    const spy = new Proxy(ctx, {
        get(target, prop) {
            if (typeof target[prop] === 'function') {
                return (...args) => { calls.push(prop); return target[prop](...args); };
            }
            return target[prop];
        },
        set(target, prop, value) { target[prop] = value; return true; }
    });
    const images = { 0: { width: 320, height: 300 }, 1: { width: 320, height: 320 } };
    for (const [w, h] of [[440, 550], [480, 600]]) {
        engine.drawCard(spy, {
            width: w, height: h, images, owlImg: { width: 516, height: 484 },
            seed: 7, time: 0.5, flowers: ['rose', 'lily'],
            message: 'A note that is long enough to wrap onto more than a single line of the card.',
            from: 'Aarav'
        });
    }
    for (const name of ['drawImage', 'fillText', 'fillRect', 'arc']) {
        assert.ok(calls.includes(name), 'card draws ' + name);
    }
});

test('gif encoder writes a decodable animated file', () => {
    const width = 12, height = 10;
    const palette = new Uint8Array(768);
    for (let i = 0; i < 256; i++) { palette[i * 3] = i; palette[i * 3 + 1] = 255 - i; palette[i * 3 + 2] = i >> 1; }
    const indices = new Uint8Array(width * height);
    for (let i = 0; i < indices.length; i++) indices[i] = i % 16;
    const bytes = gif.encode([{ indices, delay: 8 }, { indices, delay: 8 }], width, height, palette, 256, 0);

    const header = Buffer.from(bytes.subarray(0, 6)).toString('ascii');
    assert.equal(header, 'GIF89a');
    assert.equal(bytes[bytes.length - 1], 0x3b, 'trailer');
    assert.ok(Buffer.from(bytes).includes(Buffer.from('NETSCAPE2.0', 'latin1')), 'loops forever');
    const buf = Buffer.from(bytes);
    assert.equal(buf.readUInt16LE(6), width);
    assert.equal(buf.readUInt16LE(8), height);
});

test('delta frames only store the rectangle that moved', () => {
    const width = 32, height = 32;
    const base = new Uint8ClampedArray(width * height * 4).fill(20);
    const moved = new Uint8ClampedArray(base);
    // recolour a 4x4 patch in the middle
    for (let y = 14; y < 18; y++) {
        for (let x = 14; x < 18; x++) {
            const i = (y * width + x) * 4;
            moved[i] = 240; moved[i + 1] = 30; moved[i + 2] = 90;
        }
    }
    const frames = [{ data: base, delay: 8 }, { data: moved, delay: 8 }];
    const full = gif.encodeFrames(frames, width, height, { maxColors: 32 });
    const delta = gif.encodeFrames(frames, width, height, { maxColors: 32, delta: true });
    assert.ok(delta.length < full.length, 'delta file is smaller');

    // walk the file and collect image descriptors: the delta version's second
    // frame must be a sub-rectangle, the plain one must be full size
    const rects = (bytes) => {
        const buf = Buffer.from(bytes);
        const found = [];
        let p = 13 + 3 * (1 << (buf[10] & 0x07));
        while (p < buf.length) {
            const marker = buf[p];
            if (marker === 0x21) {                       // extension
                p += 2;
                while (buf[p] !== 0) p += buf[p] + 1;    // skip sub-blocks
                p += 1;
            } else if (marker === 0x2c) {                // image descriptor
                found.push({
                    x: buf.readUInt16LE(p + 1), y: buf.readUInt16LE(p + 3),
                    w: buf.readUInt16LE(p + 5), h: buf.readUInt16LE(p + 7)
                });
                p += 10;
                p += 1;                                  // LZW min code size
                while (buf[p] !== 0) p += buf[p] + 1;    // skip image data
                p += 1;
            } else {
                p += 1;
            }
        }
        return found;
    };
    const fullRects = rects(full);
    const deltaRects = rects(delta);
    assert.equal(fullRects.length, 2);
    assert.equal(deltaRects.length, 2);
    assert.equal(fullRects[1].w, width, 'plain frames are full size');
    assert.ok(deltaRects[1].w < width, 'delta sub frame width');
    assert.ok(deltaRects[1].x > 0 || deltaRects[1].y > 0, 'delta sub frame is offset');
});

test('quantiser produces a usable palette for a mixed frame', () => {
    const samples = new Uint8Array(3000);
    for (let i = 0; i < samples.length; i += 3) {
        samples[i] = (i * 7) % 256;
        samples[i + 1] = (i * 13) % 256;
        samples[i + 2] = (i * 29) % 256;
    }
    const { palette, size } = gif.quantize(samples, 64);
    assert.ok(size > 1 && size <= 64);
    assert.equal(palette.length, 768);
    const map = gif.makeMapper(palette, size);
    const first = map(samples[0], samples[1], samples[2]);
    assert.ok(first >= 0 && first < size);
    assert.equal(map(samples[0], samples[1], samples[2]), first, 'mapping is stable');
});

for (const mode of ['browser', 'cancel', 'fallback', 'browser-error', 'native', 'native-fallback', 'native-failure']) {
    test('premium is consumed once on Share GIF: ' + mode, async (t) => {
        const { window, doc } = pageDom(t);
        await settle();
        const page = window.OwBouquetPage;
        const used = new Set();
        let requests = 0;
        window.fetch = async (url, options) => {
            requests++;
            const code = JSON.parse(options.body).code;
            const ok = ['123456789', '987654321'].includes(code) && !used.has(code);
            if (ok && url.endsWith('/redeem')) used.add(code);
            return { ok, json: async () => ok ? { unlocked: true, consumed: url.endsWith('/redeem') } : { error: 'Code invalid or already used.' } };
        };
        async function redeem(code) {
            doc.getElementById('codeInput').value = code;
            await page.redeemCode();
        }
        await redeem('123456789');
        assert.equal(page.state.unlocked, true);
        assert.equal(used.size, 0, 'unlocking never spends the code');
        page.chooseTheme('birthday');
        page.addBloom('hydrangea');
        const original = new window.Blob(['GIF89a-authorized-payload'], { type: 'image/gif' });
        page.state.gifBlob = original;
        page.state.gifUrl = 'blob:authorized';
        doc.getElementById('gifPreview').src = 'blob:authorized';
        const revoked = [];
        window.URL.revokeObjectURL = (url) => revoked.push(url);
        const downloaded = [];
        window.HTMLAnchorElement.prototype.click = function () { downloaded.push(this.download); };
        let finish;
        let shared = 0;
        let cap;
        if (mode.startsWith('native')) {
            cap = installCapacitor(window, { shareFails: mode !== 'native', writeFails: mode === 'native-failure' });
        } else {
            window.navigator.canShare = () => mode !== 'fallback';
            window.navigator.share = async ({ files }) => {
                shared++;
                assert.equal(files[0].size, original.size, 'captured authorized file');
                if (mode === 'cancel') throw new window.DOMException('Cancelled', 'AbortError');
                if (mode === 'browser-error') throw new Error('share failed');
                await new Promise((resolve) => { finish = resolve; });
            };
        }
        const draws = [];
        const drawCard = window.OwBouquet.drawCard;
        window.OwBouquet.drawCard = (ctx, options) => { draws.push(options); return drawCard(ctx, options); };
        const attempt = page.shareGif();
        assert.equal(page.state.unlocked, false, 'locked before OS completes');
        assert.equal(page.state.unlockedCode, null);
        assert.equal(page.needsCode(), true);
        assert.ok(draws.some((options) => options.watermark && options.markPremium), 'locked preview watermarks restored');
        assert.equal(doc.querySelector('.theme-tile[data-theme="birthday"]').dataset.locked, 'true');
        assert.equal(page.state.gifBlob, null, 'old unlocked export cannot be reused');
        assert.equal(page.state.gifUrl, null);
        assert.ok(revoked.includes('blob:authorized'));
        assert.equal(doc.getElementById('gifPreview').hasAttribute('src'), false);
        assert.equal(doc.getElementById('messageInput').readOnly, true);
        assert.equal(doc.querySelector('.flower-btn[data-flower="hydrangea"]').disabled, true);
        const before = page.totalBlooms();
        page.addBloom('hydrangea');
        assert.equal(page.totalBlooms(), before, 'premium additions gated again');
        const repeated = page.shareGif();
        const duringShare = redeem('987654321');
        assert.equal(requests, 2, 'one validation and one consumption; concurrent actions blocked');
        doc.getElementById('createBtn').click();
        assert.equal(page.state.busy, false, 'no racing export during sharing');
        await settle();
        if (finish) finish();
        await Promise.all([attempt, repeated, duringShare]);
        assert.equal(page.state.sharing, false);
        assert.ok(used.has('123456789'), 'only Share GIF spends the code');
        await page.shareGif();
        assert.equal(shared, mode.startsWith('native') || mode === 'fallback' ? 0 : 1);
        assert.equal(downloaded.length, ['fallback', 'browser-error'].includes(mode) ? 1 : 0);
        if (mode === 'native') assert.equal(cap.shares.length, 1);
        if (mode === 'native-fallback') {
            assert.deepEqual(cap.writes.map((w) => w.directory), ['CACHE', 'DOCUMENTS']);
            assert.equal(cap.writes[0].data, cap.writes[1].data, 'fallback retains same authorized bytes');
        }
        await redeem('123456789');
        assert.equal(page.state.unlocked, false, 'spent code does not unlock again');
        await redeem('000000000');
        assert.equal(page.state.unlocked, false, 'incorrect code does not unlock');
        await redeem('987654321');
        assert.equal(page.state.unlocked, true, 'new valid unused code unlocks');
        assert.equal(page.state.gifBlob, null, 'a new GIF must be built');
        assert.equal(doc.getElementById('messageInput').readOnly, false);
    });
}

test('an unlocked free bouquet also consumes its code; ordinary free sharing remains reusable', async (t) => {
    const { window } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    window.navigator.canShare = () => true;
    let shares = 0;
    window.navigator.share = async () => { shares++; };
    page.state.unlocked = true;
    page.state.unlockedCode = '123456789';
    let consumptions = 0;
    window.fetch = async (url) => {
        assert.ok(url.endsWith('/redeem'));
        consumptions++;
        return { ok: true, json: async () => ({ consumed: true }) };
    };
    page.state.gifBlob = new window.Blob(['premium-free']);
    await page.shareGif();
    assert.equal(page.state.unlocked, false);
    assert.equal(page.state.gifBlob, null);
    assert.equal(page.needsCode(), false, 'free design still needs no code');
    page.state.gifBlob = new window.Blob(['ordinary-free']);
    await page.shareGif();
    await page.shareGif();
    assert.equal(shares, 3);
    assert.equal(consumptions, 1, 'ordinary free sharing makes no code requests');
    assert.ok(page.state.gifBlob, 'ordinary free export remains reusable');
});

// Shared server double for page reloads and multiple tabs. Production service
// transaction behavior is tested independently in gift-codes.test.js.
function codeServer() {
    const used = new Set();
    const calls = [];
    const fetch = async (url, options) => {
        const code = JSON.parse(options.body).code;
        const action = url.split('/').pop();
        calls.push({ action, code });
        const ok = code === '123456789' && !used.has(code);
        if (ok && action === 'redeem') used.add(code);
        return { ok, json: async () => ok
            ? { unlocked: true, consumed: action === 'redeem' }
            : { error: 'That code has already been used or is invalid.' } };
    };
    return { used, calls, fetch };
}

async function unlockPage(view, server) {
    view.window.fetch = server.fetch;
    view.doc.getElementById('codeInput').value = '123456789';
    await view.window.OwBouquetPage.redeemCode();
}

function readyPremiumGif(view) {
    const page = view.window.OwBouquetPage;
    page.chooseTheme('birthday');
    page.state.gifBlob = new view.window.Blob(['GIF89a-premium'], { type: 'image/gif' });
    return page;
}

test('refresh before Share GIF preserves the code benefit; it can unlock again', async (t) => {
    const server = codeServer();
    const original = pageDom(t);
    await settle();
    await unlockPage(original, server);
    assert.equal(original.window.OwBouquetPage.state.unlocked, true);
    assert.equal(server.used.size, 0);
    const refreshed = pageDom(t);
    await settle();
    assert.equal(refreshed.window.OwBouquetPage.state.unlocked, false);
    await unlockPage(refreshed, server);
    assert.equal(refreshed.window.OwBouquetPage.state.unlocked, true);
    assert.equal(server.used.size, 0);
    assert.deepEqual(server.calls.map((c) => c.action), ['validate', 'validate']);
    assert.match(refreshed.doc.getElementById('premiumStatus').textContent, /still unused/);
});

test('two previously unlocked tabs race to share and only the winner transfers a GIF', async (t) => {
    const server = codeServer();
    const tabs = [pageDom(t), pageDom(t)];
    await settle();
    let shares = 0;
    for (const view of tabs) {
        await unlockPage(view, server);
        assert.equal(view.window.OwBouquetPage.state.unlocked, true);
        readyPremiumGif(view);
        view.window.navigator.canShare = () => true;
        view.window.navigator.share = async () => { shares++; };
    }
    await Promise.all(tabs.map((v) => v.window.OwBouquetPage.shareGif()));
    assert.equal(shares, 1);
    assert.equal(server.used.size, 1);
    assert.equal(server.calls.filter((c) => c.action === 'redeem').length, 2);
    for (const view of tabs) {
        assert.equal(view.window.OwBouquetPage.state.unlocked, false);
        assert.equal(view.window.OwBouquetPage.state.gifBlob, null);
        await unlockPage(view, server);
        assert.equal(view.window.OwBouquetPage.state.unlocked, false, 'spent code cannot unlock either tab');
    }
});

test('Share GIF waits for consumption confirmation and ignores concurrent taps/redemption/export', async (t) => {
    const view = pageDom(t);
    await settle();
    const server = codeServer();
    await unlockPage(view, server);
    const page = readyPremiumGif(view);
    let resolve;
    let requests = 0;
    let transfers = 0;
    view.window.fetch = async (url, options) => {
        requests++;
        assert.ok(url.endsWith('/redeem'));
        assert.equal(JSON.parse(options.body).code, '123456789');
        return new Promise((done) => { resolve = done; });
    };
    view.window.navigator.canShare = () => true;
    view.window.navigator.share = async () => { transfers++; };
    const sharing = page.shareGif();
    await settle();
    assert.equal(transfers, 0, 'no bytes transferred before server confirms usage');
    assert.equal(page.state.unlocked, false);
    await page.shareGif();
    view.doc.getElementById('codeInput').value = '987654321';
    await page.redeemCode();
    view.doc.getElementById('createBtn').click();
    assert.equal(requests, 1);
    assert.equal(page.state.busy, false);
    assert.equal(await page.downloadGif(), false);
    resolve({ ok: true, json: async () => ({ consumed: true }) });
    await sharing;
    assert.equal(transfers, 1);
    assert.equal(page.state.sharing, false);
});

for (const failure of ['spent', 'disabled', 'unavailable', 'network', 'unconfirmed', 'invalid-json']) {
    test('no transfer or retained premium export when consumption fails: ' + failure, async (t) => {
        const view = pageDom(t);
        await settle();
        await unlockPage(view, codeServer());
        const page = readyPremiumGif(view);
        let transfers = 0;
        view.window.navigator.canShare = () => true;
        view.window.navigator.share = async () => { transfers++; };
        view.window.HTMLAnchorElement.prototype.click = () => { transfers++; };
        view.window.fetch = async () => {
            if (failure === 'network') throw new Error('offline');
            return {
                ok: ['unconfirmed', 'invalid-json'].includes(failure),
                json: async () => {
                    if (failure === 'invalid-json') throw new Error('bad JSON');
                    return failure === 'unconfirmed' ? { unlocked: true } : { error: failure };
                }
            };
        };
        await page.shareGif();
        assert.equal(transfers, 0);
        assert.equal(page.state.unlocked, false);
        assert.equal(page.state.unlockedCode, null);
        assert.equal(page.state.gifBlob, null);
        assert.equal(page.state.sharing, false);
        assert.equal(view.doc.getElementById('shareGifBtn').disabled, false);
        assert.match(view.doc.getElementById('shareNotice').textContent, /Nothing was shared/i);
        await unlockPage(view, codeServer());
        assert.equal(page.state.unlocked, true, 'a genuinely unused code can be revalidated after a failed request');
    });
}

test('a lost consumption response blocks sharing even if the server already spent the code', async (t) => {
    const view = pageDom(t);
    await settle();
    const server = codeServer();
    await unlockPage(view, server);
    const page = readyPremiumGif(view);
    let transfers = 0;
    view.window.navigator.canShare = () => true;
    view.window.navigator.share = async () => { transfers++; };
    view.window.fetch = async (url, options) => {
        await server.fetch(url, options); // transaction commits, response is lost
        throw new Error('connection dropped');
    };
    await page.shareGif();
    assert.equal(transfers, 0);
    assert.equal(server.used.size, 1);
    await unlockPage(view, server);
    assert.equal(page.state.unlocked, false);
    assert.match(view.doc.getElementById('premiumStatus').textContent, /already been used/);
});
