// E-Bouquet page logic.
//
// Flow: pick 6-10 blooms -> arrange (seeded, reproducible) -> write a note ->
// render the animated card on a canvas -> encode a GIF in the browser -> share.
//
// Nothing leaves the device: the GIF is built locally and either downloaded as
// a file or handed to the OS share sheet, so we never need a backend or file
// host.
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
    // A single variety can fill the whole bouquet if the sender wants that.
    const MAX_PER_FLOWER = 10;
    const MAX_MESSAGE = 220;
    const MAX_FROM = 28;

    // Card canvas size for the GIF. 440x550 keeps the animation under ~1.5 MB,
    // small enough to send as a normal chat attachment.
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
        { id: 'anemone', name: 'Anemone', mood: 'anticipation', month: 'October' },
        // ---- premium varieties (a code unlocks these for one bouquet) ----
        { id: 'dahlia', name: 'Dahlia', mood: 'inner strength', month: 'August', premium: true },
        { id: 'hydrangea', name: 'Hydrangea', mood: 'heartfelt thanks', month: 'June', premium: true },
        { id: 'magnolia', name: 'Magnolia', mood: 'dignity', month: 'May', premium: true },
        { id: 'protea', name: 'Protea', mood: 'courage', month: 'September', premium: true },
        { id: 'hellebore', name: 'Hellebore', mood: 'serenity', month: 'January', premium: true },
        { id: 'sweetpea', name: 'Sweet Pea', mood: 'blissful pleasure', month: 'March', premium: true }
    ];

    // Where the redeem call goes. Same host as the API the rest of the app uses.
    const API_BASE_URL = (window.OWL_API_BASE || 'https://us-central1-finder-owl.cloudfunctions.net/api');
    // Owl Watcher team's WhatsApp for buying a code. The real number lives in
    // Firestore (configs/owlwatcher.teamPhone) and is read through the public
    // /config endpoint; this value is only used until that answer arrives or
    // when the network is unavailable.
    const FALLBACK_WA_NUMBER = '919033406816';
    const CODE_HELP_TEXT = 'Hi Owl Watcher! I would like to buy an E-Bouquet premium code (Rs.30).';

    function codeHelpUrl(number) {
        const digits = String(number || '').replace(/\D/g, '');
        const target = digits.length >= 10 ? digits : FALLBACK_WA_NUMBER;
        return 'https://wa.me/' + target + '?text=' + encodeURIComponent(CODE_HELP_TEXT);
    }

    const CODE_HELP_URL = codeHelpUrl(FALLBACK_WA_NUMBER);

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
        busy: false,
        sharing: false,
        redeeming: false,
        theme: 'night',        // selected theme id
        unlocked: false,       // a code is available for one share attempt
        unlockedCode: null,
        pendingTheme: null     // premium theme the visitor tried to pick
    };

    // ------------------------------------------------------------ elements --
    const el = {
        grid: document.getElementById('flowerGrid'),
        counter: document.getElementById('pickCounter'),
        notice: document.getElementById('pickNotice'),
        clearBlooms: document.getElementById('clearBloomsBtn'),
        canvas: document.getElementById('previewCanvas'),
        shuffle: document.getElementById('shuffleBtn'),
        greenery: document.getElementById('greeneryBtn'),
        greeneryChip: document.getElementById('greeneryChip'),
        arrangeSelect: document.getElementById('arrangeSelect'),
        arrangeControls: document.getElementById('arrangeControls'),
        message: document.getElementById('messageInput'),
        from: document.getElementById('fromInput'),
        charCount: document.getElementById('charCount'),
        messageLock: document.getElementById('messageLock'),
        createBtn: document.getElementById('createBtn'),
        progressWrap: document.getElementById('progressWrap'),
        progressBar: document.getElementById('progressBar'),
        shareNotice: document.getElementById('shareNotice'),
        shareResult: document.getElementById('shareResult'),
        gifPreview: document.getElementById('gifPreview'),
        gifMeta: document.getElementById('gifMeta'),
        shareGifBtn: document.getElementById('shareGifBtn'),
        themeGrid: document.getElementById('themeGrid'),
        themeChip: document.getElementById('themeChip'),
        premiumToggle: document.getElementById('premiumToggle'),
        premiumDetails: document.getElementById('premiumDetails'),
        buyCodeLink: document.getElementById('buyCodeLink'),
        codeInput: document.getElementById('codeInput'),
        redeemBtn: document.getElementById('redeemBtn'),
        premiumStatus: document.getElementById('premiumStatus'),
        sendHint: document.getElementById('sendHint'),
        //gifLink: document.getElementById('gifLink'),
        //copyLink: document.getElementById('copyLinkBtn'),
        //linkHint: document.getElementById('linkHint')
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
    // ------------------------------------------------------- theme + locks --
    function flowerById(id) {
        return FLOWERS.find((f) => f.id === id) || null;
    }

    function isPremiumFlower(id) {
        const f = flowerById(id);
        return !!(f && f.premium);
    }

    function selectedPremiumFlowers() {
        return selectedFlowerIds().filter(isPremiumFlower);
    }

    function themeById(id) {
        return engine.themeById(id);
    }

    // A bouquet needs a code when it uses a premium theme or any premium flower.
    // The free night-sky theme and the ten original flowers never need one.
    function needsCode() {
        if (state.unlocked) return false;
        if (themeById(state.theme).free !== true) return true;
        return selectedPremiumFlowers().length > 0;
    }

    // Writing the note is part of the paid experience: while a premium theme is
    // selected and no code has been redeemed, both fields are read-only. The
    // free theme never locks, and unlocking enables typing immediately.
    function messageLocked() {
        return !state.unlocked && themeById(state.theme).free !== true;
    }

    function syncMessageLock() {
        const locked = messageLocked();
        [el.message, el.from].forEach((field) => {
            if (!field) return;
            field.readOnly = locked;
            field.setAttribute('aria-readonly', String(locked));
        });
        if (el.messageLock) {
            el.messageLock.hidden = !locked;
            el.messageLock.textContent = locked
                ? 'Writing your note unlocks with a code — redeem one above to type your message.'
                : '';
        }
        return locked;
    }

    function setPremiumStatus(text, kind) {
        if (!el.premiumStatus) return;
        el.premiumStatus.textContent = text || '';
        el.premiumStatus.className = 'small premium-status' +
            (kind === 'ok' ? ' is-ok' : kind === 'err' ? ' is-err' : '');
    }

    function renderThemeGrid() {
        if (!el.themeGrid) return;
        el.themeGrid.innerHTML = '';
        engine.THEMES.forEach((theme) => {
            const tile = document.createElement('button');
            tile.type = 'button';
            tile.className = 'theme-tile';
            tile.dataset.theme = theme.id;
            tile.dataset.locked = String(!theme.free && !state.unlocked);
            tile.setAttribute('role', 'button');
            tile.innerHTML = '<canvas width="132" height="165" aria-hidden="true"></canvas>' +
                '<span class="theme-name">' + theme.name + '</span>';
            tile.setAttribute('aria-label', theme.name + (theme.free ? ', free' : ', premium'));
            tile.setAttribute('aria-pressed', String(state.theme === theme.id));
            tile.addEventListener('click', () => chooseTheme(theme.id));

            // Draw a miniature using the same renderer as the real card, so the
            // thumbnail is an honest representation of the theme.
            const c = tile.querySelector('canvas');
            const tctx = c.getContext('2d');
            if (tctx) {
                try {
                    const sample = FLOWERS.slice(0, 6);
                    const images = {};
                    sample.forEach((f, i) => { if (state.images[f.id]) images[i] = state.images[f.id]; });
                    engine.drawCard(tctx, {
                        width: 132, height: 165,
                        images,
                        owlImg: state.owlImg,
                        seed: 7, time: 0.6,
                        flowers: sample.map((f) => f.id), flowerCount: sample.length,
                        greenery: 'classic', message: '', from: '',
                        theme: theme.id, reduceMotion: true
                    });
                } catch (err) {
                    // A thumbnail failure must never break the page.
                    console.error('E-Bouquet: theme preview failed.', err);
                }
            }

            el.themeGrid.appendChild(tile);
        });

        const active = themeById(state.theme);
        if (el.themeChip) el.themeChip.textContent = active.name;
    }

    function syncThemeGrid() {
        if (!el.themeGrid) return;
        el.themeGrid.querySelectorAll('.theme-tile').forEach((tile) => {
            const theme = themeById(tile.dataset.theme);
            tile.dataset.locked = String(!theme.free && !state.unlocked);
            tile.setAttribute('aria-pressed', String(state.theme === theme.id));
        });
    }

    function chooseTheme(id) {
        const theme = themeById(id);
        state.theme = id;
        syncThemeGrid();

        // The note belongs to the free experience. Selecting a locked
        // premium theme wipes whatever was typed on the free theme, so a
        // visitor can never keep a note into a theme they can't yet share.
        if (!theme.free && !state.unlocked) {
            clearNote();
        }

        syncMessageLock();
        drawPreview();
        invalidateExport();

        if (!theme.free && !state.unlocked) {
            // Preview is allowed; sharing is not. Say so plainly.
            state.pendingTheme = id;
            setPremiumStatus('Previewing "' + theme.name + '". Enter a code below to share this theme.', 'err');
            if (el.codeInput) el.codeInput.focus();
        } else {
            setPremiumStatus('', null);
        }
    }

    // Reset the typed note and signature back to empty, reflecting it in
    // the fields, the counter and the preview.
    function clearNote() {
        state.message = '';
        state.from = '';
        if (el.message) el.message.value = '';
        if (el.from) el.from.value = '';
        if (el.charCount) el.charCount.textContent = '0 / ' + MAX_MESSAGE;
        if (el.charCount) el.charCount.classList.remove('is-near');
    }

    function renderFlowerGrid() {
        el.grid.innerHTML = '';
        FLOWERS.forEach((flower) => {
            const tile = document.createElement('div');
            tile.className = 'flower-tile';
            tile.dataset.flower = flower.id;
            if (flower.premium) tile.dataset.premium = 'true';

            const add = document.createElement('button');
            add.type = 'button';
            add.className = 'flower-btn';
            add.dataset.flower = flower.id;
            add.innerHTML =
                '<span class="flower-count" aria-hidden="true">0</span>' +
                '<img src="assets/flowers/' + flower.id + '.png" alt="" width="68" height="68" loading="lazy">' +
                '<span class="flower-name">' + flower.name + '</span>';
            add.addEventListener('click', () => addBloom(flower.id));

            const minus = document.createElement('button');
            minus.type = 'button';
            minus.className = 'flower-minus';
            minus.dataset.flower = flower.id;
            minus.setAttribute('aria-label', 'Remove one ' + flower.name);
            minus.textContent = '−';
            minus.addEventListener('click', (event) => {
                event.stopPropagation();
                removeBloom(flower.id);
            });

            tile.appendChild(add);
            tile.appendChild(minus);
            el.grid.appendChild(tile);
        });
        syncFlowerGrid();
    }

    function syncFlowerGrid() {
        const total = totalBlooms();
        el.grid.querySelectorAll('.flower-tile').forEach((tile) => {
            const id = tile.dataset.flower;
            const n = state.counts[id] || 0;
            const flower = FLOWERS.find(f => f.id === id);
            const add = tile.querySelector('.flower-btn');
            const minus = tile.querySelector('.flower-minus');

            tile.dataset.count = String(n);
            add.dataset.count = String(n);
            tile.querySelector('.flower-count').textContent = String(n);

            // A bouquet holds at most MAX_BLOOMS, so once it is full only the
            // flowers already in it can still be topped up.
            const capped = total >= MAX_BLOOMS;
            const blocked = capped && n === 0;
            // Premium flowers cannot be added until a code is accepted.
            const locked = !!flower.premium && !state.unlocked;
            tile.dataset.locked = String(locked);
            add.disabled = blocked || locked;
            add.classList.toggle('is-at-max', blocked && !locked);
            add.setAttribute('aria-label', locked
                ? flower.name + ', premium. Enter a code to unlock.'
                : flower.name + ', ' + n + ' in the bouquet. Add another.');
            minus.hidden = n === 0;
            minus.setAttribute('aria-label', 'Remove one ' + flower.name);
        });

        el.counter.textContent = total + ' / ' + MIN_BLOOMS + '–' + MAX_BLOOMS;
        el.counter.className = 'chip pick-counter ' + (total >= MIN_BLOOMS ? 'is-good' : 'is-low');
        if (el.clearBlooms) el.clearBlooms.hidden = total === 0;

        if (total < MIN_BLOOMS) {
            setNotice(el.notice, 'Add ' + (MIN_BLOOMS - total) + ' more bloom' + (MIN_BLOOMS - total === 1 ? '' : 's') + ' to continue.', 'warn');
        } else if (total >= MAX_BLOOMS) {
            setNotice(el.notice, 'Lovely — that is a full bouquet. Use − to swap one out.', 'ok');
        } else {
            setNotice(el.notice, '', 'ok');
        }
    }

    function afterBloomChange() {
        syncFlowerGrid();
        refreshArrangeSelect();
        drawPreview();
        invalidateExport();
    }

    function addBloom(id) {
        if (isPremiumFlower(id) && !state.unlocked) {
            // Show the price panel instead of silently doing nothing.
            setPremiumStatus('That flower is premium. Enter a code below to unlock it.', 'err');
            if (el.premiumDetails) el.premiumDetails.hidden = false;
            if (el.premiumToggle) el.premiumToggle.setAttribute('aria-expanded', 'true');
            if (el.codeInput) el.codeInput.focus();
            return;
        }
        const current = state.counts[id] || 0;
        if (totalBlooms() >= MAX_BLOOMS) {
            el.counter.animate(
                [{ transform: 'translateX(0)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'translateX(0)' }],
                { duration: 220 }
            );
            return;
        }
        state.counts[id] = Math.min(MAX_PER_FLOWER, current + 1);
        afterBloomChange();
    }

    function removeBloom(id) {
        const current = state.counts[id] || 0;
        if (current <= 0) return;
        if (current === 1) delete state.counts[id];
        else state.counts[id] = current - 1;
        afterBloomChange();
    }

    function clearBlooms() {
        state.counts = {};
        state.nudges = {};
        afterBloomChange();
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
            stars: previewStars(),
            theme: state.theme,
            // A locked premium bloom is drawn in full colour but carries its own
            // PREVIEW seal, so the mark sits on the flowers themselves too.
            premiumFlowers: (function () {
                const map = {};
                ids.forEach((id, i) => { map[i] = isPremiumFlower(id); });
                return map;
            })(),
            markPremium: !state.unlocked,
            // Free preview of a locked look carries a watermark so a screenshot
            // is never mistaken for the finished card.
            watermark: needsCode()
        });
    }

    function drawPreview(time) {
        const ids = selectedFlowerIds();
        if (!ids.length) {
            engine.paintSky(ctx, PREVIEW_W, PREVIEW_H, themeById(state.theme));
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
        if (state.busy || state.sharing || state.redeeming) return;
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
        //el.gifLink.value = url;
        //el.linkHint.textContent = 'Optional. The link re-creates the bouquet on their device so they can make their own.';
    }

    function updateSendHint() {
        const payload = sharePayload();
        const flowerNames = Array.from(new Set(selectedFlowerIds()))
            .map(id => (FLOWERS.find(f => f.id === id) || {}).name || id);
        const text = [
            '🌷 An E-Bouquet by Owl Watcher for you 🌷',
            flowerNames.length ? 'Made with ' + flowerNames.join(', ') + '.' : '',
            payload.note ? '\n"' + payload.note + '"' : '',
            payload.from ? '— ' + payload.from : ''
        ].filter(Boolean).join('\n');
        state.shareText = text;
        el.sendHint.textContent = 'Share it straight into a chat.';
    }

    function gifFile() {
        if (!state.gifBlob) return null;
        const filename = 'ebouquet-owlwatcher-' + Date.now() + '.gif';
        return new File([state.gifBlob], filename, { type: 'image/gif' });
    }

    // Save the GIF to the device. Nothing is uploaded and no other app is
    // involved. Resolves true only once the file is really on the device, so
    // the hint never reports a save that did not happen.
    async function downloadGif() {
        if (state.sharing || needsCode()) return false;
        // Premium transfers must go through the server-backed Share GIF path.
        if (state.unlocked) {
            el.sendHint.textContent = 'Use Share GIF to use your premium code and share or save this GIF.';
            return false;
        }
        return saveGifFile(gifFile());
    }

    async function saveGifFile(file) {
        if (!file) return false;

        if (nativePlatformName()) {
            try {
                await nativeSaveGif(file.name, file);
                el.sendHint.textContent = 'Saved ' + file.name + ' — the animated GIF is all yours.';
                return true;
            } catch (err) {
                console.error('E-Bouquet: native save failed.', err);
                el.sendHint.textContent = 'Sorry, this app could not save the GIF to your device.';
                return false;
            }
        }

        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        el.sendHint.textContent = 'Saved ' + file.name + ' — the animated GIF is all yours.';
        return true;
    }

    function canShareFiles(file) {
        return !!(navigator.canShare && navigator.canShare({ files: [file] }));
    }

    // ------------------------------------------------------ native hand-off --
    // Inside the Android/iOS app this page runs in a WebView, which has no
    // download manager and no navigator.share. A blob <a download> click lands
    // on a URL nothing handles, so it fails silently. When the page is running
    // natively both actions go through Capacitor's Filesystem and Share plugins
    // instead. The browser path is untouched.
    function nativePlatformName() {
        const cap = window.Capacitor;
        if (!cap) return null;
        const flag = cap.isNativePlatform;
        const native = typeof flag === 'function' ? flag.call(cap) : flag === true;
        if (!native) return null;
        const platform = typeof cap.getPlatform === 'function' ? cap.getPlatform() : cap.platform;
        return platform === 'android' || platform === 'ios' ? platform : 'unknown';
    }

    function nativePlugin(name) {
        const cap = window.Capacitor;
        return (cap && cap.Plugins && cap.Plugins[name]) || null;
    }

    // Blob -> bare base64 (the Filesystem plugin wants no data: prefix).
    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onerror = () => reject(reader.error || new Error('Could not read the GIF data.'));
            reader.onload = () => {
                const result = String(reader.result || '');
                const comma = result.indexOf(',');
                resolve(comma === -1 ? result : result.slice(comma + 1));
            };
            reader.readAsDataURL(blob);
        });
    }

    // Writes the GIF into the WebView app's own storage and hands back the file
    // URI. The cache directory is used for sharing because it always exists and
    // needs no storage permission; Documents is used for a saved copy.
    async function nativeWriteGif(fileName, directory, blob) {
        const filesystem = nativePlugin('Filesystem');
        if (!filesystem || typeof filesystem.writeFile !== 'function') {
            throw new Error('The Filesystem plugin is not available in this build.');
        }
        const data = await blobToBase64(blob);
        const written = await filesystem.writeFile({
            path: fileName,
            data,
            directory,
            recursive: true
        });
        if (!written || !written.uri) throw new Error('The GIF file was not written.');
        return written.uri;
    }

    async function nativeSaveGif(fileName, blob) {
        return nativeWriteGif(fileName, 'DOCUMENTS', blob);
    }

    async function nativeShareGif(fileName, blob, text) {
        const share = nativePlugin('Share');
        if (!share || typeof share.share !== 'function') {
            throw new Error('The Share plugin is not available in this build.');
        }
        const uri = await nativeWriteGif(fileName, 'CACHE', blob);
        await share.share({
            title: 'E-Bouquet by Owl Watcher',
            text,
            files: [uri],
            dialogTitle: 'Share your E-Bouquet'
        });
    }

    // Hand the actual GIF to the OS share sheet so it can go to any app on the
    // device (messaging, mail, notes, AirDrop...). The file is always the
    // payload - never a link. Where the sheet is unavailable we fall back to
    // a plain download instead of opening any third-party service.
    async function shareGif() {
        if (state.sharing || state.busy || state.redeeming) return;
        const file = gifFile();
        if (!file) return;

        // A locked bouquet can be looked at (with a watermark) but not sent.
        // Validate to unlock first; only this Share action asks the server to spend it.
        if (needsCode()) {
            el.sendHint.textContent = 'This bouquet needs a premium code before it can be shared.';
            setPremiumStatus('Enter your 9 digit code to unlock sharing.', 'err');
            if (el.premiumDetails) el.premiumDetails.hidden = false;
            if (el.premiumToggle) el.premiumToggle.setAttribute('aria-expanded', 'true');
            if (el.codeInput) el.codeInput.focus();
            return;
        }

        // Capture the authorized payload before relocking. Async OS handoffs and
        // their save fallback must never read the now-invalidated global export.
        const text = state.shareText || '';
        const hadUnlock = state.unlocked;
        const code = state.unlockedCode;
        state.sharing = true;
        el.shareGifBtn.disabled = true;
        el.createBtn.disabled = true;
        if (hadUnlock) {
            state.unlocked = false;
            state.unlockedCode = null;
            state.pendingTheme = null;
            releaseGif();
            syncThemeGrid();
            syncFlowerGrid();
            syncMessageLock();
            drawPreview();
            setPremiumStatus('Checking and using your code for this share…', null);
            setNotice(el.shareNotice, 'Waiting for the server to confirm this code before sharing.', 'warn');
        }
        try {
            if (hadUnlock) {
                const result = await requestGiftCode('redeem', code);
                if (!result.ok) {
                    // A failed/lost response is not permission to transfer. The
                    // server might have committed before the connection failed.
                    const message = result.offline
                        ? 'Could not confirm code usage. Nothing was shared. Check your connection and enter your code again; it will unlock only if still unused.'
                        : result.message + ' Nothing was shared. Enter an unused code and create a new GIF.';
                    setPremiumStatus(message, 'err');
                    setNotice(el.shareNotice, message, 'warn');
                    return;
                }
                setPremiumStatus('Code used. Premium locked again. Enter a new unused code for another share attempt.', 'err');
                setNotice(el.shareNotice, 'This code was used for this Share GIF attempt, even if sharing is cancelled or fails. Another premium share needs a new unused code and a new GIF.', 'warn');
            }
            await transferGif(file, text);
        } finally {
            state.sharing = false;
            el.shareGifBtn.disabled = false;
            el.createBtn.disabled = false;
            if (hadUnlock) el.createBtn.innerHTML = 'Create my bouquet GIF';
        }
    }

    async function transferGif(file, text) {
        if (nativePlatformName()) {
            try {
                await nativeShareGif(file.name, file, text);
                el.sendHint.textContent = 'Shared — the animated GIF went out as an image file.';
            } catch (err) {
                if (err && err.name === 'AbortError') return;
                console.error('E-Bouquet: native share failed.', err);
                // Only claim a save once the file is really on the device.
                let saved = false;
                try {
                    await nativeSaveGif(file.name, file);
                    saved = true;
                } catch (saveErr) {
                    console.error('E-Bouquet: native save failed too.', saveErr);
                }
                el.sendHint.textContent = saved
                    ? 'The share sheet could not open, so the GIF was saved to this device instead.'
                    : 'Sorry, this app could not open the share sheet or save the GIF.';
            }
            return;
        }

        if (!canShareFiles(file)) {
            const saved = await saveGifFile(file);
            el.sendHint.textContent = saved
                ? 'This browser cannot open a share sheet, so the GIF was downloaded instead — attach it wherever you like.'
                : 'Sorry, this browser could not share or download the GIF.';
            return;
        }

        try {
            await navigator.share({ files: [file], text });
            el.sendHint.textContent = 'Shared — the animated GIF went out as an image file.';
        } catch (err) {
            if (err && err.name === 'AbortError') return;
            const saved = await saveGifFile(file);
            el.sendHint.textContent = saved
                ? 'The share sheet could not open, so the GIF was downloaded instead.'
                : 'Sorry, the share sheet could not open and the download failed too.';
        }
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
    // -------------------------------------------------------- premium codes --
    // Validation never spends a code. Only Share GIF calls redeem; both checks
    // are server-side and the share transaction can reject a previously valid
    // code that has since been used or disabled on another page.
    async function requestGiftCode(action, code) {
        try {
            const res = await fetch(API_BASE_URL + '/gift-codes/' + action, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code })
            });
            const body = await res.json().catch(() => ({}));
            const confirmed = action === 'redeem' ? body.consumed === true : body.unlocked === true;
            if (res.ok && confirmed) return { ok: true };
            return { ok: false, message: body.error || 'The server could not confirm this code. Please check it and try again.' };
        } catch (err) {
            console.error('E-Bouquet: code request failed.', err);
            return { ok: false, offline: true };
        }
    }

    async function redeemCode() {
        if (!el.codeInput || state.sharing || state.redeeming || state.unlocked || state.busy) return;
        const raw = el.codeInput.value.replace(/[\s-]/g, '');
        if (!/^\d{9}$/.test(raw)) {
            setPremiumStatus('Enter the full 9 digit code.', 'err');
            return;
        }

        state.redeeming = true;
        if (el.redeemBtn) el.redeemBtn.disabled = true;
        setPremiumStatus('Checking your code…', null);

        const result = await requestGiftCode('validate', raw);

        state.redeeming = false;
        if (el.redeemBtn) el.redeemBtn.disabled = false;

        if (!result.ok) {
            setPremiumStatus(
                result.offline
                    ? 'Could not reach the server. Check your connection and try again.'
                    : result.message,
                'err'
            );
            return;
        }

        state.unlocked = true;
        state.unlockedCode = raw;
        el.codeInput.value = '';
        setPremiumStatus('Unlocked! Your code is still unused. You can enter it again after a refresh. It is used only when you press Share GIF and the server confirms it, even if sharing is then cancelled or fails.', 'ok');
        renderThemeGrid();
        syncFlowerGrid();
        syncMessageLock();
        drawPreview();
        invalidateExport();
    }

    // The purchase number is public contact data, not a secret: the same value
    // is already rendered into the Contact links across the site. Keep the
    // fallback link usable if this request fails.
    async function fetchTeamPhone() {
        try {
            const res = await fetch(API_BASE_URL + '/config', {
                headers: { 'ngrok-skip-browser-warning': 'true' }
            });
            if (!res.ok) return null;
            const data = await res.json().catch(() => ({}));
            const digits = String((data && data.teamPhone) || '').replace(/\D/g, '');
            return digits.length >= 10 ? digits : null;
        } catch (err) {
            console.error('E-Bouquet: could not load the team WhatsApp number.', err);
            return null;
        }
    }

    async function refreshBuyCodeLink() {
        if (!el.buyCodeLink) return null;
        const number = await fetchTeamPhone();
        if (!number) return null;
        el.buyCodeLink.href = codeHelpUrl(number);
        return number;
    }

    function togglePremiumDetails() {
        if (!el.premiumDetails || !el.premiumToggle) return;
        const open = el.premiumDetails.hidden;
        el.premiumDetails.hidden = !open;
        el.premiumToggle.setAttribute('aria-expanded', String(open));
    }

    function bindEvents() {
        if (el.clearBlooms) el.clearBlooms.addEventListener('click', clearBlooms);
        if (el.premiumToggle) el.premiumToggle.addEventListener('click', togglePremiumDetails);
        if (el.redeemBtn) el.redeemBtn.addEventListener('click', redeemCode);
        if (el.codeInput) {
            el.codeInput.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') { event.preventDefault(); redeemCode(); }
            });
        }
        // Start with the built-in link, then upgrade it to the number stored in
        // Firestore (configs/owlwatcher) as soon as that answers.
        if (el.buyCodeLink) el.buyCodeLink.href = CODE_HELP_URL;
        if (el.shareGifBtn) el.shareGifBtn.setAttribute('aria-describedby', 'premiumStatus');
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
        el.shareGifBtn.addEventListener('click', shareGif);
        //el.copyLink.addEventListener('click', copyLink);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) drawPreview(); });
    }

    async function init() {
        renderFlowerGrid();
        renderThemeGrid();
        bindEvents();
        syncMessageLock();
        refreshBuyCodeLink();

        const prefilled = readLink();
        if (prefilled) {
            el.message.value = state.message;
            el.from.value = state.from;
            el.charCount.textContent = state.message.length + ' / ' + MAX_MESSAGE;
            syncFlowerGrid();
        }
        // A shared link may carry premium flowers, which re-lock the note.
        syncMessageLock();

        // default arrangement seed is stable per visit
        state.arrangementSeed = state.arrangementSeed || engine.hashString('owl-watcher-bouquet');

        const loads = FLOWERS.map((f) => loadImage('assets/flowers/' + f.id + '.png').then((img) => { state.images[f.id] = img; }));
        loads.push(loadImage('owl.png').then((img) => { state.owlImg = img; }).catch(() => {}));
        try {
            await Promise.all(loads);
        } catch (err) {
            console.error('E-Bouquet: some artwork failed to load.', err);
        }
        // Thumbnails are real renders, so redraw them now the artwork is here.
        renderThemeGrid();
        drawPreview();
        refreshArrangeSelect();
        requestAnimationFrame(tick);
    }

    // expose a couple of internals for tests / debugging
    window.OwBouquetPage = {
        FLOWERS, MIN_BLOOMS, MAX_BLOOMS, MAX_PER_FLOWER, state,
        addBloom, removeBloom, clearBlooms,
        totalBlooms, selectedFlowerIds, drawCardTo, downloadGif, shareGif,
        nativePlatformName, blobToBase64,
        needsCode, chooseTheme, redeemCode, renderThemeGrid,
        fetchTeamPhone, refreshBuyCodeLink, codeHelpUrl,
        isPremiumFlower, selectedPremiumFlowers,
        messageLocked, syncMessageLock
    };

    init();
})();
