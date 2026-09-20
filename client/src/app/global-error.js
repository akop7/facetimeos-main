'use client';

/**
 * Last-resort boundary: this one catches failures in the root layout itself,
 * which the per-route `error.js` cannot — if the layout throws, there is no
 * layout left to render a nice card inside.
 *
 * It therefore has to supply its own `<html>` and `<body>`, and it cannot use
 * Tailwind: the stylesheet is imported by the layout that just failed. Inline
 * styles are not a shortcut here, they are the only thing guaranteed to apply.
 * Colours are hard-coded for the same reason — the CSS custom properties live in
 * `globals.css`.
 */

export default function GlobalError({ error, reset }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0d1117',
          color: '#f3f6fa',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          padding: '1.5rem',
        }}
      >
        <div
          style={{
            maxWidth: '28rem',
            width: '100%',
            background: '#131922',
            border: '1px solid #303a48',
            borderRadius: '0.75rem',
            padding: '1.75rem',
          }}
        >
          <h1 style={{ margin: '0 0 0.5rem', fontSize: '1.125rem' }}>FaceTimeOS could not start</h1>
          <p style={{ margin: '0 0 1.25rem', fontSize: '0.875rem', lineHeight: 1.6, color: '#a8a8b8' }}>
            The app failed before it could draw anything. Reloading fixes most causes; if it does
            not, the signaling server may be unreachable from this network.
          </p>
          {error?.digest && (
            <p style={{ margin: '0 0 1.25rem', fontSize: '0.6875rem', color: '#a8a8b8', fontFamily: 'monospace' }}>
              Reference: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{
              width: '100%',
              padding: '0.625rem 1rem',
              fontSize: '0.875rem',
              fontWeight: 600,
              color: '#fff',
              background: '#3f73ef',
              border: 'none',
              borderRadius: '0.6rem',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
