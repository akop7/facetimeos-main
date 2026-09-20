/** @type {import('next').NextConfig} */

const nextConfig = {
  output: 'export',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },

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
};

export default nextConfig;
