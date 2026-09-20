import './config.js';
import { readFile } from 'node:fs/promises';

export const firebaseAdminConfigured = () => Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
async function adminApp() {
  const { cert, getApps, initializeApp } = await import('firebase-admin/app');
  const existing = getApps().find(app => app.name === 'facetimeos-server');
  if (existing) return existing;
  if (!firebaseAdminConfigured()) throw new Error('Firebase Admin is not configured. Add the service-account secret on Render.');
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try { credential = cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)); }
    catch { throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is invalid. Use the complete Firebase service-account JSON.'); }
  } else {
    // Render secret files contain the downloaded service-account JSON. Use its
    // private-key signer directly; ADC otherwise selects remote IAM signing and
    // unnecessarily requires the IAM Credentials API for desktop custom tokens.
    let account;
    try { account = JSON.parse(await readFile(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8')); }
    catch { throw new Error('The Firebase service-account secret file is missing or invalid. Check GOOGLE_APPLICATION_CREDENTIALS on Render.'); }
    try { credential = cert(account); }
    catch { throw new Error('The Firebase secret file must contain the complete downloaded service-account JSON.'); }
  }
  return initializeApp({ credential, ...(process.env.FIREBASE_PROJECT_ID ? { projectId: process.env.FIREBASE_PROJECT_ID } : {}) }, 'facetimeos-server');
}
export const firebaseAuth = async () => {
  const { getAuth } = await import('firebase-admin/auth');
  return getAuth(await adminApp());
};
export const firestore = async () => {
  const { getFirestore } = await import('firebase-admin/firestore');
  return getFirestore(await adminApp(), process.env.FIRESTORE_DATABASE_ID || '(default)');
};
