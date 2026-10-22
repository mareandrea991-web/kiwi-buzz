/**
 * In-memory Spotify host sessions.
 * A session is created when a host completes the OAuth flow; the client only
 * ever holds an opaque session id — never the tokens themselves.
 */
import crypto from "node:crypto";
import { logger } from "./logger";

export interface SpotifySession {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  displayName: string;
  product: string; // "premium" | "free" | ...
  createdAt: number;
}

const sessions = new Map<string, SpotifySession>();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h — longer than any party

function sweep() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}
setInterval(sweep, 30 * 60 * 1000).unref();

export function createSession(data: Omit<SpotifySession, "id" | "createdAt">): SpotifySession {
  const id = crypto.randomBytes(24).toString("base64url");
  const session: SpotifySession = { ...data, id, createdAt: Date.now() };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string): SpotifySession | null {
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(id);
    return null;
  }
  return s;
}

/** Returns a valid access token, refreshing it if it expires within 60s. */
export async function getFreshAccessToken(id: string): Promise<string | null> {
  const s = getSession(id);
  if (!s) return null;
  if (Date.now() < s.expiresAt - 60_000) return s.accessToken;

  const clientId = process.env["SPOTIFY_CLIENT_ID"];
  const clientSecret = process.env["SPOTIFY_CLIENT_SECRET"];
  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: s.refreshToken,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "spotify token refresh failed");
      return null;
    }
    const data = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string };
    s.accessToken = data.access_token;
    s.expiresAt = Date.now() + data.expires_in * 1000;
    if (data.refresh_token) s.refreshToken = data.refresh_token;
    return s.accessToken;
  } catch (err) {
    logger.warn({ err }, "spotify token refresh error");
    return null;
  }
}
