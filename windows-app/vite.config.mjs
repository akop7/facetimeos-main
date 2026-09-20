import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { transform } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import urls from './electron/urls.cjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const client = path.resolve(here, '../client');
const publicKeys = ['API_KEY', 'AUTH_DOMAIN', 'PROJECT_ID', 'STORAGE_BUCKET', 'MESSAGING_SENDER_ID', 'APP_ID', 'MEASUREMENT_ID'];

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, client, 'NEXT_PUBLIC_'), ...process.env };
  const define = {
    'process.env.NEXT_PUBLIC_SIGNALING_URL': JSON.stringify(urls.API_URL),
    'process.env.NEXT_PUBLIC_WEB_URL': JSON.stringify(urls.WEB_URL),
    'process.env.NEXT_PUBLIC_STUN_URLS': JSON.stringify(''),
  };
  for (const key of publicKeys) define[`process.env.NEXT_PUBLIC_FIREBASE_${key}`] = JSON.stringify(env[`NEXT_PUBLIC_FIREBASE_${key}`] || '');
  if (!env.NEXT_PUBLIC_FIREBASE_API_KEY || !env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) {
    throw new Error('Set the public Firebase web config in client/.env.local before building the installer.');
  }
  return {
    base: '/',
    define,
    plugins: [{
      name: 'shared-client-jsx', enforce: 'pre',
      async transform(code, id) {
        if (id.replaceAll('\\', '/').includes('/client/src/') && /\.js$/.test(id)) {
          return transform(code, { loader: 'jsx', jsx: 'automatic', sourcemap: true, sourcefile: id });
        }
      },
    }, react(), tailwindcss()],
    resolve: {
      alias: [
        { find: 'next/navigation', replacement: path.resolve(here, 'src/navigation.jsx') },
        { find: 'next/dynamic', replacement: path.resolve(here, 'src/dynamic.jsx') },
        ...['react', 'react-dom', 'firebase', 'yjs', 'y-protocols', 'monaco-editor', '@monaco-editor/react', 'react-rnd', 'socket.io-client', 'tailwindcss'].map(name => ({
          find: new RegExp(`^${name.replace('/', '\\/')}(?=/|$)`), replacement: path.join(client, 'node_modules', name),
        })),
      ],
      dedupe: ['react', 'react-dom', 'yjs'],
    },
    build: { target: 'chrome144', sourcemap: false, chunkSizeWarningLimit: 1800, commonjsOptions: { include: [/node_modules/, /electron\/urls\.cjs$/] } },
  };
});
