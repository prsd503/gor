/* The signed-in administrator's request context, handed over to the deletion
 * request pages.
 *
 * The Danger zone buttons open deletedata.html ("Bulk data delete") and
 * delete.html ("Delete full account") in a new tab. A freshly opened tab does
 * not always have the Firebase session restored by the time the page runs, so
 * the request page used to show "Please log in as a society admin…" with a
 * disabled button and no society name — the exact complaint these pages were
 * built to answer.
 *
 * The admin portal therefore stores the society it just resolved from
 * GET /api/admins/me here, keyed by origin (localStorage, so every tab of the
 * site sees it). The request pages read it before the auth callback resolves
 * and keep it only until the live session, when there is one, confirms or
 * replaces it — a signed-in record always wins over the hand-off.
 *
 * Plain script with no dependencies: loaded before admin-logic.js and before
 * the request pages' modules.
 */
(function (global) {
    'use strict';

    var KEY = 'owl:requestContext';
    var MAX_LENGTH = 120;

    function text(value) {
        return typeof value === 'string' ? value.trim().slice(0, MAX_LENGTH) : '';
    }

    function valid(record) {
        return !!(record && (record.society || record.email));
    }

    /* Remember who is asking. Returns the stored record, or null when there is
     * nothing worth handing over (signed out / no society and no email). */
    function save(context) {
        var record = {
            society: text(context && context.society),
            societyId: text(context && context.societyId),
            email: text(context && context.email),
            isMaster: !!(context && context.isMaster),
            savedAt: Date.now()
        };
        if (!valid(record)) return null;
        try {
            global.localStorage.setItem(KEY, JSON.stringify(record));
        } catch (_) {
            return null; // private mode / storage disabled: pages still work signed in
        }
        return record;
    }

    function load() {
        var raw;
        try {
            raw = global.localStorage.getItem(KEY);
        } catch (_) {
            return null;
        }
        if (!raw) return null;
        var parsed;
        try {
            parsed = JSON.parse(raw);
        } catch (_) {
            return null;
        }
        if (!parsed || typeof parsed !== 'object') return null;
        var record = {
            society: text(parsed.society),
            societyId: text(parsed.societyId),
            email: text(parsed.email),
            isMaster: parsed.isMaster === true
        };
        return valid(record) ? record : null;
    }

    function clear() {
        try {
            global.localStorage.removeItem(KEY);
        } catch (_) { /* nothing to clean up */ }
    }

    global.OwRequestContext = { KEY: KEY, save: save, load: load, clear: clear };
})(typeof window !== 'undefined' ? window : this);
