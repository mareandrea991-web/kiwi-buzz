/**
 * Spotify app-level (Client Credentials) token — used to search track metadata
 * for native Android Spotify Host Mode rooms, where the host authenticates on
 * their device and the server never holds their user token. Metadata search
 * does not require a user token; playback happens only on the host device.
 */
import { logger } from "./logger.js";

let cached: { token: string; expiresAt: number } | null = null;

export async function getAppAccessToken(): Promise<string | null> {
  if (cached && Date.now() < cached.expiresAt - 30_000) return cached.token;

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
      body: new URLSearchParams({ grant_type: "client_credentials" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "spotify client-credentials token failed");
      return null;
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return cached.token;
  } catch (err) {
    logger.warn({ err }, "spotify client-credentials token error");
    return null;
  }
}
