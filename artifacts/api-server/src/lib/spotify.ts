/**
 * Music track service — uses the iTunes Search API (free, no auth required)
 * as the primary source for 30-second preview URLs and album art.
 * Spotify credentials are no longer needed for this flow.
 */
import { logger } from "./logger";

export interface SpotifySong {
  title: string;
  artist: string;
  albumArt: string;
  previewUrl: string;
  /** Present only in Spotify Host Mode — track URI for Web Playback SDK */
  spotifyUri?: string;
  year: string;
  category: string;
}

// iTunes Search API query terms per category
const CATEGORY_QUERIES: Record<string, string> = {
  Pop: "pop hits",
  Rock: "rock classics",
  "Rap / Hip-Hop": "hip hop rap",
  "R&B": "r&b soul",
  Dance: "dance electronic",
  "70s": "70s greatest hits",
  "80s": "80s greatest hits",
  "90s": "90s greatest hits",
  "2000s": "2000s hits",
  "2010s": "2010s hits",
};

interface ItunesTrack {
  trackName?: string;
  artistName?: string;
  artworkUrl100?: string;
  previewUrl?: string;
  releaseDate?: string;
  primaryGenreName?: string;
}

async function fetchTracksForCategory(category: string, limit: number): Promise<SpotifySong[]> {
  const term = CATEGORY_QUERIES[category] ?? category;
  const offset = Math.floor(Math.random() * 50);

  // iTunes Search API — completely free, no API key required
  const url =
    `https://itunes.apple.com/search?` +
    `term=${encodeURIComponent(term)}&media=music&entity=song` +
    `&limit=${Math.min(limit + 10, 200)}&country=US&explicit=No`;

  const res = await fetch(url, {
    headers: { "User-Agent": "KiwiBuzz/1.0" },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    throw new Error(`iTunes search failed: ${res.status}`);
  }

  const data = (await res.json()) as { results?: ItunesTrack[] };
  const items = data.results ?? [];

  return items
    .filter((t) => t.previewUrl && t.trackName && t.artistName)
    .slice(offset % Math.max(items.length, 1), (offset % Math.max(items.length, 1)) + limit)
    .map((t) => ({
      title: t.trackName!,
      artist: t.artistName!,
      // Replace 100x100 thumbnail with 300x300 for better quality
      albumArt: (t.artworkUrl100 ?? "").replace("100x100bb", "300x300bb"),
      previewUrl: t.previewUrl!,
      year: t.releaseDate?.slice(0, 4) ?? "",
      category,
    }));
}

// Fallback songs used when the network is unavailable.
// previewUrl is empty — the app falls back to the local demo track.
const FALLBACK_SONGS: SpotifySong[] = [
  { title: "Blinding Lights", artist: "The Weeknd", albumArt: "", previewUrl: "", year: "2019", category: "Pop" },
  { title: "Shape of You", artist: "Ed Sheeran", albumArt: "", previewUrl: "", year: "2017", category: "Pop" },
  { title: "Uptown Funk", artist: "Mark Ronson ft. Bruno Mars", albumArt: "", previewUrl: "", year: "2014", category: "Pop" },
  { title: "Rolling in the Deep", artist: "Adele", albumArt: "", previewUrl: "", year: "2010", category: "Pop" },
  { title: "Happy", artist: "Pharrell Williams", albumArt: "", previewUrl: "", year: "2013", category: "Pop" },
  { title: "Bohemian Rhapsody", artist: "Queen", albumArt: "", previewUrl: "", year: "1975", category: "Rock" },
  { title: "Smells Like Teen Spirit", artist: "Nirvana", albumArt: "", previewUrl: "", year: "1991", category: "Rock" },
  { title: "Hotel California", artist: "Eagles", albumArt: "", previewUrl: "", year: "1977", category: "Rock" },
  { title: "HUMBLE.", artist: "Kendrick Lamar", albumArt: "", previewUrl: "", year: "2017", category: "Rap / Hip-Hop" },
  { title: "God's Plan", artist: "Drake", albumArt: "", previewUrl: "", year: "2018", category: "Rap / Hip-Hop" },
  { title: "Lose Yourself", artist: "Eminem", albumArt: "", previewUrl: "", year: "2002", category: "Rap / Hip-Hop" },
  { title: "No Scrubs", artist: "TLC", albumArt: "", previewUrl: "", year: "1999", category: "R&B" },
  { title: "Crazy in Love", artist: "Beyoncé", albumArt: "", previewUrl: "", year: "2003", category: "R&B" },
  { title: "One More Time", artist: "Daft Punk", albumArt: "", previewUrl: "", year: "2000", category: "Dance" },
  { title: "Levels", artist: "Avicii", albumArt: "", previewUrl: "", year: "2011", category: "Dance" },
  { title: "Sweet Child O' Mine", artist: "Guns N' Roses", albumArt: "", previewUrl: "", year: "1987", category: "80s" },
  { title: "Girls Just Want to Have Fun", artist: "Cyndi Lauper", albumArt: "", previewUrl: "", year: "1983", category: "80s" },
  { title: "...Baby One More Time", artist: "Britney Spears", albumArt: "", previewUrl: "", year: "1998", category: "90s" },
  { title: "Waterfalls", artist: "TLC", albumArt: "", previewUrl: "", year: "1994", category: "90s" },
  { title: "In Da Club", artist: "50 Cent", albumArt: "", previewUrl: "", year: "2003", category: "2000s" },
];

export async function buildSongQueue(categories: string[], count: number): Promise<SpotifySong[]> {
  if (!categories.length) categories = ["Pop"];
  const perCat = Math.ceil((count + 4) / categories.length);

  const results = await Promise.allSettled(
    categories.map((cat) => fetchTracksForCategory(cat, perCat + 5)),
  );

  const all: SpotifySong[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
    else logger.warn({ err: r.reason }, "iTunes category fetch failed");
  }

  // Dedupe by title
  const seen = new Set<string>();
  const deduped = all.filter((s) => {
    const key = s.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const tracks = deduped.sort(() => Math.random() - 0.5).slice(0, count + 5);

  if (tracks.length === 0) {
    logger.warn("iTunes returned 0 tracks — using fallback song list");
    return FALLBACK_SONGS.sort(() => Math.random() - 0.5).slice(0, count + 5);
  }

  return tracks;
}
