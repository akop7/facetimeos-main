'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useYArray } from '../../hooks/useYjs';
import { getAwarenessColor } from '../../lib/crdt';

/**
 * Shared whiteboard.
 *
 * Fixed here, all of it live in production before:
 *  - the `text` tool wrote a stroke that the renderer had no branch for, so text
 *    was accepted, stored, synced… and never drawn, on anyone's screen;
 *  - the eraser painted a hardcoded `#1a1a2e` rectangle, which is only invisible
 *    if you happen to be in dark mode with that exact background — in light mode
 *    it drew navy smears. It now composites with `destination-out`, which is
 *    what erasing actually is;
 *  - mouse events only, on a container marked `touch-none`, so the board was
 *    unusable on the phones this app is mostly demoed on. Pointer events cover
 *    mouse, touch and pen with one path;
 *  - undo removed the last stroke *globally*, so your Ctrl-Z deleted whatever a
 *    colleague had just drawn. Strokes now carry their author and undo only
 *    reaches your own;
 *  - the root element carried `bg-[#1a1a2e] dark:bg-[#1a1a2e] bg-white`, three
 *    competing background classes;
 *  - cursors were broadcast as raw `clientX/clientY`, which mean nothing on a
 *    peer with a different window size. They are normalised and carried on
 *    awareness now, so they disappear on their own when someone leaves.
 */

const TOOLS = [
  { id: 'pen', label: 'Pen', glyph: '✏️' },
  { id: 'line', label: 'Line', glyph: '╱' },
  { id: 'rectangle', label: 'Rectangle', glyph: '▭' },
  { id: 'circle', label: 'Ellipse', glyph: '◯' },
  { id: 'text', label: 'Text', glyph: 'T' },
  { id: 'eraser', label: 'Eraser', glyph: '🧽' },
];

const COLORS = ['#6366f1', '#ef4444', '#22c55e', '#eab308', '#f97316', '#ec4899', '#111827', '#ffffff'];
const WIDTHS = [2, 5, 12];
const SHAPES = new Set(['line', 'rectangle', 'circle']);

/**
 * Draw one stroke. Coordinates are stored normalised (0..1) so a board drawn on
 * a 4K monitor still lines up on a phone; `w`/`h` are the CSS pixel size of the
 * target canvas.
 */
function drawStroke(ctx, stroke, w, h) {
  const points = stroke?.points;
  if (!points?.length) return;

  const x = (n) => n * w;
  const y = (n) => n * h;
  const erasing = stroke.tool === 'eraser';

  ctx.save();
  // Erasing is a composite operation, not a colour. Painting the background
  // colour only works until the background changes.
  ctx.globalCompositeOperation = erasing && !stroke.preview ? 'destination-out' : 'source-over';
  ctx.strokeStyle = erasing ? 'rgba(0,0,0,1)' : stroke.color || '#6366f1';
  ctx.fillStyle = ctx.strokeStyle;
  if (erasing && stroke.preview) {
    ctx.strokeStyle = 'rgba(148,163,184,0.55)';
  }
  ctx.lineWidth = (stroke.width || 2) * (erasing ? 4 : 1);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const first = points[0];
  const last = points[points.length - 1];

  if (stroke.tool === 'text') {
    const size = Math.max(13, (stroke.width || 2) * 7);
    ctx.font = `${size}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(stroke.text || '', x(first.x), y(first.y));
    ctx.restore();
    return;
  }

  ctx.beginPath();
  if (stroke.tool === 'rectangle') {
    ctx.rect(x(first.x), y(first.y), x(last.x) - x(first.x), y(last.y) - y(first.y));
  } else if (stroke.tool === 'circle') {
    const cx = (x(first.x) + x(last.x)) / 2;
    const cy = (y(first.y) + y(last.y)) / 2;
    ctx.ellipse(
      cx,
      cy,
      Math.abs(x(last.x) - x(first.x)) / 2,
      Math.abs(y(last.y) - y(first.y)) / 2,
      0,
      0,
      Math.PI * 2
    );
  } else if (stroke.tool === 'line') {
    ctx.moveTo(x(first.x), y(first.y));
    ctx.lineTo(x(last.x), y(last.y));
  } else {
    ctx.moveTo(x(first.x), y(first.y));
    if (points.length === 1) ctx.lineTo(x(first.x) + 0.01, y(first.y));
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(x(points[i].x), y(points[i].y));
  }
  ctx.stroke();
  ctx.restore();
}

/** Size a canvas for the device pixel ratio and hand back a CSS-pixel context. */
function prepare(canvas, width, height) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export default function Whiteboard({
  sharedWhiteboard,
  awareness,
  peerId,
  displayName,
  readOnly = false,
  onActivity,
}) {
  const containerRef = useRef(null);
  const boardRef = useRef(null);
  const liveRef = useRef(null);
  const drawingRef = useRef(null);
  const lastCursorSentRef = useRef(0);
  const redoStackRef = useRef([]);

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [tool, setTool] = useState('pen');
  const [color, setColor] = useState('#6366f1');
  const [width, setWidth] = useState(2);
  const [draft, setDraft] = useState(null); // inline text entry
  const [cursors, setCursors] = useState([]);
  const [redoCount, setRedoCount] = useState(0);

  const strokes = useYArray(sharedWhiteboard);

  const mine = useMemo(
    () => (peerId ? strokes.filter((stroke) => stroke?.by === peerId).length : strokes.length),
    [strokes, peerId]
  );

  /* ------------------------------- sizing -------------------------------- */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    // ResizeObserver fires once on observe(), so the first measurement arrives
    // through the same path as every later one — no synchronous setState here.
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      setSize((prev) =>
        Math.abs(prev.width - box.width) < 1 && Math.abs(prev.height - box.height) < 1
          ? prev
          : { width: box.width, height: box.height }
      );
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  /* ---------------------------- committed layer -------------------------- */
  useEffect(() => {
    const canvas = boardRef.current;
    if (!canvas || !size.width || !size.height) return;
    const ctx = prepare(canvas, size.width, size.height);
    ctx.clearRect(0, 0, size.width, size.height);
    for (const stroke of strokes) drawStroke(ctx, stroke, size.width, size.height);
  }, [strokes, size]);

  /* ------------------------------- cursors -------------------------------- */
  useEffect(() => {
    if (!awareness) return undefined;

    const read = () => {
      const next = [];
      awareness.getStates().forEach((state, clientId) => {
        if (!state) return;
        const id = state.peerId || String(clientId);
        if (peerId && id === peerId) return;
        const cursor = state.cursor;
        if (!cursor || cursor.widget !== 'whiteboard') return;
        if (typeof cursor.x !== 'number' || typeof cursor.y !== 'number') return;
        next.push({
          id,
          name: state.name || 'Guest',
          color: state.color || getAwarenessColor(id),
          x: cursor.x,
          y: cursor.y,
          drawing: Boolean(cursor.drawing),
        });
      });
      setCursors(next);
    };

    read();
    awareness.on('change', read);
    return () => awareness.off('change', read);
  }, [awareness, peerId]);

  const publishCursor = useCallback(
    (point, drawing) => {
      if (!awareness) return;
      const now = Date.now();
      // ~25 Hz. Awareness is broadcast to every peer, and a pointer can fire far
      // faster than anyone can perceive.
      if (point && now - lastCursorSentRef.current < 40) return;
      lastCursorSentRef.current = now;
      awareness.setLocalStateField(
        'cursor',
        point ? { widget: 'whiteboard', x: point.x, y: point.y, drawing, at: now } : null
      );
    },
    [awareness]
  );

  const positionOf = useCallback((event) => {
    const canvas = liveRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  }, []);

  const commit = useCallback(
    (stroke) => {
      if (!sharedWhiteboard || readOnly) return;
      sharedWhiteboard.push([
        { ...stroke, by: peerId || null, byName: displayName || null, at: Date.now() },
      ]);
      // A new drawing starts a new history branch, so previously undone work
      // should no longer be offered as redo.
      redoStackRef.current = [];
      setRedoCount(0);
      onActivity?.();
    },
    [sharedWhiteboard, readOnly, peerId, displayName, onActivity]
  );

  const clearLive = useCallback(() => {
    const canvas = liveRef.current;
    if (!canvas || !size.width) return;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }, [size.width]);

  // The live layer is only ever transient, but it still has to match the device
  // pixel ratio or in-progress strokes look half-resolution.
  useEffect(() => {
    const canvas = liveRef.current;
    if (!canvas || !size.width || !size.height) return;
    prepare(canvas, size.width, size.height);
  }, [size]);

  const paintLive = useCallback(
    (stroke) => {
      const canvas = liveRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawStroke(ctx, { ...stroke, preview: true }, size.width, size.height);
    },
    [size]
  );

  const handlePointerDown = useCallback(
    (event) => {
      const point = positionOf(event);
      if (!point) return;
      publishCursor(point, false);
      if (readOnly) return;

      if (tool === 'text') {
        setDraft({ x: point.x, y: point.y, value: '' });
        return;
      }

      event.currentTarget.setPointerCapture?.(event.pointerId);
      drawingRef.current = { tool, color, width, points: [point], pointerId: event.pointerId };
      paintLive(drawingRef.current);
    },
    [positionOf, publishCursor, readOnly, tool, color, width, paintLive]
  );

  const handlePointerMove = useCallback(
    (event) => {
      const point = positionOf(event);
      if (!point) return;
      const active = drawingRef.current;
      publishCursor(point, Boolean(active));
      if (!active) return;

      if (SHAPES.has(active.tool)) {
        // A shape only ever needs its two corners; keeping every intermediate
        // point would store a rectangle as a thousand-point path.
        active.points = [active.points[0], point];
      } else {
        const previous = active.points[active.points.length - 1];
        const far =
          Math.abs(point.x - previous.x) > 0.0015 || Math.abs(point.y - previous.y) > 0.0015;
        if (!far) return;
        active.points.push(point);
      }
      paintLive(active);
    },
    [positionOf, publishCursor, paintLive]
  );

  const finishStroke = useCallback(() => {
    const active = drawingRef.current;
    drawingRef.current = null;
    clearLive();
    if (!active) return;
    if (SHAPES.has(active.tool) && active.points.length < 2) return;
    commit({
      tool: active.tool,
      points: active.points,
      color: active.color,
      width: active.width,
    });
  }, [clearLive, commit]);

  const handlePointerUp = useCallback(
    (event) => {
      const point = positionOf(event);
      finishStroke();
      publishCursor(point, false);
    },
    [positionOf, finishStroke, publishCursor]
  );

  const handlePointerLeave = useCallback(() => {
    finishStroke();
    // Drop my cursor rather than leaving it frozen at the edge of everyone
    // else's board.
    if (awareness) awareness.setLocalStateField('cursor', null);
  }, [finishStroke, awareness]);

  const commitDraft = useCallback(() => {
    const text = draft?.value?.trim();
    if (text) {
      commit({ tool: 'text', text, points: [{ x: draft.x, y: draft.y }], color, width });
    }
    setDraft(null);
  }, [draft, commit, color, width]);

  const undo = useCallback(() => {
    if (!sharedWhiteboard || readOnly) return;
    for (let i = sharedWhiteboard.length - 1; i >= 0; i -= 1) {
      const stroke = sharedWhiteboard.get(i);
      // Only ever my own work: a shared undo stack means your Ctrl-Z deletes
      // whatever your colleague just finished drawing.
      if (!peerId || stroke?.by === peerId) {
        sharedWhiteboard.delete(i, 1);
        redoStackRef.current.push(stroke);
        setRedoCount(redoStackRef.current.length);
        onActivity?.();
        return;
      }
    }
  }, [sharedWhiteboard, readOnly, peerId, onActivity]);

  const redo = useCallback(() => {
    if (!sharedWhiteboard || readOnly) return;
    const stroke = redoStackRef.current.pop();
    if (!stroke) return;
    // Re-appending is intentional: it keeps the restored stroke above anything
    // collaborators drew while it was undone, without rewriting their history.
    sharedWhiteboard.push([stroke]);
    setRedoCount(redoStackRef.current.length);
    onActivity?.();
  }, [sharedWhiteboard, readOnly, onActivity]);

  const clearBoard = useCallback(() => {
    if (!sharedWhiteboard || readOnly) return;
    if (!window.confirm('Clear the whiteboard for everyone in this room?')) return;
    sharedWhiteboard.delete(0, sharedWhiteboard.length);
    redoStackRef.current = [];
    setRedoCount(0);
    onActivity?.();
  }, [sharedWhiteboard, readOnly, onActivity]);

  /** Flatten the board to a PNG. Part of what makes a room's work take-away. */
  const exportPng = useCallback(() => {
    if (!size.width || !size.height) return;
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(size.width * scale);
    canvas.height = Math.round(size.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size.width, size.height);
    for (const stroke of strokes) drawStroke(ctx, stroke, size.width, size.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `facetimeos-whiteboard-${new Date().toISOString().slice(0, 10)}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }, [size, strokes]);

  const disabled = readOnly || !sharedWhiteboard;

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-white dark:bg-[#0f1424]">
      <div className="flex items-center gap-2 p-2 bg-stone-100 dark:bg-black/40 border-b border-stone-200 dark:border-white/10 overflow-x-auto shrink-0">
        <div className="flex gap-1 pr-2 border-r border-stone-300 dark:border-white/10">
          {TOOLS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setTool(entry.id)}
              disabled={disabled}
              title={entry.label}
              aria-pressed={tool === entry.id}
              className={`w-8 h-8 grid place-items-center rounded text-sm transition-colors disabled:opacity-40 ${
                tool === entry.id
                  ? 'bg-indigo-500 text-white'
                  : 'hover:bg-stone-200 dark:hover:bg-white/10 text-stone-700 dark:text-white/80'
              }`}
            >
              {entry.glyph}
            </button>
          ))}
        </div>

        <div className="flex gap-1 pr-2 border-r border-stone-300 dark:border-white/10">
          <button
            type="button"
            onClick={undo}
            disabled={disabled || mine === 0}
            title="Undo your last change"
            className="flex h-8 items-center gap-1.5 rounded px-2 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-200 disabled:opacity-40 dark:text-white/80 dark:hover:bg-white/10"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 7 4 12l5 5"/><path d="M4 12h9a7 7 0 0 1 7 7"/>
            </svg>
            Undo
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={disabled || redoCount === 0}
            title="Redo your last undone change"
            className="flex h-8 items-center gap-1.5 rounded px-2 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-200 disabled:opacity-40 dark:text-white/80 dark:hover:bg-white/10"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m15 7 5 5-5 5"/><path d="M20 12h-9a7 7 0 0 0-7 7"/>
            </svg>
            Redo
          </button>
        </div>

        <div className="flex gap-1 pr-2 border-r border-stone-300 dark:border-white/10">
          {COLORS.map((entry) => (
            <button
              key={entry}
              type="button"
              onClick={() => setColor(entry)}
              disabled={disabled}
              aria-label={`Colour ${entry}`}
              aria-pressed={color === entry}
              className={`w-5 h-5 rounded-full shrink-0 border transition-transform disabled:opacity-40 ${
                color === entry
                  ? 'ring-2 ring-offset-1 ring-indigo-500 ring-offset-stone-100 dark:ring-offset-black scale-110 border-transparent'
                  : 'border-stone-300 dark:border-white/20'
              }`}
              style={{ backgroundColor: entry }}
            />
          ))}
        </div>

        <div className="flex gap-1 pr-2 border-r border-stone-300 dark:border-white/10">
          {WIDTHS.map((entry) => (
            <button
              key={entry}
              type="button"
              onClick={() => setWidth(entry)}
              disabled={disabled}
              aria-label={`${entry} pixel stroke`}
              aria-pressed={width === entry}
              className={`w-7 h-7 grid place-items-center rounded disabled:opacity-40 ${
                width === entry ? 'bg-stone-300 dark:bg-white/20' : 'hover:bg-stone-200 dark:hover:bg-white/10'
              }`}
            >
              <span
                className="bg-stone-800 dark:bg-white rounded-full block"
                style={{ width: entry + 2, height: entry + 2 }}
              />
            </button>
          ))}
        </div>

        <div className="flex gap-1 items-center ml-auto shrink-0">
          <span className="hidden md:inline text-[10px] text-stone-500 dark:text-white/35 tabular-nums px-1">
            {strokes.length} strokes{peerId ? ` · ${mine} yours` : ''}
          </span>
          <button
            type="button"
            onClick={exportPng}
            className="px-2.5 py-1 rounded text-xs bg-stone-200 dark:bg-white/10 hover:bg-stone-300 dark:hover:bg-white/20 text-stone-700 dark:text-white"
          >
            PNG
          </button>
          <button
            type="button"
            onClick={clearBoard}
            disabled={disabled || strokes.length === 0}
            className="px-2.5 py-1 rounded text-xs bg-red-100 dark:bg-red-500/20 hover:bg-red-200 dark:hover:bg-red-500/40 text-red-700 dark:text-red-300 disabled:opacity-40"
          >
            Clear
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 relative min-h-0 touch-none overflow-hidden"
        style={{
          backgroundImage:
            'radial-gradient(currentColor 1px, transparent 1px)',
          backgroundSize: '22px 22px',
          color: 'rgba(120,130,150,0.22)',
        }}
      >
        <canvas ref={boardRef} className="absolute inset-0 pointer-events-none" />
        <canvas
          ref={liveRef}
          className={`absolute inset-0 touch-none ${
            readOnly ? 'cursor-not-allowed' : tool === 'text' ? 'cursor-text' : 'cursor-crosshair'
          }`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={handlePointerLeave}
        />

        {cursors.map((cursor) => (
          <div
            key={cursor.id}
            className="absolute pointer-events-none transition-transform duration-75 will-change-transform"
            style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%` }}
          >
            <div
              className="w-2.5 h-2.5 rounded-full border border-white/70"
              style={{ background: cursor.color, opacity: cursor.drawing ? 1 : 0.6 }}
            />
            <span
              className="absolute left-3.5 top-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium text-white shadow"
              style={{ background: cursor.color }}
            >
              {cursor.name}
            </span>
          </div>
        ))}

        {draft && (
          <input
            autoFocus
            value={draft.value}
            onChange={(event) => setDraft((prev) => ({ ...prev, value: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitDraft();
              if (event.key === 'Escape') setDraft(null);
            }}
            onBlur={commitDraft}
            placeholder="Type, then Enter"
            className="absolute z-10 bg-white/95 dark:bg-black/80 border border-indigo-500 rounded px-1.5 py-0.5 text-sm outline-none text-stone-900 dark:text-white"
            style={{
              left: `${draft.x * 100}%`,
              top: `${draft.y * 100}%`,
              color,
              maxWidth: '60%',
            }}
          />
        )}

        {readOnly && (
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 px-2.5 py-1 rounded-full bg-black/60 text-[11px] text-white/70">
            View only — ask the host for edit access
          </div>
        )}
      </div>
    </div>
  );
}
