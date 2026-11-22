'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    initializeTestEnvironment,
    assertFails,
    assertSucceeds
} = require('@firebase/rules-unit-testing');
const {
    collection,
    deleteDoc,
    doc,
    getDoc,
    getDocs,
    setDoc,
    updateDoc
} = require('firebase/firestore');

const root = path.resolve(__dirname, '..');
const rulesConfig = JSON.parse(fs.readFileSync(path.join(root, 'firebase.rules.json'), 'utf8'));
const rules = fs.readFileSync(path.join(root, rulesConfig.firestore.rules), 'utf8');
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const projectId = process.env.GCLOUD_PROJECT || 'demo-firestore-rules';

function documentRef(db, documentPath) {
    return doc(db, ...documentPath.split('/'));
}

test('Firestore Rules Emulator allows only three public document gets and denies client writes', {
    skip: emulatorHost ? false : 'Run with npm run test:firestore-rules to start the Firestore Emulator.'
}, async () => {
    const env = await initializeTestEnvironment({ projectId, firestore: { rules } });
    try {
        const publicDocs = [
            'app_config/appVersion',
            'ads/Aangan',
            'settings/contact'
        ];
        const privateDocs = [
            'app_config/private',
            'ads/global',
            'settings/private',
            'admins/admin@example.test',
            'guards/guard@example.test',
            'societies/aangan',
            'societies/other',
            'vehicles/vehicle-1',
            'notices/aangan',
            'bookings/booking-1',
            'facilities/aangan',
            'configs/owlwatcher',
            'giftCodes/code-1',
            'contestAttempts/attempt-1',
            'unknown/secret'
        ];

        await env.withSecurityRulesDisabled(async context => {
            const adminDb = context.firestore();
            await Promise.all([...publicDocs, ...privateDocs].map(documentPath =>
                setDoc(documentRef(adminDb, documentPath), { fixture: 'emulator-only' })
            ));
        });

        const anonymousDb = env.unauthenticatedContext().firestore();
        const signedInDb = env.authenticatedContext('ordinary-user', {
            email: 'resident@example.test', email_verified: true
        }).firestore();
        const forgedRoleDbs = [
            env.authenticatedContext('forged-admin', {
                role: 'admin', isAdmin: true, isMaster: true
            }).firestore(),
            env.authenticatedContext('forged-guard', {
                role: 'guard', isGuard: true, societyId: 'aangan'
            }).firestore(),
            env.authenticatedContext('forged-society-admin', {
                role: 'societyAdmin', isAdmin: true, societyId: 'aangan'
            }).firestore()
        ];

        for (const documentPath of publicDocs) {
            await assertSucceeds(getDoc(documentRef(anonymousDb, documentPath)), `anonymous get ${documentPath}`);
            await assertSucceeds(getDoc(documentRef(signedInDb, documentPath)), `signed-in get ${documentPath}`);
        }

        for (const documentPath of privateDocs) {
            await assertFails(getDoc(documentRef(anonymousDb, documentPath)), `anonymous get ${documentPath}`);
            await assertFails(getDoc(documentRef(signedInDb, documentPath)), `signed-in get ${documentPath}`);
            for (const db of forgedRoleDbs) {
                await assertFails(getDoc(documentRef(db, documentPath)), `client role claims do not grant get ${documentPath}`);
            }
        }

        for (const collectionName of ['app_config', 'ads', 'settings', 'admins', 'guards', 'societies', 'vehicles']) {
            await assertFails(getDocs(collection(anonymousDb, collectionName)), `anonymous list ${collectionName}`);
            await assertFails(getDocs(collection(signedInDb, collectionName)), `signed-in list ${collectionName}`);
        }

        for (const db of [anonymousDb, signedInDb]) {
            await assertFails(setDoc(documentRef(db, 'vehicles/new-vehicle'), { fixture: true }));
            await assertFails(setDoc(documentRef(db, 'settings/new-public-doc'), { fixture: true }));
            for (const documentPath of publicDocs) {
                const ref = documentRef(db, documentPath);
                await assertFails(setDoc(ref, { overwritten: true }));
                await assertFails(updateDoc(ref, { overwritten: true }));
                await assertFails(deleteDoc(ref));
            }
            for (const documentPath of privateDocs) {
                const ref = documentRef(db, documentPath);
                await assertFails(setDoc(ref, { created: true }));
                await assertFails(updateDoc(ref, { updated: true }));
                await assertFails(deleteDoc(ref));
            }
        }
    } finally {
        await env.cleanup();
    }
});
