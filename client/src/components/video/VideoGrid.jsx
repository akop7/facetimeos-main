'use client';

import React, { useMemo } from 'react';
import VideoTile from './VideoTile';

/**
 * The tile layout.
 *
 * Changes from the previous version, all of which were visible in a real call:
 *  - tiles come from the **participant roster**, not from the set of inbound
 *    media streams. Building them from `remoteStreams` meant a peer who has not
 *    published video — camera off, camera busy in another browser, or still
 *    negotiating — produced no tile at all, so each side saw only itself and the
 *    call looked broken while the mesh was in fact connected;
 *  - mute and camera state come from peer state instead of being read off a
 *    `MediaStreamTrack` during render (a track mutation re-renders nothing);
 *  - a screen share or a pinned tile gets a spotlight with the rest as a filmstrip,
 *    instead of a shared screen being squeezed into one cell of an even grid;
 *  - the grid is computed from the tile count rather than hard-coded to nine, so
 *    a seventh participant is not invisible.
 */

function gridClassFor(count) {
  if (count <= 1) return 'grid-cols-1';
  if (count === 2) return 'grid-cols-1 sm:grid-cols-2';
  if (count <= 4) return 'grid-cols-2 grid-rows-2';
  if (count <= 6) return 'grid-cols-2 sm:grid-cols-3 grid-rows-3 sm:grid-rows-2';
  if (count <= 9) return 'grid-cols-3 grid-rows-3';
  return 'grid-cols-3 sm:grid-cols-4';
}

export default function VideoGrid({
  localStream,
  remoteStreams = new Map(),
  peers = new Map(),
  localName = 'You',
  localRole = 'editor',
  localMuted = false,
  localCameraOff = false,
  localScreenSharing = false,
  localHandRaised = false,
  speakingIds,
  pinnedId = null,
  onTogglePin,
}) {
  const tiles = useMemo(() => {
    const list = [];

    // Always present, stream or not: somebody who joined receive-only still
    // belongs in the room, and seeing their own placeholder is how they know the
    // camera is the problem rather than the call.
    list.push({
      id: 'local',
      stream: localStream || null,
      displayName: localName,
      isLocal: true,
      isMuted: localMuted || !localStream,
      isCameraOff: (localCameraOff || !localStream) && !localScreenSharing,
      isScreenShare: localScreenSharing,
      handRaised: localHandRaised,
      role: localRole,
      quality: 'good',
    });

    for (const [id, peer] of peers) {
      const stream = remoteStreams.get(id) || null;
      const media = peer?.media || {};
      /**
       * Three sources, in order of how much they can be trusted:
       *  - `videoLive` is the transport telling us whether that track is
       *    currently carrying frames. It cannot be wrong and cannot go missing.
       *  - `media.video` is what the peer says about itself, which arrives as a
       *    presence frame and may not have arrived yet.
       *  - the presence of a stream at all.
       * A tile only claims a camera is on when nothing contradicts it.
       */
      const trackLive = peer?.videoLive;
      const hasVideo =
        Boolean(stream) &&
        Boolean(stream.getVideoTracks?.().length) &&
        media.video !== false &&
        trackLive !== false;
      list.push({
        id,
        stream,
        displayName: peer?.displayName || 'Participant',
        isLocal: false,
        // `media` is what the peer says about itself; `mutedByHost` is what the
        // server says. Either one showing means the microphone is not live.
        isMuted: media.audio === false || Boolean(peer?.mutedByHost) || !stream,
        isCameraOff: !hasVideo && !media.screen,
        isScreenShare: Boolean(media.screen) && hasVideo,
        mutedByHost: Boolean(peer?.mutedByHost),
        handRaised: Boolean(peer?.handRaised),
        role: peer?.role || 'editor',
        quality: peer?.quality || 'good',
        connectionState: peer?.connectionState,
      });
    }

    return list;
  }, [
    localStream,
    remoteStreams,
    peers,
    localName,
    localRole,
    localMuted,
    localCameraOff,
    localScreenSharing,
    localHandRaised,
  ]);

  // A pin wins over an automatic spotlight: if someone deliberately pinned a
  // tile, a peer starting to share must not yank the view away from them.
  const spotlightId =
    (pinnedId && tiles.some((t) => t.id === pinnedId) && pinnedId) ||
    tiles.find((t) => t.isScreenShare)?.id ||
    null;

  const spotlight = spotlightId ? tiles.find((t) => t.id === spotlightId) : null;
  const rest = spotlight ? tiles.filter((t) => t.id !== spotlight.id) : tiles;

  const renderTile = (tile) => (
    <VideoTile
      {...tile}
      isSpeaking={speakingIds?.has(tile.id) ?? false}
      isPinned={tile.id === pinnedId}
      onTogglePin={onTogglePin ? () => onTogglePin(tile.id === pinnedId ? null : tile.id) : undefined}
    />
  );

  if (tiles.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[var(--bg-primary)] p-8 text-center">
        <p className="max-w-sm text-sm text-[var(--on-surface-muted)]">
          Nobody here yet. The shared workspace works without video — the widgets do not need a
          camera.
        </p>
      </div>
    );
  }

  if (spotlight) {
    return (
      <div className="flex h-full w-full flex-col gap-2 bg-transparent p-2">
        <div className="min-h-0 flex-1">{renderTile(spotlight)}</div>
        {rest.length > 0 && (
          <div className="flex h-24 shrink-0 gap-2 overflow-x-auto pb-1 sm:h-32">
            {rest.map((tile) => (
              <div key={tile.id} className="aspect-video h-full shrink-0">
                {renderTile(tile)}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`grid h-full w-full gap-2 bg-transparent p-2 transition-all duration-300 ${gridClassFor(
        tiles.length
      )}`}
    >
      {tiles.map((tile) => (
        <div key={tile.id} className="min-h-0 min-w-0">
          {renderTile(tile)}
        </div>
      ))}
    </div>
  );
}
