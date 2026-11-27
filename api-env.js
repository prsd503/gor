/* Where the website sends API calls.
 *
 * Loaded before api-config.js on every page. Leave a value empty to ignore it.
 *
 * primary   https://api.owlwatcher.tech/api — the PERMANENT custom domain
 *           attached to the API Function (Functions console → api → Custom
 *           domains). If the backend later moves to another cloud provider,
 *           only the domain's mapping changes — this file never does.
 * local     the MacBook copy, normally a Cloudflare Tunnel / ngrok HTTPS URL
 * fallbacks extra servers, tried in the order listed (deliberately empty:
 *           the app targets the single permanent domain above; no
 *           production users rely on a failover path).
 * testBases trusted opt-in endpoints, NEVER automatic fallback destinations
 *
 * For a one-off test without editing this file, add ?api=<url> to any page URL
 * (must match one of the trusted bases configured below).
 */
window.OWL_API_CONFIG = {
    primary: 'https://api.owlwatcher.tech/api',
    local: '',
    fallbacks: [],
    // Restricted, read-only MacBook pilot. Only selected by an exact ?api= link.
    // Remove/update this entry if the ngrok hostname changes ownership or expires.
    testBases: ['https://unloving-limit-ferry.ngrok-free.dev/api']
};
