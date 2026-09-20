# FaceTimeOS on Windows

A real application window — Start-menu entry, taskbar icon, its own process — around
the same web app. Not a second implementation: the window is Chromium, so the call,
the camera, the screen share and the tools inside the room are the code that already
works in the browser. What the shell adds is the three things a web page cannot do
for itself on Windows.

**Sign-in leaves the app on purpose.** Google refuses OAuth inside embedded browsers
(`disallowed_useragent`), so a popup here would load an error page and stop. Clicking
*Continue with Google* opens your normal browser, you sign in where your passwords and
2FA already are, and the shell catches the redirect on `127.0.0.1` and passes the
resulting ID token back into the window. Same account, same uid as on the web.

---

## Run it from source

```bash
cd desktop && npm install && npm start
```

First launch asks for one thing: **the URL of your deployment** — e.g.
`https://facetimeos.vercel.app`, or `http://localhost:3000` while you are developing.
Nothing is hardcoded, so the same installer works against any deployment. Change it
later under **File → Change server URL**.

For a dev loop, skip the screen entirely:

```bash
FACETIMEOS_APP_URL=http://localhost:3000 npm start --prefix desktop
```

## Build the installer

```bash
npm run dist --prefix desktop
```

Output lands in `desktop/dist/`:

- `FaceTimeOS Setup 1.0.0.exe` — the installer to keep or hand to someone else. It
  lets you choose the install directory and creates desktop and Start-menu shortcuts.
- `win-unpacked/FaceTimeOS.exe` — the app without installing anything, useful for a
  quick check.

`npm run pack --prefix desktop` builds only `win-unpacked`, which is faster when you
are iterating on the shell itself.

**Windows will warn about it.** The build is not code-signed, so SmartScreen shows
"Windows protected your PC" → *More info* → *Run anyway*. Signing needs a certificate
from a CA (roughly $100–400/year); nothing in the code changes if you buy one, you
just add `win.certificateFile` and `win.certificatePassword` to the `build` block in
`desktop/package.json`.

## Google sign-in inside the app

Optional. Without it, everything except the Google button works; email/password
sign-in is unaffected. To turn it on you need an OAuth client of a different type
than the web app uses, because the flow is different.

1. Open [Google Cloud console → Credentials](https://console.cloud.google.com/apis/credentials)
   and pick the same project as your Firebase app.
2. **Create credentials → OAuth client ID**, application type **Desktop app**. Name it
   something like "FaceTimeOS desktop".
3. Copy the **client ID** and **client secret**. No redirect URI to register: Google
   matches loopback addresses and ignores the port, which is why the shell can use a
   free one each time.
4. In the app: **File → Change server URL → Google sign-in (optional)**, paste both,
   save. They are stored in `%APPDATA%\FaceTimeOS\settings.json` on your machine and
   are never handed to the page.
5. In [Firebase console → Authentication → Sign-in method](https://console.firebase.google.com/),
   make sure **Google** is enabled — the ID token is verified against that project.

The secret is not a secret in the usual sense here, and Google says so: for installed
apps it cannot be kept confidential. PKCE is what actually secures the exchange — the
verifier never leaves the process, so an intercepted authorization code is useless.

## What the shell allows, and what it refuses

- **Camera, microphone and screen capture** are granted to the configured origin and
  to nothing else. A page on any other origin gets a denial, including for
  `navigator.permissions.query`.
- **Screen sharing** uses the Windows 11 native picker.
- **Navigation stays inside the app.** Any link to another origin opens in your
  browser instead of turning this window into a general-purpose one, and nothing can
  open a second window.
- **The renderer is sandboxed**, with `contextIsolation` on and Node disabled. The
  page sees exactly two bridges (`facetimeosDesktop`, `facetimeosShell`), and the main
  process re-checks the sender's URL on every call — so the sign-in bridge is
  unavailable to the setup page and vice versa.
- **One instance.** Launching it again focuses the call you are already in rather than
  starting a second process to fight over the camera.

## Environment variables

Useful for development; they override the saved settings.

| Variable | Effect |
| --- | --- |
| `FACETIMEOS_APP_URL` | Where to point. Skips the setup screen. |
| `FACETIMEOS_GOOGLE_CLIENT_ID` | Desktop-app OAuth client ID. |
| `FACETIMEOS_GOOGLE_CLIENT_SECRET` | Its secret. |
| `FACETIMEOS_SMOKE=1` | Load, print what happened, exit. Used by `npm run smoke`. |

## Checks

```bash
npm test --prefix desktop && npm run smoke --prefix desktop
```

`npm test` covers the settings layering and the whole OAuth flow against a stubbed
token endpoint — no browser, no display, no Google account. `npm run smoke` launches
the real Electron app three times: unconfigured (it must show the setup screen),
against a local stub server (it must navigate there), and against a dead port (it must
fall back to the error page), checking that the preload bridges arrived each time.

## Troubleshooting

**"Can't reach FaceTimeOS"** — the window could not load your URL. The page shows the
address it tried and Chromium's reason, with *Try again* and *Change server URL*.

**Camera works in Chrome but not here** — check that the URL in the shell is the exact
origin your app is served from; permissions are scoped to it. Windows' own privacy
switch matters too: *Settings → Privacy & security → Camera → Let desktop apps access
your camera*.

**The Google button says no client is configured** — the client ID is missing or was
saved as a *Web application* client. It must be **Desktop app**.

**Sign-in opens the browser and nothing comes back** — the loopback redirect was
blocked. Allow `FaceTimeOS.exe` through the Windows firewall on private networks; it
only ever listens on `127.0.0.1`, and only while a sign-in is in progress.
