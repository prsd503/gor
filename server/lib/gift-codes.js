/* One-time E-Bouquet gift codes.
 *
 * A code is 9 digits. Owl Watcher staff create them and they live in
 * Firestore under `giftCodes/{code}`:
 *
 *   { code: '123456789', used: false, createdAt, createdBy,
 *     usedAt: null, usedBy: null, price: 30, currency: 'INR' }
 *
 * Validation is read-only and can be repeated after a refresh. Only Share GIF
 * calls redeem, a single Firestore transaction: the code is re-read, checked
 * for `used`, and only then flipped to `used`. Two people redeeming the same
 * code at the same moment therefore cannot both win - the second transaction
 * sees `used: true` and is rejected.
 *
 * The module takes the Firestore handle as an argument so the logic can be
 * tested without a live database.
 */
'use strict';

const CODE_PATTERN = /^\d{9}$/;
const COLLECTION = 'giftCodes';
const PRICE_INR = 30;

function normalizeCode(raw) {
    return String(raw == null ? '' : raw).replace(/[\s-]/g, '');
}

function isValidCode(raw) {
    return CODE_PATTERN.test(normalizeCode(raw));
}

function createGiftCodeService(options) {
    const db = options.db;
    const FieldValue = options.FieldValue;
    const now = options.now || (() => new Date());

    function collection() {
        return db.collection(COLLECTION);
    }

    // Both operations bypass the read cache using a transaction. Validation
    // checks current availability without writing; sharing rechecks and spends
    // atomically, even if several pages previously validated the same code.
    async function validate(rawCode) {
        return checkCode(rawCode, false);
    }

    async function redeem(rawCode, redeemedBy) {
        return checkCode(rawCode, true, redeemedBy);
    }

    async function checkCode(rawCode, consume, redeemedBy) {
        const code = normalizeCode(rawCode);
        if (!isValidCode(code)) {
            return { ok: false, status: 400, error: 'Enter the 9 digit code exactly as you received it.' };
        }
        const usedBy = redeemedBy || 'guest';

        const ref = collection().doc(code);

        return db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists) {
                return { ok: false, status: 404, error: 'That code is not recognised. Please check it and try again.' };
            }
            const data = snap.data() || {};
            if (data.used === true) {
                return { ok: false, status: 409, error: 'That code has already been used.' };
            }
            if (data.disabled === true) {
                return { ok: false, status: 409, error: 'That code is no longer active.' };
            }

            if (!consume) return { ok: true, code, price: data.price || PRICE_INR };

            const updates = {
                used: true,
                usedAt: now(),
                usedBy: usedBy
            };
            if (FieldValue && FieldValue.serverTimestamp) {
                updates.usedAtServer = FieldValue.serverTimestamp();
            }
            tx.update(ref, updates);

            return { ok: true, code, price: data.price || PRICE_INR };
        });
    }

    /* Staff-side creation. Codes are unique 9 digit strings. */
    async function create(count, createdBy) {
        const wanted = Math.max(1, Math.min(500, Number(count) || 1));
        const made = [];
        for (let i = 0; i < wanted; i++) {
            let code = null;
            // A handful of attempts is plenty for a 9 digit space.
            for (let attempt = 0; attempt < 8 && !code; attempt++) {
                const candidate = String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
                const ref = collection().doc(candidate);
                const snap = await ref.get();
                if (!snap.exists) {
                    await ref.set({
                        code: candidate,
                        used: false,
                        usedAt: null,
                        usedBy: null,
                        createdAt: now(),
                        createdBy: createdBy || null,
                        price: PRICE_INR,
                        currency: 'INR'
                    });
                    code = candidate;
                }
            }
            if (code) made.push(code);
        }
        return made;
    }

    return { validate, redeem, create, isValidCode, normalizeCode, PRICE_INR };
}

module.exports = { createGiftCodeService, isValidCode, normalizeCode, CODE_PATTERN, PRICE_INR, COLLECTION };
