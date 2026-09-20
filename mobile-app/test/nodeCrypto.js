const { webcrypto } = require('node:crypto');
module.exports = {
  ensureSecure() {},
  getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
  subtle: webcrypto.subtle,
};
