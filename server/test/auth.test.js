import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROLES,
  isUuid,
  newPeerId,
  roleAtLeast,
  sanitizeDisplayName,
  signInviteToken,
  signSessionToken,
  verifyInviteToken,
  verifySessionToken,
} from '../src/auth.js';

// Built with fromCharCode so the source file itself stays free of raw control
// bytes (which corrupt diffs and editors).
const CONTROL = String.fromCharCode(0x00, 0x1b, 0x7f, 0x9f);

test('roleAtLeast ranks host > editor > viewer', () => {
  assert.equal(roleAtLeast(ROLES.HOST, ROLES.EDITOR), true);
  assert.equal(roleAtLeast(ROLES.EDITOR, ROLES.EDITOR), true);
  assert.equal(roleAtLeast(ROLES.VIEWER, ROLES.EDITOR), false);
  assert.equal(roleAtLeast('nonsense', ROLES.VIEWER), false);
});

test('sanitizeDisplayName strips control characters and clamps length', () => {
  assert.equal(sanitizeDisplayName('Alok'), 'Alok');
  assert.equal(sanitizeDisplayName(`A${CONTROL}lok`), 'Alok');
  assert.equal(sanitizeDisplayName('evil\nnewline'), 'evilnewline');
  assert.equal(sanitizeDisplayName('  padded  '), 'padded');
  assert.equal(sanitizeDisplayName('   '), 'Guest');
  assert.equal(sanitizeDisplayName(undefined), 'Guest');
  assert.equal(sanitizeDisplayName(null, 'Anon'), 'Anon');
  assert.equal(sanitizeDisplayName('x'.repeat(200)).length, 40);
  // Emoji are multi-code-unit; iterating code points must not split them.
  assert.equal(sanitizeDisplayName('hi 👋'), 'hi 👋');
});

test('newPeerId returns a v4 uuid that isUuid accepts', () => {
  const id = newPeerId();
  assert.equal(isUuid(id), true);
  assert.equal(isUuid('../../etc/passwd'), false);
  assert.equal(isUuid(''), false);
  assert.equal(isUuid(undefined), false);
});

test('a session token round-trips its claims', () => {
  const token = signSessionToken({
    roomId: 'r1',
    peerId: 'p1',
    role: ROLES.HOST,
    displayName: 'Alok',
  });
  assert.deepEqual(verifySessionToken(token), {
    roomId: 'r1',
    peerId: 'p1',
    role: ROLES.HOST,
    displayName: 'Alok',
  });
});

test('an invite token round-trips its room and role', () => {
  const token = signInviteToken({ roomId: 'r1', role: ROLES.VIEWER });
  assert.deepEqual(verifyInviteToken(token), { roomId: 'r1', role: ROLES.VIEWER });
});

test('token types are not interchangeable', () => {
  const invite = signInviteToken({ roomId: 'r1', role: ROLES.HOST });
  const session = signSessionToken({
    roomId: 'r1',
    peerId: 'p1',
    role: ROLES.HOST,
    displayName: 'A',
  });
  // An invite must not be usable as a session (it carries no peer identity) and
  // vice versa, or role escalation is just a matter of sending the other one.
  assert.equal(verifySessionToken(invite), null);
  assert.equal(verifyInviteToken(session), null);
});

test('forged and tampered tokens are rejected', () => {
  assert.equal(verifySessionToken('not-a-jwt'), null);
  assert.equal(verifySessionToken(''), null);
  assert.equal(verifySessionToken(undefined), null);
  assert.equal(verifyInviteToken(null), null);

  // The old design let the browser invent its own host token. Simulate that: a
  // hand-rolled, unsigned "token" claiming host must not verify.
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ rid: 'r1', role: 'host', typ: 'invite' })).toString(
    'base64url'
  );
  assert.equal(verifyInviteToken(`${header}.${body}.`), null);

  // Flipping the tail of a genuine token invalidates the signature.
  const good = signInviteToken({ roomId: 'r1', role: ROLES.VIEWER });
  const tampered = good.slice(0, -2) + (good.endsWith('aa') ? 'bb' : 'aa');
  assert.equal(verifyInviteToken(tampered), null);
});

test('unknown roles cannot be signed', () => {
  assert.throws(() => signInviteToken({ roomId: 'r1', role: 'superadmin' }), /Unknown role/);
  assert.throws(
    () => signSessionToken({ roomId: 'r1', peerId: 'p', role: 'god', displayName: 'x' }),
    /Unknown role/
  );
});
