# Run and test on your MacBook

## A. Completely Firebase-free backend test (recommended first)

You need **Node.js 22** and npm. Install Node 22 LTS from a trusted installer or use your existing Node version manager. Check:

```sh
node --version   # v22.x
npm --version
```

Open Terminal in your repository checkout:

```sh
cd /path/to/gor
npm ci
npm run start:local
```

The launcher automatically:

1. Creates **`.env.local`** on the first run, with a random JWT secret and random local admin password (owner-readable only).
2. Sets `DATA_BACKEND=local`, `AUTH_MODE=local`, `APP_CHECK_MODE=off`, `SERVE_STATIC=1`.
3. Starts Node on `0.0.0.0:3000`. No Firebase project, credentials, CLI or network calls to Firebase are needed by the backend.
4. Stores testing data in **`.local-data/db.json`**, ignored by Git. Run only **one** process per database file.

Open **http://localhost:3000/local-test.html** in Safari or Chrome. It is a development-only API console with no Firebase SDK dependencies.

- Click **Health**: expect `dataBackend: "local"`, `authMode: "local"`.
- Open `.env.local` in your editor and copy its `LOCAL_ADMIN_EMAIL` and `LOCAL_ADMIN_PASSWORD` into the local login form. Do not paste these into chat or commit them.
- Sign in, choose **POST**, path `/api/config`, and send `{"teamPhone":"911234567890"}`.
- Choose **GET** for the same path. You should get that configuration back.
- Refreshing the page clears its in-memory login; restarting the server preserves the local JSON data and credentials.

Regular website: **http://localhost:3000/**. Its API endpoint is automatically set to the same server by the locally generated `api-env.js`; you do not need to edit production configuration. Use HTTP URLs, not `file://`.

**Scope:** The existing admin/guard/deletion screens still use Firebase client sign-in, and regular pages can load CDN resources. They are not an entirely offline copy of Firebase Auth. For a test with *zero Firebase dependencies*, use `local-test.html` or the API commands below. For testing the existing Firebase-login screens, use mode B.

### API checks from Terminal

While the server runs, open a second Terminal:

```sh
curl http://localhost:3000/api/health
npm run quota:status

# Replace the password below with the value from .env.local.
curl -X POST http://localhost:3000/api/auth/token \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@local.test","password":"YOUR_LOCAL_PASSWORD"}'
```

The last call returns a one-hour backend JWT. Use it for protected routes:

```sh
curl -X POST http://localhost:3000/api/config \
  -H 'Authorization: Bearer YOUR_RETURNED_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"teamPhone":"911234567890"}'

curl -X POST http://localhost:3000/api/vehicles \
  -H 'Content-Type: application/json' \
  -d '{"societyName":"Test","flatNumber":"101","vehicleNumber":"GJ01AB1234","vehicleType":"4-Wheeler"}'

curl 'http://localhost:3000/api/vehicles?societyName=Test'
```

Local admin credentials are for development only. `NODE_ENV=production` refuses this auth mode. Stop with **Control-C**. To change the port, add `PORT=3001` in `.env.local` (or run `PORT=3001 npm run start:local`). Use `LOCAL_DB_FILE=/absolute/path/test.json` to select a different database. To start fresh, stop Node and back up/rename the database file first. Never point two running servers at the same JSON file.

### Try the 80% cutoff without spending Firebase quota

Stop the normal server, then run a small artificial **invocation** budget:

```sh
QUOTA_ACTION=stop QUOTA_MONTHLY_INVOCATION_LIMIT=5 QUOTA_STATE_FILE='' \
  npm run start:local
```

In another Terminal, send four application requests:

```sh
for n in 1 2 3 4; do
  curl -i http://localhost:3000/api/ads/global
  echo
done
curl http://localhost:3000/api/quota
```

The fourth request reaches **4/5 = 80%** and returns **503**, `X-Owl-Drain: 1`, and `code: "quota-threshold-reached"`. Diagnostics remain reachable. Make no other API calls before this loop, because each counts as an invocation. `QUOTA_STATE_FILE=''` avoids carrying earlier test counters into this run.

This only simulates the policy with local counters. Production uses project-wide delayed Monitoring data instead. Restart normally to leave test-drain mode. The read/write/delete meters are not fed by the JSON store because those operations do not consume Firebase quota.

## B. MacBook running against real Firebase

Use this to test existing Firebase Auth/App Check screens with production-like data access. **It consumes Firebase quota**, unlike mode A. Prefer a separate Firebase staging project and test users.

```sh
cp .env.example .env
```

Edit `.env`:

- Set a random 32+ character `JWT_SECRET`.
- Set `FIREBASE_PROJECT_ID`.
- Set `GOOGLE_APPLICATION_CREDENTIALS` to the **absolute path** of a service-account JSON **outside the repository**, or configure Application Default Credentials.
- Keep `DATA_BACKEND=firestore`, `AUTH_MODE=firebase`, `QUOTA_ACTION=stop`.
- Use `APP_CHECK_MODE=monitor` for browser testing, then validate `enforce` separately with valid tokens.
- Grant the runtime credential Monitoring Viewer access to the chosen project. Do not disable production App Check because a test token is missing.

```sh
npm run start:firebase
```

This forces `QUOTA_SOURCE=monitoring`, waits for usage before application work, and serves the site at http://localhost:3000. A Monitoring permission/network failure results in a fail-closed 503. See [deployment.md](deployment.md) for IAM and caveats.

The repository's client Firebase configuration in `app.js` and other existing login modules points at `finder-owl`; if using a staging project, update the client configuration too. Backend environment variables do not reconfigure Firebase's browser SDK automatically. Normal Firebase Auth email/password sign-in and authorized-domain requirements still apply.

## C. Access from an iPhone or another computer

For same-Wi-Fi testing, the server prints its LAN address, e.g. `http://192.168.1.20:3000`. Keep both devices on that network and permit incoming connections to Node in the macOS firewall. Avoid public Wi-Fi.

For a remote HTTPS website/native client, use a private HTTPS reverse tunnel to port 3000; configure its stable HTTPS base in `api-env.js` and the cloud's `QUOTA_FALLBACK_URLS`. Add the actual frontend origin to `ALLOWED_ORIGINS` when needed. A phone's `localhost` means the phone, not your MacBook. An HTTPS page generally cannot use an HTTP LAN backend because of mixed-content/private-network browser restrictions.

Keep the MacBook awake during tests (for example, run `caffeinate -i npm run start:local`). Tunnel uptime, network access, laptop sleep and permissions all affect availability. **Do not publicly expose the development password login**; keep access restricted. For a shared Internet-facing backend, use normal Firebase Auth/App Check and properly managed storage instead.

The JSON database is independent of Firestore. There is **no data synchronization, automatic import, or merge on failback**. Never treat a testing fallback as a production replica; see the data-consistency warnings in [deployment.md](deployment.md).

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `EADDRINUSE` | Stop the other Node process or use `PORT=3001`. |
| `JWT_SECRET must be set` | Use `start:local` for auto setup, or configure the right `ENV_FILE`. |
| Firebase-free login fails | Use `/local-test.html` and the generated local password, not the regular Firebase login page. |
| Browser CORS error | Use the server's own page URL; for a separate frontend, allow its exact origin including port. |
| Cloud 503 monitoring unavailable | Monitoring API and runtime service-account IAM; inspect `/api/quota`. |
| Cloud 503 quota threshold reached | Read `/api/quota`; wait for the relevant daily/monthly reset or use isolated local testing. |
| Local database cannot be read | Back it up and inspect JSON; corrupt files are intentionally not silently reset. |

Validation: `npm test` and `npm run check` from the repository root.
