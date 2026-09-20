# FaceTimeOS for Windows — owner setup and sharing

This is the new **`windows-app/`** implementation. It packages the current meeting UI, Firebase client and Monaco editor inside Electron. It does not run Next.js, Node commands, or a local meeting server on your friends' computers. Internet is required for meetings and cloud saving.

Your services are configured as:

| Purpose | Service |
| --- | --- |
| Windows application | `windows-app/` → `FaceTimeOS-Setup-2.0.0-x64.exe` |
| Meeting API + Socket.IO | `https://facetimeos.onrender.com` |
| Website + Google sign-in approval | `https://facetimeos.vercel.app` |
| Authentication + saved room documents | Firebase project `facetimeos`, Cloud Firestore |
| Media relay | Your existing Metered configuration on Render |

**Do the owner setup once. Your users only install, sign in, and join.**

## 1. Firebase Authentication

Open [Firebase Console](https://console.firebase.google.com/) → project **facetimeos**.

1. Authentication → Sign-in method → enable **Google**. Choose the support email and save.
2. Enable **Email/Password** too if you want that alternative. Email-link sign-in is not required.
3. Authentication → Settings → Authorized domains: add `facetimeos.vercel.app`. Keep the existing `facetimeos.firebaseapp.com` and `facetimeos.web.app` domains. Add any custom web domain you actually use. Do not enter URL paths or `ftos://app` here; the Google popup runs on the HTTPS website, not in the embedded Windows view.
4. Project settings → General → Your apps → select the existing Web app. Keep its public `firebaseConfig` values in `client/.env.local` locally and in the website's production environment. Use the **same Firebase project** for the web app, desktop app, and Admin service account.

Google's OAuth consent configuration must allow the people you invite. If Google Cloud's audience is External/Testing, add testers or publish the consent configuration for the intended audience. If it is Internal, people outside that organization cannot use it. Basic Google sign-in does not require adding a separate Windows OAuth client with this implementation.

## 2. Cloud Firestore and the exact rules

Firebase → Build → Firestore Database. Use an existing **Standard edition, Native mode** database, normally `(default)`, or create it in a suitable region. This app does not use Realtime Database or Firebase Storage for chat.

Firestore → Rules → publish the contents of **`server/firestore.rules`**:

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

This is intentional: Windows/web clients do not connect to Firestore directly. They send updates through the meeting server, which checks room session/role capabilities. Firebase Admin on Render accesses Firestore through IAM and is not blocked by client security rules. **Do not use `allow read, write: if true`**, and remove old broad `allow` rules in this dedicated project. An overlapping allow rule wins even if another rule says false.

If other apps share this Firebase project, do not replace their rules blindly. Keep reviewed collection-specific rules for those apps, and deny client access to `/facetimeosRooms/{document=**}` without any broader rule granting it access.

You do not need to create a collection or message documents manually. After a room makes changes, the backend creates:

```text
facetimeosRooms/{roomId}               # archive metadata and savedAt
  chunks/{0,1,...}                    # compressed shared room state
```

Chat, timeline, code, notes, whiteboard and shared layout are part of this state. The console shows binary chunks, not one readable document per message. Room titles/live participant lists/moderation state are still managed in memory by the meeting server; this change does not turn them into database-backed records. Do not manually edit the binary chunks.

Firestore → Indexes → Single field → Add exemption: **collection group `chunks`, field `data`**, disable ascending/descending/array indexing. No query indexes are needed. The checked-in `server/firestore.indexes.json` contains the same exemption for CLI deployment if you already use the Firebase CLI. Avoid replacing unrelated indexes from a shared project.

## 3. Private Firebase credential on Render

1. Firebase → Project settings → **Service accounts** → Firebase Admin SDK → **Generate new private key**. Download the JSON securely.
2. Render → your `facetimeos` Web Service → **Environment → Secret Files**.
3. Add a secret file named **`firebase-service-account.json`**, with the complete downloaded JSON as its content.
4. Add these environment variables to the Render service:

```dotenv
NODE_ENV=production
CLIENT_ORIGIN=https://facetimeos.vercel.app,ftos://app
DOC_STORE_PROVIDER=firestore
DOC_STORE_ENABLED=true
DOC_FLUSH_DEBOUNCE_MS=10000
FIREBASE_PROJECT_ID=facetimeos
FIRESTORE_DATABASE_ID=(default)
GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/firebase-service-account.json
```

Keep any other legitimate website origins already present in `CLIENT_ORIGIN`, separated by commas. No trailing slash on origins. Do **not** use `*` or allow `null` as a workaround for CORS.

Keep your existing **strong, stable `JWT_SECRET`** (at least 32 characters), `METERED_APP_NAME`, `METERED_API_KEY`, and any deliberate TURN settings. Never put these values into `client/`, `windows-app/`, a `NEXT_PUBLIC_*` variable, screenshots, or GitHub. Render supplies `PORT`; no fixed public port is needed.

Alternative credential method: put the full JSON in Render's private **`FIREBASE_SERVICE_ACCOUNT_JSON`** env variable instead of a Secret File. Use one credential method, not both. The service account must have permissions for Firestore and Firebase Authentication in this project; the Firebase-generated Admin SDK account normally has them. If you use a restricted custom account, grant only the required Firestore data and Firebase Auth permissions. No IAM Owner role is needed. Rotate a key immediately if it has been exposed.

Render service settings:

- Repository: `AlokGond/facetimeos`, branch `main`.
- Root directory: `server`.
- Build command: `npm ci`.
- Start command: `npm start`.
- Node: **22 LTS** (22.14 or newer supported by the project; do not choose an older 18 runtime).
- Health check path: `/rtc/health`.
- Use **one running backend instance**. The room authority, connected peers and pending desktop logins are in memory; horizontal scaling requires a shared Socket.IO/room-state design first.

Save and deploy the newest commit. Do this outside an important call: restarting Render disconnects current meetings.

Firestore saves are debounced to reduce writes, and the server also flushes when a room empties or shuts down normally. A hard crash can lose the last unflushed changes; keep session exports for important work. Switching storage does not automatically migrate older `.data` files from Render. Export any existing important sessions before redeployment. Firestore artifacts remain until explicitly deleted by the host; `ROOM_TTL_HOURS` only evicts their in-memory cache in Firestore mode.

## 4. Deploy the website update

Deploy the latest `client/` code to the existing website. It adds **`/desktop-auth`**, used to approve Windows Google sign-ins.

Keep all seven existing `NEXT_PUBLIC_FIREBASE_*` web config values. Ensure these public/service routing settings are correct, then redeploy:

```dotenv
NEXT_PUBLIC_SIGNALING_URL=https://facetimeos.onrender.com
SIGNALING_ORIGIN=https://facetimeos.onrender.com
NEXT_PUBLIC_WEB_URL=https://facetimeos.vercel.app
```

No private Firebase Admin key is needed on the website. The installer already contains only the public web config from your local client environment. If you later change Firebase projects or backend/web URLs, rebuild the installer too. The fixed desktop endpoints live in `windows-app/electron/urls.cjs`; both the native process and renderer use that same source of truth.

Google login flow: app opens your normal browser → compare the displayed verification code → approve Google sign-in → return to the app. The request expires in five minutes and is redeemable only by the requesting app's random verifier. Tokens and passwords are not put in URLs. The Render service must stay running during that short exchange; after a restart just try sign-in again.

## 5. Verify before sharing

1. Open `https://facetimeos.onrender.com/rtc/health`. Expect `status: "ok"`, `turn: true`, `storage: "firestore"`, `desktopAuth: true`. These are configuration indicators, not a successful Firebase write or TURN connectivity test.
2. Launch FaceTimeOS. Its home page should show **Meeting server connected** and **Firestore enabled**. If the browser health URL works but the desktop says unavailable, re-check `CLIENT_ORIGIN` includes `ftos://app` and redeploy Render.
3. Sign in with Google through the normal browser, or with an enabled email/password account. Google needs both the new Render endpoints and `/desktop-auth` deployed. Do not use a service-account credential as an end-user login.
4. Create a room; allow camera/mic when you choose. Invite a second device on another network (e.g. mobile hotspot), check both video/audio directions, then test Share screen → choose a specific window → Share selected → stop sharing.
5. Write a test message and whiteboard stroke. Leave all participants, wait for the flush, reopen the same room, and check they return. Check Firestore for the matching room ID and `savedAt`. For a stronger test, restart Render after saving and reopen again.
6. Test chat, people, tool minimize/restore, whiteboard undo/redo, code editor, and Export session. The code editor and its workers are packaged locally. Screen sharing currently sends **video plus your existing microphone**; system/desktop audio is not added by this release.

Only ordinary browser-supported languages run in the existing code widget. Bundling it as a desktop app does not silently add Python/Java runtimes or remove websites' iframe restrictions.

If camera/mic is unavailable: close another program holding the camera, and check Windows Settings → Privacy & security → Camera/Microphone → let desktop apps access the device. Users choose these permissions themselves.

## 6. Give the app to someone

Build output: **`windows-app/release/FaceTimeOS-Setup-2.0.0-x64.exe`**.

Send that installer, or upload it as an asset to a [GitHub Release](https://github.com/AlokGond/facetimeos/releases). Users download it, install for their Windows account, open FaceTimeOS from Start/Desktop, sign in, and paste a meeting link. They do not install Node/npm/Firebase tools, edit environment variables, or keep your computer on. Your hosted services must remain available.

This build targets **Windows 10/11 x64**. The new installer uses its own app ID/profile and does not replace the old desktop source or read its credentials. It supports `facetimeos://room/<room-id>?t=<invite-token>` deep links; normal copied invitations remain HTTPS web links and can be pasted into the app.

The local installer is **unsigned** unless you configure your own signing certificate. Windows may show an unknown-publisher/SmartScreen warning. Do not ask users to disable Defender or other protections. Professional warning-free distribution requires appropriate code signing/reputation or a store distribution process; a free build cannot promise that. Share a SHA-256 checksum with the installer. An existing install can be updated by running the newer installer; user data is preserved. The app's **Downloads & updates** link opens GitHub Releases. There is no silent auto-update/restart in this version.

## 7. Build future installers yourself

Developer machine only — Node 22.14+:

```powershell
cd C:\Users\Alok\OneDrive\Desktop\Project\facetimeos\client
npm ci
cd ..\windows-app
npm ci
npm test
npm run dist
npm run smoke
```

Keep public Firebase web config in `client/.env.local`. Increase `windows-app/package.json` → `version` before each release. Do not commit `release/` or any `.env` / private service-account JSON. Build artifacts are intentionally ignored by Git.

The **Windows installer** GitHub Actions workflow can also build an installer manually or on a `windows-v*` tag. Set the repository Actions **variables** named `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`, `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`, `NEXT_PUBLIC_FIREBASE_APP_ID`, and optionally `NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID` to the public web config. It uploads an artifact; it does not publish a release automatically or need your private Admin key. You can attach the built installer to a release once the live checklist passes.

## Free-tier limitations

Render free web services can sleep after inactivity and take about a minute to wake. Firestore and Metered also have usage limits; a Windows installer does not remove hosting/bandwidth costs. This setup is suitable for a small free pilot, not a promise of unlimited always-on conferencing. Monitor their dashboards and set budget alerts if you enable billing.

References: [Render free instances](https://render.com/docs/free), [Render secret files](https://render.com/docs/configure-environment-variables#secret-files), [Firestore rules and Admin access](https://firebase.google.com/docs/firestore/security/overview), [Firestore quotas](https://firebase.google.com/docs/firestore/quotas), [Firebase custom tokens](https://firebase.google.com/docs/auth/admin/create-custom-tokens), [Electron security](https://www.electronjs.org/docs/latest/tutorial/security).
