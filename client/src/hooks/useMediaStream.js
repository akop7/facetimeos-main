'use client';

import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * Camera, microphone and screen capture.
 *
 * Two things the old version got wrong and this fixes:
 *
 *  - It called `navigator.mediaDevices.getUserMedia` unconditionally. Outside a
 *    secure context (a plain-HTTP LAN address, which is exactly how people test
 *    on their phone) `mediaDevices` is `undefined`, so this threw a TypeError
 *    and the room never finished loading. Now it is detected and reported.
 *  - There was no screen-share path at all, and no way to get the camera back
 *    afterwards.
 */

const VIDEO_CONSTRAINTS = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30, max: 30 },
};

const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export function mediaSupport() {
  if (typeof navigator === 'undefined') return { camera: false, screen: false, reason: 'ssr' };
  const secure = typeof window !== 'undefined' && window.isSecureContext;
  if (!navigator.mediaDevices?.getUserMedia) {
    return {
      camera: false,
      screen: false,
      reason: secure ? 'unsupported' : 'insecure-context',
    };
  }
  return {
    camera: true,
    screen: Boolean(navigator.mediaDevices.getDisplayMedia),
    reason: null,
  };
}

export function useMediaStream() {
  const [stream, setStream] = useState(null);
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [error, setError] = useState(null);

  const streamRef = useRef(null);
  const cameraTrackRef = useRef(null);
  const screenStreamRef = useRef(null);
  /** Called with the new video track whenever it is swapped. */
  const onVideoTrackRef = useRef(null);

  const setVideoTrackListener = useCallback((handler) => {
    onVideoTrackRef.current = handler;
  }, []);

  const startMedia = useCallback(async () => {
    // Nothing is live until something is acquired. These start `true` so the
    // control bar renders un-crossed on first paint, but leaving them `true`
    // after a failure made us announce a camera and a microphone that do not
    // exist — peers rendered a tile waiting for a track that was never coming.
    const publishNothing = () => {
      setIsAudioEnabled(false);
      setIsVideoEnabled(false);
    };

    const support = mediaSupport();
    if (!support.camera) {
      const message =
        support.reason === 'insecure-context'
          ? 'Camera and mic need HTTPS (or localhost). Open the https:// link, not the http:// IP.'
          : 'This browser does not expose camera or microphone access.';
      publishNothing();
      setError({ code: support.reason, message });
      return null;
    }

    const adopt = (media, note) => {
      streamRef.current = media;
      cameraTrackRef.current = media.getVideoTracks()[0] || null;
      setStream(media);
      setIsAudioEnabled(media.getAudioTracks()[0]?.enabled ?? false);
      setIsVideoEnabled(media.getVideoTracks()[0]?.enabled ?? false);
      setError(note);
      return media;
    };

    /**
     * Ask for less, rather than nothing.
     *
     * Requesting camera+mic together means one unavailable device fails the
     * whole call: on Windows a webcam is normally exclusive to a single process,
     * so opening the same room in a second browser threw `NotReadableError` and
     * that participant published *neither* video nor audio — they showed up as
     * a silent, camera-less ghost. Falling back to mic-only keeps them audible
     * and, now that tiles come from the roster, visible as a placeholder.
     */
    const ladder = [
      { video: VIDEO_CONSTRAINTS, audio: AUDIO_CONSTRAINTS, note: null },
      {
        video: false,
        audio: AUDIO_CONSTRAINTS,
        note: {
          code: 'camera-unavailable',
          level: 'warn',
          message:
            'Camera is in use by another app or browser — joined with microphone only. Close the other window and press the camera button to retry.',
        },
      },
      {
        video: VIDEO_CONSTRAINTS,
        audio: false,
        note: {
          code: 'mic-unavailable',
          level: 'warn',
          message: 'Microphone is unavailable — joined with camera only.',
        },
      },
    ];

    let lastError = null;

    for (const rung of ladder) {
      // A reload can leave the previous page still releasing the devices, so a
      // brief retry is the difference between "camera works" and a scary error.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const media = await navigator.mediaDevices.getUserMedia({
            video: rung.video,
            audio: rung.audio,
          });
          return adopt(media, rung.note);
        } catch (err) {
          lastError = err;
          const busy = err?.name === 'NotReadableError' || err?.name === 'AbortError';
          if (busy && attempt < 2) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            continue;
          }
          break;
        }
      }
      // A hard refusal applies to every device, so there is nothing left to try.
      if (lastError?.name === 'NotAllowedError') break;
    }

    // Receive-only is a legitimate way to attend, so this is not fatal.
    publishNothing();
    setError({
      code: lastError?.name || 'media-error',
      message:
        lastError?.name === 'NotAllowedError'
          ? 'Camera and mic are blocked. You can still watch and listen.'
          : `Could not start camera or mic (${lastError?.name || 'unknown'}). Joining receive-only.`,
    });
    return null;
  }, []);

  /**
   * Retry the camera on a stream that came up mic-only, and splice the new track
   * into the existing `MediaStream` so the mesh's `replaceTrack` path can pick it
   * up without renegotiating.
   */
  const retryCamera = useCallback(async () => {
    if (!mediaSupport().camera) return null;
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
      const track = fresh.getVideoTracks()[0] || null;
      if (!track) return null;
      cameraTrackRef.current = track;
      const current = streamRef.current;
      if (current) {
        for (const old of current.getVideoTracks()) {
          old.stop();
          current.removeTrack(old);
        }
        current.addTrack(track);
        setStream(new MediaStream(current.getTracks()));
      } else {
        streamRef.current = fresh;
        setStream(fresh);
      }
      setIsVideoEnabled(true);
      setError(null);
      await onVideoTrackRef.current?.(track);
      return track;
    } catch (err) {
      setError({
        code: err?.name || 'camera-unavailable',
        level: 'warn',
        message: 'Camera is still busy. Close the other browser or app using it and try again.',
      });
      return null;
    }
  }, []);

  const stopScreenShare = useCallback(async () => {
    const screen = screenStreamRef.current;
    screenStreamRef.current = null;
    if (screen) screen.getTracks().forEach((track) => track.stop());
    setIsScreenSharing(false);

    // Put the camera back on the same transceiver. If the camera was never
    // available we hand back null, which shows a placeholder rather than a
    // frozen last frame of someone's desktop.
    const cameraTrack = cameraTrackRef.current;
    if (cameraTrack && cameraTrack.readyState === 'live') {
      await onVideoTrackRef.current?.(cameraTrack);
      return cameraTrack;
    }

    const support = mediaSupport();
    if (!support.camera) {
      await onVideoTrackRef.current?.(null);
      return null;
    }
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
      const track = fresh.getVideoTracks()[0] || null;
      cameraTrackRef.current = track;
      if (streamRef.current && track) {
        for (const old of streamRef.current.getVideoTracks()) {
          streamRef.current.removeTrack(old);
        }
        streamRef.current.addTrack(track);
        setStream(new MediaStream(streamRef.current.getTracks()));
      }
      await onVideoTrackRef.current?.(track);
      return track;
    } catch {
      await onVideoTrackRef.current?.(null);
      return null;
    }
  }, []);

  const startScreenShare = useCallback(async () => {
    const support = mediaSupport();
    if (!support.screen) {
      setError({
        code: 'screen-unsupported',
        message: 'Screen sharing needs a desktop browser on HTTPS.',
      });
      return null;
    }
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } },
        audio: false,
      });
      screenStreamRef.current = screen;
      const track = screen.getVideoTracks()[0];
      // The browser's own "Stop sharing" button ends the track directly, so the
      // UI has to listen for that rather than only its own toggle.
      track.onended = () => stopScreenShare();
      setIsScreenSharing(true);
      await onVideoTrackRef.current?.(track);
      return track;
    } catch (err) {
      // A user cancelling the picker is not an error worth surfacing.
      if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') {
        setError({ code: err?.name || 'screen-error', message: 'Screen share failed to start.' });
      }
      return null;
    }
  }, [stopScreenShare]);

  const toggleScreenShare = useCallback(
    () => (screenStreamRef.current ? stopScreenShare() : startScreenShare()),
    [startScreenShare, stopScreenShare]
  );

  const stopMedia = useCallback(() => {
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    cameraTrackRef.current = null;
    setStream(null);
    setIsScreenSharing(false);
  }, []);

  const toggleAudio = useCallback(() => {
    const track = streamRef.current?.getAudioTracks()[0];
    if (!track) return false;
    track.enabled = !track.enabled;
    setIsAudioEnabled(track.enabled);
    return track.enabled;
  }, []);

  const toggleVideo = useCallback(() => {
    const track = streamRef.current?.getVideoTracks()[0];
    // No track at all means the camera never opened (busy, or mic-only
    // fallback). Pressing the camera button should try again rather than do
    // nothing, which is what it used to do.
    if (!track || track.readyState === 'ended') {
      retryCamera();
      return false;
    }
    track.enabled = !track.enabled;
    setIsVideoEnabled(track.enabled);
    return track.enabled;
  }, [retryCamera]);

  /**
   * Force-mute, for host moderation. Deliberately one-way: a host can silence
   * someone, but nothing should be able to switch a participant's microphone
   * back ON remotely.
   */
  const forceMute = useCallback((kind = 'audio') => {
    const tracks =
      kind === 'video' ? streamRef.current?.getVideoTracks() : streamRef.current?.getAudioTracks();
    if (!tracks?.length) return;
    for (const track of tracks) track.enabled = false;
    if (kind === 'video') setIsVideoEnabled(false);
    else setIsAudioEnabled(false);
  }, []);

  // Devices must be released even if the page is torn down without a clean
  // leave — otherwise the camera light stays on.
  useEffect(() => stopMedia, [stopMedia]);

  return {
    stream,
    isAudioEnabled,
    isVideoEnabled,
    isScreenSharing,
    error,
    startMedia,
    stopMedia,
    retryCamera,
    toggleAudio,
    toggleVideo,
    forceMute,
    startScreenShare,
    stopScreenShare,
    toggleScreenShare,
    setVideoTrackListener,
  };
}
