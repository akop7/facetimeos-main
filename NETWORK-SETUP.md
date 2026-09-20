# Testing FaceTimeOS across devices (phone, second laptop)

## Two separate reasons the page looks broken over the network

There are **two** independent issues when you leave `localhost`. Both are now
fixed in the repo, but it helps to know which is which:

### 1. Blank page → Next.js blocked its own JavaScript

Next.js 16 refuses to serve its dev resources (`/_next/hmr`,
`/_next/static/chunks/*`) to any origin other than `localhost` unless you
whitelist it. When it's blocked, **no JavaScript loads and the page is
completely blank** (this is what you were seeing on both the LAN IP and the
tunnel). You'll see this in the client terminal:

```
⚠ Blocked cross-origin request to Next.js dev resource /_next/... from "192.168.204.1".
  ... add it to "allowedDevOrigins" in next.config.js and restart the dev server
```

**Fixed** in `client/next.config.mjs` via `allowedDevOrigins`, which whitelists
the LAN IP and `*.trycloudflare.com` (plus ngrok/localtunnel). After changing
that file you **must restart `npm run dev`** — it's only read at startup.

### 2. No camera/mic → insecure context

Even once the page loads, opening the app at `http://192.168.x.x:3000` gives you
**no camera or mic**. That is **not** a Firebase problem — it's a browser
security rule:

- `http://localhost` is treated as a **secure context**.
- `http://192.168.x.x` (any plain-HTTP LAN IP) is treated as **insecure**.

In an insecure context the browser removes `navigator.mediaDevices` (camera +
mic) and restricts other startup APIs, so a WebRTC app can't run. Adding the IP
to Firebase Authorized Domains only fixes Google's sign-in domain check; it does
not make the origin secure.

The fix is to serve the app over **HTTPS**. The easiest way to get HTTPS that
works on phones (no certificate warnings) is a tunnel.

---

## Recommended: one HTTPS tunnel with cloudflared

The app now proxies signaling (`/socket.io`) through the Next server, so a
**single tunnel** exposes both the UI and the signaling server. No second
tunnel, no CORS setup, no editing config files.

### 1. Install cloudflared (one time)

Windows (PowerShell):

```powershell
winget install --id Cloudflare.cloudflared
```

(or download `cloudflared.exe` from Cloudflare and put it on your PATH)

### 2. Start the app (two terminals)

```bash
# Terminal 1 — signaling server (port 3001)
cd server
npm run dev
```

```bash
# Terminal 2 — web app (port 3000)
cd client
npm run dev
```

### 3. Start the tunnel (third terminal)

```bash
cloudflared tunnel --url http://localhost:3000
```

It prints a public URL like:

```
https://random-words-here.trycloudflare.com
```

### 4. Open that HTTPS URL on any device

Open the `https://….trycloudflare.com` link on your phone and/or another
laptop. Camera and mic now work, and refreshing keeps you as a single
participant. Create a room on one device, copy the room link, open it on the
other.

> **Sign-in note:** random `trycloudflare.com` subdomains change each run and
> Firebase can't wildcard them, so **Google sign-in popups will fail** on a
> tunnel. Use **email/password** sign-in for tunnel demos (it doesn't require an
> authorized domain). If you need Google sign-in, use a stable named tunnel or a
> real domain and add it under Firebase → Authentication → Settings → Authorized
> domains.

---

## Notes

- **Transport:** through a tunnel, socket.io signaling may run over HTTP
  long-polling instead of a raw WebSocket. That is fine — signaling is
  low-volume, and the actual audio/video/data flows peer-to-peer over WebRTC,
  not through the tunnel.
- **ngrok** works too: `ngrok http 3000` (needs a free account). Same idea.
- **Same machine only?** You don't need any of this — just use
  `http://localhost:3000`. Camera works because localhost is a secure context.

---

## Both devices connected but can't see each other ("1 participant" on each)

If the app loads on both devices, both show "Connected", but each shows only
**1 participant** and no remote video, the socket.io **signaling** connection
isn't completing through the tunnel.

Why: the single-tunnel setup proxies `/socket.io` through Next.js `rewrites()`.
Next.js rewrites forward plain HTTP but **do not proxy WebSocket upgrades**, so
socket.io's attempt to upgrade from long-polling to a WebSocket fails and can
drop the connection before either peer finishes joining the room.

Fix (already in the repo): the client pins socket.io to **polling only** when it
detects it's talking to its own origin (i.e. going through the rewrite) — see
`client/src/lib/signaling.js`. Polling is forwarded reliably by the rewrite, and
signaling is low-volume so there's no downside; the actual audio/video still
flows peer-to-peer over WebRTC.

To confirm it's working, open the browser console on each device. You should see
`[Signaling] connected to https://…trycloudflare.com via polling`. If instead
you see `[Signaling] connect_error …`, the polling proxy itself is failing — use
the **two-tunnel** setup below, which connects the client straight to the
signaling server (no rewrite in the way) and is guaranteed to work.

---

## Both devices joined, but video never arrives → you need a TURN relay

Different symptom from the one above: each device shows **2 participants**, chat
and the shared widgets work, but one or both video tiles stay black, and the
status pill's transport note says the connection is still checking or failed.

Signaling did its job here; the media path is what failed. STUN only tells each
peer its own public address — it works when at least one side can be reached
directly. Behind symmetric NAT, CGNAT (most mobile carriers), or a firewall that
blocks UDP (most corporate networks), no direct path exists and the media has to
be **relayed**. That is what a TURN server does, and it is the difference between
"works on my laptop" and "works for everyone" — roughly 8–15% of real-world peer
pairs need it.

Two devices on the same home Wi-Fi usually connect without one, which is why this
only shows up once you test across networks (phone on mobile data, or a laptop on
an office network).

### Option A: Metered.ca — hosted, free tier, nothing to run

1. Sign up at <https://www.metered.ca> and open the dashboard.
2. The **app name** on the home page forms your API host,
   `https://<appname>.metered.live`. Copy it.
3. Go to **TURN → Credentials**, create a credential, and copy its **API key**
   (the per-credential key, *not* the account secret key).
4. Put both in `server/.env`:

   ```
   METERED_APP_NAME=your-app-name
   METERED_API_KEY=your-credential-api-key
   ```

5. Restart the signaling server. The boot log should now read
   `[server] TURN relay: metered (default region)` instead of
   `NOT configured`.

The server fetches the credential list from Metered, caches it for ten minutes
(`METERED_CACHE_SECONDS`), and merges the relay entries into what `/rtc/ice`
hands the browser. The API key stays on the server, so rotating it is a restart
rather than a client deploy. `METERED_REGION` is a paid-plan feature — on the
free plan leave it unset and you get the shared `standard.relay.metered.ca` host.

If Metered is unreachable or the key is wrong, the server logs a warning and
serves a STUN-only list rather than failing the join: calls that would have
connected anyway still connect.

### Option B: any provider, static credentials

Works with Twilio, Cloudflare Calls, Metered's dashboard credentials, or a
coturn box configured with a fixed user:

```
TURN_URLS=turn:standard.relay.metered.ca:80,turn:standard.relay.metered.ca:443,turns:standard.relay.metered.ca:443?transport=tcp
TURN_USERNAME=...
TURN_PASSWORD=...
```

Include the port 443 and `turns:` entries. Port 443 over TLS is what gets
through firewalls that block everything else, because it is indistinguishable
from ordinary HTTPS.

### Option C: self-hosted coturn

Set `TURN_URLS` and `TURN_SECRET`, where `TURN_SECRET` equals coturn's
`static-auth-secret`. The server then mints a short-lived HMAC credential per
peer, so no long-lived password ever reaches a browser and a leaked one expires
on its own. `TURN_TTL_SECONDS` controls the lifetime (default 24h).

All three can be set at once — the list is merged and the browser uses whichever
answers first.

### Checking it worked

```bash
npm run turn:check --prefix server
```

That does the thing a browser would do, without a browser: it takes the relay
list the server would hand out and performs a real TURN allocation against each
URL, using the long-term credential mechanism. A healthy run looks like this:

```
configured: metered (default region)
stun: 2 server(s)

Allocating against 4 relay URL(s):

  ✓ turn:global.relay.metered.ca:80  (296ms)
      relayed address: 64.227.188.203:26905
      allocation lifetime: 600s (released)
  ...
4 of 4 relay URL(s) allocated successfully.
```

A relayed address means the relay is reachable from this network, the
credentials authenticate, and the provider is willing to allocate — which is the
whole media path short of actually sending video through it. Each allocation is
released immediately, so the check costs a handful of packets rather than quota.
The script exits non-zero when nothing allocates, so CI or a deploy hook can
gate on it.

`401` against every URL means the credentials are wrong or the dashboard
credential was revoked. A timeout on some URLs but not others is normal on a
restricted network and is exactly why several ports are offered.

The lighter check, if you only want to know whether the server *has* credentials:

```bash
curl -s http://localhost:3001/rtc/ice
```

`hasTurn` must be `true`, with `turn:`/`turns:` entries carrying a `username`
and `credential`. Note that this proves nothing about reachability — that is what
the allocation check above is for.

During a real call, Chrome's `chrome://webrtc-internals` shows the selected
candidate pair; a pair of type `relay` means media is going through TURN.

---

## Advanced: two tunnels (native WebSocket)

Only needed if you specifically want a raw WebSocket for signaling.

1. Tunnel the signaling server:
   `cloudflared tunnel --url http://localhost:3001` → copy its `https://…` URL.
2. Create `client/.env.local`:
   ```
   NEXT_PUBLIC_SIGNALING_URL=https://your-server-tunnel.trycloudflare.com
   ```
3. Restart `npm run dev` in `client` (env vars are read at startup).
4. Tunnel the client too: `cloudflared tunnel --url http://localhost:3000`, and
   open that URL on your devices.

The server already accepts any origin in dev. To lock it down in production,
set `CLIENT_ORIGIN` on the server to a comma-separated list of allowed origins.
