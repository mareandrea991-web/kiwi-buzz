# Kiwi Buzz

A live music quiz for a room full of phones. The host starts a game, everyone joins with a 6-letter code, a song plays, and the first to buzz gets 10 seconds to name it.

Players just open a web link — there's nothing to install.

---

## Put it online (Render)

One Render "web service" runs everything: the game server and the web page players open.

1. **Put this code on GitHub.** Create a free account at github.com → **New repository** (e.g. `kiwi-buzz`, private is fine) → **uploading an existing file** → drag in everything from this folder → **Commit changes**.
2. **Create a Render account** at render.com and sign in with GitHub.
3. In Render, choose **New → Blueprint**, pick your `kiwi-buzz` repository, and click **Apply**. Render reads `render.yaml` and sets everything up. When it asks for the optional settings, you can leave them blank.
4. Wait for the first build (about 5 minutes). Your game is live at the address Render shows, like `https://kiwi-buzz.onrender.com`.

Every time you change the code on GitHub, Render rebuilds and redeploys automatically.

**Free vs paid:** on Render's free plan the server goes to sleep after 15 minutes with nobody playing, and the first visit after that takes about 30–60 seconds to wake it up. Open the link a minute before your party. The **Starter** plan (about US$7/month) stays awake — change `plan: free` to `plan: starter` in `render.yaml`, or change it in the Render dashboard.

**Good to know:** games live in the server's memory. A redeploy or restart ends any game in progress (players are sent back to the home screen).

### Optional: Spotify Host Mode

Without Spotify, the game uses free 30-second song previews on every phone — that's the default and needs no setup. Spotify Host Mode plays full tracks from the host's own Spotify **Premium** account, on the host's device only.

1. At developer.spotify.com → **Dashboard → Create app**.
2. Add this **Redirect URI** (use your real Render address):
   `https://kiwi-buzz.onrender.com/api/spotify/callback`
3. Copy the app's **Client ID** and **Client Secret** into the Render service: **Environment → SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET**, then **Save** (Render redeploys).

Spotify requires the owner of the developer app to have Premium, otherwise searches fail and the game falls back to previews on its own.

### Optional: your own domain

Add the domain in Render (**Settings → Custom Domains**), then set `PUBLIC_HOSTNAME` to it (e.g. `kiwibuzz.nz`). If you use Spotify, add a matching redirect URI with the new domain.

---

## Android app (APK)

GitHub builds an installable Android app automatically whenever the app code changes (recipe: `.github/workflows/android-apk.yml`). Each build appears under **Releases** on the repository page as **kiwi-buzz.apk** — open that page on an Android phone, download it, and install (allow "Install unknown apps" for your browser if asked). New builds install over the old one.

- The app connects to `kiwi-buzz.onrender.com` — if your Render address changes, update `EXPO_PUBLIC_DOMAIN` in the workflow file.
- To build by hand: repository → **Actions** → **Build Android APK** → **Run workflow**. A build takes about 15–25 minutes.
- Android and web players can be in the same game. iPhones use the web link.
- Spotify Host Mode isn't in the Android app yet: its add-on (`react-native-spotify-remote`) is too old for current Android tools, so it's left out via `expo.autolinking.exclude` in `artifacts/music-quiz/package.json`. Hosting from a web browser still supports Spotify.



| Step | What happens |
|---|---|
| Lobby | Host creates a room. Players scan the QR code on the host's screen (or enter the 6-letter code) — up to 12. Start unlocks once someone has joined |
| 3-2-1 | Countdown before each song; buzzers are locked |
| Listening | Song plays; first buzz wins. Nobody in **30 s** → answer shown, no points |
| Answering | Buzzer has **10 s** to type. Blank = wrong (−1). Typed = locked in for the host to judge |
| Reveal | Host marks it right (+1) or wrong (−1), then goes to the next round |

The host can also skip a song, or end the round early with **Nobody got it — reveal**.

**Dropped connections:** if a phone locks or loses Wi-Fi, it rejoins its game automatically when it reconnects — even after a page refresh. If the host drops, players see "waiting for the host" and the room stays open for 60 seconds.

**Sound on iPhones:** browsers only allow sound after a tap. Joining and buzzing count as taps, so sound normally just works; if a browser still blocks it, a **Tap for sound** button appears.

---

## Run it on your own computer

Needs Node.js 22+ and pnpm (`npm install -g pnpm`).

```bash
pnpm install
pnpm run build:deploy        # builds the web app + server
PORT=8080 PUBLIC_HOSTNAME=localhost pnpm start
```

Then open http://localhost:8080. To test with several "phones", open it in a few browser windows (or private windows).

Other commands:

- `pnpm run typecheck` — check all the code for errors
- `pnpm --filter @workspace/music-quiz exec expo start` — Expo dev server, for working on the app with live reload (set `EXPO_PUBLIC_DOMAIN` to a running server's hostname)

## Settings

| Setting | Needed? | What it does |
|---|---|---|
| `PORT` | Set by Render | Port the server listens on |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | Optional | Enables Spotify Host Mode |
| `PUBLIC_HOSTNAME` | Optional | Your own domain (comma separated for several) |
| `RENDER_EXTERNAL_HOSTNAME` | Set by Render | Your `*.onrender.com` address |
| `EXPO_PUBLIC_DOMAIN` | Only for native phone builds | Server hostname the installed app connects to |

Game timings (countdown, round, answer window, host grace period) are constants at the top of `artifacts/api-server/src/lib/socketHandler.ts`.

---

## Where things live

- `artifacts/music-quiz/` — the app (Expo / React Native, built for the web)
  - `app/index.tsx` — every game screen, chosen by the room's phase
  - `context/GameContext.tsx` — connection to the server, game state, auto-rejoin
  - `lib/webAudio.ts` — song playback in phone browsers
  - `hooks/useSpotify*.ts` — Spotify Host Mode playback
- `artifacts/api-server/` — the server (Express + Socket.IO)
  - `src/lib/gameManager.ts` — rooms, rounds, scoring
  - `src/lib/socketHandler.ts` — live game events and timers
  - `src/lib/spotify*.ts`, `src/routes/spotifyAuth.ts` — song search and Spotify sign-in
  - `src/app.ts` — also serves the built web app
- `render.yaml` — Render deployment setup

### Technical notes

- **Server-owned timers.** The server runs every phase clock and sends `deadlineInMs` (relative, so phone clocks don't matter); the app only displays it.
- **Rejoin tokens.** Each player gets a private `rejoinToken` on create/join, stored on the device. Any reconnect sends `rejoin_room` to reclaim the seat. Tokens are never broadcast.
- **Song queue.** `room.songIndex` points at the next unused song, so skips never repeat a track. The queue is built with 10 spare songs for skips.
- **Song sources.** iTunes previews by default (no key needed); bundled demo songs if iTunes is unreachable. Not every Spotify track has a preview — the server over-fetches and filters.
