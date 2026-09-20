module.exports = {
  preset: '@react-native/jest-preset',
  testMatch: ['<rootDir>/test/**/*.test.js'],
  moduleNameMapper: {
    '^isomorphic-webcrypto/src/react-native$': '<rootDir>/test/nodeCrypto.js',
  },
};
