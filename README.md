# gor
gor

## Optional mobile update popup

Android/iOS builds show a dismissible Firestore-controlled update popup when the
installed version is lower than the configured version. See
[the setup and release checklist](docs/update-popup.md). Users can choose Later and
keep using the app; the ordinary browser website is unaffected.

Native debug/release App Check setup: [docs/app-check.md](docs/app-check.md).

Backend API (version endpoint, auth, App Check enforcement): [docs/backend-api.md](docs/backend-api.md).
The server lives in `server/` and is deployed separately from the static frontend.

Run `npm ci`, `npm test`, and `npm run check` to validate the shared web app.

## E-Bouquet

`bouquet.html` — reachable from the button under Owl Jump on the home page — lets a
visitor pick 6–10 blooms from a set of ten watercolour flowers (up to 10 of any single
variety), nudge the arrangement,
switch the greenery, write a short note and take away or pass on the result as an
animated GIF (*E-Bouquet by Owl Watcher*).

Everything runs in the browser:

| File | Purpose |
| --- | --- |
| `bouquet.html` | page markup + page-specific styles |
| `bouquet-app.js` | picker, arrangement state, GIF export, sharing |
| `bouquet-engine.js` | seeded bouquet/card renderer (canvas 2D) |
| `gif-encoder.js` | dependency-free GIF89a writer (median-cut palette, LZW, delta frames) |
| `assets/flowers/*.png` | sixteen bloom cut-outs (320 px, transparent): ten free, six premium |

### Premium themes and flowers

Midnight Sky and the ten original blooms are free for everyone. Nine occasion
themes (birthday, anniversary, champion, promotion, wedding, romance, new baby,
farewell, Diwali) and six premium blooms (dahlia, hydrangea, magnolia, protea,
hellebore, sweet pea) are premium.

A premium selection is **previewable but not shareable**: the rendered card
carries a `PREVIEW` watermark until a code is accepted.

A **9 digit code costs ₹30 and works once** for one bouquet. Owl Watcher staff
create codes to `giftCodes/{code}` in Firestore; redemption is a single
transaction that re-reads the code and flips `used` to true, so two simultaneous
attempts cannot both win.

**The unlock lasts for the current page session only.** Redeeming opens every
premium theme and flower immediately, so the bouquet can be built and shared on
the spot. Nothing is written to `localStorage` or `sessionStorage` and nothing is
tied to an account, so refreshing or reopening the page locks the premium set
again — and the spent code cannot be reused. This is stated in the on-page rules.

| Route | Who | Purpose |
| --- | --- | --- |
| `POST /api/gift-codes/redeem` | anyone | validates + burns a code (no sign-in: the code is the credential) |
| `POST /api/gift-codes` | admin | mints a batch of codes |

Buying a code is a WhatsApp chat with the team (`wa.me/919033406816`, the same
number as the site's Contact links). The bouquet itself is never routed through
WhatsApp.

The page offers two plain actions once the GIF is ready — **Download GIF** saves the file
to the device, and **Share GIF** hands it to the OS share sheet (`navigator.share` with
files) so it can go to any app as a real animation. Nothing is uploaded: the GIF is
encoded locally and no third-party service is opened. Where a share sheet is
unavailable, *Share GIF* falls back to a download. A compact
`bouquet.html?b=rose,lily&m=…&f=…` link is still available for anyone who prefers it.
