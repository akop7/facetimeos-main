import { useMemo, useSyncExternalStore } from 'react';
const subscribe = (cb) => { window.addEventListener('popstate', cb); return () => window.removeEventListener('popstate', cb); };
const snapshot = () => window.location.pathname + window.location.search;
const router = {
  push(path) {
    if (!/^\/(?!\/)/.test(path)) throw new Error('Invalid app route');
    window.history.pushState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  },
  replace(path) {
    if (!/^\/(?!\/)/.test(path)) throw new Error('Invalid app route');
    window.history.replaceState(null, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  },
  back: () => window.history.back(),
};
export function useRoute() { return useSyncExternalStore(subscribe, snapshot); }
export function useRouter() { return router; }
export function useParams() { const route = useRoute(); return useMemo(() => ({ roomId: route.split('?')[0].split('/')[2] }), [route]); }
export function useSearchParams() { const route = useRoute(); return useMemo(() => new URLSearchParams(route.split('?')[1]), [route]); }
