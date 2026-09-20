'use client';

import React, { useCallback, useRef, useState } from 'react';
import { Rnd } from 'react-rnd';
import WindowToolbar from './WindowToolbar';
import { widgetMeta } from '../../constants/channel-config';

/**
 * One draggable widget window.
 *
 * Two changes from the previous version:
 *  - titles and icons come from the shared widget catalogue, so WEB_BROWSER and
 *    MEETING_TIMER are no longer unnamed windows with a generic icon;
 *  - stacking order is shared rather than a local counter, so "the window I
 *    clicked" is on top for everyone, not just for me.
 *
 * Geometry is still committed on drag/resize *stop*, not per frame. That is
 * deliberate: the position lives in the CRDT, and writing it 60 times a second
 * would push a document update per frame to every peer.
 */
export default function SpatialWindow({
  id,
  type,
  position = { x: 0.2, y: 0.2, w: 0.4, h: 0.5 },
  containerSize = { width: 0, height: 0 },
  isMinimized,
  z = 1,
  readOnly = false,
  ownerLabel,
  onMove,
  onResize,
  onClose,
  onMinimize,
  onFocus,
  children,
}) {
  const [isActive, setIsActive] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const preMaxRef = useRef(null);

  const meta = widgetMeta(type);

  /**
   * The floor on window size used to be a flat 320×220. On a phone the room
   * container is around 360×640, so a window opened at 40% width was snapped up
   * to 320px — nearly the whole screen — and then could not be resized down,
   * while `bounds="parent"` let it be dragged until only a sliver showed. Clamp
   * the floor to the container: on a narrow screen a widget takes the width it
   * has, and on a desktop nothing changes.
   */
  const minWidth = Math.min(320, Math.max(160, containerSize.width || 320));
  const minHeight = Math.min(220, Math.max(140, containerSize.height || 220));

  const pixelCoords = isMaximized
    ? { x: 0, y: 0, width: containerSize.width, height: containerSize.height }
    : {
        x: position.x * containerSize.width,
        y: position.y * containerSize.height,
        width: Math.max(minWidth, position.w * containerSize.width),
        height: Math.max(minHeight, position.h * containerSize.height),
      };

  const handleDragStop = (event, d) => {
    if (isMaximized || !containerSize.width) return;
    onMove?.({ x: d.x / containerSize.width, y: d.y / containerSize.height });
  };

  const handleResizeStop = (event, direction, ref, delta, pos) => {
    if (isMaximized || !containerSize.width) return;
    onResize?.({
      x: pos.x / containerSize.width,
      y: pos.y / containerSize.height,
      w: ref.offsetWidth / containerSize.width,
      h: ref.offsetHeight / containerSize.height,
    });
  };

  const bringToFront = useCallback(() => {
    setIsActive(true);
    onFocus?.(id);
  }, [id, onFocus]);

  const toggleMaximize = useCallback(() => {
    if (isMaximized) {
      if (preMaxRef.current) onMove?.(preMaxRef.current);
      setIsMaximized(false);
      return;
    }
    preMaxRef.current = { ...position };
    setIsMaximized(true);
  }, [isMaximized, position, onMove]);

  const minimize = useCallback(() => {
    // A restored window should return to its normal geometry, not unexpectedly
    // cover the whole workspace because it was minimized while maximized.
    if (isMaximized) setIsMaximized(false);
    onMinimize?.(id);
  }, [id, isMaximized, onMinimize]);

  if (isMinimized) return null;

  return (
    <Rnd
      size={{ width: pixelCoords.width, height: pixelCoords.height }}
      position={{ x: pixelCoords.x, y: pixelCoords.y }}
      onDragStart={bringToFront}
      onDragStop={handleDragStop}
      onResizeStop={handleResizeStop}
      minWidth={minWidth}
      minHeight={minHeight}
      bounds="parent"
      dragHandleClassName="window-drag-handle"
      className="pointer-events-auto"
      onMouseDown={bringToFront}
      style={{ zIndex: 10 + z + (isActive ? 100 : 0) }}
      disableDragging={isMaximized}
      enableResizing={!isMaximized}
      resizeHandleStyles={{
        bottom: { cursor: 'ns-resize', height: '8px' },
        right: { cursor: 'ew-resize', width: '8px' },
        bottomRight: { cursor: 'nwse-resize', width: '14px', height: '14px' },
        top: { cursor: 'ns-resize', height: '8px' },
        left: { cursor: 'ew-resize', width: '8px' },
        topLeft: { cursor: 'nwse-resize', width: '14px', height: '14px' },
        topRight: { cursor: 'nesw-resize', width: '14px', height: '14px' },
        bottomLeft: { cursor: 'nesw-resize', width: '14px', height: '14px' },
      }}
    >
      <div
        /* `ftos-panel` rather than `bg-[var(--bg-glass)]`: a floating window over
           live video needs an opaque fill, and the 4% glass token gave it none. */
        className={`ftos-panel flex h-full w-full flex-col overflow-hidden rounded-lg border transition-shadow duration-200 ${
          isActive
            ? 'border-blue-500/60 shadow-[0_18px_50px_rgba(0,0,0,0.28)]'
            : 'border-[var(--surface-border)]'
        }`}
      >
        <WindowToolbar
          title={meta.title}
          type={type}
          icon={meta.icon}
          badge={readOnly ? 'View only' : ownerLabel}
          onClose={() => onClose?.(id)}
          onMinimize={minimize}
          onMaximize={toggleMaximize}
          isMaximized={isMaximized}
        />
        <div className="flex-1 overflow-hidden min-h-0 bg-[var(--surface-panel)]">{children}</div>
      </div>
    </Rnd>
  );
}
