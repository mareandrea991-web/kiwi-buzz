import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { ourHosts } from "./lib/hosts";
import fs from "node:fs";
import path from "node:path";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// CORS with credentials so the app can send the HttpOnly Spotify session
// cookie. Only our own frontends are allowed.
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // same-origin / curl
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    if (ourHosts().includes(hostname)) return true;
    // localhost only ever allowed outside production
    return hostname === "localhost" && process.env["NODE_ENV"] !== "production";
  } catch {
    return false;
  }
}

app.use(cors({
  origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// ── the web app ──────────────────────────────────────────────────────────────
// The same server hands out the game itself, so players just open the link.
// Built by `pnpm run build:deploy` into artifacts/music-quiz/dist-web.
const webDir = [
  process.env["WEB_DIR"],
  path.resolve(process.cwd(), "artifacts/music-quiz/dist-web"),
  path.resolve(process.cwd(), "../music-quiz/dist-web"),
].find((d): d is string => !!d && fs.existsSync(path.join(d, "index.html")));

if (webDir) {
  logger.info({ webDir }, "Serving web app");
  app.use(express.static(webDir, {
    index: "index.html",
    // The bundler puts fonts under ".pnpm" folders — those must be served
    dotfiles: "allow",
    setHeaders(res, filePath) {
      // Hashed bundles can be cached forever; the page itself must not be
      if (filePath.includes(`${path.sep}_expo${path.sep}`) || filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }));
  // Any other page URL → the app (it handles its own screens)
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    // A missing file (font, image…) should 404, not get the page back
    if (path.extname(req.path)) return next();
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(webDir, "index.html"));
  });
} else {
  logger.warn("Web app build not found — only the API is being served. Run `pnpm run build:deploy`.");
}

export default app;
