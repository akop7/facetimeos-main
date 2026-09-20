/**
 * @format
 */

import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';
// Yjs/lib0 and fflate supply UTF-8 fallbacks when Hermes has no TextDecoder.
// Do not install fast-text-encoding: it rejects lib0's fatal decoding mode.
import { registerGlobals } from 'react-native-webrtc';
import { AppRegistry } from 'react-native';
import App from './src/App';
import { name as appName } from './app.json';

registerGlobals();
AppRegistry.registerComponent(appName, () => App);
