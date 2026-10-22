import { Server, Socket } from "socket.io";
import * as gm from "./gameManager";
import { buildSongQueue } from "./spotify";
import { buildSpotifySongQueue } from "./spotifyTracks";
import { getSession, getFreshAccessToken } from "./spotifySessions";
import { getAppAccessToken } from "./spotifyAppToken";
import { sidFromCookieHeader } from "../routes/spotifyAuth";
import { logger } from "./logger";

// ── timings ───────────────────────────────────────────────────────────────────
/** "3-2-1" before buzzers unlock */
export const COUNTDOWN_MS = 3500;
/** how long the track plays with open buzzers before "nobody got it" */
export const ROUND_MS = 30_000;
/** how long the buzzer player has to type an answer */
export const ANSWER_MS = 10_000;
/** how long a room waits for a disconnected host before closing */
export const HOST_GRACE_MS = 60_000;

// ── payload validation ────────────────────────────────────────────────────────
const VALID_COLORS = new Set(["coral", "blue", "yellow", "mint", "purple", "orange"]);
function asStr(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
}
function asObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

// ── serialisers ───────────────────────────────────────────────────────────────
function publicPlayers(room: gm.GameRoom) {
  return gm.getPlayersArray(room).map((p) => ({
    playerId: p.playerId,
    name: p.name,
    color: p.color,
    score: p.score,
    isHost: p.isHost,
    connected: p.connected,
    left: p.left ?? false,
  }));
}

function publicRoom(room: gm.GameRoom) {
  const winner = room.buzzerWinnerSocketId
    ? room.players.get(room.buzzerWinnerSocketId)
    : null;
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    totalRounds: room.totalRounds,
    players: publicPlayers(room),
    buzzerWinnerId: winner?.playerId ?? null,
    buzzerWinnerName: winner?.name ?? null,
    buzzerWinnerColor: winner?.color ?? null,
    songsReady: room.songsReady,
    musicSource: room.musicSource,
    // Relative, not absolute, so phone clocks that disagree don't matter
    deadlineInMs: room.deadlineAt ? Math.max(0, room.deadlineAt - Date.now()) : null,
    answerLocked: room.answerLocked,
  };
}

// Host gets full song info; players only get what they need to play audio + show art
function songForHost(song: gm.Song) {
  return { title: song.title, artist: song.artist, albumArt: song.albumArt, previewUrl: song.previewUrl, spotifyUri: song.spotifyUri ?? null, year: song.year, category: song.category };
}
function songForPlayer(song: gm.Song) {
  return { albumArt: song.albumArt, previewUrl: song.previewUrl, year: song.year, category: song.category };
}

// ── handler ───────────────────────────────────────────────────────────────────
export function setupSocketHandlers(io: Server) {
  // One phase timer per room (countdown → round → answer window)
  const phaseTimers = new Map<string, NodeJS.Timeout>();
  // Rooms whose host has dropped and may come back
  const hostGraceTimers = new Map<string, NodeJS.Timeout>();

  function clearPhaseTimer(code: string) {
    const t = phaseTimers.get(code);
    if (t) clearTimeout(t);
    phaseTimers.delete(code);
    const room = gm.getRoom(code);
    if (room) room.deadlineAt = null;
  }

  function setPhaseTimer(code: string, ms: number, fn: () => void) {
    clearPhaseTimer(code);
    const room = gm.getRoom(code);
    if (!room) return;
    room.deadlineAt = Date.now() + ms;
    phaseTimers.set(code, setTimeout(() => {
      phaseTimers.delete(code);
      const r = gm.getRoom(code);
      if (r) r.deadlineAt = null;
      fn();
    }, ms));
  }

  function clearHostGrace(code: string) {
    const t = hostGraceTimers.get(code);
    if (t) clearTimeout(t);
    hostGraceTimers.delete(code);
  }

  function closeRoomFor(code: string, message: string) {
    clearPhaseTimer(code);
    clearHostGrace(code);
    gm.closeRoom(code);
    io.to(code).emit("game_ended", { message });
    io.socketsLeave(code);
  }

  function emitReveal(room: gm.GameRoom, reveal: gm.RoundReveal) {
    io.to(room.code).emit("answer_result", {
      ...reveal,
      isCorrect: reveal.outcome === "correct",
      room: publicRoom(room),
    });
  }

  /** Track is playing with open buzzers; nobody buzzing in time ends the round. */
  function startRoundClock(code: string) {
    setPhaseTimer(code, ROUND_MS, () => {
      const result = gm.revealNobody(code);
      if (result) emitReveal(result.room, result.reveal);
    });
  }

  /** Emit a new round (or replacement song) and run the 3-2-1 countdown. */
  function launchRound(socket: Socket, room: gm.GameRoom, song: gm.Song) {
    const code = room.code;
    const token = room.countdownToken;
    setPhaseTimer(code, COUNTDOWN_MS, () => {
      const updated = gm.openBuzzers(code, token);
      if (!updated) return;
      startRoundClock(code);
      io.to(code).emit("buzzers_open", { room: publicRoom(updated) });
    });
    const pr = publicRoom(room);
    socket.emit("round_started", { room: pr, song: songForHost(song), isHost: true });
    socket.to(code).emit("round_started", { room: pr, song: songForPlayer(song), isHost: false });
  }

  /** Validate that this socket is the host of the room named in the payload. */
  function hostRoom(socket: Socket, payload: unknown): gm.GameRoom | null {
    const roomCode = asStr(asObj(payload)?.['roomCode'], 10)?.toUpperCase();
    if (!roomCode) return null;
    const room = gm.getRoom(roomCode);
    if (!room || socket.id !== room.hostSocketId) return null;
    return room;
  }

  io.on("connection", (socket: Socket) => {
    logger.info({ id: socket.id }, "socket connected");

    // ── create_room ──────────────────────────────────────────────────────────
    socket.on(
      "create_room",
      async (payload: unknown) => {
        const p = asObj(payload);
        if (!p) return;
        const playerName = asStr(p['playerName'], 30);
        const color = asStr(p['color'], 20) as gm.PlayerColor | null;
        if (!playerName || !color || !VALID_COLORS.has(color)) return;
        const categories = Array.isArray(p['categories'])
          ? (p['categories'].filter((c) => typeof c === "string") as string[]).slice(0, 10).map((c) => c.slice(0, 40))
          : [];
        const rounds = typeof p['rounds'] === "number" && Number.isFinite(p['rounds'])
          ? Math.min(30, Math.max(1, Math.floor(p['rounds'])))
          : 10;

        // Optional Spotify Host Mode — the session id comes ONLY from the
        // HttpOnly cookie on the socket handshake, never from the payload.
        // Native Android hosts (App Remote) have no cookie session: the host
        // authenticates on-device, so the server only needs app-level search
        // access (client credentials) to build the queue. Playback still
        // happens exclusively on the host's device.
        let musicSource: gm.MusicSource = "itunes";
        let spotifySessionId: string | null = null;
        if (p['musicSource'] === "spotify") {
          const sid = sidFromCookieHeader(socket.handshake.headers.cookie);
          if (sid && getSession(sid)) {
            musicSource = "spotify";
            spotifySessionId = sid;
          } else if (p['nativeSpotify'] === true) {
            // Native Android host — declared explicitly; without it, cookie-less
            // spotify requests keep the original iTunes fallback behavior.
            musicSource = "spotify";
          }
        }

        const room = gm.createRoom(socket.id, playerName, color, categories, rounds, musicSource, spotifySessionId);
        socket.join(room.code);

        const host = gm.getPlayersArray(room).find((p) => p.isHost)!;
        socket.emit("room_created", {
          roomCode: room.code,
          playerId: host.playerId,
          rejoinToken: host.token,
          room: publicRoom(room),
        });

        // Build the song queue in the background. Extra songs cover skips.
        const cats = categories.length ? categories : ["Pop"];
        const buildQueue = async (): Promise<gm.Song[]> => {
          if (musicSource === "spotify") {
            try {
              // Web host: fresh user token from the cookie session.
              // Native host: app-level client-credentials token (search only).
              const token = spotifySessionId
                ? await getFreshAccessToken(spotifySessionId)
                : await getAppAccessToken();
              if (!token) throw new Error("Spotify session expired");
              const songs = await buildSpotifySongQueue(cats, rounds + 10, token, !!spotifySessionId);
              if (!songs.length) throw new Error("Spotify search returned no tracks");
              return songs;
            } catch (err) {
              // Fall back to iTunes previews so the game is never blocked
              logger.warn({ err, code: room.code }, "Spotify queue failed — falling back to iTunes");
              gm.setMusicSource(room.code, "itunes");
              io.to(room.code).emit("music_source_fallback", {
                message: "Spotify was unavailable — using song previews instead.",
              });
            }
          }
          return buildSongQueue(cats, rounds + 10);
        };
        buildQueue()
          .then((songs) => {
            gm.setSongQueue(room.code, songs);
            io.to(room.code).emit("songs_ready", { count: songs.length });
            logger.info({ code: room.code, count: songs.length, source: gm.getRoom(room.code)?.musicSource }, "Song queue ready");
          })
          .catch((err) => {
            logger.error({ err }, "Failed to build song queue");
          });
      },
    );

    // ── join_room ────────────────────────────────────────────────────────────
    socket.on(
      "join_room",
      (payload: unknown) => {
        logger.info({ sid: socket.id }, "join_room received");
        const p = asObj(payload);
        if (!p) {
          logger.warn({ sid: socket.id }, "join_room: malformed payload");
          return;
        }
        const roomCode = asStr(p['roomCode'], 10)?.toUpperCase();
        const playerName = asStr(p['playerName'], 30);
        const color = asStr(p['color'], 20) as gm.PlayerColor | null;
        if (!roomCode || !playerName || !color || !VALID_COLORS.has(color)) {
          logger.warn({ sid: socket.id, roomCode }, "join_room: invalid fields → join_error sent");
          socket.emit("join_error", { message: "Invalid join request." });
          return;
        }
        const result = gm.joinRoom(roomCode, socket.id, playerName, color);
        if ("error" in result) {
          logger.info({ sid: socket.id, roomCode, error: result.error }, "join_room: rejected → join_error sent");
          socket.emit("join_error", { message: result.error });
          return;
        }
        logger.info({ sid: socket.id, roomCode, player: playerName }, "join_room: success → room_joined sent");
        socket.join(roomCode);
        socket.emit("room_joined", {
          roomCode,
          playerId: result.player.playerId,
          rejoinToken: result.player.token,
          room: publicRoom(result.room),
        });
        socket.to(roomCode).emit("room_updated", publicRoom(result.room));
      },
    );

    // ── rejoin_room — a dropped player/host comes back on a new socket ───────
    socket.on("rejoin_room", (payload: unknown) => {
      const p = asObj(payload);
      const roomCode = asStr(p?.['roomCode'], 10)?.toUpperCase();
      const playerId = asStr(p?.['playerId'], 40);
      const token = asStr(p?.['rejoinToken'], 80);
      if (!roomCode || !playerId || !token) {
        socket.emit("rejoin_error", { message: "Could not rejoin that game." });
        return;
      }
      const result = gm.rejoinRoom(roomCode, socket.id, playerId, token);
      if ("error" in result) {
        socket.emit("rejoin_error", { message: result.error });
        return;
      }
      const { room, player, oldSocketId } = result;
      // Detach a stale socket the server still thinks is alive
      if (oldSocketId !== socket.id) io.sockets.sockets.get(oldSocketId)?.leave(roomCode);
      socket.join(roomCode);
      if (player.isHost) clearHostGrace(roomCode);

      const song = room.currentSong;
      const iAmBuzzer = room.buzzerWinnerSocketId === socket.id;
      socket.emit("room_rejoined", {
        roomCode,
        playerId: player.playerId,
        isHost: player.isHost,
        room: publicRoom(room),
        song: song ? (player.isHost ? songForHost(song) : songForPlayer(song)) : null,
        reveal: room.phase === "revealing" ? room.lastReveal : null,
        iAmBuzzer,
        answerText: player.isHost || iAmBuzzer ? room.answerText : "",
      });
      socket.to(roomCode).emit("room_updated", publicRoom(room));
      logger.info({ code: roomCode, player: player.name, host: player.isHost }, "player rejoined");
    });

    // ── start_game ───────────────────────────────────────────────────────────
    socket.on("start_game", (payload: unknown) => {
      const room = hostRoom(socket, payload);
      if (!room) return;

      const result = gm.startRound(room.code);
      if ("error" in result) {
        socket.emit("start_error", { message: result.error });
        return;
      }
      launchRound(socket, result.room, result.song);
    });

    // ── switch_music_source — host switches a live Spotify game to previews ──
    // Never destroys the room: rebuilds the not-yet-played part of the queue
    // with iTunes previews and notifies everyone. Host-only, spotify rooms only.
    socket.on("switch_music_source", async (payload: unknown) => {
      const room = hostRoom(socket, payload);
      if (!room || room.musicSource !== "spotify") return;
      const roomCode = room.code;

      try {
        const cats = room.categories.length ? room.categories : ["Pop"];
        const remaining = Math.max(room.totalRounds - room.round, 1) + 5;
        const songs = await buildSongQueue(cats, remaining);
        if (!songs.length) throw new Error("iTunes returned no tracks");
        const updated = gm.replaceUpcomingSongs(roomCode, songs);
        if (!updated) return;
        gm.setMusicSource(roomCode, "itunes");
        io.to(roomCode).emit("music_source_fallback", {
          message: "Switched to song previews — they start with the next song.",
        });
        io.to(roomCode).emit("room_updated", publicRoom(gm.getRoom(roomCode)!));
        logger.info({ code: roomCode }, "host switched music source to itunes mid-game");
      } catch (err) {
        logger.warn({ err, code: roomCode }, "switch_music_source failed");
        socket.emit("error", { message: "Could not switch to previews — try again." });
      }
    });

    // ── player_answer — player types their answer, host sees it live ─────────
    socket.on("player_answer", (payload: unknown) => {
      const p = asObj(payload);
      const roomCode = asStr(p?.['roomCode'], 10)?.toUpperCase();
      const answerText = typeof p?.['answerText'] === "string" ? (p['answerText'] as string).slice(0, 200) : null;
      if (!roomCode || answerText === null) return;
      const room = gm.getRoom(roomCode);
      if (!room) return;
      const player = room.players.get(socket.id);
      if (!player || player.left || !player.connected) return;
      // Only the buzzer player, and only while the answer window is open
      if (!gm.setAnswerText(roomCode, socket.id, answerText)) return;
      io.to(room.hostSocketId).emit("player_answered", {
        answerText,
        fromName: player.name,
        fromColor: player.color,
      });
    });

    // ── buzz ─────────────────────────────────────────────────────────────────
    socket.on("buzz", (payload: unknown) => {
      const roomCode = asStr(asObj(payload)?.['roomCode'], 10)?.toUpperCase();
      if (!roomCode) return;
      const result = gm.buzz(roomCode, socket.id);
      if (!result) return; // rejected (too slow or wrong phase)

      // Answer window: if they type nothing in time it counts as wrong;
      // if they typed something, lock it and let the host judge.
      setPhaseTimer(roomCode, ANSWER_MS, () => {
        const room = gm.getRoom(roomCode);
        if (!room || room.phase !== "buzzed") return;
        if (room.answerText.trim()) {
          const locked = gm.lockAnswer(roomCode);
          if (locked) io.to(roomCode).emit("room_updated", publicRoom(locked));
          return;
        }
        const res = gm.resolveAnswer(roomCode, "timeout");
        if (res) emitReveal(res.room, res.reveal);
      });

      io.to(roomCode).emit("buzz_locked", {
        winnerId: result.winner.playerId,
        winnerName: result.winner.name,
        winnerColor: result.winner.color,
        winnerSocketId: socket.id,
        room: publicRoom(result.room),
      });
    });

    // ── host_accept / host_reject ────────────────────────────────────────────
    const judge = (outcome: "correct" | "wrong") => (payload: unknown) => {
      const room = hostRoom(socket, payload);
      if (!room) return;
      const result = gm.resolveAnswer(room.code, outcome);
      if (!result) return;
      clearPhaseTimer(room.code);
      emitReveal(result.room, result.reveal);
    };
    socket.on("host_accept", judge("correct"));
    socket.on("host_reject", judge("wrong"));

    // ── reveal_answer — host ends the round with no winner ───────────────────
    socket.on("reveal_answer", (payload: unknown) => {
      const room = hostRoom(socket, payload);
      if (!room) return;
      const result = gm.revealNobody(room.code);
      if (!result) return;
      clearPhaseTimer(room.code);
      emitReveal(result.room, result.reveal);
    });

    // ── next_round ───────────────────────────────────────────────────────────
    socket.on("next_round", (payload: unknown) => {
      const room = hostRoom(socket, payload);
      if (!room) return;

      const result = gm.nextRound(room.code);
      if (!result) return;

      if (result.finished) {
        clearPhaseTimer(room.code);
        io.to(room.code).emit("game_over", { room: publicRoom(result.room) });
        return;
      }
      launchRound(socket, result.room, result.song);
    });

    // ── skip_song ────────────────────────────────────────────────────────────
    socket.on("skip_song", (payload: unknown) => {
      const room = hostRoom(socket, payload);
      if (!room) return;
      const result = gm.skipSong(room.code);
      if (!result) return;
      launchRound(socket, result.room, result.song);
    });

    // ── leave_room — player deliberately exits ───────────────────────────────
    socket.on("leave_room", (payload: unknown) => {
      const roomCode = asStr(asObj(payload)?.['roomCode'], 10)?.toUpperCase();
      if (!roomCode) return;
      const result = gm.leaveRoom(roomCode, socket.id);
      if (!result) return;
      socket.leave(roomCode);
      // The buzzer walked out mid-answer — reopen buzzers with a fresh clock
      if (result.buzzerReleased) {
        startRoundClock(roomCode);
        io.to(roomCode).emit("buzzers_open", { room: publicRoom(result.room) });
      } else {
        io.to(roomCode).emit("room_updated", publicRoom(result.room));
      }
      logger.info({ code: roomCode, id: socket.id }, "player left room");
    });

    // ── end_game — host closes the room for everyone ─────────────────────────
    socket.on("end_game", (payload: unknown) => {
      const room = hostRoom(socket, payload);
      if (!room) return;
      closeRoomFor(room.code, "The host ended the game.");
      logger.info({ code: room.code }, "host ended game — room closed");
    });

    // ── disconnect ───────────────────────────────────────────────────────────
    // Phones drop connections constantly (screen locks, Wi-Fi blips). Keep
    // everyone's seat; give a missing host a grace period to come back.
    socket.on("disconnect", () => {
      const result = gm.handleDisconnect(socket.id);
      if (!result) return;
      const { roomCode, room, isHost } = result;
      io.to(roomCode).emit("room_updated", publicRoom(room));

      if (isHost) {
        clearHostGrace(roomCode);
        hostGraceTimers.set(roomCode, setTimeout(() => {
          hostGraceTimers.delete(roomCode);
          const r = gm.getRoom(roomCode);
          const host = r ? gm.getHost(r) : null;
          if (r && host && !host.connected) {
            closeRoomFor(roomCode, "The host didn't come back — the game is over.");
            logger.info({ code: roomCode }, "host grace expired — room closed");
          }
        }, HOST_GRACE_MS));
        logger.info({ code: roomCode }, "host disconnected — waiting for rejoin");
      }
    });
  });
}
