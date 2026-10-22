/**
 * Spotify Host Mode OAuth (Authorization Code flow).
 * The host connects their Premium account; the client only receives an opaque
 * session id. Tokens live server-side in spotifySessions.
 */
import { ourHosts, primaryHost } from "../lib/hosts";
import { Router, type Request } from "express";
import crypto from "node:crypto";
import { createSession, getSession, getFreshAccessToken } from "../lib/spotifySessions.js";
import { logger } from "../lib/logger.js";

const router = Router();

const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
].join(" ");

// Pending OAuth states: state → { returnTo, createdAt }
const pendingStates = new Map<string, { returnTo: string; createdAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingStates) if (now - v.createdAt > 10 * 60_000) pendingStates.delete(k);
}, 60_000).unref();

function allowedHosts(): string[] {
  return ourHosts();
}

function redirectUri(req: Request): string {
  // Only trust the forwarded host if it is one of OUR domains; otherwise use
  // the configured dev/prod domain. Prevents header-spoofed redirect URIs.
  const raw = (req.get("x-forwarded-host") ?? req.get("host") ?? "").split(",")[0]!.trim().toLowerCase();
  const host = allowedHosts().includes(raw)
    ? raw
    : (primaryHost() ?? raw);
  return `https://${host}/api/spotify/callback`;
}

/** Only allow returning to our own known frontends, over https. */
function safeReturnTo(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 500) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return null;
    if (!allowedHosts().includes(u.hostname.toLowerCase())) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export const SPOTIFY_COOKIE = "kb_spotify_sid";

export function sidFromCookieHeader(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === SPOTIFY_COOKIE) return decodeURIComponent(rest.join("=")) || null;
  }
  return null;
}

// ── GET /api/spotify/login?returnTo=<app url> ────────────────────────────────
router.get("/spotify/login", (req, res) => {
  const clientId = process.env["SPOTIFY_CLIENT_ID"];
  if (!clientId) {
    res.status(500).json({ error: "Spotify is not configured on this server." });
    return;
  }
  const returnTo = safeReturnTo(req.query["returnTo"]);
  if (!returnTo) {
    res.status(400).json({ error: "Invalid returnTo" });
    return;
  }
  const state = crypto.randomBytes(16).toString("base64url");
  pendingStates.set(state, { returnTo, createdAt: Date.now() });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: redirectUri(req),
    state,
    show_dialog: "false",
  });
  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

// ── GET /api/spotify/callback ────────────────────────────────────────────────
router.get("/spotify/callback", async (req, res) => {
  const state = typeof req.query["state"] === "string" ? req.query["state"] : "";
  const pending = pendingStates.get(state);
  pendingStates.delete(state);
  if (!pending) {
    res.status(400).send("This sign-in link has expired. Go back to Kiwi Buzz and try again.");
    return;
  }
  const back = new URL(pending.returnTo);

  const err = typeof req.query["error"] === "string" ? req.query["error"] : null;
  const code = typeof req.query["code"] === "string" ? req.query["code"] : null;
  if (err || !code) {
    back.searchParams.set("spotify_error", err ?? "cancelled");
    res.redirect(back.toString());
    return;
  }

  const clientId = process.env["SPOTIFY_CLIENT_ID"]!;
  const clientSecret = process.env["SPOTIFY_CLIENT_SECRET"] ?? "";

  try {
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(req),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      logger.warn({ status: tokenRes.status, body: body.slice(0, 300) }, "spotify token exchange failed");
      back.searchParams.set("spotify_error", "token_exchange_failed");
      res.redirect(back.toString());
      return;
    }
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    // Who is this? (also tells us whether the account is Premium)
    const meRes = await fetch("https://api.spotify.com/v1/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const me = meRes.ok
      ? ((await meRes.json()) as { display_name?: string; product?: string })
      : {};

    const session = createSession({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      displayName: me.display_name ?? "Spotify user",
      product: me.product ?? "unknown",
    });

    // The session id never reaches client JS — it travels only in an
    // HttpOnly cookie. The URL just signals success.
    res.cookie(SPOTIFY_COOKIE, session.id, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
      maxAge: 12 * 60 * 60 * 1000,
    });
    back.searchParams.set("spotify_connected", "1");
    res.redirect(back.toString());
  } catch (e) {
    logger.error({ err: e }, "spotify callback error");
    back.searchParams.set("spotify_error", "server_error");
    res.redirect(back.toString());
  }
});

// ── GET /api/spotify/session — status for the client UI (cookie auth) ───────
router.get("/spotify/session", (req, res) => {
  const sid = sidFromCookieHeader(req.headers.cookie);
  const s = sid ? getSession(sid) : null;
  if (!s) {
    res.status(404).json({ error: "Not connected to Spotify" });
    return;
  }
  res.json({ displayName: s.displayName, product: s.product, premium: s.product === "premium" });
});

// ── GET /api/spotify/token — access token for the Web Playback SDK ──────────
// Cookie-authenticated: only the browser that completed OAuth can get it.
router.get("/spotify/token", async (req, res) => {
  const sid = sidFromCookieHeader(req.headers.cookie);
  const token = sid ? await getFreshAccessToken(sid) : null;
  if (!token) {
    res.status(404).json({ error: "Not connected to Spotify" });
    return;
  }
  res.json({ accessToken: token });
});

// ── Native Android (App Remote) token swap/refresh ──────────────────────────
// Used by react-native-spotify-remote's tokenSwapURL / tokenRefreshURL so the
// client secret NEVER ships inside the APK. Standard Spotify swap protocol:
// form-encoded body, Spotify's token JSON response passed through.
const NATIVE_REDIRECT_URI = "kiwibuzz://spotify-auth-callback";

// Simple per-IP rate limit for the public token broker endpoints.
const nativeHits = new Map<string, { count: number; windowStart: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of nativeHits) if (now - v.windowStart > 5 * 60_000) nativeHits.delete(k);
}, 60_000).unref();

function nativeRateLimited(req: Request): boolean {
  const ip = req.ip ?? "unknown";
  const now = Date.now();
  const rec = nativeHits.get(ip);
  if (!rec || now - rec.windowStart > 5 * 60_000) {
    nativeHits.set(ip, { count: 1, windowStart: now });
    return false;
  }
  rec.count += 1;
  return rec.count > 30; // 30 requests / 5 min / IP is plenty for auth flows
}

// Public app config for the native client (a Spotify client ID is not secret).
router.get("/spotify/native/config", (_req, res) => {
  const clientId = process.env["SPOTIFY_CLIENT_ID"];
  if (!clientId) {
    res.status(500).json({ error: "Spotify is not configured on this server." });
    return;
  }
  res.json({ clientId, redirectUri: NATIVE_REDIRECT_URI });
});

router.post("/spotify/native/swap", async (req, res) => {
  if (nativeRateLimited(req)) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }
  const clientId = process.env["SPOTIFY_CLIENT_ID"];
  const clientSecret = process.env["SPOTIFY_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    res.status(500).json({ error: "Spotify is not configured on this server." });
    return;
  }
  const code = typeof req.body?.code === "string" ? req.body.code : null;
  if (!code) {
    res.status(400).json({ error: "Missing code" });
    return;
  }
  try {
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: NATIVE_REDIRECT_URI,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await tokenRes.text();
    if (!tokenRes.ok) {
      logger.warn({ status: tokenRes.status, body: body.slice(0, 300) }, "native token swap failed");
    }
    res.status(tokenRes.status).type("application/json").send(body);
  } catch (err) {
    logger.error({ err }, "native token swap error");
    res.status(502).json({ error: "Token swap failed" });
  }
});

router.post("/spotify/native/refresh", async (req, res) => {
  if (nativeRateLimited(req)) {
    res.status(429).json({ error: "Too many requests" });
    return;
  }
  const clientId = process.env["SPOTIFY_CLIENT_ID"];
  const clientSecret = process.env["SPOTIFY_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    res.status(500).json({ error: "Spotify is not configured on this server." });
    return;
  }
  const refreshToken = typeof req.body?.refresh_token === "string" ? req.body.refresh_token : null;
  if (!refreshToken) {
    res.status(400).json({ error: "Missing refresh_token" });
    return;
  }
  try {
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await tokenRes.text();
    if (!tokenRes.ok) {
      logger.warn({ status: tokenRes.status, body: body.slice(0, 300) }, "native token refresh failed");
    }
    res.status(tokenRes.status).type("application/json").send(body);
  } catch (err) {
    logger.error({ err }, "native token refresh error");
    res.status(502).json({ error: "Token refresh failed" });
  }
});

export default router;
