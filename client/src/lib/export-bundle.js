'use client';

/**
 * Export everything the meeting produced as one .zip the user can keep.
 *
 * This is the feature the incumbents structurally cannot offer. Meet, Zoom and
 * Teams treat a meeting as a stream: when it ends, the artifacts are gone, and
 * what you get back — if anything — is a recording you have to watch again to
 * find the decision. Here the room *is* a document, so the export is not a
 * recording, it is the work: the notes, the code, the whiteboard as a real SVG,
 * the full chat transcript, the pages you looked at together, and a timeline of
 * what happened when.
 *
 * The zip is written by hand, stored (uncompressed), because the alternative was
 * adding a compression dependency to ship one button. A store-only zip is a
 * handful of headers and a CRC-32, and every unzip tool on every platform reads
 * it.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time, which is what the zip format stores. */
function dosStamp(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Build a store-only zip from `[{ name, text }]`.
 * @returns {Blob}
 */
export function makeZip(entries, when = new Date()) {
  const encoder = new TextEncoder();
  const stamp = dosStamp(when);

  const files = entries.map(({ name, text }) => {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(text ?? '');
    return { nameBytes, data, crc: crc32(data) };
  });

  const localSize = files.reduce((sum, f) => sum + 30 + f.nameBytes.length + f.data.length, 0);
  const centralSize = files.reduce((sum, f) => sum + 46 + f.nameBytes.length, 0);
  const buffer = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(buffer.buffer);

  let offset = 0;
  const offsets = [];

  for (const file of files) {
    offsets.push(offset);
    view.setUint32(offset, 0x04034b50, true);
    view.setUint16(offset + 4, 20, true); // version needed
    view.setUint16(offset + 6, 0x0800, true); // UTF-8 names
    view.setUint16(offset + 8, 0, true); // stored, no compression
    view.setUint16(offset + 10, stamp.time, true);
    view.setUint16(offset + 12, stamp.date, true);
    view.setUint32(offset + 14, file.crc, true);
    view.setUint32(offset + 18, file.data.length, true);
    view.setUint32(offset + 22, file.data.length, true);
    view.setUint16(offset + 26, file.nameBytes.length, true);
    view.setUint16(offset + 28, 0, true); // no extra field
    offset += 30;
    buffer.set(file.nameBytes, offset);
    offset += file.nameBytes.length;
    buffer.set(file.data, offset);
    offset += file.data.length;
  }

  const centralStart = offset;
  files.forEach((file, index) => {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 4, 20, true); // version made by
    view.setUint16(offset + 6, 20, true); // version needed
    view.setUint16(offset + 8, 0x0800, true);
    view.setUint16(offset + 10, 0, true);
    view.setUint16(offset + 12, stamp.time, true);
    view.setUint16(offset + 14, stamp.date, true);
    view.setUint32(offset + 16, file.crc, true);
    view.setUint32(offset + 20, file.data.length, true);
    view.setUint32(offset + 24, file.data.length, true);
    view.setUint16(offset + 28, file.nameBytes.length, true);
    view.setUint16(offset + 30, 0, true);
    view.setUint16(offset + 32, 0, true); // no comment
    view.setUint16(offset + 34, 0, true); // disk 0
    view.setUint16(offset + 36, 0, true); // internal attrs
    view.setUint32(offset + 38, 0, true); // external attrs
    view.setUint32(offset + 42, offsets[index], true);
    offset += 46;
    buffer.set(file.nameBytes, offset);
    offset += file.nameBytes.length;
  });

  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 4, 0, true);
  view.setUint16(offset + 6, 0, true);
  view.setUint16(offset + 8, files.length, true);
  view.setUint16(offset + 10, files.length, true);
  view.setUint32(offset + 12, centralSize, true);
  view.setUint32(offset + 16, centralStart, true);
  view.setUint16(offset + 20, 0, true);

  return new Blob([buffer], { type: 'application/zip' });
}

/* -------------------------------------------------------------------------- */
/* Renderers                                                                   */
/* -------------------------------------------------------------------------- */

const stamp = (at) => (Number.isFinite(at) ? new Date(at).toISOString() : '');
const clock = (at) =>
  Number.isFinite(at) ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

const escapeXml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * The whiteboard, as an SVG rather than a screenshot: coordinates are stored
 * normalised, so it re-renders crisply at any size and the shapes stay editable
 * in any vector tool.
 */
export function strokesToSvg(strokes, width = 1600, height = 1000) {
  const parts = [];
  for (const stroke of strokes || []) {
    const points = stroke?.points;
    if (!points?.length) continue;
    // An eraser is a composite operation on a canvas; in a static SVG there is
    // nothing to erase from, so those strokes are simply omitted.
    if (stroke.tool === 'eraser') continue;

    const px = (n) => (n * width).toFixed(2);
    const py = (n) => (n * height).toFixed(2);
    const colour = escapeXml(stroke.color || '#6366f1');
    const w = stroke.width || 2;
    const first = points[0];
    const last = points[points.length - 1];

    if (stroke.tool === 'text') {
      const size = Math.max(13, w * 7);
      parts.push(
        `<text x="${px(first.x)}" y="${py(first.y)}" fill="${colour}" font-size="${size}" font-family="system-ui, sans-serif" dominant-baseline="hanging">${escapeXml(stroke.text)}</text>`
      );
    } else if (stroke.tool === 'rectangle') {
      const x = Math.min(first.x, last.x);
      const y = Math.min(first.y, last.y);
      parts.push(
        `<rect x="${px(x)}" y="${py(y)}" width="${px(Math.abs(last.x - first.x))}" height="${py(Math.abs(last.y - first.y))}" fill="none" stroke="${colour}" stroke-width="${w}" />`
      );
    } else if (stroke.tool === 'circle') {
      parts.push(
        `<ellipse cx="${px((first.x + last.x) / 2)}" cy="${py((first.y + last.y) / 2)}" rx="${px(Math.abs(last.x - first.x) / 2)}" ry="${py(Math.abs(last.y - first.y) / 2)}" fill="none" stroke="${colour}" stroke-width="${w}" />`
      );
    } else if (stroke.tool === 'line') {
      parts.push(
        `<line x1="${px(first.x)}" y1="${py(first.y)}" x2="${px(last.x)}" y2="${py(last.y)}" stroke="${colour}" stroke-width="${w}" stroke-linecap="round" />`
      );
    } else {
      const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.x)} ${py(p.y)}`).join(' ');
      parts.push(
        `<path d="${d}" fill="none" stroke="${colour}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" />`
      );
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="#ffffff" />
  ${parts.join('\n  ')}
</svg>
`;
}

function transcriptMarkdown(chat) {
  if (!chat?.length) return '# Chat transcript\n\n_No messages._\n';
  const lines = ['# Chat transcript', ''];
  for (const message of chat) {
    lines.push(`**${message.name || 'Participant'}** · ${clock(message.at)}`, '', message.text, '');
  }
  return lines.join('\n');
}

function timelineMarkdown(events) {
  if (!events?.length) return '# Session timeline\n\n_Nothing recorded._\n';
  const lines = ['# Session timeline', ''];
  for (const event of events) {
    const who = event.byName ? ` — ${event.byName}` : '';
    lines.push(`- \`${clock(event.at)}\` **${event.kind}** ${event.text || ''}${who}`);
  }
  return lines.join('\n') + '\n';
}

function summaryMarkdown({ roomId, title, chat, timeline, notes, code, strokes, trail, participants, exportedBy }) {
  const decisions = (timeline || []).filter((event) => event.kind === 'decision');
  const started = timeline?.[0]?.at;
  const lines = [
    `# ${title || 'FaceTimeOS session'}`,
    '',
    `- Room: \`${roomId}\``,
    `- Exported: ${stamp(Date.now())}${exportedBy ? ` by ${exportedBy}` : ''}`,
    started ? `- First recorded event: ${stamp(started)}` : null,
    `- Participants seen: ${participants?.length ? participants.join(', ') : 'unknown'}`,
    '',
    '## What this meeting produced',
    '',
    `- Notes: ${notes ? `${notes.split(/\s+/).filter(Boolean).length} words` : 'none'}`,
    `- Code: ${code ? `${code.split('\n').length} lines` : 'none'}`,
    `- Whiteboard: ${strokes?.length || 0} strokes`,
    `- Chat messages: ${chat?.length || 0}`,
    `- Pages opened together: ${trail?.length || 0}`,
    '',
    '## Decisions marked during the call',
    '',
  ];

  if (decisions.length === 0) {
    lines.push(
      '_None marked. Anyone can mark a decision from the timeline panel while the call is running — that is what makes this file worth keeping._'
    );
  } else {
    for (const decision of decisions) {
      lines.push(`- **${decision.text}** — ${decision.byName || 'someone'} at ${clock(decision.at)}`);
    }
  }

  lines.push('', '## Files in this bundle', '');
  lines.push(
    '- `notes.md` — the shared notes as they stood at export',
    '- `code.txt` — the shared editor buffer',
    '- `whiteboard.svg` — the board as vectors, not a screenshot',
    '- `transcript.md` — every chat message, including ones sent before you joined',
    '- `timeline.md` / `timeline.json` — what happened, when, and who did it',
    '- `links.md` — every page the room browsed together',
    '- `session.json` — the whole thing as data, for anything you want to build on it',
    ''
  );

  return lines.filter((line) => line !== null).join('\n');
}

function linksMarkdown(trail) {
  if (!trail?.length) return '# Pages opened together\n\n_None._\n';
  return ['# Pages opened together', '', ...trail.map((url) => `- ${url}`), ''].join('\n');
}

/**
 * Read the room document and produce the bundle.
 *
 * Everything comes out of the CRDT, which means the export is identical for
 * every participant and works offline — you do not need the server, the host, or
 * anyone else still being in the call to get your copy.
 */
export function buildBundle({ roomId, title, sharedTypes, exportedBy }) {
  const notes = sharedTypes?.notes?.toString?.() ?? '';
  const code = sharedTypes?.code?.toString?.() ?? '';
  const strokes = sharedTypes?.whiteboard?.toArray?.() ?? [];
  const chat = sharedTypes?.chat?.toArray?.() ?? [];
  const timeline = sharedTypes?.timeline?.toArray?.() ?? [];
  const meta = sharedTypes?.meta;
  const trail = meta?.get?.('browserNav')?.trail ?? [];

  const participants = [
    ...new Set(
      [...chat, ...timeline]
        .map((entry) => entry.byName || entry.name)
        .filter((name) => typeof name === 'string' && name.length > 0)
    ),
  ];

  const session = {
    roomId,
    title: title || null,
    exportedAt: Date.now(),
    exportedBy: exportedBy || null,
    participants,
    notes,
    code,
    codeLanguage: meta?.get?.('codeLanguage') ?? null,
    chat,
    timeline,
    whiteboardStrokes: strokes,
    browserTrail: trail,
  };

  const entries = [
    {
      name: 'README.md',
      text: summaryMarkdown({ roomId, title, chat, timeline, notes, code, strokes, trail, participants, exportedBy }),
    },
    { name: 'notes.md', text: notes || '_No notes were taken._\n' },
    { name: 'code.txt', text: code || '' },
    { name: 'whiteboard.svg', text: strokesToSvg(strokes) },
    { name: 'transcript.md', text: transcriptMarkdown(chat) },
    { name: 'timeline.md', text: timelineMarkdown(timeline) },
    { name: 'timeline.json', text: JSON.stringify(timeline, null, 2) },
    { name: 'links.md', text: linksMarkdown(trail) },
    { name: 'session.json', text: JSON.stringify(session, null, 2) },
  ];

  const when = new Date();
  const slug = `${(title || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'session'}-${roomId}`;
  return {
    filename: `facetimeos-${slug}-${when.toISOString().slice(0, 10)}.zip`,
    blob: makeZip(entries, when),
    stats: {
      notesWords: notes.split(/\s+/).filter(Boolean).length,
      codeLines: code ? code.split('\n').length : 0,
      strokes: strokes.length,
      messages: chat.length,
      events: timeline.length,
      links: trail.length,
    },
  };
}

/** Hand the blob to the browser's downloader and clean up after it. */
export function downloadBlob(blob, filename) {
  if (typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in Safari; one frame is enough.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
