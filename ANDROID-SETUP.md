# FaceTimeOS for Android

Native React Native Android app in `mobile-app/`. It uses the existing Render service, Firebase Authentication and the same Yjs/WebRTC room protocol as the web/Windows apps. It does not package or change the old desktop wrapper.

## Install and share

1. Download the **Android APK** from [GitHub Releases](https://github.com/AlokGond/facetimeos/releases). Android beta releases are separate from Windows installers.
2. Open the APK on your phone. If Android asks, you decide whether to permit that browser/file manager to install this app. Keep Play Protect enabled. No PC, local backend, Node.js or Android Studio is needed on the recipient's phone.
3. Sign in with Google or an existing Firebase email/password account. New email accounts can be created in the app if that provider is enabled in Firebase.
4. Create a meeting or paste an existing FaceTimeOS invitation. Pre-join choices control whether camera/microphone permissions are requested when joining.
5. Camera/mic permissions and each screen-capture consent must be approved by the phone owner. Screen sharing includes the call microphone, **not internal device audio**.

The release targets Android 16 (API 36), supports Android 7+ (API 24+), and packages ARM64 phones plus x86_64 emulators. Your iQOO 15R uses ARM64. Hardware-specific verification is still required before calling this production-ready.

## Firebase configuration

- Project: `facetimeos`
- Android application ID: `com.alokgond.facetimeos.android`
- Place the downloaded **Android** `google-services.json` in `mobile-app/android/app/google-services.json`. The supplied updated file has been copied there locally; it is gitignored.
- Firebase Console → Authentication → Sign-in method: enable **Google** and **Email/Password** if you want both buttons to work. Set the Google support email when prompted.
- Firebase Console → Project settings → this Android app: keep these release fingerprints registered:

```text
SHA-1:   93:F7:5D:87:B8:CA:ED:D2:1D:3C:FC:B0:EB:58:8E:AD:B3:59:C7:0F
SHA-256: BD:44:25:97:CA:19:EA:A4:6C:3C:03:E2:32:61:49:28:41:B7:81:EE:CB:FF:50:FB:3A:FD:82:F0:08:7B:F8:B4
```

The updated JSON includes the release Android OAuth client. Google sign-in must still be exercised on a device. A `DEVELOPER_ERROR`/code 10 usually means package, certificate or OAuth-client configuration does not match the installed APK. A debug APK uses a different certificate.

**Never put the Firebase Admin service-account JSON in the Android app, web bundle, Git repository or release assets.** That private file belongs only on Render. `google-services.json` is client configuration, not an Admin credential.

## Firestore rules: preserve the web app

Mobile does not directly read/write Firestore meeting archives. It uses Render's signed room sessions; the backend writes archives through Firebase Admin, which bypasses client rules. **No new public Firestore permission is required for Android.** Keep existing `/users` and `/rooms` rules unchanged for web compatibility.

Under `match /databases/{database}/documents`, archives should remain denied to clients:

```text
match /facetimeosRooms/{roomId} {
  allow read, write: if false;
  match /{document=**} {
    allow read, write: if false;
  }
}
```

Keep a default deny rule as well. Firestore matching `allow` rules are ORed: a broad `allow read, write: if true` elsewhere overrides a deny. Do not publish permissive test-mode rules. Firebase login and room-token authorization are distinct; the existing backend uses room tokens for meeting privileges.

## Hosted backend

- API/signaling: `https://facetimeos.onrender.com`
- Web invitations: `https://facetimeos.vercel.app`
- Keep existing Render Firebase secret and Metered TURN settings. Never put TURN provider API keys in the mobile client; it fetches ICE configuration from Render.
- The free Render service can sleep. Initial create/join may take about a minute; retry if the app reports the server is waking up. Cold starts and service quotas are not eliminated by installing an APK.
- Existing live rooms use a single-instance in-memory coordinator. This release is not an SFU or unlimited-participant conferencing service.

## Build a signed update on this Windows PC

Requirements: Node 22.11+, npm, Android SDK 36/build-tools 36, NDK 27.1.12297006, CMake and compatible JDK (this machine uses Android Studio's bundled JDK 21).

```powershell
cd C:\Users\Alok\OneDrive\Desktop\Project\facetimeos\mobile-app
npm ci
npm test -- --runInBand
./tools/build-android.ps1
```

If the wrapper download times out on this network, select the already downloaded and checksum-verified Gradle:

```powershell
./tools/build-android.ps1 -GradlePath C:/Users/Alok/AppData/Local/FaceTimeOS/build-tools/gradle-9.3.1/bin/gradle.bat
```

The script requires release credentials, verifies the APK using `apksigner`, and copies it to `mobile-app/release/FaceTimeOS-<package-version>-android.apk` with a SHA-256 checksum. Native C++ intermediates use a shorter cache to avoid Windows path-length failures. This does not change system-wide Java settings.

`npm ci` applies the checked-in WebView security patch. It denies webpage camera/microphone requests even when the native meeting has those permissions. Do not remove this patch when upgrading WebView. Shared pages/code previews have no React Native message bridge or app cookies.

Before each update, increment `versionCode` and `versionName` in `android/app/build.gradle`, package version and `src/config.js`. Build and publish scripts derive artifact names from the package version. Use the **same key** so Android can install over the previous version; do not uninstall the old app first.

## Signing key: back up before reinstalling Windows

Private release key and machine-bound encrypted password are outside Git:

```text
C:\Users\Alok\AppData\Local\FaceTimeOS\signing\android-release.jks
C:\Users\Alok\AppData\Local\FaceTimeOS\signing\android-release-password.dpapi
```

DPAPI can only be decrypted by this Windows user/machine. Copying the JKS without its usable password is insufficient. Make a portable password-protected backup to your own secure drive:

```powershell
./tools/backup-signing-key.ps1 -Destination E:/PrivateBackup/facetimeos-android.p12
```

Choose an actual backup drive/path you own; the script prompts privately for a new backup password. Store it separately in a password manager. Never commit/upload the key, DPAPI file or backup. Losing the signing identity prevents update installation over the old APK. No signing key has been placed in GitHub Secrets.

## Beta scope and phone acceptance test

Implemented: native account/home/pre-join flows; camera/mic, camera switching, speaker/headset route, native screen capture; participant names and roles; invitations, waiting room and host moderation; chat, notes, code editor, whiteboard with own-stroke undo/redo, timer, shared URL browser, timeline/decisions and ZIP export; consistent panels with minimize/restore.

Code execution: JavaScript/HTML/CSS preview and JSON validation. TypeScript/Python/Java/C++ are collaboratively editable, not executable on mobile. Whiteboard exports as JSON, not a rendered image. Invites can be pasted; `facetimeos://room/<id>` is supported, but verified HTTPS App Links have not been deployed. Incoming-call push notifications, automatic APK installation and iOS are not included.

Before promoting beta to stable, test on the iQOO plus a web/Windows participant:

- Google/email login, fresh install and signed update.
- Create/join both directions; names, audio/video, mute, camera switch, headphones.
- Screen share both directions; stop via Android and app; capture stops on Leave.
- Wi-Fi/mobile-data switch and a relay-required call on separate networks.
- Whiteboard undo/redo, notes/code, chat and timer sync; reconnect/reopen archived room.
- Viewer restrictions, tool grants, lock/admission, kick, host transfer, end for all.
- Minimize/restore every tool; keyboard, landscape, text sizing, ZIP save/cancel.
- Background/lock-screen microphone continuity, camera pause and notification under the manufacturer's battery policy. Do not disable Android safety controls.

Automated tests and emulator startup do not prove all device-specific media paths work. Release notes must distinguish verified checks from pending phone tests.
