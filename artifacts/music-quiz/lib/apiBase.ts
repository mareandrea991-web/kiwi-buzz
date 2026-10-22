/**
 * Where the game server lives.
 *
 * - Web (the normal case): the server also serves this page, so we use the
 *   same site the page came from — leave EXPO_PUBLIC_DOMAIN unset.
 * - Native phone builds: set EXPO_PUBLIC_DOMAIN to the server's hostname,
 *   e.g. EXPO_PUBLIC_DOMAIN=kiwi-buzz.onrender.com
 */
const domain = (process.env['EXPO_PUBLIC_DOMAIN'] ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');

/** "https://host" for native builds, "" (same site) on the web */
export const SERVER_ORIGIN = domain ? `https://${domain}` : '';

/** Base URL for REST calls, e.g. `${API_BASE}/spotify/session` */
export const API_BASE = `${SERVER_ORIGIN}/api`;
