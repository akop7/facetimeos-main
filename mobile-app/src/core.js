import { API, WEB } from './config';

export function parseInvite(input) {
  const value = String(input || '').trim();
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuid.test(value)) return { roomId: value, inviteToken: null };
  try {
    const url = new URL(value);
    if (url.username || url.password || url.port) return null;
    if (
      url.origin !== WEB &&
      !(url.protocol === 'facetimeos:' && url.hostname === 'room')
    )
      return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const roomId = url.protocol === 'facetimeos:' ? parts[0] : parts[1];
    if (
      !uuid.test(roomId || '') ||
      (url.protocol === 'facetimeos:'
        ? parts.length !== 1
        : parts.length !== 2 || parts[0] !== 'room')
    )
      return null;
    const inviteToken = url.searchParams.get('t');
    if (inviteToken && inviteToken.length > 8192) return null;
    return { roomId, inviteToken };
  } catch {
    return null;
  }
}

export async function api(path, body, method = body ? 'POST' : 'GET') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 75000);
  try {
    const response = await fetch(`${API}/rtc${path}`, {
      method,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(
        'The meeting server is waking up or unavailable. Wait a minute and retry.',
      );
    }
    if (!response.ok)
      throw new Error(
        data.message || data.error || `Server error (${response.status})`,
      );
    return data;
  } catch (error) {
    if (error.name === 'AbortError')
      throw new Error(
        'The server took too long. Check your connection and try again.',
      );
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function applyTextDiff(text, next) {
  const current = text.toString();
  if (current === next) return;
  let start = 0,
    end = 0;
  while (
    start < Math.min(current.length, next.length) &&
    current[start] === next[start]
  )
    start++;
  while (
    end < Math.min(current.length - start, next.length - start) &&
    current[current.length - end - 1] === next[next.length - end - 1]
  )
    end++;
  text.doc.transact(() => {
    const count = current.length - start - end;
    if (count) text.delete(start, count);
    const insert = next.slice(start, next.length - end);
    if (insert) text.insert(start, insert);
  });
}

export function safeWebUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function timerValue(timer, now = Date.now()) {
  const elapsed = Number.isFinite(timer.anchor)
    ? Math.max(0, now - timer.anchor)
    : 0;
  return timer.mode === 'stopwatch'
    ? timer.base + elapsed
    : timer.base - elapsed;
}

export function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value);
  if (value?.type === 'Buffer' && Array.isArray(value.data))
    return Uint8Array.from(value.data);
  throw new Error('Invalid document update');
}
