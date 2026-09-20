import test from 'node:test';
import assert from 'node:assert/strict';
import urls from '../electron/urls.cjs';
const id = 'c7ecbf6c-b7ed-4975-abd4-206f2499e11b';
test('Windows and web invite links preserve role tokens', () => {
  assert.equal(urls.roomPath(`facetimeos://room/${id}?t=a.b.c`), `/room/${id}?t=a.b.c`);
  assert.equal(urls.roomPath(`${urls.WEB_URL}/room/${id}?t=a.b.c`), `/room/${id}?t=a.b.c`);
});
test('deep links cannot open other sites, local files, or arbitrary app routes', () => {
  for (const value of ['file:///C:/Windows/system.ini', 'javascript:alert(1)', `https://evil.test/room/${id}`, 'facetimeos://room/../../settings', `facetimeos://user:pass@room/${id}`, `facetimeos://room:80/${id}`, 'facetimeos://settings/anything']) assert.equal(urls.roomPath(value), null, value);
});
test('native IPC only trusts the packaged application origin', () => {
  assert.equal(urls.isAppUrl('ftos://app/'), true);
  assert.equal(urls.isAppUrl('ftos://app/room/123'), true);
  for (const value of ['ftos://app.evil/', 'https://app/', 'ftos://user:pass@app/', 'ftos://app:443/', 'about:blank']) assert.equal(urls.isAppUrl(value), false);
});
test('distributed builds have HTTPS services and no local backend dependency', () => {
  assert.equal(urls.API_URL, 'https://facetimeos.onrender.com');
  assert.equal(urls.WEB_URL, 'https://facetimeos.vercel.app');
});
