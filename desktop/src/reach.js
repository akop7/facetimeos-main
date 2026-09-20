/**
 * Finding the server without asking anyone.
 *
 * The first version of this shell opened onto a form asking for a URL, which is a
 * question no user should have to answer to start a video call. So instead it
 * looks: a dev server on this machine, or the deployment. Whichever answers wins,
 * and the answer is saved, so the question is never asked again.
 *
 * Order matters more than speed here. Both candidates are probed at once, but the
 * first one in this list that responded is the one used — a developer with
 * `npm run dev` running means to test that, not production.
 *
 * "Responded" deliberately includes a 404 or a 500. This is a liveness check, not
 * a health check: something is serving on that address, and the window can show
 * whatever it says. Node-only and injectable, so `test/reach.test.js` can drive it
 * against local stubs.
 */

export const DEFAULT_APP_URLS = ['http://localhost:3000', 'https://facetimeos.vercel.app'];

const PROBE_TIMEOUT_MS = 2500;

export async function reachable(url, { timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      // A redirect is an answer; following it would only cost time.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return Boolean(res && res.status > 0);
  } catch {
    // DNS failure, refused connection, TLS error, timeout — all the same answer.
    return false;
  }
}

/**
 * The first reachable URL in preference order, or `null` if none answered.
 * Probes run concurrently, so this costs one timeout rather than one per候 URL.
 */
export async function firstReachable(urls = DEFAULT_APP_URLS, options = {}) {
  const results = await Promise.all(urls.map((url) => reachable(url, options)));
  const index = results.indexOf(true);
  return index === -1 ? null : urls[index];
}
