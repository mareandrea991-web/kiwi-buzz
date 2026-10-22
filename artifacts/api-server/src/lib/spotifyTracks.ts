/**
 * Spotify Host Mode song queue — searches Spotify with the HOST's access token
 * and returns tracks with Spotify URIs for Web Playback SDK playback.
 * (previewUrl is intentionally empty: Spotify no longer provides preview MP3s;
 * audio plays only on the host device.)
 */
import type { SpotifySong } from "./spotify";
import { logger } from "./logger";

// Search terms per quiz category (mirrors the iTunes mapping)
const CATEGORY_QUERIES: Record<string, string> = {
  Pop: "genre:pop",
  Rock: "genre:rock",
  "Rap / Hip-Hop": "genre:hip-hop",
  "R&B": "genre:r-n-b",
  Dance: "genre:dance",
  "70s": "year:1970-1979",
  "80s": "year:1980-1989",
  "90s": "year:1990-1999",
  "2000s": "year:2000-2009",
  "2010s": "year:2010-2019",
};

interface SpotifyApiTrack {
  uri?: string;
  name?: string;
  artists?: { name: string }[];
  album?: { images?: { url: string }[]; release_date?: string };
}

async function searchCategory(
  category: string,
  limit: number,
  accessToken: string,
  isUserToken: boolean,
): Promise<SpotifySong[]> {
  const q = CATEGORY_QUERIES[category] ?? category;
  // `market=from_token` only works with a USER token; app-level
  // (client-credentials) tokens get 403 — use an explicit market instead.
  // App tokens are also capped at limit=10 per request ("Invalid limit"
  // above that), so we page through several offsets to gather enough tracks.
  const market = isUserToken ? "from_token" : "NZ";
  const maxPerReq = isUserToken ? 50 : 10;
  const want = Math.min(limit + 10, 50);
  const baseOffset = Math.floor(Math.random() * 100);

  const items: SpotifyApiTrack[] = [];
  for (let page = 0; items.length < want && page < Math.ceil(want / maxPerReq); page++) {
    const url =
      `https://api.spotify.com/v1/search?type=track&market=${market}` +
      `&q=${encodeURIComponent(q)}&limit=${Math.min(want - items.length, maxPerReq)}` +
      `&offset=${baseOffset + page * maxPerReq}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      if (items.length) break; // keep what we already have
      throw new Error(`Spotify search failed: ${res.status}`);
    }
    const data = (await res.json()) as { tracks?: { items?: SpotifyApiTrack[] } };
    const got = data.tracks?.items ?? [];
    items.push(...got);
    if (got.length === 0) break;
  }

  return items
    .filter((t) => t.uri && t.name && t.artists?.length)
    .slice(0, limit)
    .map((t) => ({
      title: t.name!,
      artist: t.artists!.map((a) => a.name).join(", "),
      albumArt: t.album?.images?.[1]?.url ?? t.album?.images?.[0]?.url ?? "",
      previewUrl: "", // no preview — host device plays via Web Playback SDK
      spotifyUri: t.uri!,
      year: t.album?.release_date?.slice(0, 4) ?? "",
      category,
    }));
}

export async function buildSpotifySongQueue(
  categories: string[],
  count: number,
  accessToken: string,
  isUserToken = true,
): Promise<SpotifySong[]> {
  if (!categories.length) categories = ["Pop"];
  const perCat = Math.ceil((count + 4) / categories.length);

  const results = await Promise.allSettled(
    categories.map((cat) => searchCategory(cat, perCat + 5, accessToken, isUserToken)),
  );

  const all: SpotifySong[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
    else logger.warn({ err: r.reason }, "Spotify category search failed");
  }

  const seen = new Set<string>();
  const deduped = all.filter((s) => {
    const key = s.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.sort(() => Math.random() - 0.5).slice(0, count + 5);
}
