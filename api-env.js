/* Where the website sends API calls — the only file you edit after deploying.
 *
 * Loaded before api-config.js on every page. Leave a value empty to ignore it.
 *
 * primary   the Firebase Cloud Functions URL (or today's API host)
 * local     the MacBook copy, normally a Cloudflare Tunnel / ngrok HTTPS URL
 * fallbacks any extra servers, tried in the order listed
 * testBases trusted opt-in endpoints, NEVER automatic fallback destinations
 *
 * After `firebase deploy --only functions` the URL looks like:
 *   https://us-central1-finder-owl.cloudfunctions.net/api
 * and for the MacBook, with Cloudflare Tunnel:
 *   https://owl-mac.example.com/api
 *
 * For a one-off test without editing this file, add ?api=<url> to any page URL
 * (must match one of the trusted bases configured below).
 */
window.OWL_API_CONFIG = {
    primary: 'https://us-central1-finder-owl.cloudfunctions.net/api',
    local: '',
    fallbacks: [],
    // Restricted, read-only MacBook pilot. Only selected by an exact ?api= link.
    // Remove/update this entry if the ngrok hostname changes ownership or expires.
    testBases: ['https://unloving-limit-ferry.ngrok-free.dev/api']
};
