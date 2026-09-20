import React, { lazy, Suspense } from 'react';
export default function dynamic(load) {
  const Component = lazy(async () => { await import('./monaco.js'); return load(); });
  return function LazyComponent(props) {
    return <Suspense fallback={<p className="p-4">Opening editor…</p>}><Component {...props} /></Suspense>;
  };
}
