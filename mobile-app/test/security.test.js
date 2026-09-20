const fs = require('node:fs');
const path = require('node:path');
test('untrusted Android WebViews deny native media permission inheritance', () => {
  const source = fs.readFileSync(
    path.join(
      __dirname,
      '../node_modules/react-native-webview/android/src/main/java/com/reactnativecommunity/webview/RNCWebChromeClient.java',
    ),
    'utf8',
  );
  const method = source
    .split(
      'public void onPermissionRequest(final PermissionRequest request) {',
    )[1]
    .split('@Override')[0];
  expect(method).toContain('request.deny()');
  expect(method).not.toContain('request.grant');
});
test('release uses its own signing config and disables Android backup', () => {
  const manifest = fs.readFileSync(
    path.join(__dirname, '../android/app/src/main/AndroidManifest.xml'),
    'utf8',
  );
  expect(manifest).toContain('android:allowBackup="false"');
  const build = fs.readFileSync(
    path.join(__dirname, '../android/app/build.gradle'),
    'utf8',
  );
  expect(build.split('buildTypes {')[1].split('release {')[1]).toContain(
    'signingConfig signingConfigs.release',
  );
});
