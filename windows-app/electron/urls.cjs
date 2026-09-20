const APP_ORIGIN = 'ftos://app';
const API_URL = 'https://facetimeos.onrender.com';
const WEB_URL = 'https://facetimeos.vercel.app';
const RELEASE_URL = 'https://github.com/AlokGond/facetimeos/releases';
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function isAppUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'ftos:' && u.hostname === 'app' && !u.port && !u.username && !u.password;
  } catch { return false; }
}

function roomPath(value) {
  try {
    const u = new URL(value);
    const pathname = u.protocol === 'facetimeos:' && u.hostname === 'room'
      ? `/room${u.pathname}` : u.pathname;
    if (!(u.protocol === 'facetimeos:' && u.hostname === 'room') && u.origin !== WEB_URL) return null;
    if (u.username || u.password || u.port || !new RegExp(`^/room/${uuid}/?$`, 'i').test(pathname)) return null;
    const token = u.searchParams.get('t');
    // Only room navigation is accepted; never pass arbitrary protocols or commands.
    return pathname.replace(/\/$/, '') + (token ? `?t=${encodeURIComponent(token.slice(0, 8192))}` : '');
  } catch { return null; }
}

module.exports = { APP_ORIGIN, API_URL, WEB_URL, RELEASE_URL, isAppUrl, roomPath };
