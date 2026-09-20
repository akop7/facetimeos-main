/**
 * Lets Node import the app's own modules.
 *
 * `src/**` is written for Turbopack, which resolves `'./yjs-transport'` to
 * `yjs-transport.js` on its own. Node's ESM resolver does not: a relative
 * specifier is a URL, and a URL without an extension is a missing file. The
 * choice was to append `.js`/`.jsx` to 54 imports across 21 source files so a
 * test runner could read them, or to teach the test runner the one rule the
 * bundler already applies. This is the second option.
 *
 * Nothing in the shipped app loads this — it is registered only by `npm test`.
 */

const EXTENSIONS = ['.js', '.jsx', '/index.js', '/index.jsx'];

const isRelative = (specifier) => specifier.startsWith('./') || specifier.startsWith('../');

/** Already ends in something that looks like a file extension. */
const hasExtension = (specifier) => /\.[a-z0-9]+$/i.test(specifier.split('/').pop() ?? '');

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    if (!isRelative(specifier) || hasExtension(specifier)) throw error;

    for (const extension of EXTENSIONS) {
      try {
        return await nextResolve(specifier + extension, context);
      } catch (retryError) {
        if (retryError?.code !== 'ERR_MODULE_NOT_FOUND') throw retryError;
      }
    }
    throw error;
  }
}
