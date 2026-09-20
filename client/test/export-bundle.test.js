/**
 * The export bundle.
 *
 * The zip is written by hand, byte by byte, with no library to blame — so the
 * test reads it back the same way, from the end-of-central-directory record
 * inward, rather than trusting `makeZip` to describe its own output. The CRC of
 * one known string is checked against the published constant for that string,
 * because a checksum verified with the same code that produced it proves nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeZip,
  strokesToSvg,
  buildBundle,
  downloadBlob,
} from '../src/lib/export-bundle.js';

const decoder = new TextDecoder();

/** Read a store-only zip back into `{ name: text }`, plus the recorded CRCs. */
async function readZip(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);

  const eocd = bytes.length - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50, 'no end-of-central-directory record');
  const count = view.getUint16(eocd + 10, true);
  const centralStart = view.getUint32(eocd + 16, true);

  const files = {};
  const crcs = {};
  let offset = centralStart;

  for (let i = 0; i < count; i += 1) {
    assert.equal(view.getUint32(offset, true), 0x02014b50, 'bad central directory entry');
    const nameLength = view.getUint16(offset + 28, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    assert.equal(view.getUint32(localOffset, true), 0x04034b50, `bad local header for ${name}`);
    assert.equal(view.getUint16(localOffset + 8, true), 0, 'expected stored, not deflated');
    assert.equal(view.getUint16(localOffset + 6, true) & 0x0800, 0x0800, 'expected the UTF-8 flag');
    const size = view.getUint32(localOffset + 18, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const dataStart = localOffset + 30 + localNameLength;

    files[name] = decoder.decode(bytes.subarray(dataStart, dataStart + size));
    crcs[name] = view.getUint32(localOffset + 14, true);
    offset += 46 + nameLength;
  }

  return { files, crcs, count };
}

test('a zip written by hand is a zip that can be read back', async () => {
  const blob = makeZip([
    { name: 'notes.md', text: 'hello' },
    { name: 'code.txt', text: 'const x = 1;\n' },
    { name: 'empty.txt', text: '' },
  ]);

  assert.equal(blob.type, 'application/zip');

  const { files, crcs, count } = await readZip(blob);
  assert.equal(count, 3);
  assert.equal(files['notes.md'], 'hello');
  assert.equal(files['code.txt'], 'const x = 1;\n');
  assert.equal(files['empty.txt'], '');

  // The CRC-32 of "hello" is a published constant; this is the one assertion
  // here that does not depend on our own arithmetic.
  assert.equal(crcs['notes.md'], 0x3610a686);
  assert.equal(crcs['empty.txt'], 0);
});

test('non-ASCII names and content survive the round trip', async () => {
  const { files } = await readZip(
    makeZip([{ name: 'notes-日本語.md', text: 'decisión: enviar 🚀' }])
  );
  assert.equal(files['notes-日本語.md'], 'decisión: enviar 🚀');
});

test('a zip with no entries is still structurally valid', async () => {
  const { count } = await readZip(makeZip([]));
  assert.equal(count, 0);
});

test('dates before the zip epoch do not produce a negative field', async () => {
  // 1979 is representable in JS and not in a DOS timestamp. The clamp exists so
  // a machine with a wrong clock produces an odd date rather than a corrupt file.
  const blob = makeZip([{ name: 'a.txt', text: 'a' }], new Date('1979-01-01T00:00:00Z'));
  const { files } = await readZip(blob);
  assert.equal(files['a.txt'], 'a');
});

test('the whiteboard exports as vectors, one element per stroke', () => {
  const svg = strokesToSvg(
    [
      { tool: 'pen', color: '#111111', width: 3, points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }] },
      { tool: 'line', color: '#222222', width: 2, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
      { tool: 'rectangle', color: '#333333', width: 2, points: [{ x: 0.5, y: 0.5 }, { x: 0.25, y: 0.25 }] },
      { tool: 'circle', color: '#444444', width: 2, points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }] },
      { tool: 'text', color: '#555555', width: 3, text: 'ship it', points: [{ x: 0.1, y: 0.2 }] },
    ],
    1000,
    500
  );

  assert.match(svg, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(svg, /viewBox="0 0 1000 500"/);
  assert.equal((svg.match(/<path /g) || []).length, 1);
  assert.equal((svg.match(/<line /g) || []).length, 1);
  assert.equal((svg.match(/<ellipse /g) || []).length, 1);
  assert.equal((svg.match(/<text /g) || []).length, 1);
  assert.match(svg, /ship it<\/text>/);

  // Normalised coordinates are multiplied by the requested size, and a rectangle
  // is drawn from its top-left corner however it was dragged.
  assert.match(svg, /<rect x="250\.00" y="125\.00" width="250\.00" height="125\.00"/);
  assert.match(svg, /<path d="M0\.00 0\.00 L500\.00 250\.00"/);
});

test('an eraser stroke is dropped, because a static SVG has nothing to erase from', () => {
  const svg = strokesToSvg([
    { tool: 'eraser', width: 20, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] },
  ]);
  assert.equal(svg.includes('<path'), false);
});

test('stroke text and colours are escaped, not interpolated', () => {
  const svg = strokesToSvg([
    {
      tool: 'text',
      color: '"><script>alert(1)</script>',
      text: '<b>5 < 6 & "quoted"</b>',
      points: [{ x: 0, y: 0 }],
    },
  ]);

  assert.equal(svg.includes('<script>'), false);
  assert.match(svg, /&lt;b&gt;5 &lt; 6 &amp; &quot;quoted&quot;&lt;\/b&gt;/);
});

test('malformed strokes are skipped rather than crashing the export', () => {
  const svg = strokesToSvg([null, undefined, {}, { tool: 'pen', points: [] }, { points: null }]);
  assert.match(svg, /<svg /);
  assert.equal(svg.includes('<path'), false);
  assert.match(strokesToSvg(null), /<svg /);
});

/** The duck-typed shape `buildBundle` reads out of the CRDT. */
function fakeSharedTypes({ notes = '', code = '', strokes = [], chat = [], timeline = [], meta = {} } = {}) {
  return {
    notes: { toString: () => notes },
    code: { toString: () => code },
    whiteboard: { toArray: () => strokes },
    chat: { toArray: () => chat },
    timeline: { toArray: () => timeline },
    meta: { get: (key) => meta[key] },
  };
}

test('the bundle contains every file its README promises', async () => {
  const { filename, blob, stats } = buildBundle({
    roomId: 'abc123',
    title: "Alok's room",
    exportedBy: 'Alok',
    sharedTypes: fakeSharedTypes({
      notes: 'two words',
      code: 'line one\nline two\nline three',
      strokes: [{ tool: 'pen', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
      chat: [{ name: 'Alok', text: 'starting', at: 1_700_000_000_000 }],
      timeline: [
        { kind: 'join', text: 'Alok joined', at: 1_700_000_000_000, byName: 'Alok' },
        { kind: 'decision', text: 'ship on friday', at: 1_700_000_060_000, byName: 'Alok' },
      ],
      meta: { codeLanguage: 'javascript', browserNav: { trail: ['https://example.com'] } },
    }),
  });

  const { files } = await readZip(blob);
  assert.deepEqual(Object.keys(files).sort(), [
    'README.md',
    'code.txt',
    'links.md',
    'notes.md',
    'session.json',
    'timeline.json',
    'timeline.md',
    'transcript.md',
    'whiteboard.svg',
  ]);

  assert.match(filename, /^facetimeos-alok-s-room-abc123-\d{4}-\d{2}-\d{2}\.zip$/);
  assert.deepEqual(stats, {
    notesWords: 2,
    codeLines: 3,
    strokes: 1,
    messages: 1,
    events: 2,
    links: 1,
  });

  // The decision is the reason anyone keeps this file.
  assert.match(files['README.md'], /\*\*ship on friday\*\* — Alok/);
  assert.match(files['transcript.md'], /\*\*Alok\*\*/);
  assert.match(files['transcript.md'], /starting/);
  assert.match(files['links.md'], /https:\/\/example\.com/);
  assert.match(files['whiteboard.svg'], /<path /);

  const session = JSON.parse(files['session.json']);
  assert.equal(session.roomId, 'abc123');
  assert.equal(session.codeLanguage, 'javascript');
  assert.deepEqual(session.participants, ['Alok']);
  assert.deepEqual(session.browserTrail, ['https://example.com']);
  assert.equal(JSON.parse(files['timeline.json']).length, 2);
});

test('exporting a room where nothing happened yet still produces a bundle', async () => {
  const { filename, blob, stats } = buildBundle({ roomId: 'empty1', sharedTypes: undefined });

  const { files, count } = await readZip(blob);
  assert.equal(count, 9);
  assert.match(filename, /^facetimeos-session-empty1-/);
  assert.deepEqual(stats, {
    notesWords: 0,
    codeLines: 0,
    strokes: 0,
    messages: 0,
    events: 0,
    links: 0,
  });

  assert.match(files['notes.md'], /No notes were taken/);
  assert.match(files['transcript.md'], /No messages/);
  assert.match(files['timeline.md'], /Nothing recorded/);
  assert.match(files['links.md'], /_None\._/);
  assert.match(files['README.md'], /_None marked\./);
  assert.equal(JSON.parse(files['session.json']).title, null);
});

test('a title that slugifies to nothing still yields a usable filename', () => {
  const { filename } = buildBundle({
    roomId: 'r1',
    title: '!!!',
    sharedTypes: fakeSharedTypes(),
  });
  assert.match(filename, /^facetimeos-session-r1-\d{4}-\d{2}-\d{2}\.zip$/);
});

test('downloadBlob is a no-op where there is no document to click', () => {
  assert.equal(typeof document, 'undefined');
  assert.doesNotThrow(() => downloadBlob(makeZip([]), 'x.zip'));
});
