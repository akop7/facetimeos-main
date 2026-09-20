import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);

test('Render service-account files sign custom tokens without remote IAM signing', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ftos-admin-test-'));
  const file = path.join(directory, 'service-account.json');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = {
    type: 'service_account',
    project_id: 'facetimeos-unit-test',
    client_email: 'unit-test@facetimeos-unit-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
  try {
    await writeFile(file, JSON.stringify(account));
    const moduleUrl = new URL('../src/firebase-admin.js', import.meta.url).href;
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', `
      const { firebaseAuth } = await import(${JSON.stringify(moduleUrl)});
      const token = await (await firebaseAuth()).createCustomToken('unit-test-user');
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
      console.log(JSON.stringify({ uid: payload.uid, locallySigned: payload.iss === ${JSON.stringify(account.client_email)} }));
    `], {
      timeout: 15000,
      env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: file, FIREBASE_SERVICE_ACCOUNT_JSON: '', FIREBASE_PROJECT_ID: account.project_id },
    });
    assert.deepEqual(JSON.parse(stdout.trim()), { uid: 'unit-test-user', locallySigned: true });
  } finally {
    // Only the unique, test-created directory is removed; no real credentials.
    await rm(directory, { recursive: true, force: true });
  }
});
