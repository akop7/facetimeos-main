/** @type {import('next').NextConfig} */

// Where the local signaling (socket.io) server is reachable FROM this Next
// server. Defaults to the local dev server on :3001. Override with
// SIGNALING_ORIGIN if the signaling server runs elsewhere.
const SIGNALING_ORIGIN = process.env.SIGNALING_ORIGIN || 'http://localhost:3001';

const nextConfig = {
  // Next.js 16 blocks cross-origin requests to its dev resources (/_next/*,
  // HMR, JS chunks) by default. When the app is opened from anything other
  // than localhost — a LAN IP or an HTTPS tunnel — those chunks fail to load
  // and the page renders BLANK. Whitelisting the hosts we develop against
  // fixes it. Wildcards are supported, so every trycloudflare quick-tunnel
  // (random subdomain each run) is covered without editing this each time.
  allowedDevOrigins: [
    '192.168.204.1',      // this machine's current LAN IP
    '*.trycloudflare.com', // cloudflared quick tunnels (any subdomain)
    '*.ngrok-free.app',    // ngrok, if you switch tunnels later
    '*.loca.lt',           // localtunnel, likewise
  ],

  // Proxy socket.io through the Next app so the whole thing lives behind a
  // SINGLE origin. That means one HTTPS tunnel (e.g. cloudflared) exposes both
  // the UI and signaling — no second tunnel, no CORS, and https/wss "just
  // work" so getUserMedia (camera/mic) is available on phones and other
  // devices. Non-localhost clients connect socket.io to their own origin (see
  // src/constants/ice-servers.js), and these rewrites forward it to :3001.
  async rewrites() {
    return [
      {
        source: '/socket.io/:path*',
        destination: `${SIGNALING_ORIGIN}/socket.io/:path*`,
      },
      // The REST surface (rooms, sessions, invites, ICE) lives under /rtc
      // rather than /api precisely so it cannot collide with Next's own
      // /api routes while being proxied through this single origin.
      {
        source: '/rtc/:path*',
        destination: `${SIGNALING_ORIGIN}/rtc/:path*`,
      },
    ];
  },
};

export default nextConfig;
