/**
 * Guarded wrapper around react-native-spotify-remote (Spotify App Remote SDK).
 *
 * The native module only exists in a development/production build of the app
 * (Expo prebuild). In Expo Go and on web/iOS this wrapper reports
 * `isNativeSpotifyAvailable() === false` and every call becomes a safe no-op,
 * so the rest of the app never crashes.
 *
 * Auth: Authorization Code flow with server-side token swap — the client
 * secret never ships in the APK (tokenSwapURL / tokenRefreshURL point at our
 * API server).
 */
import { NativeModules, Platform } from 'react-native';

import { API_BASE } from '@/lib/apiBase';

type RemoteApi = {
  auth: {
    authorize: (config: Record<string, unknown>) => Promise<{ accessToken: string }>;
    endSession: () => Promise<void>;
  };
  remote: {
    connect: (token: string) => Promise<void>;
    disconnect: () => Promise<void>;
    isConnectedAsync: () => Promise<boolean>;
    playUri: (uri: string) => Promise<void>;
    pause: () => Promise<void>;
    resume: () => Promise<void>;
    getPlayerState: () => Promise<{ isPaused: boolean; track?: { uri: string } }>;
    addListener?: (event: string, cb: (...args: unknown[]) => void) => void;
  };
};

let api: RemoteApi | null = null;
let loadAttempted = false;

function load(): RemoteApi | null {
  if (loadAttempted) return api;
  loadAttempted = true;
  if (Platform.OS !== 'android') return null;
  // The JS package can be bundled even when its Android half isn't linked
  // (it's excluded in react-native.config.js) — only enable when it really is.
  if (!NativeModules.RNSpotifyRemoteAuth || !NativeModules.RNSpotifyRemoteAppRemote) return null;
  try {
    // Dynamic require — module only present in native dev/production builds.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('react-native-spotify-remote');
    if (mod?.auth && mod?.remote) api = { auth: mod.auth, remote: mod.remote } as RemoteApi;
  } catch {
    api = null; // Expo Go — native module not linked
  }
  return api;
}

export function isNativeSpotifyAvailable(): boolean {
  return load() !== null;
}

/** Authorize the host with Spotify and connect App Remote to the Spotify app. */
export async function nativeSpotifyConnect(): Promise<{ ok: true } | { ok: false; error: string }> {
  const mod = load();
  if (!mod) return { ok: false, error: 'Spotify native module is not available in this build.' };
  try {
    const cfgRes = await fetch(`${API_BASE}/spotify/native/config`);
    if (!cfgRes.ok) return { ok: false, error: 'Spotify is not configured on the server.' };
    const cfg = (await cfgRes.json()) as { clientId: string; redirectUri: string };

    const session = await mod.auth.authorize({
      clientID: cfg.clientId,
      redirectURL: cfg.redirectUri,
      // Authorization Code flow: the code is swapped for tokens on OUR server,
      // so the client secret never ships in the APK and refresh works.
      authType: 'CODE',
      tokenSwapURL: `${API_BASE}/spotify/native/swap`,
      tokenRefreshURL: `${API_BASE}/spotify/native/refresh`,
      scopes: ['app-remote-control', 'user-read-playback-state', 'user-modify-playback-state'],
    });
    await mod.remote.connect(session.accessToken);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    if (/not installed|CouldNotFindSpotifyApp/i.test(msg)) {
      return { ok: false, error: 'The Spotify app is not installed on this phone. Install it, log in, then try again.' };
    }
    return { ok: false, error: `Could not connect to Spotify: ${msg}` };
  }
}

export async function nativeSpotifyIsConnected(): Promise<boolean> {
  const mod = load();
  if (!mod) return false;
  try { return await mod.remote.isConnectedAsync(); } catch { return false; }
}

export async function nativeSpotifyPlay(uri: string): Promise<void> {
  const mod = load();
  if (!mod) throw new Error('Spotify native module unavailable');
  await mod.remote.playUri(uri);
}

export async function nativeSpotifyPause(): Promise<void> {
  const mod = load();
  if (!mod) return;
  try { await mod.remote.pause(); } catch { /* already paused / disconnected */ }
}

/** Confirm playback is actually active (used after starting a round). */
export async function nativeSpotifyIsPlaying(): Promise<boolean> {
  const mod = load();
  if (!mod) return false;
  try {
    const st = await mod.remote.getPlayerState();
    return !st.isPaused;
  } catch { return false; }
}
