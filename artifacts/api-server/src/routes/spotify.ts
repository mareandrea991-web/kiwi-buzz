import { Router } from "express";
import { buildSongQueue } from "../lib/spotify.js";

const spotifyRouter = Router();

// GET /api/music/tracks?category=Pop&limit=10
spotifyRouter.get("/music/tracks", async (req, res) => {
  const category =
    typeof req.query.category === "string" ? req.query.category : "Pop";
  const rawLimit =
    typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 10;
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 10;

  try {
    const tracks = await buildSongQueue([category], limit);
    res.json({ category, tracks });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(502).json({ error: message });
  }
});

export default spotifyRouter;
