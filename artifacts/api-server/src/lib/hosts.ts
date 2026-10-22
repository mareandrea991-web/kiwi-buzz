/**
 * The public hostnames this server is reachable on. Used for CORS and to build
 * safe Spotify redirect URLs.
 *
 * - PUBLIC_HOSTNAME: your own domain(s), comma separated (e.g. "kiwibuzz.nz")
 * - RENDER_EXTERNAL_HOSTNAME: set automatically by Render (e.g. "kiwi-buzz.onrender.com")
 */
export function ourHosts(): string[] {
  return [
    ...(process.env["PUBLIC_HOSTNAME"]?.split(",") ?? []),
    process.env["RENDER_EXTERNAL_HOSTNAME"],
  ]
    .filter(Boolean)
    .map((d) => d!.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);
}

/** The main public hostname (first configured), if any. */
export function primaryHost(): string | null {
  return ourHosts()[0] ?? null;
}
