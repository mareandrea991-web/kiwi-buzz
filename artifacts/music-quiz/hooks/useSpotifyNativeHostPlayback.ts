/**
 * Native Android Spotify Host Mode playback (App Remote SDK).
 * Mirrors useSpotifyHostPlayback's phase contract: play on 'playing', pause
 * immediately on buzz / reveal / countdown / lobby / finished. Full tracks
 * play only on the host's Android device through the installed Spotify app.
 * No-ops entirely unless enabled AND the native module is present.
 */
import { useEffect, useRef, useState } from 'react';
import type { GamePhase } from '@/context/GameContext';
import {
  isNativeSpotifyAvailable,
  nativeSpotifyConnect,
  nativeSpotifyIsConnected,
  nativeSpotifyIsPlaying,
  nativeSpotifyPause,
  nativeSpotifyPlay,
} from '@/lib/spotifyNative';

interface Params {
  enabled: boolean; // isHost && musicSource === 'spotify' && native build
  phase: GamePhase | undefined;
  spotifyUri: string | null | undefined;
}

export function useSpotifyNativeHostPlayback({ enabled, phase, spotifyUri }: Params) {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = enabled && isNativeSpotifyAvailable();

  // Reconnect check when (re)enabled
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    nativeSpotifyIsConnected().then((ok) => { if (!cancelled) setConnected(ok); });
    return () => { cancelled = true; };
  }, [active]);

  /** Host-facing action: (re)connect Spotify. Never touches the room. */
  const reconnect = async () => {
    setError(null);
    const res = await nativeSpotifyConnect();
    if (res.ok) {
      setConnected(true);
    } else {
      setConnected(false);
      setError(res.error);
    }
    return res.ok;
  };

  // Phase-driven playback with a generation counter: a stale in-flight play
  // whose phase has moved on pauses itself instead of restarting audio.
  const generation = useRef(0);
  useEffect(() => {
    if (!active) return;
    const gen = ++generation.current;

    if (phase === 'playing' && spotifyUri) {
      (async () => {
        try {
          await nativeSpotifyPlay(spotifyUri);
          if (generation.current !== gen) { await nativeSpotifyPause(); return; }
          // Confirm playback actually started (Spotify app may have died)
          setTimeout(async () => {
            if (generation.current !== gen) return;
            const playing = await nativeSpotifyIsPlaying();
            if (!playing) {
              setError('Spotify is not playing — check the Spotify app, then reconnect.');
              setConnected(await nativeSpotifyIsConnected());
            } else {
              setError(null);
            }
          }, 2000);
        } catch (e) {
          if (generation.current === gen) {
            setError('Could not start Spotify playback — reconnect Spotify or switch to previews.');
            setConnected(await nativeSpotifyIsConnected());
          }
        }
      })();
    } else {
      // buzzed / revealing / countdown / lobby / finished → immediate silence
      void nativeSpotifyPause();
    }
  }, [active, phase, spotifyUri]);

  return {
    nativeAvailable: isNativeSpotifyAvailable(),
    nativeConnected: connected,
    nativeError: error,
    nativeReconnect: reconnect,
  };
}
