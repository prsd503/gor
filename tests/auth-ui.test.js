'use strict';
// Sign-in UI: the admin and guard pages share the home page's card language
// (soft panel, icon badge, icon-led fields, one pill primary action) and the
// password field can be revealed without losing any existing behaviour.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const pages = ['admin.html', 'guard.html'];

function loadPage(file) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    const dom = new JSDOM(html, { url: 'https://owlwatcher.test/' + file, runScripts: 'outside-only' });
    return { html, dom, window: dom.window, doc: dom.window.document };
}

for (const file of pages) {
    test(`${file}: the sign-in card uses the shared auth design`, () => {
        const { doc } = loadPage(file);
        const card = doc.getElementById('login-section');
        assert.ok(card, 'login section exists');
        assert.ok(card.classList.contains('card'), 'still a card');
        assert.ok(card.classList.contains('auth-card'), 'uses the auth panel styling');

        // Icon badge + eyebrow + title + subtitle, like the home page's panels.
        assert.ok(card.querySelector('.auth-badge svg'), 'icon badge present');
        assert.ok(card.querySelector('.auth-head .auth-eyebrow'));
        assert.ok(card.querySelector('.auth-title'));
        assert.equal(card.querySelector('.auth-title')?.tagName, 'H2', 'title keeps its heading level');
        assert.ok(card.querySelector('.auth-sub'));

        // Fields keep their ids and are icon-led.
        for (const id of ['email', 'pass']) {
            const field = doc.getElementById(id);
            assert.ok(field, `${id} field exists`);
            assert.ok(field.closest('.field-icon'), `${id} is icon-led`);
            assert.ok(field.closest('.field-icon').querySelector('svg'), `${id} has an icon`);
        }

        // Buttons: one primary pill + the ghost "forgot password" + logout untouched.
        const login = doc.getElementById('loginBtn');
        assert.ok(login.classList.contains('auth-submit'), 'primary action is styled');
        assert.ok(login.textContent.includes('Sign in'));
        assert.ok(doc.getElementById('forgotPasswordBtn').classList.contains('btn-ghost'));
        assert.ok(doc.querySelector('.auth-secure'), 'secure sign-in note');
    });

    test(`${file}: the password can be revealed and hidden`, () => {
        const { window, doc } = loadPage(file);
        const toggle = doc.querySelector('[data-pw-toggle]');
        assert.equal(toggle.getAttribute('data-pw-toggle'), 'pass');
        assert.equal(toggle.getAttribute('aria-pressed'), 'false');
        assert.equal(toggle.getAttribute('aria-label'), 'Show password');

        window.eval(fs.readFileSync(path.join(root, 'menu.js'), 'utf8'));

        toggle.click();
        assert.equal(doc.getElementById('pass').type, 'text', 'revealed');
        assert.equal(toggle.getAttribute('aria-pressed'), 'true');
        assert.equal(toggle.getAttribute('aria-label'), 'Hide password');

        toggle.click();
        assert.equal(doc.getElementById('pass').type, 'password', 'hidden again');
        assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    });
}

test('the shared auth styles live in theme.css, not in the pages', () => {
    const css = fs.readFileSync(path.join(root, 'theme.css'), 'utf8');
    for (const className of ['.auth-card', '.auth-badge', '.auth-submit', '.pw-toggle', '.auth-secure']) {
        assert.ok(css.includes(className), `${className} is defined in theme.css`);
    }
    // Colours must come from the theme tokens so both colour schemes work.
    const authBlock = css.slice(css.indexOf('.auth-card {'), css.indexOf('/* ---------- Home: quick-action tiles'));
    assert.ok(authBlock.includes('var(--ow-'), 'auth styles use theme tokens');
    assert.doesNotMatch(authBlock, /background(-color)?:\s*#fff/i, 'no hardcoded white panel');
});

test('the sign-in markup keeps the scripts and nav the pages rely on', () => {
    for (const file of pages) {
        const { html } = loadPage(file);
        assert.ok(html.includes('href="theme.css"'), 'theme.css is linked');
        assert.ok(html.includes('src="menu.js"'), 'menu.js is loaded');
        assert.ok(html.includes('class="main-nav"'), 'navigation present');
    }
    assert.ok(fs.readFileSync(path.join(root, 'guard.html'), 'utf8').includes('src="guard-logic.js"'));
    assert.ok(fs.readFileSync(path.join(root, 'admin.html'), 'utf8').includes('src="admin-logic.js"'));
});
