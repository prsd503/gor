'use strict';
// npm run quota:status -- https://REGION-PROJECT.cloudfunctions.net/api
const base = (process.argv[2] || `http://localhost:${process.env.PORT || 3000}/api`).replace(/\/+$/, '');
fetch(base + '/quota', { signal: AbortSignal.timeout(15000) }).then(async response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const status = await response.json();
    console.log(JSON.stringify(status, null, 2));
    if (status.draining) process.exitCode = 2;
}).catch(error => { console.error(error.message); process.exitCode = 1; });
