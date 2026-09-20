# FaceTimeOS Android 1.0.0-beta.2

## Meeting-start crash hotfix

Fixed the recorded Android crash `Failed to construct 'TextDecoder': the 'fatal' option is unsupported`. An incompatible text-encoding shim crashed Yjs initialization when opening a meeting, even though login worked. Removed the shim so Yjs/lib0 use their UTF-8 fallback, and added regression tests for document initialization, Hindi/emoji synchronization, BOM handling and malformed UTF-8. Meeting initialization errors now show an error state instead of escaping the startup effect.

Install this APK **over beta.1 without uninstalling**. Version code 2 uses the same release certificate and Firebase fingerprints. No Firebase, Firestore rules, Render or Metered changes are required for this fix. Web and Windows application logic is unchanged.

Install the APK directly on an ARM64 Android phone (Android 7 or newer). Android 16 is targeted. No local server or computer is needed by recipients. Uses the existing hosted FaceTimeOS backend and Firebase project.

## Included

- Native home, Google/email account flows and pre-join device choices.
- Video/audio calls, camera switching, speaker/headset routing and native screen sharing.
- Named participants, invitations, waiting room and host controls.
- Shared chat, notes, code, whiteboard with undo/redo, timer, browser URLs and session timeline.
- Labeled controls, consistently placed panels with minimize/restore, and ZIP export.
- Release-key signed APK; SHA-256 checksum attached. Web and Windows source logic is unchanged.

## Verification and beta limitations

Passed for this hotfix: 15 mobile tests, ESLint with no errors (104 existing warnings), Android release compilation, APK signature verification matching the registered Firebase release fingerprint, 16 KB ZIP alignment, and in-place update installation/startup on the Android 16 x86_64 emulator. Dependency audit reported no known vulnerabilities. No AndroidRuntime crash appeared in the fresh emulator crash buffer after startup.

The restarted emulator was signed out, so post-login meeting/media verification is pending owner sign-in and permission approval. Automated UTF-8 regression tests exercise the dependency path that caused the recorded crash, but do not replace an actual-device call test. Web/backend tests were not rerun for this mobile-only hotfix; the previous release passed 63 web-client and 75 backend tests.

**Not yet end-to-end verified on the iQOO 15R:** Google login, real camera/microphone calls, cross-network TURN, Bluetooth, background behavior and screen sharing between actual devices. Treat this as a testing beta, not a production-readiness guarantee.

Screen sharing does not include internal device audio. Camera pauses in the background. Mobile code runs JavaScript/HTML/CSS and validates JSON; other listed languages are edit-only. Whiteboard export is stroke JSON. No iOS, incoming-call push, verified HTTPS App Links or automatic APK installation. Paste web invitations into the app. The free Render service may need a minute to wake up.

## Setup

Keep Google/Email authentication enabled in Firebase. No new permissive Firestore rules are needed. Never upload Firebase Admin credentials or the private Android signing key. See [ANDROID-SETUP.md](https://github.com/AlokGond/facetimeos/blob/main/ANDROID-SETUP.md) for all owner steps and the phone test checklist.

Phone owner must approve installation, camera/mic and screen-capture prompts themselves. Keep Android security protections enabled.
