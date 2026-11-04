// Shared UI behaviour loaded on every page: the mobile hamburger menu (#menuToggle / #navLinks) and
// enabling touch press feedback on iOS.
// Plain (non-module) script with no dependencies, loaded in <head>: the click handler is attached to the
// document straight away, so the menu works even when Firebase/CDN modules are slow, fail to load, or the
// page is opened from file:// (where module scripts are blocked).
(function () {
    if (window.__owMenuReady) return;
    window.__owMenuReady = true;

    function parts() {
        return { button: document.getElementById('menuToggle'), links: document.getElementById('navLinks') };
    }

    function setOpen(open) {
        const { button, links } = parts();
        if (!links) return;
        links.classList.toggle('active', open);
        if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    document.addEventListener('click', function (event) {
        const { button, links } = parts();
        if (!button || !links) return;

        if (button.contains(event.target)) {
            setOpen(!links.classList.contains('active'));
        } else if (links.classList.contains('active') &&
                   (event.target.closest('#navLinks a') || !links.contains(event.target))) {
            // Close after picking a link or tapping anywhere outside the open menu
            setOpen(false);
        }
    });

    document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') setOpen(false);
    });

    // Don't leave the dropdown open when the screen widens to the desktop bar (e.g. rotating a tablet)
    window.addEventListener('resize', function () {
        if (window.innerWidth > 768) setOpen(false);
    });

    // Coming back via the browser/app back button can restore the page with the menu still open
    window.addEventListener('pageshow', function () { setOpen(false); });

    // iOS (Safari / WKWebView) only applies :active styles when a touchstart listener exists; this empty one
    // turns on the press animations for buttons and links on iPhone/iPad. Android works without it.
    document.addEventListener('touchstart', function () {}, { passive: true });

    // Material-style ripple from the press point on buttons and tiles (mouse, touch and pen).
    // Styled by .ow-ripple in theme.css; skipped on the welcome overlay and calendar buttons.
    var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.addEventListener('pointerdown', function (event) {
        if (reduceMotion || event.button > 0) return;
        var target = event.target.closest('button, .btn, .back-btn, .contact-btn, .admin-btn, .tile');
        if (!target || target.disabled || target.closest('#startOverlay, .fc')) return;
        var rect = target.getBoundingClientRect();
        var size = Math.max(rect.width, rect.height) * 2;
        var ripple = document.createElement('span');
        ripple.className = 'ow-ripple';
        ripple.style.width = ripple.style.height = size + 'px';
        ripple.style.left = (event.clientX - rect.left - size / 2) + 'px';
        ripple.style.top = (event.clientY - rect.top - size / 2) + 'px';
        target.appendChild(ripple);
        ripple.addEventListener('animationend', function () { ripple.remove(); });
    }, { passive: true });
})();
