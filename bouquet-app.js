// E-Bouquet page logic.
//
// Flow: pick 6-10 blooms -> arrange (seeded, reproducible) -> write a note ->
// render the animated card on a canvas -> encode a GIF in the browser -> share.
//
// Nothing leaves the device: the GIF is built locally and the WhatsApp link
// only carries a text message, so we never need a backend or file host.
(function () {
    'use strict';

    const engine = window.OwBouquet;
    const gifEncoder = window.OwGif;
    if (!engine || !gifEncoder) {
        console.error('E-Bouquet: renderer failed to load.');
        return;
    }

    const MIN_BLOOMS = 6;
    const MAX_BLOOMS = 10;
    const MAX_MESSAGE = 220;
    const MAX_FROM = 28;

    // Card canvas size for the GIF. 440x550 keeps the animation under ~1.5 MB
    // (WhatsApp's own sticker limit is far lower, but a document send is fine).
    const CARD_W = 440;
    const CARD_H = 550;
    const PREVIEW_W = 440;
    const PREVIEW_H = 550;

    const FLOWERS = [
        { id: 'rose', name: 'Rose', mood: 'love & passion', month: 'June' },
        { id: 'peony', name: 'Peony', mood: 'good fortune', month: 'May' },
        { id: 'sunflower', name: 'Sunflower', mood: 'warmth & joy', month: 'August' },
        { id: 'tulip', name: 'Tulip', mood: 'perfect love', month: 'April' },
        { id: 'lily', name: 'Lily', mood: 'purity & grace', month: 'July' },
        { id: 'daisy', name: 'Daisy', mood: 'innocence', month: 'April' },
        { id: 'ranunculus', name: 'Ranunculus', mood: 'you are radiant', month: 'March' },
        { id: 'zinnia', name: 'Zinnia', mood: 'lasting affection', month: 'September' },
        { id: 'orchid', name: 'Orchid', mood: 'rare beauty', month: 'February' },
        { id: 'anemone', name: 'Anemone', mood: 'anticipation', month: 'October' }
    ];

    const GREENERY_STYLES = [
        { id: 'classic', label: 'classic' },
        { id: 'lush', label: 'lush' },
        { id: 'minimal', label: 'minimal' }
    ];

    const state = {
        counts: {},            // flowerId -> number chosen
        arrangementSeed: 1,
        greenery: 0,
        nudges: {},            // index -> {dx, dy}
        message: '',
        from: '',
        images: {},            // flowerId -> HTMLImageElement
        owlImg: null,
        gifBlob: null,
        gifUrl: null,
        busy: false
    };

    // ------------------------------------------------------------ elements --
    const el = {
        grid: document.getElementById('flowerGrid'),
        counter: document.getElementById('pickCounter'),
        notice: document.getElementById('pickNotice'),
        canvas: document.getElementById('previewCanvas'),
        shuffle: document.getElementById('shuffleBtn'),
        greenery: document.getElementById('greeneryBtn'),
        greeneryChip: document.getElementById('greeneryChip'),
        arrangeSelect: document.getElementById('arrangeSelect'),
        arrangeControls: document.getElementById('arrangeControls'),
        message: document.getElementById('messageInput'),
        from: document.getElementById('fromInput'),
        charCount: document.getElementById('charCount'),
        createBtn: document.getElementById('createBtn'),
        progressWrap: document.getElementById('progressWrap'),
        progressBar: document.getElementById('progressBar'),
        shareNotice: document.getElementById('shareNotice'),
        shareResult: document.getElementById('shareResult'),
        gifPreview: document.getElementById('gifPreview'),
        gifMeta: document.getElementById('gifMeta'),
        sendGifBtn: document.getElementById('sendGifBtn'),
        sendHint: document.getElementById('sendHint'),
        gifLink: document.getElementById('gifLink'),
        copyLink: document.getElementById('copyLinkBtn'),
        linkHint: document.getElementById('linkHint')
    };

    const ctx = el.canvas.getContext('2d');

    // --------------------------------------------------------------- utils --
    function totalBlooms() {
        return Object.values(state.counts).reduce((a, b) => a + b, 0);
    }

    function selectedFlowerIds() {
        const list = [];
        for (let i = 0; i < FLOWERS.length; i++) {
            const n = state.counts[FLOWERS[i].id] || 0;
            for (let k = 0; k < n; k++) list.push(FLOWERS[i].id);
        }
        return list;
    }

    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Could not load ' + src));
            img.src = src;
        });
    }

    function setNotice(node, text, kind) {
        if (!text) { node.hidden = true; node.textContent = ''; return; }
        node.hidden = false;
        node.textContent = text;
        node.className = 'notice ' + (kind === 'ok' ? 'notice-ok' : 'notice-warn');
    }

    // ------------------------------------------------------- flower picker --
    function renderFlowerGrid() {
        el.grid.innerHTML = '';
        FLOWERS.forEach((flower) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'flower-btn';
            btn.dataset.flower = flower.id;
            btn.setAttribute('aria-pressed', 'false');
            btn.innerHTML =
                '<span class="flower-count" aria-hidden="true">0</span>' +
                '<img src="assets/flowers/' + flower.id + '.png" alt="' + flower.name + '" width="68" height="68" loading="lazy">' +
                '<span class="flower-name">' + flower.name + '</span>';
            btn.addEventListener('click', () => toggleFlower(flower.id));
            el.grid.appendChild(btn);
        });
        syncFlowerGrid();
    }

    function syncFlowerGrid() {
        const capped = totalBlooms() >= MAX_BLOOMS;
        el.grid.querySelectorAll('.flower-btn').forEach((btn) => {
            const id = btn.dataset.flower;
            const n = state.counts[id] || 0;
            btn.dataset.count = String(n);
            btn.setAttribute('aria-pressed', n > 0 ? 'true' : 'false');
            btn.querySelector('.flower-count').textContent = String(n);
            // Once the bouquet is full only flowers already in it stay active:
            // tapping those removes a bloom and frees a slot.
            const blocked = capped && n === 0;
            btn.classList.toggle('is-at-max', blocked);
            btn.disabled = blocked;
            btn.setAttribute('aria-label', FLOWERS.find(f => f.id === id).name + ', ' + n + ' selected');
        });

        const total = totalBlooms();
        el.counter.textContent = total + ' / ' + MIN_BLOOMS + '–' + MAX_BLOOMS;
        el.counter.className = 'chip pick-counter ' + (total >= MIN_BLOOMS ? 'is-good' : 'is-low');

        if (total < MIN_BLOOMS) {
            setNotice(el.notice, 'Add ' + (MIN_BLOOMS - total) + ' more bloom' + (MIN_BLOOMS - total === 1 ? '' : 's') + ' to continue.', 'warn');
        } else if (total >= MAX_BLOOMS) {
            setNotice(el.notice, 'Lovely — that is a full bouquet. Tap a flower to swap it out.', 'ok');
        } else {
            setNotice(el.notice, '', 'ok');
        }
    }

    function toggleFlower(id) {
        const total = totalBlooms();
        const current = state.counts[id] || 0;
        if (current === 0 && total >= MAX_BLOOMS) {
            // full bouquet: nudge the counter, the button is disabled in the UI
            el.counter.animate(
                [{ transform: 'translateX(0)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(0)' }],
                { duration: 220 }
            );
            return;
        }
        if (current === 0) state.counts[id] = 1;
        else if (current === 1) delete state.counts[id];
        else state.counts[id] = current - 1;
        syncFlowerGrid();
        refreshArrangeSelect();
        drawPreview();
        invalidateExport();
    }

    // --------------------------------------------------------- arrangement --
    // The card renderer owns the layout maths: given the flower list, the seed
    // and the card size it returns a bouquet that is guaranteed to fit between
    // the header and the message panel. Both the preview and the export call it
    // with the same inputs, so they always match.
    function drawCardTo(targetCtx, width, height, time) {
        const ids = selectedFlowerIds();
        const images = {};
        ids.forEach((id, i) => { if (state.images[id]) images[i] = state.images[id]; });
        return engine.drawCard(targetCtx, {
            width, height,
            images,
            owlImg: state.owlImg,
            seed: state.arrangementSeed,
            nudges: state.nudges,
            greenery: GREENERY_STYLES[state.greenery].id,
            flowers: ids,
            flowerCount: ids.length,
            message: state.message,
            from: state.from,
            time: time || 0,
            reduceMotion: false,
            stars: previewStars()
        });
    }

    function drawPreview(time) {
        const ids = selectedFlowerIds();
        if (!ids.length) {
            engine.paintSky(ctx, PREVIEW_W, PREVIEW_H);
            engine.paintStars(ctx, engine.buildStars(90, 5, PREVIEW_W, PREVIEW_H), 0, true);
            ctx.save();
            ctx.fillStyle = 'rgba(255, 240, 214, 0.78)';
            ctx.font = '600 15px "Inter", system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Pick a few blooms to start', PREVIEW_W / 2, PREVIEW_H * 0.52);
            ctx.font = '400 12px "Inter", system-ui, sans-serif';
            ctx.fillStyle = 'rgba(255, 236, 205, 0.55)';
            ctx.fillText('6 to 10 flowers', PREVIEW_W / 2, PREVIEW_H * 0.52 + 22);
            ctx.restore();
            return;
        }
        drawCardTo(ctx, PREVIEW_W, PREVIEW_H, time);
    }

    let starCache = null;
    function previewStars() {
        if (!starCache) starCache = engine.buildStars(130, 424242, PREVIEW_W, PREVIEW_H);
        return starCache;
    }

    // Light idle animation so the preview feels alive (paused for reduced
    // motion and when the tab is hidden). Stops for good if the page unloads.
    const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let stopped = false;
    function tick(now) {
        if (stopped) return;
        try {
            if (!reduceMotion && !document.hidden && selectedFlowerIds().length) {
                drawPreview(typeof now === 'number' ? now / 1000 : undefined);
            }
            window.requestAnimationFrame(tick);
        } catch (err) {
            // The document went away (navigation or a closed test window).
            stopped = true;
        }
    }
    window.addEventListener('pagehide', () => { stopped = true; });

    function shuffleArrangement() {
        // walk the seed forward until the arrangement actually differs visibly
        let seed = state.arrangementSeed;
        const before = state.arrangementSeed;
        for (let i = 0; i < 12; i++) {
            seed = engine.hashString(String(seed) + ':shuffle');
            if (seed !== before) break;
        }
        state.arrangementSeed = seed;
        state.nudges = {};
        refreshArrangeSelect();
        drawPreview();
        invalidateExport();
    }

    function cycleGreenery() {
        state.greenery = (state.greenery + 1) % GREENERY_STYLES.length;
        el.greeneryChip.textContent = 'Greenery: ' + GREENERY_STYLES[state.greenery].label;
        drawPreview();
        invalidateExport();
    }

    // ------------------------------------------------------------ fine tune --
    function refreshArrangeSelect() {
        const ids = selectedFlowerIds();
        el.arrangeSelect.innerHTML = '';
        ids.forEach((id, i) => {
            const opt = document.createElement('option');
            opt.value = String(i);
            const flower = FLOWERS.find(f => f.id === id);
            opt.textContent = '#' + (i + 1) + ' · ' + (flower ? flower.name : id);
            el.arrangeSelect.appendChild(opt);
        });
        el.arrangeControls.style.display = ids.length ? 'flex' : 'none';
    }

    function nudge(dir) {
        const idx = Number(el.arrangeSelect.value || 0);
        if (!state.nudges[idx]) state.nudges[idx] = { dx: 0, dy: 0 };
        const n = state.nudges[idx];
        if (dir === 'up') n.dy -= 1;
        else if (dir === 'down') n.dy += 1;
        else if (dir === 'left') n.dx -= 1;
        else if (dir === 'right') n.dx += 1;
        else if (dir === 'reset') state.nudges = {};
        else if (dir === 'front') {
            // draw this bloom on top of the rest
            n.front = true;
        }
        drawPreview();
        invalidateExport();
    }

    // ------------------------------------------------------------- the GIF --
    function invalidateExport() {
        if (!state.gifBlob) return;
        releaseGif();
        setNotice(el.shareNotice, 'Your bouquet changed — create the GIF again to share the new version.', 'warn');
        el.createBtn.disabled = false;
        el.createBtn.innerHTML = 'Create my bouquet GIF';
    }

    function releaseGif() {
        if (state.gifUrl) URL.revokeObjectURL(state.gifUrl);
        state.gifUrl = null;
        state.gifBlob = null;
        el.shareResult.classList.remove('is-visible');
        el.gifPreview.removeAttribute('src');
    }

    async function createGif() {
        if (state.busy) return;
        const ids = selectedFlowerIds();
        if (ids.length < MIN_BLOOMS) {
            setNotice(el.shareNotice, 'Pick at least ' + MIN_BLOOMS + ' blooms first.', 'warn');
            document.getElementById('pickTitle').scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }
        state.busy = true;
        el.createBtn.disabled = true;
        setNotice(el.shareNotice, '', 'ok');
        el.progressWrap.hidden = false;
        setProgress(0.05);

        // A second canvas at card size keeps the preview crisp and the export
        // independent of whatever the preview canvas is doing.
        const canvas = document.createElement('canvas');
        canvas.width = CARD_W;
        canvas.height = CARD_H;
        const gctx = canvas.getContext('2d');

        const FRAMES = ids.length >= 9 ? 18 : 20;
        const CYCLES = 2;            // seconds of animation, loops seamlessly
        const frames = [];

        try {
            for (let f = 0; f < FRAMES; f++) {
                drawCardTo(gctx, CARD_W, CARD_H, (f / FRAMES) * CYCLES);
                const data = gctx.getImageData(0, 0, CARD_W, CARD_H).data;
                frames.push({ data: new Uint8ClampedArray(data), delay: Math.round((CYCLES * 100) / FRAMES) });
                setProgress(0.05 + (f / FRAMES) * 0.6);
                await nextFrame();
            }

            const bytes = gifEncoder.encodeFrames(frames, CARD_W, CARD_H, { maxColors: 128, delta: true });
            setProgress(0.85);
            await nextFrame();

            const blob = new Blob([bytes], { type: 'image/gif' });
            state.gifBlob = blob;
            state.gifUrl = URL.createObjectURL(blob);
            setProgress(1);

            el.gifPreview.src = state.gifUrl;
            el.gifMeta.textContent = CARD_W + '×' + CARD_H + ' · ' + (blob.size / 1024).toFixed(0) + ' KB · ' + FRAMES + ' frames';
            el.shareResult.classList.add('is-visible');
            el.createBtn.disabled = false;
            el.createBtn.innerHTML = 'Create again';
            updateSendHint();
            buildLink();
            el.shareResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (err) {
            console.error('E-Bouquet export failed:', err);
            setNotice(el.shareNotice, 'Sorry, the GIF could not be created on this device. Try fewer blooms or a shorter message.', 'warn');
            el.createBtn.disabled = false;
        } finally {
            state.busy = false;
            el.progressWrap.hidden = true;
        }
    }

    function setProgress(v) {
        el.progressBar.style.width = Math.round(Math.max(0, Math.min(1, v)) * 100) + '%';
    }

    function nextFrame() {
        return new Promise((resolve) => requestAnimationFrame(() => resolve()));
    }

    // ------------------------------------------------------- link + sharing --
    function sharePayload() {
        const ids = selectedFlowerIds();
        const flowers = ids.join(',');
        const note = state.message.trim();
        const from = state.from.trim();
        return { flowers, note, from };
    }

    // A compact text-only link: the bouquet is re-built on the other device,
    // so no image ever has to be uploaded.
    function buildLink() {
        const payload = sharePayload();
        const params = new URLSearchParams();
        params.set('b', payload.flowers);
        params.set('s', String(state.arrangementSeed));
        if (payload.note) params.set('m', payload.note);
        if (payload.from) params.set('f', payload.from);
        const url = window.location.origin === 'null'
            ? 'bouquet.html?' + params.toString()
            : new URL('bouquet.html?' + params.toString(), window.location.href).href;
        el.gifLink.value = url;
        el.linkHint.textContent = 'Send this link too — they can open the bouquet and make it their own.';
    }

    function updateSendHint() {
        const payload = sharePayload();
        const flowerNames = Array.from(new Set(selectedFlowerIds()))
            .map(id => (FLOWERS.find(f => f.id === id) || {}).name || id);
        const text = [
            '🌷 An E-Bouquet by Owl Watcher for you 🌷',
            flowerNames.length ? 'Made with ' + flowerNames.join(', ') + '.' : '',
            payload.note ? '\n"' + payload.note + '"' : '',
            payload.from ? '— ' + payload.from : '',
            '\nOpen your own at owlwatcher.tech/bouquet.html'
        ].filter(Boolean).join('\n');
        state.shareText = text;
        el.sendHint.textContent = 'WhatsApp opens with your note ready. Attach the GIF from your downloaded files.';
    }

    async function downloadGif() {
        if (!state.gifBlob) return null;
        const filename = 'ebouquet-owlwatcher-' + Date.now() + '.gif';
        const file = new File([state.gifBlob], filename, { type: 'image/gif' });

        // Browsers that support it can hand the file straight to the share
        // sheet, where WhatsApp will appear as a target with the image attached.
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({ files: [file], text: state.shareText || '' });
                return { direct: true, filename };
            } catch (err) {
                if (err && err.name === 'AbortError') return { direct: true, filename, cancelled: true };
                // fall through to the download route
            }
        }
        const url = URL.createObjectURL(state.gifBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        return { direct: false, filename };
    }

    async function sendToWhatsApp() {
        if (!state.gifBlob) return;
        // Always save the GIF first: on phones the WhatsApp tab opens over the
        // page, so the download has to start while we still have the gesture.
        const result = await downloadGif();
        if (result && result.cancelled) return;

        const attachHint = result && result.direct
            ? 'Check WhatsApp — your bouquet GIF should already be attached.'
            : 'Your GIF is saved to Downloads. In WhatsApp, tap 📎 → Gallery (or Document → GIF) → your latest file.';
        const text = [state.shareText || '', result && !result.direct ? '\n\n📎 GIF saved as ' + result.filename : '']
            .filter(Boolean).join('');
        el.sendHint.textContent = attachHint;

        // wa.me works on mobile and desktop; the text pre-fills the chat.
        window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
    }

    async function copyLink() {
        const value = el.gifLink.value;
        if (!value) return;
        try {
            await navigator.clipboard.writeText(value);
            el.copyLink.textContent = 'Copied';
            setTimeout(() => { el.copyLink.textContent = 'Copy'; }, 1600);
        } catch (e) {
            el.gifLink.select();
            document.execCommand && document.execCommand('copy');
            el.copyLink.textContent = 'Copied';
            setTimeout(() => { el.copyLink.textContent = 'Copy'; }, 1600);
        }
    }

    // ------------------------------------------------------------ prefill --
    // Opening bouquet.html?b=rose,lily&m=hello lets a recipient see (and keep
    // building) a bouquet someone sent them.
    function readLink() {
        const params = new URLSearchParams(window.location.search);
        const b = params.get('b');
        if (!b) return false;
        const ids = b.split(',').map(s => s.trim()).filter(Boolean);
        let ok = false;
        ids.slice(0, MAX_BLOOMS).forEach((id) => {
            if (FLOWERS.some(f => f.id === id)) {
                state.counts[id] = (state.counts[id] || 0) + 1;
                ok = true;
            }
        });
        const s = Number(params.get('s'));
        if (s && Number.isFinite(s)) state.arrangementSeed = s >>> 0;
        const m = params.get('m');
        if (m) state.message = m.slice(0, MAX_MESSAGE);
        const f = params.get('f');
        if (f) state.from = f.slice(0, MAX_FROM);
        return ok;
    }

    // --------------------------------------------------------------- init --
    function bindEvents() {
        el.shuffle.addEventListener('click', shuffleArrangement);
        el.greenery.addEventListener('click', cycleGreenery);
        el.arrangeControls.addEventListener('click', (event) => {
            const btn = event.target.closest('[data-nudge]');
            if (btn) nudge(btn.dataset.nudge);
        });
        el.message.addEventListener('input', () => {
            state.message = el.message.value.slice(0, MAX_MESSAGE);
            const len = state.message.length;
            el.charCount.textContent = len + ' / ' + MAX_MESSAGE;
            el.charCount.classList.toggle('is-near', len > MAX_MESSAGE * 0.85);
            drawPreview();
            invalidateExport();
        });
        el.from.addEventListener('input', () => {
            state.from = el.from.value.slice(0, MAX_FROM);
            drawPreview();
            invalidateExport();
        });
        el.createBtn.addEventListener('click', createGif);
        el.sendGifBtn.addEventListener('click', sendToWhatsApp);
        el.copyLink.addEventListener('click', copyLink);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) drawPreview(); });
    }

    async function init() {
        renderFlowerGrid();
        bindEvents();

        const prefilled = readLink();
        if (prefilled) {
            el.message.value = state.message;
            el.from.value = state.from;
            el.charCount.textContent = state.message.length + ' / ' + MAX_MESSAGE;
            syncFlowerGrid();
        }

        // default arrangement seed is stable per visit
        state.arrangementSeed = state.arrangementSeed || engine.hashString('owl-watcher-bouquet');

        const loads = FLOWERS.map((f) => loadImage('assets/flowers/' + f.id + '.png').then((img) => { state.images[f.id] = img; }));
        loads.push(loadImage('owl.png').then((img) => { state.owlImg = img; }).catch(() => {}));
        try {
            await Promise.all(loads);
        } catch (err) {
            console.error('E-Bouquet: some artwork failed to load.', err);
        }
        drawPreview();
        refreshArrangeSelect();
        requestAnimationFrame(tick);
    }

    // expose a couple of internals for tests / debugging
    window.OwBouquetPage = {
        FLOWERS, MIN_BLOOMS, MAX_BLOOMS, state,
        totalBlooms, selectedFlowerIds, drawCardTo
    };

    init();
})();
