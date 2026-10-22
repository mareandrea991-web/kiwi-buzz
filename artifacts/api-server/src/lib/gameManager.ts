export type PlayerColor = "coral" | "blue" | "yellow" | "mint" | "purple" | "orange";
export type GamePhase = "lobby" | "countdown" | "playing" | "buzzed" | "revealing" | "finished";

export interface GamePlayer {
  socketId: string;
  playerId: string;
  /** private secret used to rejoin after a dropped connection — never broadcast */
  token: string;
  name: string;
  color: PlayerColor;
  score: number;
  isHost: boolean;
  connected: boolean;
  left?: boolean; // player deliberately exited the game
}

export type MusicSource = "itunes" | "spotify";

export interface Song {
  title: string;
  artist: string;
  albumArt: string;
  previewUrl: string;
  /** Spotify Host Mode only — track URI played on the host device */
  spotifyUri?: string;
  year: string;
  category: string;
}

/** How a round ended. */
export type RoundOutcome = "correct" | "wrong" | "timeout" | "nobody";

export interface RoundReveal {
  outcome: RoundOutcome;
  correctTitle: string;
  correctArtist: string;
  buzzerId: string | null;
  buzzerName: string | null;
}

export interface GameRoom {
  code: string;
  hostSocketId: string;
  players: Map<string, GamePlayer>; // keyed by socketId
  phase: GamePhase;
  round: number;
  totalRounds: number;
  currentSong: Song | null;
  buzzerWinnerSocketId: string | null;
  countdownToken: number; // invalidates stale phase timers
  songQueue: Song[];
  /** index of the next unplayed song in songQueue (rounds + skips both consume songs) */
  songIndex: number;
  categories: string[];
  songsReady: boolean;
  musicSource: MusicSource;
  /** Spotify Host Mode only — opaque server-side session id for the host's account */
  spotifySessionId: string | null;
  /** epoch ms when the current phase's timer fires, or null if untimed */
  deadlineAt: number | null;
  /** latest answer text typed by the buzzer player this round */
  answerText: string;
  /** the answer window has closed — the buzzer can no longer edit */
  answerLocked: boolean;
  /** result of the current round once revealed (kept so reconnecting clients can render it) */
  lastReveal: RoundReveal | null;
}

// ── internal state ────────────────────────────────────────────────────────────
const rooms = new Map<string, GameRoom>();
const socketToRoom = new Map<string, string>(); // socketId → roomCode

// ── helpers ───────────────────────────────────────────────────────────────────
function makeCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code: string;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function makeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function makeToken(): string {
  return Array.from({ length: 3 }, () => Math.random().toString(36).slice(2)).join("");
}

export function getPlayersArray(room: GameRoom): GamePlayer[] {
  return Array.from(room.players.values());
}

export function getRoom(code: string): GameRoom | null {
  return rooms.get(code) ?? null;
}

export function getRoomBySocket(socketId: string): GameRoom | null {
  const code = socketToRoom.get(socketId);
  return code ? (rooms.get(code) ?? null) : null;
}

export function getHost(room: GameRoom): GamePlayer | null {
  return room.players.get(room.hostSocketId) ?? null;
}

/** Take the next song off the queue (wrapping if we somehow run out). */
function consumeSong(room: GameRoom): Song | null {
  if (!room.songQueue.length) return null;
  const song = room.songQueue[room.songIndex % room.songQueue.length] ?? null;
  room.songIndex += 1;
  return song;
}

function resetRoundState(room: GameRoom) {
  room.buzzerWinnerSocketId = null;
  room.answerText = "";
  room.answerLocked = false;
  room.lastReveal = null;
}

// ── mutations ─────────────────────────────────────────────────────────────────
export function createRoom(
  hostSocketId: string,
  playerName: string,
  color: PlayerColor,
  categories: string[],
  rounds: number,
  musicSource: MusicSource = "itunes",
  spotifySessionId: string | null = null,
): GameRoom {
  const code = makeCode();
  const host: GamePlayer = {
    socketId: hostSocketId,
    playerId: makeId(),
    token: makeToken(),
    name: playerName,
    color,
    score: 0,
    isHost: true,
    connected: true,
  };
  const room: GameRoom = {
    code,
    hostSocketId,
    players: new Map([[hostSocketId, host]]),
    phase: "lobby",
    round: 0,
    totalRounds: rounds,
    currentSong: null,
    buzzerWinnerSocketId: null,
    countdownToken: 0,
    songQueue: [],
    songIndex: 0,
    categories,
    songsReady: false,
    musicSource,
    spotifySessionId,
    deadlineAt: null,
    answerText: "",
    answerLocked: false,
    lastReveal: null,
  };
  rooms.set(code, room);
  socketToRoom.set(hostSocketId, code);
  return room;
}

export function joinRoom(
  code: string,
  socketId: string,
  playerName: string,
  color: PlayerColor,
): { room: GameRoom; player: GamePlayer } | { error: string } {
  const room = rooms.get(code);
  if (!room) return { error: "Room not found. Check your code." };
  if (room.phase !== "lobby") return { error: "This game has already started." };
  if (room.players.size >= 12) return { error: "Room is full (max 12 players)." };

  const player: GamePlayer = {
    socketId,
    playerId: makeId(),
    token: makeToken(),
    name: playerName,
    color,
    score: 0,
    isHost: false,
    connected: true,
  };
  room.players.set(socketId, player);
  socketToRoom.set(socketId, code);
  return { room, player };
}

/**
 * Re-attach a player who lost their connection to a new socket.
 * Requires the private token handed out when they created/joined the room.
 */
export function rejoinRoom(
  code: string,
  newSocketId: string,
  playerId: string,
  token: string,
): { room: GameRoom; player: GamePlayer; oldSocketId: string } | { error: string } {
  const room = rooms.get(code);
  if (!room) return { error: "That game has ended." };

  let oldSocketId: string | null = null;
  let player: GamePlayer | null = null;
  for (const [sid, p] of room.players) {
    if (p.playerId === playerId) { oldSocketId = sid; player = p; break; }
  }
  if (!player || oldSocketId === null || player.token !== token) return { error: "Could not rejoin that game." };
  if (player.left) return { error: "You left that game." };

  if (oldSocketId !== newSocketId) {
    room.players.delete(oldSocketId);
    room.players.set(newSocketId, player);
    socketToRoom.delete(oldSocketId);
    if (room.hostSocketId === oldSocketId) room.hostSocketId = newSocketId;
    if (room.buzzerWinnerSocketId === oldSocketId) room.buzzerWinnerSocketId = newSocketId;
  }
  player.socketId = newSocketId;
  player.connected = true;
  socketToRoom.set(newSocketId, code);
  return { room, player, oldSocketId };
}

export function setSongQueue(code: string, songs: Song[]): void {
  const room = rooms.get(code);
  if (!room) return;
  room.songQueue = songs;
  room.songIndex = 0;
  room.songsReady = true;
}

/**
 * Replace all not-yet-played songs with a new queue — used when the host
 * switches a live Spotify game to iTunes previews. Songs already used
 * (played or skipped, including the current one) keep their entries.
 */
export function replaceUpcomingSongs(code: string, songs: Song[]): GameRoom | null {
  const room = rooms.get(code);
  if (!room || !songs.length) return null;
  const used = room.songQueue.slice(0, Math.max(0, room.songIndex));
  room.songQueue = [...used, ...songs];
  return room;
}

export function setMusicSource(code: string, source: MusicSource): void {
  const room = rooms.get(code);
  if (room) room.musicSource = source;
}

export function startRound(
  code: string,
): { room: GameRoom; song: Song } | { error: string } {
  const room = rooms.get(code);
  if (!room) return { error: "Room not found" };
  // A new round may only start from the lobby or after a reveal
  if (room.phase !== "lobby" && room.phase !== "revealing") return { error: "Round already in progress" };
  if (!room.songsReady || !room.songQueue.length) return { error: "Songs not ready yet — wait a moment" };
  if (room.phase === "lobby" && !getPlayersArray(room).some((p) => !p.isHost && !p.left)) {
    return { error: "Wait for at least one player to join first." };
  }

  const song = consumeSong(room);
  if (!song) return { error: "No songs available" };

  room.round += 1;
  room.phase = "countdown";
  room.countdownToken += 1;
  room.currentSong = song;
  resetRoundState(room);
  return { room, song };
}

export function openBuzzers(code: string, token: number): GameRoom | null {
  const room = rooms.get(code);
  if (!room) return null;
  // Only open buzzers if this timer belongs to the current countdown —
  // a stale timer from a skipped/replaced round must not reopen the room.
  if (room.phase !== "countdown" || room.countdownToken !== token) return null;
  room.phase = "playing";
  return room;
}

export function buzz(
  code: string,
  socketId: string,
): { winner: GamePlayer; room: GameRoom } | null {
  const room = rooms.get(code);
  if (!room || room.phase !== "playing") return null;
  if (room.buzzerWinnerSocketId) return null; // already claimed

  const player = room.players.get(socketId);
  if (!player || player.isHost || player.left || !player.connected) return null;

  room.buzzerWinnerSocketId = socketId;
  room.phase = "buzzed";
  room.answerText = "";
  room.answerLocked = false;
  return { winner: player, room };
}

export function setAnswerText(code: string, socketId: string, text: string): GameRoom | null {
  const room = rooms.get(code);
  if (!room || room.phase !== "buzzed" || room.answerLocked) return null;
  if (room.buzzerWinnerSocketId !== socketId) return null;
  room.answerText = text;
  return room;
}

/** Close the answer window — the buzzer can no longer type. */
export function lockAnswer(code: string): GameRoom | null {
  const room = rooms.get(code);
  if (!room || room.phase !== "buzzed") return null;
  room.answerLocked = true;
  return room;
}

/** Judge the buzzer's answer: correct +1, wrong / out of time −1. */
export function resolveAnswer(
  code: string,
  outcome: "correct" | "wrong" | "timeout",
): { room: GameRoom; reveal: RoundReveal } | null {
  const room = rooms.get(code);
  if (!room || !room.currentSong) return null;
  if (room.phase !== "buzzed") return null; // prevent double-scoring the same round

  const winner = room.buzzerWinnerSocketId
    ? room.players.get(room.buzzerWinnerSocketId)
    : null;
  if (winner) winner.score += outcome === "correct" ? 1 : -1;

  room.phase = "revealing";
  room.lastReveal = {
    outcome,
    correctTitle: room.currentSong.title,
    correctArtist: room.currentSong.artist,
    buzzerId: winner?.playerId ?? null,
    buzzerName: winner?.name ?? null,
  };
  return { room, reveal: room.lastReveal };
}

/** Nobody buzzed (or the host gave up on the round) — reveal with no points. */
export function revealNobody(code: string): { room: GameRoom; reveal: RoundReveal } | null {
  const room = rooms.get(code);
  if (!room || !room.currentSong) return null;
  if (room.phase !== "playing" && room.phase !== "countdown") return null;

  room.phase = "revealing";
  room.buzzerWinnerSocketId = null;
  room.lastReveal = {
    outcome: "nobody",
    correctTitle: room.currentSong.title,
    correctArtist: room.currentSong.artist,
    buzzerId: null,
    buzzerName: null,
  };
  return { room, reveal: room.lastReveal };
}

export function nextRound(
  code: string,
): { room: GameRoom; song: Song; finished: boolean } | null {
  const room = rooms.get(code);
  if (!room || room.phase !== "revealing") return null;

  if (room.round >= room.totalRounds) {
    room.phase = "finished";
    return { room, song: room.currentSong!, finished: true };
  }

  const result = startRound(code);
  if ("error" in result) return null;
  return { ...result, finished: false };
}

export function skipSong(
  code: string,
): { room: GameRoom; song: Song } | null {
  const room = rooms.get(code);
  if (!room || !room.songQueue.length) return null;
  // Skipping only makes sense mid-round
  if (room.phase !== "countdown" && room.phase !== "playing" && room.phase !== "buzzed") return null;

  const song = consumeSong(room);
  if (!song) return null;
  room.currentSong = song;
  resetRoundState(room);
  room.phase = "countdown";
  room.countdownToken += 1;
  return { room, song };
}

export function leaveRoom(
  code: string,
  socketId: string,
): { room: GameRoom; buzzerReleased: boolean } | null {
  const room = rooms.get(code);
  if (!room) return null;
  const player = room.players.get(socketId);
  if (!player || player.isHost) return null; // host uses end_game instead

  let buzzerReleased = false;
  if (room.phase === "lobby") {
    // In the lobby just remove them from the list
    room.players.delete(socketId);
  } else {
    // Mid-game: keep them on the scoreboard, marked as left
    player.left = true;
    player.connected = false;
    // If they held the buzzer, release the round back to playing
    if (room.buzzerWinnerSocketId === socketId && room.phase === "buzzed") {
      room.buzzerWinnerSocketId = null;
      room.answerText = "";
      room.answerLocked = false;
      room.phase = "playing";
      buzzerReleased = true;
    }
  }
  socketToRoom.delete(socketId);
  return { room, buzzerReleased };
}

export function closeRoom(code: string): GameRoom | null {
  const room = rooms.get(code);
  if (!room) return null;
  room.players.forEach((_, sid) => socketToRoom.delete(sid));
  rooms.delete(code);
  return room;
}

export function endGame(code: string, hostSocketId: string): GameRoom | null {
  const room = rooms.get(code);
  if (!room || room.hostSocketId !== hostSocketId) return null;
  return closeRoom(code);
}

/**
 * A socket dropped. The player stays in the room marked disconnected so they
 * can rejoin — the caller decides how long to wait for a missing host.
 */
export function handleDisconnect(
  socketId: string,
): { roomCode: string; room: GameRoom; isHost: boolean } | null {
  const code = socketToRoom.get(socketId);
  if (!code) return null;
  socketToRoom.delete(socketId);

  const room = rooms.get(code);
  if (!room) return null;

  const player = room.players.get(socketId);
  if (!player) return null;
  player.connected = false;

  return { roomCode: code, room, isHost: socketId === room.hostSocketId };
}
