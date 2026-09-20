import * as Y from 'yjs';
import {
  parseInvite,
  applyTextDiff,
  timerValue,
  safeWebUrl,
  bytes,
} from '../src/core';

const id = 'c7ecbf6c-b7ed-4975-abd4-206f2499e11b';
test('accepts only valid FaceTimeOS invitations without credentials or foreign origins', () => {
  expect(parseInvite(id)).toEqual({ roomId: id, inviteToken: null });
  expect(parseInvite(`https://facetimeos.vercel.app/room/${id}?t=abc`)).toEqual(
    { roomId: id, inviteToken: 'abc' },
  );
  expect(parseInvite(`facetimeos://room/${id}?t=abc`)).toEqual({
    roomId: id,
    inviteToken: 'abc',
  });
  for (const value of [
    `https://evil.test/room/${id}`,
    `https://user@facetimeos.vercel.app/room/${id}`,
    `javascript:alert(1)`,
    `facetimeos://room/${id}/extra`,
    `https://facetimeos.vercel.app/room/${id}?t=${'x'.repeat(9000)}`,
  ])
    expect(parseInvite(value)).toBeNull();
});
test('text edits preserve unchanged CRDT characters and converge', () => {
  const first = new Y.Doc(),
    second = new Y.Doc();
  first.getText('notes').insert(0, 'hello world');
  Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
  applyTextDiff(first.getText('notes'), 'hello mobile world');
  second.getText('notes').insert(11, '!');
  Y.applyUpdate(first, Y.encodeStateAsUpdate(second));
  Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
  expect(first.getText('notes').toString()).toBe('hello mobile world!');
  expect(second.getText('notes').toString()).toBe(
    first.getText('notes').toString(),
  );
  first.destroy();
  second.destroy();
});
test('timer format matches the shared web protocol', () => {
  expect(
    timerValue({ mode: 'countdown', anchor: 1000, base: 10000 }, 4000),
  ).toBe(7000);
  expect(
    timerValue({ mode: 'stopwatch', anchor: null, base: 10000 }, 90000),
  ).toBe(10000);
});
test('shared browser refuses dangerous schemes and credentials', () => {
  expect(safeWebUrl('https://example.com')).toBe('https://example.com/');
  for (const url of [
    'file:///etc/passwd',
    'http://example.com',
    'intent://room',
    'javascript:alert(1)',
    'https://password@example.com',
  ])
    expect(safeWebUrl(url)).toBeNull();
});
test('socket document payloads normalize without JSON corruption', () => {
  expect([...bytes({ type: 'Buffer', data: [1, 0, 255] })]).toEqual([
    1, 0, 255,
  ]);
  expect([...bytes(new Uint8Array([9, 8]).buffer)]).toEqual([9, 8]);
  expect(() => bytes('bad')).toThrow();
});
