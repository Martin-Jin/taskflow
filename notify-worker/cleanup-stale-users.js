'use strict';

// ONE-OFF cleanup script: deletes stale/orphaned Firestore users/{uid} docs
// left behind by old anonymous/guest sign-ins, keeping only KEEP_UID.
// Not part of the regular scheduled notify-worker run — invoke manually via
// workflow_dispatch, then delete this file once it's done its job.
const admin = require('firebase-admin');

const KEEP_UID = 'f053vFPMR1T95KX9WAZGWt9ioAq1';
const DELETE_UIDS = [
  'Dhc884DZXWcIrcxio5kKUtWVCWF2',
  '9rVhHsTDpWbdH0O4lv0stucMtWk1',
  'TkInjY2OJBZPelaIJWVrHwBHbzW2',
  'TygwXXZmCeRQgFM7VVkUASzMCCL2',
  'ff7Ef0mBKsRwzYhvFPZqYaTHql03',
  'mCdMwNgFlPQLMDzEq4AF5JowT9h2',
  'nKCvpe3GXlMN2NnrBoyDAxTZNze2',
  's8T51jzCE5dSI0xmPx8Pqkmn3d93',
  'tQZ3vv7rSAO1fa5qwKSspxsGijp2',
  'zRWI5N2JdWbtXT1IpjRTgo9VwHG3',
];

async function deleteCollection(db, ref, batchSize = 200) {
  const snap = await ref.limit(batchSize).get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.docs.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  if (snap.size === batchSize) await deleteCollection(db, ref, batchSize);
}

async function main() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON env var is not set');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(serviceAccountJson)) });
  const db = admin.firestore();

  for (const uid of DELETE_UIDS) {
    if (uid === KEEP_UID) throw new Error(`Refusing to delete KEEP_UID (${KEEP_UID})`);
    const userRef = db.collection('users').doc(uid);

    for (const sub of ['backups', 'notificationState']) {
      await deleteCollection(db, userRef.collection(sub));
    }
    await userRef.delete();
    console.log(`[cleanup] deleted user ${uid}`);
  }

  console.log(`[cleanup] done. Kept ${KEEP_UID}, deleted ${DELETE_UIDS.length} stale users.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('cleanup-stale-users failed', err);
    process.exit(1);
  });
