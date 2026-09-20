/* global global */
const fs = require('node:fs');
const path = require('node:path');

function withoutBrowserEncoding(check) {
  const encoder = Object.getOwnPropertyDescriptor(global, 'TextEncoder');
  const decoder = Object.getOwnPropertyDescriptor(global, 'TextDecoder');
  try {
    Object.defineProperty(global, 'TextEncoder', {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(global, 'TextDecoder', {
      value: undefined,
      configurable: true,
    });
    jest.isolateModules(check);
  } finally {
    if (encoder) Object.defineProperty(global, 'TextEncoder', encoder);
    else delete global.TextEncoder;
    if (decoder) Object.defineProperty(global, 'TextDecoder', decoder);
    else delete global.TextDecoder;
  }
}

test('meeting documents initialize and synchronize Unicode without browser encoding globals', () => {
  withoutBrowserEncoding(() => {
    const Y = require('yjs');
    const local = new Y.Doc(),
      remote = new Y.Doc();
    const message = '\uFEFFनमस्ते 👋 meeting started';
    local.getText('notes').insert(0, message);
    local.getArray('chat').push([{ name: 'Alok', text: message }]);
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
    expect(remote.getText('notes').toString()).toBe(message);
    expect(remote.getArray('chat').get(0).text).toBe(message);
    local.destroy();
    remote.destroy();
  });
});
test('fallback preserves BOM and rejects malformed UTF-8 instead of silently corrupting data', () => {
  withoutBrowserEncoding(() => {
    const encoding = require('lib0/string');
    expect(encoding.decodeUtf8(Uint8Array.from([239, 187, 191, 65]))).toBe(
      '\uFEFFA',
    );
    expect(() => encoding.decodeUtf8(Uint8Array.from([255]))).toThrow();
  });
});
test('release bootstrap does not install the incompatible TextDecoder shim', () => {
  const entry = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  expect(entry).not.toMatch(/import\s+['"]fast-text-encoding['"]/);
  const pkg = require('../package.json');
  expect(pkg.dependencies['fast-text-encoding']).toBeUndefined();
});
