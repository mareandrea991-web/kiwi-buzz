import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { io, Socket } from 'socket.io-client';
import { SERVER_ORIGIN } from '@/lib/apiBase';

// ── types ────────────────────────────────────────────────────────────────────
export type PlayerColor = 'coral' | 'blue' | 'yellow' | 'mint' | 'purple' | 'orange';
export type GamePhase = 'lobby' | 'countdown' | 'playing' | 'buzzed' | 'revealing' | 'finished';
export type MusicSource = 'itunes' | 'spotify';
export type RoundOutcome = 'correct' | 'wrong' | 'timeout' | 'nobody';

export interface PublicPlayer {
  playerId: string;
  name: string;
  color: PlayerColor;
  score: number;
  isHost: boolean;
  connected: boolean;
  left?: boolean;
}

export interface PublicRoom {
  code: string;
  phase: GamePhase;
  round: number;
  totalRounds: number;
  players: PublicPlayer[];
  buzzerWinnerId: string | null;
  buzzerWinnerName: string | null;
  buzzerWinnerColor: PlayerColor | null;
  songsReady: boolean;
  musicSource?: MusicSource;
  /** time left on the current phase's server timer, measured when the server sent it */
  deadlineInMs?: number | null;
  /** the buzzer's answer window has closed */
  answerLocked?: boolean;
}

export interface CurrentSong {
  previewUrl: string;
  /** Spotify Host Mode only — played on the host device */
  spotifyUri?: string | null;
  albumArt: string;
  year: string;
  category: string;
  // only present for host
  title?: string;
  artist?: string;
}

export interface AnswerReveal {
  outcome: RoundOutcome;
  isCorrect: boolean;
  correctTitle: string;
  correctArtist: string;
  buzzerId: string | null;
  buzzerName: string | null;
}

interface GameState {
  connected: boolean;
  connecting: boolean;
  /** in a game but the connection dropped — trying to get back in */
  reconnecting: boolean;
  /** app just opened with a saved game — trying to rejoin it */
  restoring: boolean;
  room: PublicRoom | null;
  /** local epoch ms when the current phase timer runs out (null = untimed) */
  deadlineAt: number | null;
  myPlayerId: string | null;
  mySocketId: string | null;
  isHost: boolean;
  currentSong: CurrentSong | null;
  answerReveal: AnswerReveal | null;
  /** whether I was the one who buzzed this round */
  iAmBuzzer: boolean;
  songsReady: boolean;
  /** answer text submitted by the buzzer player (visible to host) */
  playerAnswer: string | null;
  /** answer text restored for the buzzer after a reconnect */
  restoredAnswer: string | null;
  error: string | null;
  joinError: string | null;
  startError: string | null;
  /** set when the game ends for us — UI should return to home and clear it */
  gameEnded: boolean;
  /** one-off message for the home screen (e.g. why the game ended) */
  notice: string | null;
  /** Spotify Host Mode failed on the server and the room fell back to previews */
  musicFallbackNotice: string | null;
}

interface GameActions {
  connectAndCreate: (
    playerName: string,
    color: PlayerColor,
    categories: string[],
    rounds: number,
    music?: { musicSource: MusicSource; nativeSpotify?: boolean },
  ) => void;
  connectAndJoin: (roomCode: string, playerName: string, color: PlayerColor) => void;
  startGame: () => void;
  switchMusicSource: () => void;
  buzz: () => void;
  hostAccept: () => void;
  hostReject: () => void;
  revealAnswer: () => void;
  nextRound: () => void;
  skipSong: () => void;
  submitAnswer: (answerText: string) => void;
  leaveGame: () => void;
  endGame: () => void;
  acknowledgeGameEnded: () => void;
  clearError: () => void;
  clearNotice: () => void;
}

const GameContext = createContext<(GameState & GameActions) | null>(null);

export function useGame() {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be used inside GameProvider');
  return ctx;
}

const INITIAL_STATE: GameState = {
  connected: false,
  connecting: false,
  reconnecting: false,
  restoring: false,
  room: null,
  deadlineAt: null,
  myPlayerId: null,
  mySocketId: null,
  isHost: false,
  currentSong: null,
  answerReveal: null,
  iAmBuzzer: false,
  songsReady: false,
  playerAnswer: null,
  restoredAnswer: null,
  error: null,
  joinError: null,
  startError: null,
  gameEnded: false,
  notice: null,
  musicFallbackNotice: null,
};

// ── saved session (lets a phone get back into its game after a drop/restart) ─
const SESSION_KEY = 'kiwibuzz.session.v1';
interface SavedSession { roomCode: string; playerId: string; rejoinToken: string; isHost: boolean }

async function loadSession(): Promise<SavedSession | null> {
  try {
    const raw = await AsyncStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<SavedSession>;
    return s.roomCode && s.playerId && s.rejoinToken ? (s as SavedSession) : null;
  } catch { return null; }
}
function saveSession(s: SavedSession) { AsyncStorage.setItem(SESSION_KEY, JSON.stringify(s)).catch(() => {}); }
function clearSession() { AsyncStorage.removeItem(SESSION_KEY).catch(() => {}); }

/** Merge a room update into state, converting the server's relative deadline to a local one. */
function withRoom(room: PublicRoom) {
  return {
    room,
    deadlineAt: typeof room.deadlineInMs === 'number' ? Date.now() + room.deadlineInMs : null,
  };
}

export function GameProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GameState>(INITIAL_STATE);
  const socketRef = useRef<Socket | null>(null);
  const roomCodeRef = useRef<string | null>(null);
  const sessionRef = useRef<SavedSession | null>(null);
  const myPlayerIdRef = useRef<string | null>(null);

  const forgetGame = useCallback(() => {
    sessionRef.current = null;
    roomCodeRef.current = null;
    myPlayerIdRef.current = null;
    clearSession();
  }, []);

  const rememberGame = useCallback((s: SavedSession) => {
    sessionRef.current = s;
    roomCodeRef.current = s.roomCode;
    myPlayerIdRef.current = s.playerId;
    saveSession(s);
  }, []);

  const getSocket = useCallback((): Socket => {
    // Reuse any existing socket — socket.io buffers emits while it is still
    // connecting, so creating a second socket here would leak the first one.
    // If the socket has gone inactive, explicitly reconnect it before reuse
    // so a user retry doesn't emit into a dead connection.
    const existing = socketRef.current;
    if (existing) {
      if (!existing.connected && !existing.active) existing.connect();
      return existing;
    }

    // Same site on the web; the configured server for native builds
    const socket = io(SERVER_ORIGIN || undefined, {
      path: '/api/socket.io',
      transports: ['polling', 'websocket'],
      // Send the HttpOnly Spotify session cookie on the handshake (web hosts)
      withCredentials: true,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 4000,
      // Keep trying while in a game — phones drop and recover constantly
      reconnectionAttempts: Infinity,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setState((s) => ({ ...s, connected: true, connecting: false, mySocketId: socket.id ?? null }));
      // Every (re)connect gets a new socket id — reclaim our seat in the game
      const saved = sessionRef.current;
      if (saved) {
        socket.emit('rejoin_room', { roomCode: saved.roomCode, playerId: saved.playerId, rejoinToken: saved.rejoinToken });
      }
    });

    socket.on('disconnect', () => {
      // Don't replay taps (buzz, accept…) that were queued while offline
      socket.sendBuffer = [];
      setState((s) => ({ ...s, connected: false, reconnecting: !!sessionRef.current }));
    });

    socket.on('connect_error', (err: Error) => {
      setState((s) => {
        // Mid-game: socket.io keeps retrying, the UI shows "Reconnecting…"
        if (sessionRef.current) return { ...s, connecting: false, reconnecting: !s.restoring };
        return { ...s, connecting: false, error: `Connection failed: ${err.message}` };
      });
    });

    socket.on('room_created', (data: { roomCode: string; playerId: string; rejoinToken: string; room: PublicRoom }) => {
      rememberGame({ roomCode: data.roomCode, playerId: data.playerId, rejoinToken: data.rejoinToken, isHost: true });
      setState((s) => ({
        ...s,
        ...withRoom(data.room),
        connecting: false,
        myPlayerId: data.playerId,
        isHost: true,
        songsReady: false,
        startError: null,
      }));
    });

    socket.on('room_joined', (data: { roomCode: string; playerId: string; rejoinToken: string; room: PublicRoom }) => {
      rememberGame({ roomCode: data.roomCode, playerId: data.playerId, rejoinToken: data.rejoinToken, isHost: false });
      setState((s) => ({
        ...s,
        ...withRoom(data.room),
        connecting: false,
        myPlayerId: data.playerId,
        isHost: false,
        joinError: null,
      }));
    });

    socket.on('room_rejoined', (data: {
      roomCode: string; playerId: string; isHost: boolean; room: PublicRoom;
      song: CurrentSong | null; reveal: Omit<AnswerReveal, 'isCorrect'> | null;
      iAmBuzzer: boolean; answerText: string;
    }) => {
      roomCodeRef.current = data.roomCode;
      myPlayerIdRef.current = data.playerId;
      setState((s) => ({
        ...s,
        ...withRoom(data.room),
        connected: true,
        connecting: false,
        reconnecting: false,
        restoring: false,
        myPlayerId: data.playerId,
        isHost: data.isHost,
        songsReady: data.room.songsReady,
        currentSong: data.song,
        answerReveal: data.reveal ? { ...data.reveal, isCorrect: data.reveal.outcome === 'correct' } : null,
        iAmBuzzer: data.iAmBuzzer,
        playerAnswer: data.isHost && data.answerText ? data.answerText : null,
        restoredAnswer: data.iAmBuzzer ? data.answerText : null,
      }));
    });

    socket.on('rejoin_error', (data: { message: string }) => {
      // The game is gone (ended, or we left) — stop trying and go home
      forgetGame();
      socket.disconnect();
      socketRef.current = null;
      setState({ ...INITIAL_STATE, gameEnded: true, notice: data.message });
    });

    socket.on('room_updated', (room: PublicRoom) => {
      // If the round returned to 'playing' (e.g. the buzzer player left), void the old buzz/answer
      setState((s) => ({
        ...s,
        ...withRoom(room),
        ...(room.phase === 'playing' && s.room?.phase === 'buzzed' ? { playerAnswer: null, iAmBuzzer: false } : {}),
      }));
    });

    socket.on('music_source_fallback', (data: { message: string }) => {
      setState((s) => ({
        ...s,
        musicFallbackNotice: data.message,
        room: s.room ? { ...s.room, musicSource: 'itunes' } : s.room,
      }));
    });

    socket.on('songs_ready', () => {
      setState((s) => ({
        ...s,
        songsReady: true,
        room: s.room ? { ...s.room, songsReady: true } : s.room,
      }));
    });

    socket.on('round_started', (data: { room: PublicRoom; song: CurrentSong; isHost: boolean }) => {
      setState((s) => ({
        ...s,
        ...withRoom(data.room),
        currentSong: data.song,
        answerReveal: null,
        iAmBuzzer: false,
        playerAnswer: null,
        restoredAnswer: null,
      }));
    });

    socket.on('player_answered', (data: { answerText: string; fromName: string; fromColor: string }) => {
      setState((s) => ({ ...s, playerAnswer: data.answerText }));
    });

    socket.on('buzzers_open', (data: { room: PublicRoom }) => {
      // Buzzers reopening means any previous buzz/answer is void (e.g. the buzzer player left)
      setState((s) => ({ ...s, ...withRoom(data.room), playerAnswer: null, iAmBuzzer: false }));
    });

    socket.on('buzz_locked', (data: {
      winnerId: string;
      winnerName: string;
      winnerColor: PlayerColor;
      winnerSocketId: string;
      room: PublicRoom;
    }) => {
      // Compare player ids, not socket ids — socket ids change on reconnect
      const iAmBuzzer = data.winnerId === myPlayerIdRef.current;
      setState((s) => ({ ...s, ...withRoom(data.room), iAmBuzzer, playerAnswer: null, restoredAnswer: null }));
    });

    socket.on('answer_result', (data: Omit<AnswerReveal, 'isCorrect'> & { isCorrect: boolean; room: PublicRoom }) => {
      setState((s) => ({
        ...s,
        ...withRoom(data.room),
        answerReveal: {
          outcome: data.outcome ?? (data.isCorrect ? 'correct' : 'wrong'),
          isCorrect: data.isCorrect,
          correctTitle: data.correctTitle,
          correctArtist: data.correctArtist,
          buzzerId: data.buzzerId ?? null,
          buzzerName: data.buzzerName ?? null,
        },
        iAmBuzzer: false,
      }));
    });

    socket.on('game_over', (data: { room: PublicRoom }) => {
      setState((s) => ({ ...s, ...withRoom(data.room) }));
    });

    socket.on('game_ended', (data?: { message?: string }) => {
      // Room closed — drop the connection and flag for the UI
      forgetGame();
      socketRef.current?.disconnect();
      socketRef.current = null;
      setState({ ...INITIAL_STATE, gameEnded: true, notice: data?.message ?? null });
    });

    socket.on('join_error', (data: { message: string }) => {
      // Reset `connecting` — the socket may already have been connected, in
      // which case no 'connect' event will fire to clear it.
      setState((s) => ({ ...s, connecting: false, joinError: data.message }));
    });

    socket.on('start_error', (data: { message: string }) => {
      setState((s) => ({ ...s, startError: data.message }));
    });

    socket.on('error', (data: { message: string }) => {
      setState((s) => ({ ...s, connecting: false, error: data.message }));
    });

    return socket;
  }, [forgetGame, rememberGame]);

  // On launch: if this phone was in a game (app killed, page refreshed), rejoin it
  useEffect(() => {
    let cancelled = false;
    void loadSession().then((saved) => {
      if (cancelled || !saved || socketRef.current) return;
      sessionRef.current = saved;
      roomCodeRef.current = saved.roomCode;
      myPlayerIdRef.current = saved.playerId;
      setState((s) => ({ ...s, restoring: true, connecting: true }));
      getSocket(); // the 'connect' handler sends rejoin_room
    });
    return () => { cancelled = true; };
  }, [getSocket]);

  const connectAndCreate = useCallback((
    playerName: string,
    color: PlayerColor,
    categories: string[],
    rounds: number,
    music?: { musicSource: MusicSource; nativeSpotify?: boolean },
  ) => {
    setState((s) => ({ ...s, connecting: true, error: null, notice: null, musicFallbackNotice: null }));
    const socket = getSocket();
    socket.emit('create_room', {
      playerName, color, categories, rounds,
      musicSource: music?.musicSource ?? 'itunes',
      nativeSpotify: music?.nativeSpotify === true,
    });
  }, [getSocket]);

  const connectAndJoin = useCallback((roomCode: string, playerName: string, color: PlayerColor) => {
    setState((s) => ({ ...s, connecting: true, error: null, notice: null, joinError: null }));
    const socket = getSocket();
    socket.emit('join_room', { roomCode: roomCode.toUpperCase().trim(), playerName, color });
  }, [getSocket]);

  /** Emit a room-scoped event if we're in a room. */
  const emitToRoom = useCallback((event: string, extra?: Record<string, unknown>) => {
    const socket = socketRef.current;
    const code = roomCodeRef.current;
    if (!socket || !code) return;
    socket.emit(event, { roomCode: code, ...extra });
  }, []);

  /** Host-only: switch a live Spotify game to iTunes previews (never ends the game). */
  const switchMusicSource = useCallback(() => emitToRoom('switch_music_source'), [emitToRoom]);
  const startGame = useCallback(() => {
    setState((s) => ({ ...s, startError: null }));
    emitToRoom('start_game');
  }, [emitToRoom]);
  const buzz = useCallback(() => emitToRoom('buzz'), [emitToRoom]);
  const hostAccept = useCallback(() => emitToRoom('host_accept'), [emitToRoom]);
  const hostReject = useCallback(() => emitToRoom('host_reject'), [emitToRoom]);
  const revealAnswer = useCallback(() => emitToRoom('reveal_answer'), [emitToRoom]);
  const nextRound = useCallback(() => emitToRoom('next_round'), [emitToRoom]);
  const skipSong = useCallback(() => emitToRoom('skip_song'), [emitToRoom]);
  const submitAnswer = useCallback((answerText: string) => emitToRoom('player_answer', { answerText }), [emitToRoom]);

  const closeLocal = useCallback(() => {
    socketRef.current?.disconnect();
    socketRef.current = null;
    forgetGame();
    setState(INITIAL_STATE);
  }, [forgetGame]);

  const endGame = useCallback(() => {
    emitToRoom('end_game');
    closeLocal();
  }, [emitToRoom, closeLocal]);

  /** Leave the room. A host leaving closes it for everyone. */
  const leaveGame = useCallback(() => {
    emitToRoom(sessionRef.current?.isHost ? 'end_game' : 'leave_room');
    closeLocal();
  }, [emitToRoom, closeLocal]);

  const acknowledgeGameEnded = useCallback(() => {
    setState((s) => ({ ...s, gameEnded: false }));
  }, []);

  const clearError = useCallback(() => {
    setState((s) => ({ ...s, error: null, joinError: null, startError: null }));
  }, []);

  const clearNotice = useCallback(() => {
    setState((s) => ({ ...s, notice: null }));
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => { socketRef.current?.disconnect(); };
  }, []);

  const value = {
    ...state,
    connectAndCreate, connectAndJoin, startGame, switchMusicSource, buzz, hostAccept, hostReject,
    revealAnswer, nextRound, skipSong, submitAnswer, leaveGame, endGame, acknowledgeGameEnded,
    clearError, clearNotice,
  };

  return <GameContext.Provider value={value}>{children}</GameContext.Provider>;
}
