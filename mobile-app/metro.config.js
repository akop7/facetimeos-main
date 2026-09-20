const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const path = require('node:path');
const config = {
  watchFolders: [path.resolve(__dirname, '../client/src')],
  resolver: {
    resolveRequest(context, moduleName, platform) {
      if (moduleName === 'isomorphic-webcrypto/src/react-native') {
        return {
          type: 'sourceFile',
          filePath: path.resolve(__dirname, 'src/nativeCrypto.js'),
        };
      }
      return context.resolveRequest(context, moduleName, platform);
    },
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
    disableHierarchicalLookup: true,
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
