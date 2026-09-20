# FaceTimeOS Android

Native Android client for the existing FaceTimeOS rooms. See [setup, signing, Firebase and phone testing](../ANDROID-SETUP.md).

```powershell
npm ci
npm test -- --runInBand
./tools/build-android.ps1
```

Supply the Firebase Android `google-services.json` in `android/app/` before building. Never use a Firebase Admin private key. The mobile release uses its own release signing key, not the scaffold debug key. This project currently ships Android only.
