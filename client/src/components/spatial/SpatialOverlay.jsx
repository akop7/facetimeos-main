'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The layer the widget windows live on.
 *
 * Two fixes: the effect no longer sets state synchronously (a `ResizeObserver`
 * fires once for the initial size the moment you call `observe`, so the manual
 * `clientWidth` read was both redundant and a cascading render), and the size is
 * handed to a render prop instead of injected with `cloneElement` — cloning
 * every child to add a prop breaks the moment a caller wraps a window in a
 * fragment or a `.map`, which is exactly what the room page does.
 */
export default function SpatialOverlay({ children, className = '' }) {
  const containerRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const measure = useCallback((entry) => {
    const { width, height } = entry.contentRect;
    setSize((prev) =>
      // 1px hysteresis: sub-pixel layout jitter should not re-render the whole
      // workspace, and every window re-derives its geometry from this.
      Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1
        ? prev
        : { width, height }
    );
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) measure(entry);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 z-10 overflow-visible ${className}`}
      style={{ pointerEvents: 'none' }}
    >
      {size.width > 0 && (typeof children === 'function' ? children(size) : children)}
    </div>
  );
}
