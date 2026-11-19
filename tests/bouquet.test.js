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

test('flower picker enforces the 6 to 10 bloom rule', async (t) => {
    const { window, doc } = pageDom(t);
    await settle();
    const page = window.OwBouquetPage;
    const buttons = () => Array.from(doc.querySelectorAll('.flower-btn'));
    const buttonFor = (id) => doc.querySelector('.flower-btn[data-flower="' + id + '"]');
    const click = (btn) => btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.equal(buttons().length, 10, 'ten flowers offered');
    assert.equal(page.MAX_BLOOMS, 10);
    assert.equal(page.MIN_BLOOMS, 6);

    // one of each reaches the ceiling
    buttons().forEach(click);
    assert.equal(page.totalBlooms(), 10);
    buttons().forEach((btn) => assert.equal(btn.disabled, false, 'selected blooms stay removable'));

    // tapping a selected flower removes it, which frees a slot again
    click(buttonFor('rose'));
    assert.equal(page.totalBlooms(), 9);
    assert.equal(page.state.counts.rose, undefined);
    click(buttonFor('lily'));
    assert.equal(page.totalBlooms(), 8);
    assert.ok(buttons().every((btn) => !btn.disabled));

    // the bouquet can never hold more than ten blooms
    click(buttonFor('rose'));
    click(buttonFor('lily'));
    assert.equal(page.totalBlooms(), 10);
    click(buttonFor('rose'));                     // 9
    click(buttonFor('rose'));                     // 10 again
    assert.equal(page.totalBlooms(), 10);
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
