/**
 * Spotify Host Mode playback — web only.
 * Loads the Spotify Web Playback SDK in the host's browser and plays the
 * current track through the host device. All other players just buzz.
 * Auth: the server session travels in an HttpOnly cookie; this hook only
 * ever sees short-lived access tokens fetched with credentials.
 * No-ops entirely on native platforms and in iTunes mode.
 */
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { GamePhase } from '@/context/GameContext';

import { SERVER_ORIGIN as API_BASE } from '@/lib/apiBase';

type SdkPlayer = {
  connect: () => Promise<boolean>;
  disconnect: () => void;
  pause: () => Promise<void>;
  addListener: (event: string, cb: (data: any) => void) => void;
};

interface Params {
  enabled: boolean; // isHost && musicSource === 'spotify'
  phase: GamePhase | undefined;
  spotifyUri: string | null | undefined;
}

async function getToken(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/api/spotify/token`, { credentials: 'include' });
    if (!res.ok) return null;
    const data = (await res.json()) as { accessToken: string };
    return data.accessToken;
  } catch {
    return null;
  }
}

export function useSpotifyHostPlayback({ enabled, phase, spotifyUri }: Params) {
  const playerRef = useRef<SdkPlayer | null>(null);
  const deviceIdRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const active = enabled && Platform.OS === 'web';

  // ── SDK bootstrap ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const init = () => {
      if (cancelled || playerRef.current) return;
      const Spotify = (window as any).Spotify;
      if (!Spotify) return;
      const player: SdkPlayer = new Spotify.Player({
        name: 'Kiwi Buzz Host',
        volume: 1,
        getOAuthToken: (cb: (token: string) => void) => {
          getToken().then((t) => { if (t) cb(t); });
        },
      });
      player.addListener('ready', ({ device_id }: { device_id: string }) => {
        deviceIdRef.current = device_id;
        setReady(true);
        setPlaybackError(null);
      });
      player.addListener('not_ready', () => setReady(false));
      // Terminal SDK errors also clear readiness so the UI blocks Start
      player.addListener('initialization_error', (e: any) => { setReady(false); setPlaybackError(e?.message ?? 'Spotify failed to start'); });
      player.addListener('authentication_error', () => { setReady(false); setPlaybackError('Spotify sign-in expired — reconnect Spotify, then create a new game.'); });
      player.addListener('account_error', () => { setReady(false); setPlaybackError('Spotify playback needs a Premium account.'); });
      player.connect();
      playerRef.current = player;
    };

    if ((window as any).Spotify) {
      init();
    } else {
      (window as any).onSpotifyWebPlaybackSDKReady = init;
      if (!document.getElementById('spotify-sdk')) {
        const script = document.createElement('script');
        script.id = 'spotify-sdk';
        script.src = 'https://sdk.scdn.co/spotify-player.js';
        script.async = true;
        document.body.appendChild(script);
      }
    }

    return () => {
      cancelled = true;
      playerRef.current?.disconnect();
      playerRef.current = null;
      deviceIdRef.current = null;
      setReady(false);
    };
  }, [active]);

  // ── phase-driven playback ─────────────────────────────────────────────────
  // A generation counter serialises transitions: if the phase changes while a
  // REST `play` call is in flight, the stale completion pauses itself instead
  // of restarting audio over a buzz/reveal/countdown.
  const generation = useRef(0);
  const lastStartedUri = useRef<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const gen = ++generation.current;
    const player = playerRef.current;
    const deviceId = deviceIdRef.current;

    const startTrack = async (uri: string, resume: boolean) => {
      try {
        const accessToken = await getToken();
        if (!accessToken) throw new Error('token');
        if (generation.current !== gen) return; // stale before we even started
        const res = await fetch(
          `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId!)}`,
          {
            method: 'PUT',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: resume ? undefined : JSON.stringify({ uris: [uri] }),
          },
        );
        if (!res.ok && res.status !== 204) throw new Error(`play ${res.status}`);
        if (generation.current !== gen) {
          // Phase moved on while the request was in flight — undo it.
          player?.pause().catch(() => {});
          return;
        }
        lastStartedUri.current = uri;
        setPlaybackError(null);
      } catch {
        if (generation.current === gen) {
          setPlaybackError('Could not start Spotify playback on this device.');
        }
      }
    };

    if (phase === 'playing' && spotifyUri && deviceId && ready) {
      startTrack(spotifyUri, lastStartedUri.current === spotifyUri);
    } else {
      // countdown, buzzed, revealing, lobby, finished, undefined → silence
      player?.pause().catch(() => {});
      if (!phase || phase === 'lobby' || phase === 'finished' || phase === 'countdown') {
        lastStartedUri.current = null;
      }
    }
  }, [active, phase, spotifyUri, ready]);

  return { spotifyReady: ready, spotifyPlaybackError: playbackError };
}
