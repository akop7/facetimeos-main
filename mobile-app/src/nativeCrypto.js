/* global globalThis */
import 'react-native-get-random-values';

// lib0 only needs secure random bytes for Yjs IDs. Keep its legacy RN adapter
// on the same native CSPRNG as the app; never fall back to Math.random.
export default {
  ensureSecure() {
    if (typeof globalThis.crypto?.getRandomValues !== 'function') {
      throw new Error(
        'Secure random generation is unavailable on this device.',
      );
    }
  },
  getRandomValues(array) {
    return globalThis.crypto.getRandomValues(array);
  },
  get subtle() {
    return globalThis.crypto?.subtle;
  },
};
