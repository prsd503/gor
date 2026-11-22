const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createGiftCodeService,
    isValidCode,
    normalizeCode,
    PRICE_INR
} = require('../server/lib/gift-codes.js');

// A tiny in-memory Firestore double: enough of the API for the service, with a
// runTransaction that serialises callbacks the way a real transaction retries.
function fakeDb(seed) {
    const store = new Map(Object.entries(seed || {}));
    let queue = Promise.resolve();

    const makeRef = (id) => ({
        async get() {
            return {
                exists: store.has(id),
                data: () => (store.has(id) ? { ...store.get(id) } : undefined)
            };
        },
        async set(value) { store.set(id, { ...value }); },
        async update(value) { store.set(id, { ...store.get(id), ...value }); }
    });

    return {
        store,
        collection: () => ({ doc: makeRef }),
        // Serialise transactions so a simultaneous redeem is a real race.
        runTransaction(fn) {
            const run = queue.then(() => fn({
                get: (ref) => ref.get(),
                update: (ref, value) => ref.update(value)
            }));
            queue = run.catch(() => {});
            return run;
        }
    };
}

const CODE = '123456789';

function service(db) {
    return createGiftCodeService({ db, FieldValue: null });
}

test('code format: exactly nine digits', () => {
    assert.equal(isValidCode('123456789'), true);
    assert.equal(isValidCode('12345678'), false, 'eight digits is too short');
    assert.equal(isValidCode('1234567890'), false, 'ten digits is too long');
    assert.equal(isValidCode('12345678a'), false, 'letters are rejected');
    assert.equal(isValidCode(''), false);
    assert.equal(normalizeCode(' 123 456-789 '), '123456789', 'spaces and dashes are ignored');
});

test('a fresh code redeems and is marked used', async () => {
    const db = fakeDb({ [CODE]: { code: CODE, used: false } });
    const result = await service(db).redeem(CODE, 'uid-1');

    assert.equal(result.ok, true);
    assert.equal(result.code, CODE);
    assert.equal(result.price, PRICE_INR);
    assert.equal(PRICE_INR, 30, 'the price is 30 rupees');

    const saved = db.store.get(CODE);
    assert.equal(saved.used, true, 'the code is flipped to used');
    assert.equal(saved.usedBy, 'uid-1', 'we record who used it');
    assert.ok(saved.usedAt, 'we record when');
});

test('the same code cannot be used twice', async () => {
    const db = fakeDb({ [CODE]: { code: CODE, used: false } });
    const svc = service(db);

    const first = await svc.redeem(CODE, 'uid-1');
    assert.equal(first.ok, true);

    const second = await svc.redeem(CODE, 'uid-2');
    assert.equal(second.ok, false);
    assert.equal(second.status, 409);
    assert.match(second.error, /already been used/i);

    assert.equal(db.store.get(CODE).usedBy, 'uid-1', 'the first winner keeps it');
});

test('two simultaneous redemptions produce exactly one winner', async () => {
    const db = fakeDb({ [CODE]: { code: CODE, used: false } });
    const svc = service(db);

    const results = await Promise.all([
        svc.redeem(CODE, 'uid-a'),
        svc.redeem(CODE, 'uid-b'),
        svc.redeem(CODE, 'uid-c')
    ]);

    const wins = results.filter((r) => r.ok);
    assert.equal(wins.length, 1, 'only one of three concurrent attempts succeeds');
    const winners = results.filter((r) => !r.ok);
    assert.equal(winners.length, 2);
    winners.forEach((r) => assert.equal(r.status, 409));
});

test('unknown and malformed codes are rejected clearly', async () => {
    const db = fakeDb({});
    const svc = service(db);

    const missing = await svc.redeem('999999999', 'uid-1');
    assert.equal(missing.ok, false);
    assert.equal(missing.status, 404);

    const malformed = await svc.redeem('12', 'uid-1');
    assert.equal(malformed.ok, false);
    assert.equal(malformed.status, 400);

});

test('redemption needs no account: the code is the credential', async () => {
    const db = fakeDb({ [CODE]: { code: CODE, used: false } });
    const result = await service(db).redeem(CODE);

    assert.equal(result.ok, true, 'redeems with no user at all');
    assert.equal(db.store.get(CODE).used, true);
    assert.equal(db.store.get(CODE).usedBy, 'guest', 'recorded for audit only');
});

test('a disabled code cannot be redeemed', async () => {
    const db = fakeDb({ [CODE]: { code: CODE, used: false, disabled: true } });
    const result = await service(db).redeem(CODE, 'uid-1');
    assert.equal(result.ok, false);
    assert.equal(result.status, 409);
    assert.equal(db.store.get(CODE).used, false, 'it stays unused');
});

test('staff can mint unique nine digit codes, unused by default', async () => {
    const db = fakeDb({});
    const made = await service(db).create(5, 'admin@owlwatcher.tech');

    assert.equal(made.length, 5);
    assert.equal(new Set(made).size, 5, 'all codes differ');
    made.forEach((code) => {
        assert.match(code, /^\d{9}$/, 'nine digits');
        const saved = db.store.get(code);
        assert.equal(saved.used, false);
        assert.equal(saved.currency, 'INR');
        assert.equal(saved.price, 30);
        assert.equal(saved.createdBy, 'admin@owlwatcher.tech');
    });

    // and one of them actually redeems
    const result = await service(db).redeem(made[0], 'uid-9');
    assert.equal(result.ok, true);
});

test('creation is clamped to a sane batch size', async () => {
    const db = fakeDb({});
    const made = await service(db).create(10000, 'admin');
    assert.ok(made.length <= 500, 'never mints an unbounded batch');
});

test('validation is repeatable, read-only, and leaves every usage/audit field unchanged', async () => {
    const original = { code: CODE, used: false, usedAt: null, usedBy: null, price: 30, createdBy: 'staff' };
    const db = fakeDb({ [CODE]: { ...original } });
    const svc = service(db);
    for (let i = 0; i < 3; i++) {
        const checked = await svc.validate(' 123-456-789 ');
        assert.equal(checked.ok, true);
        assert.equal(checked.code, CODE);
        assert.deepEqual(db.store.get(CODE), original, 'unlock/refresh checks never spend the code');
    }
    assert.equal((await svc.redeem(CODE)).ok, true, 'Share GIF can spend the validated code');
    assert.equal((await svc.validate(CODE)).status, 409, 'spent code no longer unlocks');
});

test('validation rejects malformed, missing, disabled, and spent codes without writes', async () => {
    const db = fakeDb({
        '111111111': { used: true, usedBy: 'first-winner' },
        '222222222': { used: false, disabled: true }
    });
    const before = [...db.store.entries()].map(([id, data]) => [id, { ...data }]);
    const svc = service(db);
    for (const [code, status] of [['bad', 400], ['999999999', 404], ['111111111', 409], ['222222222', 409]]) {
        const result = await svc.validate(code);
        assert.equal(result.ok, false);
        assert.equal(result.status, status);
    }
    assert.deepEqual([...db.store.entries()], before);
});

test('multiple pages can validate, but only one concurrent Share GIF transaction wins', async () => {
    const db = fakeDb({ [CODE]: { used: false } });
    const svc = service(db);
    const validations = await Promise.all([svc.validate(CODE), svc.validate(CODE), svc.validate(CODE)]);
    assert.ok(validations.every((r) => r.ok));
    assert.equal(db.store.get(CODE).used, false);
    const shares = await Promise.all([svc.redeem(CODE, 'a'), svc.redeem(CODE, 'b'), svc.redeem(CODE, 'c')]);
    assert.equal(shares.filter((r) => r.ok).length, 1);
    assert.equal(shares.filter((r) => r.status === 409).length, 2);
});

test('a code disabled after unlocking cannot be consumed by Share GIF', async () => {
    const db = fakeDb({ [CODE]: { used: false } });
    const svc = service(db);
    assert.equal((await svc.validate(CODE)).ok, true);
    db.store.get(CODE).disabled = true;
    assert.equal((await svc.redeem(CODE)).status, 409);
    assert.equal(db.store.get(CODE).used, false);
});
