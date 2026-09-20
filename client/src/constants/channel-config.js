/**
 * Widget catalogue for the spatial workspace.
 *
 * The old file also exported `FAST_CHANNEL_CONFIG` / `SYNC_CHANNEL_CONFIG`,
 * which nothing read any more — data channel setup now lives in `lib/webrtc.js`
 * as `CHANNELS`, negotiated with fixed ids on both sides so there is no
 * `ondatachannel` race.
 *
 * `WINDOW_TYPES` was missing WEB_BROWSER and MEETING_TIMER even though both
 * widgets existed and were spawned by the call controls, so every lookup keyed
 * off this map (titles, icons) silently fell through to a default.
 */

export const WINDOW_TYPES = Object.freeze({
  CODE_EDITOR: 'CODE_EDITOR',
  WHITEBOARD: 'WHITEBOARD',
  NOTES: 'NOTES',
  WEB_BROWSER: 'WEB_BROWSER',
  MEETING_TIMER: 'MEETING_TIMER',
});

/** Single source of truth for how each widget presents itself. */
export const WIDGETS = Object.freeze({
  [WINDOW_TYPES.CODE_EDITOR]: {
    title: 'Code Editor',
    icon: '⌨️',
    /** Editing this widget writes to the shared document. */
    collaborative: true,
  },
  [WINDOW_TYPES.WHITEBOARD]: { title: 'Whiteboard', icon: '🎨', collaborative: true },
  [WINDOW_TYPES.NOTES]: { title: 'Live Notes', icon: '📝', collaborative: true },
  [WINDOW_TYPES.WEB_BROWSER]: { title: 'Shared Browser', icon: '🌐', collaborative: true },
  [WINDOW_TYPES.MEETING_TIMER]: { title: 'Meeting Timer', icon: '⏱️', collaborative: true },
});

export function widgetMeta(type) {
  return WIDGETS[type] || { title: 'Window', icon: '🪟', collaborative: false };
}
