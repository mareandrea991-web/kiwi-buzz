import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';
import { Image } from 'expo-image';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import colors from '@/constants/colors';
import { useGame, PlayerColor, PublicPlayer, MusicSource } from '@/context/GameContext';
import { useSpotifyHostPlayback } from '@/hooks/useSpotifyHostPlayback';
import { useSpotifyNativeHostPlayback } from '@/hooks/useSpotifyNativeHostPlayback';
import { isNativeSpotifyAvailable } from '@/lib/spotifyNative';

// ── palette ───────────────────────────────────────────────────────────────────
const C = colors.light;
const PLAYER_COLORS: Record<PlayerColor, string> = {
  coral: C.playerCoral,
  blue: C.playerBlue,
  yellow: C.playerYellow,
  mint: C.playerMint,
  purple: '#B97BFF',
  orange: '#FF9F45',
};

import { API_BASE } from '@/lib/apiBase';
import { onWebAudioBlocked, pauseWebAudio, playWebAudio, stopWebAudio, unlockWebAudio } from '@/lib/webAudio';
const COLOR_OPTIONS: PlayerColor[] = ['coral', 'blue', 'yellow', 'mint', 'purple', 'orange'];
const CATEGORIES = ['Pop', 'Rock', 'Rap / Hip-Hop', 'R&B', 'Dance', '70s', '80s', '90s', '2000s', '2010s'];

const FALLBACK_AUDIO = require('@/assets/audio/neon-replay-demo.mp3');
// Web build: the demo track is served as a plain file from public/
const FALLBACK_AUDIO_WEB = '/audio/neon-replay-demo.mp3';
const IS_WEB = Platform.OS === 'web';

// ── tiny components ───────────────────────────────────────────────────────────
function haptic() {
  // Every important tap calls this, so it's also where web audio gets unlocked
  if (IS_WEB) { unlockWebAudio(); return; }
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
}

/** Whole seconds left until `deadlineAt` (ticks live), or null when there's no timer. */
function useSecondsLeft(deadlineAt: number | null): number | null {
  const calc = () => (deadlineAt === null ? null : Math.max(0, Math.ceil((deadlineAt - Date.now()) / 1000)));
  const [left, setLeft] = useState<number | null>(calc);
  useEffect(() => {
    setLeft(calc());
    if (deadlineAt === null) return;
    const id = setInterval(() => setLeft(calc()), 200);
    return () => clearInterval(id);
  }, [deadlineAt]);
  return left;
}

function Icon({ name, color = C.softText, size = 18 }: { name: keyof typeof Feather.glyphMap; color?: string; size?: number }) {
  return <Feather name={name} color={color} size={size} />;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <View style={s.brandRow}>
      <View style={s.brandMark}><View style={s.brandPulse} /><Icon name="zap" color={C.deep} size={17} /></View>
      {!compact && <Text style={s.brandName}>KIWI BUZZ</Text>}
    </View>
  );
}

function Btn({ children, onPress, disabled = false, icon, variant = 'primary' }: {
  children: React.ReactNode; onPress: () => void; disabled?: boolean;
  icon?: keyof typeof Feather.glyphMap; variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}) {
  return (
    <Pressable onPress={onPress} disabled={disabled}
      style={({ pressed }) => [s.btn, variant === 'secondary' && s.btnSec, variant === 'ghost' && s.btnGhost, variant === 'danger' && s.btnDanger, disabled && s.btnDisabled, pressed && !disabled && s.pressed]}>
      {icon && <Icon name={icon} color={variant === 'primary' ? C.primaryForeground : variant === 'danger' ? '#fff' : C.text} size={17} />}
      <Text style={[s.btnText, variant !== 'primary' && variant !== 'danger' && s.btnTextAlt]}>{children}</Text>
    </Pressable>
  );
}

function Header({ title, eyebrow, onBack, right }: { title: string; eyebrow?: string; onBack?: () => void; right?: React.ReactNode }) {
  return (
    <View style={s.header}>
      {onBack ? <Pressable onPress={onBack} hitSlop={12} style={s.backBtn}><Icon name="arrow-left" color={C.text} size={20} /></Pressable> : <Brand compact />}
      <View style={{ flex: 1 }}>{eyebrow && <Text style={s.eyebrow}>{eyebrow}</Text>}<Text style={s.headerTitle}>{title}</Text></View>
      {right ?? <View style={{ width: 38 }} />}
    </View>
  );
}

function Pill({ children, active }: { children: React.ReactNode; active?: boolean }) {
  return (
    <View style={[s.pill, active && s.pillActive]}>
      {active && <View style={s.pillDot} />}
      <Text style={[s.pillText, active && s.pillTextActive]}>{children}</Text>
    </View>
  );
}

function Waveform({ active = true }: { active?: boolean }) {
  return (
    <View style={s.waveform}>
      {[18, 30, 42, 25, 50, 34, 56, 29, 44, 22, 38, 52, 26, 45].map((h, i) => (
        <View key={i} style={[s.waveBar, { height: active ? h : 8, opacity: active ? 0.95 : 0.4 }]} />
      ))}
    </View>
  );
}

function Avatar({ player, size = 42 }: { player: PublicPlayer; size?: number }) {
  return (
    <View style={[s.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: PLAYER_COLORS[player.color] }]}>
      <Text style={[s.avatarText, { fontSize: size * 0.38 }]}>{player.name.charAt(0).toUpperCase()}</Text>
    </View>
  );
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <Pressable onPress={onDismiss} style={s.errorBanner}>
      <Icon name="alert-circle" color="#fff" size={15} />
      <Text style={s.errorText}>{message}</Text>
    </Pressable>
  );
}

// ── main component ────────────────────────────────────────────────────────────
type ConfirmRequest = { title: string; message: string; confirmLabel: string; onConfirm: () => void };

type PreScreen = 'home' | 'setup' | 'join';

export default function App() {
  const insets = useSafeAreaInsets();
  const game = useGame();

  // Pre-game local state
  const [pre, setPre] = useState<PreScreen>('home');
  const [playerName, setPlayerName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [selectedColor, setSelectedColor] = useState<PlayerColor>('coral');
  const [selectedCategories, setSelectedCategories] = useState<string[]>(['Pop', 'Rock', 'Rap / Hip-Hop']);
  const [rounds, setRounds] = useState(10);
  // Music source — iTunes previews (default) or Spotify Host Mode (web hosts only)
  const [musicSource, setMusicSource] = useState<MusicSource>('itunes');
  const [spotifySession, setSpotifySession] = useState<{ name: string; premium: boolean } | null>(null);
  const [spotifyAuthError, setSpotifyAuthError] = useState<string | null>(null);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [answerDraft, setAnswerDraft] = useState('');

  // Audio
  const soundRef = useRef<Audio.Sound | null>(null);
  const lastPreviewUrl = useRef<string | null>(null);

  // Buzz button animation
  const buzzScale = useRef(new Animated.Value(1)).current;

  const { room, isHost, iAmBuzzer, currentSong, answerReveal, connecting, error, joinError, startError } = game;
  const pageStyle = { paddingTop: insets.top + (Platform.OS === 'web' ? 67 : 16), paddingBottom: Math.max(insets.bottom, Platform.OS === 'web' ? 34 : 22) };

  // Live countdown for whatever the current phase timer is (3-2-1, round clock, answer window)
  const secondsLeft = useSecondsLeft(game.deadlineAt);

  // Reset answer draft on each new round
  useEffect(() => { setAnswerDraft(''); }, [room?.round]);
  // After a reconnect, put back whatever the buzzer had already typed
  useEffect(() => { if (game.restoredAnswer) setAnswerDraft(game.restoredAnswer); }, [game.restoredAnswer]);

  // Host ended the game — everyone returns to the home screen
  useEffect(() => {
    if (game.gameEnded) {
      setPre('home');
      game.acknowledgeGameEnded();
    }
  }, [game.gameEnded]);

  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  // ── Spotify Host Mode session (web only) ─────────────────────────────────
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;

    // The session lives in an HttpOnly cookie — client JS never sees it.
    const verify = async () => {
      try {
        const res = await fetch(`${API_BASE}/spotify/session`, { credentials: 'include' });
        if (!res.ok) return;
        const data = (await res.json()) as { displayName: string; premium: boolean };
        setSpotifySession({ name: data.displayName, premium: data.premium });
        if (!data.premium) setSpotifyAuthError('This Spotify account is not Premium — playback needs Premium.');
      } catch { /* ignore */ }
    };

    const params = new URLSearchParams(window.location.search);
    const connected = params.get('spotify_connected');
    const err = params.get('spotify_error');
    if (connected || err) {
      params.delete('spotify_connected');
      params.delete('spotify_error');
      const qs = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
    }
    if (err) setSpotifyAuthError('Spotify sign-in was cancelled or failed. You can try again or use song previews.');
    if (connected) {
      setPre('setup');
      setMusicSource('spotify');
    }
    void verify();
  }, []);

  const connectSpotify = () => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const returnTo = window.location.origin + window.location.pathname;
    window.location.href = `${API_BASE}/spotify/login?returnTo=${encodeURIComponent(returnTo)}`;
  };

  // Host-device Spotify playback.
  // Web hosts → Web Playback SDK; Android native builds → App Remote SDK.
  // Each hook fully no-ops unless its platform is active.
  const nativeSpotify = isNativeSpotifyAvailable();
  const { spotifyReady: webReady, spotifyPlaybackError: webError } = useSpotifyHostPlayback({
    enabled: game.isHost && game.room?.musicSource === 'spotify' && !nativeSpotify,
    phase: game.room?.phase,
    spotifyUri: game.currentSong?.spotifyUri,
  });
  const { nativeConnected, nativeError, nativeReconnect } = useSpotifyNativeHostPlayback({
    enabled: game.isHost && game.room?.musicSource === 'spotify' && nativeSpotify,
    phase: game.room?.phase,
    spotifyUri: game.currentSong?.spotifyUri,
  });
  // Unified host-Spotify status used by the lobby / in-game UI
  const spotifyReady = nativeSpotify ? nativeConnected : webReady;
  const spotifyPlaybackError = nativeSpotify ? nativeError : webError;

  const onExitGame = () => setConfirm({
    title: 'Exit game?',
    message: 'You will leave this room. The rest of the players can keep playing without you.',
    confirmLabel: 'Exit game',
    onConfirm: () => { game.leaveGame(); setPre('home'); },
  });

  const onEndGame = () => setConfirm({
    title: 'End game for everyone?',
    message: 'This will disconnect all players and close the room. This cannot be undone.',
    confirmLabel: 'End game',
    onConfirm: () => { game.endGame(); setPre('home'); },
  });

  // In-app confirmation overlay (native Alert/window.confirm are unreliable across platforms)
  const confirmOverlay = confirm ? (
    <View style={s.confirmBackdrop}>
      <View style={s.confirmCard}>
        <Text style={s.confirmTitle}>{confirm.title}</Text>
        <Text style={[s.mutedText, { marginTop: 8, lineHeight: 19 }]}>{confirm.message}</Text>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
          <Pressable testID="confirm-cancel" onPress={() => setConfirm(null)} style={[s.confirmBtn, s.confirmBtnCancel]}>
            <Text style={s.confirmBtnCancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            testID="confirm-accept"
            onPress={() => { const fn = confirm.onConfirm; setConfirm(null); fn(); }}
            style={[s.confirmBtn, s.confirmBtnDanger]}
          >
            <Text style={s.confirmBtnDangerText}>{confirm.confirmLabel}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  ) : null;

  const me = useMemo(() => room?.players.find(p => p.playerId === game.myPlayerId), [room, game.myPlayerId]);
  const sorted = useMemo(() => room ? [...room.players].sort((a, b) => b.score - a.score) : [], [room]);

  // ── audio ────────────────────────────────────────────────────────────────
  // Web: the browser may refuse to start sound until the player taps
  const [soundBlocked, setSoundBlocked] = useState(false);
  useEffect(() => (IS_WEB ? onWebAudioBlocked(setSoundBlocked) : undefined), []);

  useEffect(() => {
    const phase = room?.phase;
    const url = currentSong?.previewUrl ?? null;

    if (IS_WEB) {
      if (room?.musicSource === 'spotify') { stopWebAudio(); return; }
      if (phase === 'playing') {
        // A Spotify track without a preview stays silent — never the demo track
        if (!url && currentSong?.spotifyUri) return;
        playWebAudio(url ?? FALLBACK_AUDIO_WEB);
      } else if (phase === 'buzzed' || phase === 'revealing') pauseWebAudio();
      else stopWebAudio();
      return;
    }

    const play = async () => {
      try {
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
        if (soundRef.current && lastPreviewUrl.current === url) {
          await soundRef.current.playAsync();
          return;
        }
        await soundRef.current?.unloadAsync().catch(() => {});
        soundRef.current = null;
        // A Spotify track without a preview (e.g. right after a mid-game
        // switch to previews) stays silent — never play the demo track.
        if (!url && currentSong?.spotifyUri) return;
        const src = url ? { uri: url } : FALLBACK_AUDIO;
        const { sound } = await Audio.Sound.createAsync(src, { shouldPlay: true, isLooping: true, volume: 1 });
        soundRef.current = sound;
        lastPreviewUrl.current = url;
      } catch { /* ignore audio errors */ }
    };

    const pause = async () => { await soundRef.current?.pauseAsync().catch(() => {}); };
    const stop = async () => {
      await soundRef.current?.stopAsync().catch(() => {});
      await soundRef.current?.unloadAsync().catch(() => {});
      soundRef.current = null;
      lastPreviewUrl.current = null;
    };

    // Spotify Host Mode: audio plays only on the host device via the Spotify
    // SDK — no phone should play previews or the fallback demo track.
    if (room?.musicSource === 'spotify') { stop(); return; }

    if (phase === 'playing') play();
    else if (phase === 'buzzed' || phase === 'revealing') pause();
    else if (!phase || phase === 'lobby' || phase === 'finished') stop();
  }, [room?.phase, currentSong?.previewUrl, room?.musicSource]);

  useEffect(() => () => {
    soundRef.current?.unloadAsync().catch(() => {});
    if (IS_WEB) stopWebAudio();
  }, []);

  // ── helpers ───────────────────────────────────────────────────────────────
  const onCreateRoom = () => {
    if (!playerName.trim()) return;
    haptic();
    const useNative = nativeSpotify && nativeConnected;
    const useSpotify = musicSource === 'spotify' &&
      ((Platform.OS === 'web' && !!spotifySession?.premium) || useNative);
    game.connectAndCreate(playerName.trim(), selectedColor, selectedCategories, rounds, {
      musicSource: useSpotify ? 'spotify' : 'itunes',
      nativeSpotify: useSpotify && useNative,
    });
  };
  const onJoinRoom = () => {
    if (!playerName.trim() || joinCode.trim().length < 4) return;
    Keyboard.dismiss();
    haptic();
    game.connectAndJoin(joinCode, playerName.trim(), selectedColor);
  };
  const onBuzz = () => {
    haptic();
    Animated.sequence([
      Animated.spring(buzzScale, { toValue: 0.9, useNativeDriver: true, speed: 30, bounciness: 0 }),
      Animated.spring(buzzScale, { toValue: 1, useNativeDriver: true, speed: 18, bounciness: 9 }),
    ]).start();
    game.buzz();
  };
  const toggleCategory = (cat: string) =>
    setSelectedCategories(prev => prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]);

  // ── routing ───────────────────────────────────────────────────────────────
  // If we're connected and have a room, derive screen from phase
  if (room) {
    // Connection status strip shown over every in-game screen
    const hostPlayer = room.players.find(p => p.isHost);
    const connMessage = game.reconnecting
      ? 'Connection lost — reconnecting…'
      : !isHost && hostPlayer && !hostPlayer.connected
        ? 'The host lost connection — waiting for them to come back…'
        : null;
    const connBanner = connMessage ? (
      <View pointerEvents="none" style={[s.connBanner, { top: insets.top + (Platform.OS === 'web' ? 12 : 6) }]}>
        <Icon name="wifi-off" color={C.deep} size={14} />
        <Text style={s.connBannerText}>{connMessage}</Text>
      </View>
    ) : null;

    const roomScreen = (() => {
    const phase = room.phase;

    // ── Leaderboard overlay ──────────────────────────────────────────────────
    if (showLeaderboard) {
      return (
        <LinearGradient colors={[C.background, '#111937']} style={s.screen}>
          <ScrollView contentContainerStyle={[s.page, pageStyle]}>
            <Header title="Scoreboard" eyebrow={`ROUND ${room.round} OF ${room.totalRounds}`} onBack={() => setShowLeaderboard(false)} />
            <Text style={[s.subtitle, { marginTop: 18 }]}>Every buzz changes the race.</Text>
            <View style={[s.card, { marginTop: 22, paddingHorizontal: 14 }]}>
              {sorted.map((p, i) => (
                <View key={p.playerId} style={[s.lbRow, p.playerId === me?.playerId && s.lbRowMe]}>
                  <Text style={s.lbRank}>{String(i + 1).padStart(2, '0')}</Text>
                  <Avatar player={p} size={36} />
                  <Text style={[s.lbName, { flex: 1 }]}>{p.name}{p.playerId === me?.playerId ? ' (you)' : ''}</Text>
                  <Text style={s.lbScore}>{p.score}</Text>
                  <Text style={s.ptsLabel}>PTS</Text>
                </View>
              ))}
            </View>
            <View style={{ height: 20 }} />
            <Btn icon="arrow-left" onPress={() => setShowLeaderboard(false)}>Back to round</Btn>
          </ScrollView>
        </LinearGradient>
      );
    }

    // ── Lobby ────────────────────────────────────────────────────────────────
    if (phase === 'lobby') {
      return (
        <LinearGradient colors={[C.background, '#111937']} style={s.screen}>
          <ScrollView contentContainerStyle={[s.page, pageStyle]}>
            <Header title="Room ready" eyebrow={isHost ? 'HOST LOBBY' : 'YOU ARE IN'}
              onBack={() => { game.leaveGame(); setPre('home'); }}
              right={<View style={s.livePill}><Icon name="radio" color={C.mint} size={13} /><Text style={s.livePillText}>LIVE</Text></View>} />

            <View style={s.roomCodeCard}>
              <Text style={s.roomLabel}>ROOM CODE</Text>
              <Text style={s.roomCode}>{room.code}</Text>
              <Text style={[s.mutedText, { marginTop: 6 }]}>Share this with your crew</Text>
            </View>

            {startError && <ErrorBanner message={startError} onDismiss={game.clearError} />}
            {game.musicFallbackNotice && isHost && (
              <ErrorBanner message={game.musicFallbackNotice} onDismiss={() => { /* informational */ }} />
            )}
            {isHost && room.musicSource === 'spotify' && (
              <View style={[s.ruleBox, { marginTop: 14 }]}>
                <Icon name="speaker" color={spotifyReady ? C.mint : C.accent} size={15} />
                <Text style={[s.mutedText, { flex: 1, lineHeight: 18 }]}>
                  {spotifyPlaybackError
                    ? spotifyPlaybackError
                    : spotifyReady
                      ? 'Spotify Host Mode — full tracks will play on this device.'
                      : 'Starting Spotify player on this device…'}
                </Text>
              </View>
            )}

            <View style={[s.row, { marginTop: 26, marginBottom: 12 }]}>
              <View><Text style={s.eyebrow}>PLAYERS</Text><Text style={[s.mutedText, { marginTop: 3 }]}>{room.players.length} joined</Text></View>
              {!room.songsReady && isHost && (
                <View style={s.loadingPill}><Icon name="loader" color={C.accent} size={13} /><Text style={s.loadingPillText}>Loading tracks…</Text></View>
              )}
            </View>

            <View style={s.card}>
              {room.players.map(p => (
                <View key={p.playerId} style={s.playerRow}>
                  <Avatar player={p} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.playerName}>{p.name}{p.playerId === me?.playerId ? ' (you)' : ''}</Text>
                    <Text style={s.playerStatus}>{p.isHost ? 'Host' : p.left ? 'Left Game' : p.connected ? 'Ready' : 'Disconnected'}</Text>
                  </View>
                  {p.isHost && <Pill active>HOST</Pill>}
                  {!p.isHost && p.connected && <View style={s.readyTick}><Icon name="check" color={C.mint} size={14} /></View>}
                </View>
              ))}
            </View>

            <View style={s.ruleBox}>
              <Icon name="info" color={C.accent} size={15} />
              <Text style={[s.mutedText, { flex: 1, lineHeight: 18 }]}>First to buzz gets 10 seconds to answer. Right is +1, wrong is −1. Nobody buzzes in 30 seconds? No points.</Text>
            </View>

            <View style={{ marginTop: 24, gap: 11 }}>
              {isHost
                ? <>
                    <Btn
                      icon="play"
                      disabled={!room.songsReady || room.players.length < 1 || (room.musicSource === 'spotify' && (!spotifyReady || !!spotifyPlaybackError))}
                      onPress={() => { haptic(); game.startGame(); }}
                    >
                      {!room.songsReady
                        ? 'Fetching tracks…'
                        : room.musicSource === 'spotify' && spotifyPlaybackError
                          ? 'Spotify problem — see above'
                          : room.musicSource === 'spotify' && !spotifyReady
                            ? 'Starting Spotify player…'
                            : 'Start the game'}
                    </Btn>
                    <Pressable testID="end-game-button" onPress={onEndGame} style={s.exitLink}>
                      <Icon name="x-circle" color={C.mutedForeground} size={15} />
                      <Text style={s.exitLinkText}>End game</Text>
                    </Pressable>
                  </>
                : <>
                    <View style={s.waitBox}><View style={s.waitDot} /><Text style={s.waitText}>Waiting for the host…</Text></View>
                    <Pressable testID="exit-game-button" onPress={onExitGame} style={s.exitLink}>
                      <Icon name="log-out" color={C.mutedForeground} size={15} />
                      <Text style={s.exitLinkText}>Exit game</Text>
                    </Pressable>
                  </>}
            </View>
          </ScrollView>
          {confirmOverlay}
        </LinearGradient>
      );
    }

    // ── Countdown / Playing (player buzzer screen) ────────────────────────────
    if ((phase === 'countdown' || phase === 'playing') && !isHost) {
      const isCountdown = phase === 'countdown';
      return (
        <LinearGradient colors={[C.background, '#171032']} style={s.screen}>
          <View style={[s.gameWrap, pageStyle]}>
            <View style={s.row}>
              <View><Text style={s.eyebrow}>ROUND {room.round} OF {room.totalRounds}</Text><Text style={s.gameMode}>NAME THE {room.round % 2 === 0 ? 'ARTIST' : 'SONG'}</Text></View>
              <Pressable onPress={() => setShowLeaderboard(true)} style={s.scorePill}>
                <Text style={s.scorePillVal}>{me?.score ?? 0}</Text><Text style={s.scorePillLbl}>PTS</Text>
              </Pressable>
            </View>
            <View style={s.progressTrack}><View style={[s.progressFill, { width: `${(room.round / room.totalRounds) * 100}%` as any }]} /></View>
            <View style={s.albumStage}>
              <View style={s.albumGlow} />
              {currentSong?.albumArt ? (
                <Image source={{ uri: currentSong.albumArt }} style={s.albumArt} contentFit="cover" />
              ) : (
                <View style={[s.albumArt, { backgroundColor: C.secondary, alignItems: 'center', justifyContent: 'center' }]}><Icon name="music" color={C.mutedForeground} size={52} /></View>
              )}
              <Text style={[s.eyebrow, { marginTop: 14 }]}>NOW PLAYING</Text>
              <Waveform active={!isCountdown} />
            </View>
            {isCountdown ? (
              <View style={s.countdownWrap}>
                <Text style={s.countdownLabel}>LISTEN CLOSELY</Text>
                <Text style={s.countdownNum}>{secondsLeft ? Math.min(3, secondsLeft) : '●'}</Text>
                <Text style={s.countdownHint}>Buzzers unlock when the track starts</Text>
              </View>
            ) : (
              <View style={s.buzzWrap}>
                <Text style={s.buzzPrompt}>WHO KNOWS IT FIRST?{secondsLeft !== null ? `  ·  ${secondsLeft}s` : ''}</Text>
                <Animated.View style={{ transform: [{ scale: buzzScale }] }}>
                  <Pressable testID="buzz-button" onPress={onBuzz} style={({ pressed }) => [s.buzzBtn, pressed && { opacity: 0.88 }]}>
                    <View style={s.buzzRing}><Icon name="zap" color={C.deep} size={36} /></View>
                    <Text style={s.buzzText}>BUZZ</Text>
                    <Text style={s.buzzSub}>TAP FIRST</Text>
                  </Pressable>
                </Animated.View>
              </View>
            )}
            <Pressable testID="exit-game-button" onPress={onExitGame} style={s.exitLink}>
              <Icon name="log-out" color={C.mutedForeground} size={15} />
              <Text style={s.exitLinkText}>Exit game</Text>
            </Pressable>
          </View>
          {confirmOverlay}
        </LinearGradient>
      );
    }

    // ── Countdown / Playing (host view — sees song info + skip) ───────────────
    if ((phase === 'countdown' || phase === 'playing') && isHost) {
      const isCountdown = phase === 'countdown';
      return (
        <LinearGradient colors={[C.background, '#111937']} style={s.screen}>
          <ScrollView contentContainerStyle={[s.page, pageStyle]}>
            <View style={s.row}>
              <View><Text style={s.eyebrow}>ROUND {room.round} OF {room.totalRounds}</Text><Text style={s.gameMode}>HOST VIEW</Text></View>
              <Pressable onPress={() => setShowLeaderboard(true)} style={s.scorePill}>
                <Icon name="users" color={C.accent} size={14} />
              </Pressable>
            </View>
            <View style={s.progressTrack}><View style={[s.progressFill, { width: `${(room.round / room.totalRounds) * 100}%` as any }]} /></View>

            {currentSong && (
              <View style={[s.hostSongCard, { marginTop: 24 }]}>
                {currentSong.albumArt && <Image source={{ uri: currentSong.albumArt }} style={s.hostAlbumArt} contentFit="cover" />}
                <View style={{ flex: 1 }}>
                  <Text style={s.eyebrow}>ANSWER</Text>
                  <Text style={s.hostSongTitle}>{currentSong.title ?? '—'}</Text>
                  <Text style={s.hostSongArtist}>{currentSong.artist ?? '—'}</Text>
                  <Text style={s.mutedText}>{currentSong.year} · {currentSong.category}</Text>
                </View>
              </View>
            )}

            <View style={[s.ruleBox, { marginTop: 18 }]}>
              <Icon name="radio" color={isCountdown ? C.accent : C.mint} size={15} />
              <Text style={[s.mutedText, { flex: 1 }]}>
                {isCountdown
                  ? `Countdown running — buzzers unlock in ${secondsLeft ? Math.min(3, secondsLeft) : 0}…`
                  : `Track is playing — players can buzz!${secondsLeft !== null ? ` ${secondsLeft}s left.` : ''}`}
              </Text>
            </View>

            {room.musicSource === 'spotify' && (
              <View style={{ marginTop: 10, gap: 8 }}>
                <View style={s.ruleBox}>
                  <Icon name="speaker" color={spotifyPlaybackError ? '#FF9F45' : spotifyReady ? C.mint : C.accent} size={15} />
                  <Text style={[s.mutedText, { flex: 1 }]}>
                    {spotifyPlaybackError ?? (spotifyReady ? 'Spotify playing on this device' : 'Connecting to Spotify…')}
                  </Text>
                </View>
                {spotifyPlaybackError && (
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    {nativeSpotify && (
                      <View style={{ flex: 1 }}>
                        <Btn icon="refresh-cw" variant="secondary" onPress={() => { void nativeReconnect(); }}>Reconnect Spotify</Btn>
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      <Btn icon="music" variant="secondary" onPress={game.switchMusicSource}>Switch to previews</Btn>
                    </View>
                  </View>
                )}
              </View>
            )}

            <View style={{ gap: 10, marginTop: 24 }}>
              <Btn icon="eye" variant="secondary" disabled={isCountdown} onPress={() => { haptic(); game.revealAnswer(); }}>Nobody got it — reveal</Btn>
              <Btn icon="skip-forward" variant="ghost" onPress={() => { haptic(); game.skipSong(); }}>Skip this song</Btn>
              <Pressable testID="end-game-button" onPress={onEndGame} style={s.exitLink}>
                <Icon name="x-circle" color={C.mutedForeground} size={15} />
                <Text style={s.exitLinkText}>End game</Text>
              </Pressable>
            </View>
            {confirmOverlay}

            <View style={[s.card, { marginTop: 24, paddingHorizontal: 14 }]}>
              {sorted.map((p, i) => (
                <View key={p.playerId} style={s.lbRow}>
                  <Text style={s.lbRank}>{i + 1}</Text>
                  <Avatar player={p} size={32} />
                  <Text style={[s.lbName, { flex: 1 }, p.left && { color: C.mutedForeground }]}>{p.name}{p.left ? ' · Left Game' : ''}</Text>
                  <Text style={s.lbScore}>{p.score}</Text>
                </View>
              ))}
            </View>
          </ScrollView>
        </LinearGradient>
      );
    }

    // ── Buzzed — HOST CONTROL ─────────────────────────────────────────────────
    if (phase === 'buzzed' && isHost) {
      return (
        <LinearGradient colors={[C.background, '#1C1040']} style={s.screen}>
          <ScrollView contentContainerStyle={[s.page, pageStyle]}>
            <View style={s.row}>
              <Text style={s.gameMode}>HOST CONTROL</Text>
              <Pill active>BUZZED</Pill>
            </View>

            {/* Who buzzed */}
            <View style={s.buzzedWhoCard}>
              {room.buzzerWinnerColor && (
                <View style={[s.bigAvatar, { backgroundColor: PLAYER_COLORS[room.buzzerWinnerColor] }]}>
                  <Text style={s.bigAvatarText}>{room.buzzerWinnerName?.charAt(0).toUpperCase()}</Text>
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={s.eyebrow}>BUZZED FIRST</Text>
                <Text style={s.buzzedWhoName}>{room.buzzerWinnerName ?? '—'}</Text>
                <Text style={s.mutedText}>{game.playerAnswer ? 'Their answer:' : 'Waiting for their answer…'}</Text>
              </View>
              <View style={[s.timerCircle, room.answerLocked && { backgroundColor: C.secondary }]}>
                {room.answerLocked || secondsLeft === 0
                  ? <Icon name="lock" color={C.text} size={18} />
                  : <Text style={s.timerNum}>{secondsLeft ?? ''}</Text>}
              </View>
            </View>
            {room.answerLocked && (
              <View style={[s.ruleBox, { marginTop: 12 }]}>
                <Icon name="clock" color={C.accent} size={14} />
                <Text style={[s.mutedText, { flex: 1 }]}>Time's up — their answer is locked in. Your call.</Text>
              </View>
            )}

            {/* Player's typed answer — updates live as they type */}
            {game.playerAnswer ? (
              <View style={s.playerAnswerBox}>
                <Text style={s.eyebrow}>THEIR ANSWER</Text>
                <Text style={s.playerAnswerText}>{game.playerAnswer}</Text>
              </View>
            ) : (
              <View style={[s.ruleBox, { marginTop: 12 }]}>
                <Icon name="loader" color={C.accent} size={14} />
                <Text style={[s.mutedText, { flex: 1 }]}>Player is typing their answer… If they don't type anything in time it counts as wrong.</Text>
              </View>
            )}

            {/* Song answer (host already knows) */}
            {currentSong && (
              <View style={[s.hostSongCard, { marginTop: 16 }]}>
                {currentSong.albumArt && <Image source={{ uri: currentSong.albumArt }} style={s.hostAlbumArt} contentFit="cover" />}
                <View style={{ flex: 1 }}>
                  <Text style={s.eyebrow}>CORRECT ANSWER</Text>
                  <Text style={s.hostSongTitle}>{currentSong.title ?? '—'}</Text>
                  <Text style={s.hostSongArtist}>{currentSong.artist ?? '—'}</Text>
                </View>
              </View>
            )}

            <Text style={[s.eyebrow, { marginTop: 26, marginBottom: 10 }]}>WAS THEIR ANSWER CORRECT?</Text>

            <View style={{ gap: 10 }}>
              <Btn icon="check" onPress={() => { haptic(); game.hostAccept(); }}>Accept — correct</Btn>
              <Btn icon="x" variant="danger" onPress={() => { haptic(); game.hostReject(); }}>Reject — wrong</Btn>
            </View>

            <Btn icon="skip-forward" variant="ghost" onPress={() => { haptic(); game.skipSong(); }}>Skip song</Btn>

            <View style={[s.card, { marginTop: 22, paddingHorizontal: 14 }]}>
              {sorted.map((p, i) => (
                <View key={p.playerId} style={[s.lbRow, p.playerId === room.buzzerWinnerId && { backgroundColor: '#242443', marginHorizontal: -14, paddingHorizontal: 14, borderRadius: 12 }]}>
                  <Text style={s.lbRank}>{i + 1}</Text>
                  <Avatar player={p} size={32} />
                  <Text style={[s.lbName, { flex: 1 }, p.left && { color: C.mutedForeground }]}>{p.name}{p.left ? ' · Left Game' : ''}</Text>
                  <Text style={s.lbScore}>{p.score}</Text>
                </View>
              ))}
            </View>
          </ScrollView>
        </LinearGradient>
      );
    }

    // ── Buzzed — player who won ───────────────────────────────────────────────
    if (phase === 'buzzed' && iAmBuzzer) {
      const locked = !!room.answerLocked || secondsLeft === 0;
      return (
        <LinearGradient colors={[C.background, '#31172D']} style={s.screen}>
          <ScrollView contentContainerStyle={[s.page, pageStyle]} keyboardShouldPersistTaps="handled">
            <View style={s.row}>
              <Pill active>YOU BUZZED FIRST</Pill>
              <View style={[s.timerCircle, locked && { backgroundColor: C.secondary }]}>
                {locked
                  ? <Icon name="lock" color={C.text} size={18} />
                  : <Text style={s.timerNum}>{secondsLeft ?? ''}</Text>}
              </View>
            </View>
            <Text style={s.bigTitle}>Answer{'\n'}now!</Text>
            <Text style={s.subtitle}>Type your answer below — the host will see it instantly.</Text>
            {currentSong?.albumArt && (
              <View style={{ borderRadius: 18, overflow: 'hidden', marginTop: 20, height: 130 }}>
                <Image source={{ uri: currentSong.albumArt }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
                <View style={[StyleSheet.absoluteFill, { backgroundColor: '#0A0D1BAA', alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 10 }]}>
                  <Icon name="volume-x" color={C.text} size={20} />
                  <Text style={{ color: C.text, fontWeight: '800', fontSize: 11, letterSpacing: 1.2 }}>MUSIC PAUSED</Text>
                </View>
              </View>
            )}
            <Text style={[s.inputLabel, { marginTop: 22 }]}>YOUR ANSWER</Text>
            <TextInput
              value={answerDraft}
              onChangeText={text => {
                setAnswerDraft(text);
                // Send live as user types so host sees it in real time
                game.submitAnswer(text);
              }}
              placeholder={room?.round % 2 === 0 ? 'Who is the artist?' : 'What is the song title?'}
              placeholderTextColor={C.mutedForeground}
              style={[s.input, { fontSize: 20, fontWeight: '800' }]}
              autoFocus
              autoCapitalize="words"
              editable={!locked}
            />
            <View style={[s.ruleBox, { marginTop: 12 }]}>
              <Icon name={locked ? 'lock' : 'eye'} color={locked ? C.accent : C.mint} size={15} />
              <Text style={[s.mutedText, { flex: 1 }]}>
                {locked
                  ? "Time's up — answer locked in. Waiting for the host to judge."
                  : 'The host sees your answer as you type. Leave it blank and it counts as wrong.'}
              </Text>
            </View>
          </ScrollView>
        </LinearGradient>
      );
    }

    // ── Buzzed — other players (locked out) ──────────────────────────────────
    if (phase === 'buzzed' && !iAmBuzzer && !isHost) {
      return (
        <LinearGradient colors={[C.background, '#171032']} style={s.screen}>
          <View style={[s.page, { flex: 1, alignItems: 'center', justifyContent: 'center', ...pageStyle }]}>
            {room.buzzerWinnerColor && (
              <View style={[s.bigAvatar, { backgroundColor: PLAYER_COLORS[room.buzzerWinnerColor], marginBottom: 20 }]}>
                <Text style={s.bigAvatarText}>{room.buzzerWinnerName?.charAt(0).toUpperCase()}</Text>
              </View>
            )}
            <Text style={s.bigTitle}>{room.buzzerWinnerName ?? 'Someone'}{'\n'}buzzed!</Text>
            <Text style={s.subtitle}>Your buzzer is locked.</Text>
            <View style={[s.ruleBox, { marginTop: 24 }]}>
              <Icon name="lock" color={C.accent} size={15} />
              <Text style={[s.mutedText, { flex: 1 }]}>Waiting for the host to judge their answer…</Text>
            </View>
          </View>
        </LinearGradient>
      );
    }

    // ── Revealing ─────────────────────────────────────────────────────────────
    if (phase === 'revealing' && answerReveal) {
      const { outcome, buzzerName } = answerReveal;
      const correct = outcome === 'correct';
      const nobody = outcome === 'nobody';
      const mine = !!answerReveal.buzzerId && answerReveal.buzzerId === me?.playerId;
      const who = buzzerName ?? 'They';
      const myScore = me?.score ?? 0;
      const [title, subtitle] = nobody
        ? ['Nobody got it.', 'No points this round.']
        : mine
          ? correct ? ['Nailed it.', '+1 point to you.']
            : outcome === 'timeout' ? ["Time's up.", '−1 point. Be quicker next time.']
            : ['Not quite.', '−1 point. Keep going.']
          : correct ? [`${who} got it.`, `+1 point to ${who}.`]
            : outcome === 'timeout' ? [`${who} ran out of time.`, `−1 point to ${who}.`]
            : [`${who} missed it.`, `−1 point to ${who}.`];
      const gradient: [string, string] = nobody ? ['#0A0D1B', '#221A3F'] : correct ? ['#0A0D1B', '#0E342F'] : ['#0A0D1B', '#3A1824'];
      return (
        <LinearGradient colors={gradient} style={s.screen}>
          <ScrollView contentContainerStyle={[s.page, pageStyle]}>
            <View style={[s.resultIcon, { backgroundColor: nobody ? C.accent : correct ? C.mint : C.destructive }]}>
              <Icon name={nobody ? 'help-circle' : correct ? 'check' : outcome === 'timeout' ? 'clock' : 'x'} color={C.deep} size={30} />
            </View>
            <Text style={s.bigTitle}>{title}</Text>
            <Text style={s.subtitle}>{subtitle}</Text>

            <View style={[s.revealCard, { marginTop: 30 }]}>
              {currentSong?.albumArt && <Image source={{ uri: currentSong.albumArt }} style={s.revealArt} contentFit="cover" />}
              <View style={{ flex: 1 }}>
                <Text style={s.eyebrow}>THE ANSWER WAS</Text>
                <Text style={s.revealTitle}>{answerReveal.correctTitle}</Text>
                <Text style={s.revealArtist}>{answerReveal.correctArtist}</Text>
                {currentSong && <Pill>{currentSong.category}</Pill>}
              </View>
            </View>

            {!isHost && (
              <View style={[s.ruleBox, { marginTop: 20 }]}>
                <Text style={[s.mutedText, { flex: 1 }]}>Your score: <Text style={{ color: C.accent, fontWeight: '800' }}>{myScore} pts</Text></Text>
              </View>
            )}
            <View style={{ height: 16 }} />

            {isHost ? (
              <Btn icon="arrow-right" onPress={() => { haptic(); game.nextRound(); }}>{room.round >= room.totalRounds ? 'See final results' : 'Next round'}</Btn>
            ) : (
              <View style={s.waitBox}><View style={s.waitDot} /><Text style={s.waitText}>Waiting for host to continue…</Text></View>
            )}
          </ScrollView>
        </LinearGradient>
      );
    }

    // ── Finished ──────────────────────────────────────────────────────────────
    if (phase === 'finished') {
      const winner = sorted[0];
      return (
        <LinearGradient colors={['#14102B', '#33214A', '#0A0D1B']} style={s.screen}>
          <ScrollView contentContainerStyle={[s.page, pageStyle]}>
            <View style={s.finalBurst}><View style={s.finalBurstInner}><Icon name="award" color={C.deep} size={38} /></View></View>
            <Text style={[s.eyebrow, { textAlign: 'center', marginTop: 24 }]}>GAME OVER</Text>
            <Text style={[s.bigTitle, { textAlign: 'center' }]}>That's a wrap.</Text>
            <Text style={[s.subtitle, { textAlign: 'center', marginBottom: 20 }]}>Thanks for playing. Same time next track?</Text>

            {winner && (
              <View style={s.winnerCard}>
                <Text style={s.eyebrow}>WINNER</Text>
                <Avatar player={winner} size={64} />
                <Text style={s.winnerName}>{winner.name}</Text>
                <Text style={s.winnerScore}>{winner.score}<Text style={{ fontSize: 12, letterSpacing: 1 }}> POINTS</Text></Text>
              </View>
            )}

            <View style={{ marginTop: 12 }}>
              {sorted.slice(1).map((p, i) => (
                <View key={p.playerId} style={[s.lbRow, { borderBottomColor: C.border, borderBottomWidth: 1, minHeight: 46 }]}>
                  <Text style={s.lbRank}>{i + 2}</Text>
                  <Avatar player={p} size={32} />
                  <Text style={[s.lbName, { flex: 1 }]}>{p.name}</Text>
                  <Text style={s.mutedText}>{p.score} pts</Text>
                </View>
              ))}
            </View>

            <View style={{ marginTop: 24 }}>
              <Btn icon="rotate-ccw" onPress={() => { game.leaveGame(); setPre('home'); }}>Play another game</Btn>
            </View>
          </ScrollView>
        </LinearGradient>
      );
    }

    // Fallback — loading
    return (
      <LinearGradient colors={[C.background, '#111937']} style={s.screen}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="loader" color={C.accent} size={32} />
          <Text style={[s.mutedText, { marginTop: 14 }]}>Connecting…</Text>
        </View>
      </LinearGradient>
    );
    })();

    const soundButton = soundBlocked && room.phase === 'playing' ? (
      <Pressable testID="enable-sound" onPress={() => unlockWebAudio()} style={[s.soundBtn, { bottom: Math.max(insets.bottom, 16) + 8 }]}>
        <Icon name="volume-2" color={C.deep} size={16} />
        <Text style={s.soundBtnText}>Tap for sound</Text>
      </Pressable>
    ) : null;

    return <View style={{ flex: 1 }}>{roomScreen}{connBanner}{soundButton}</View>;
  }

  // ── Rejoining a saved game after the app was closed / page refreshed ──────
  if (game.restoring) {
    return (
      <LinearGradient colors={[C.background, '#111937']} style={s.screen}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 22 }}>
          <Icon name="refresh-cw" color={C.accent} size={32} />
          <Text style={[s.gameMode, { marginTop: 16 }]}>Getting you back in…</Text>
          <Text style={[s.mutedText, { marginTop: 6, textAlign: 'center' }]}>Rejoining the game you were in.</Text>
          <View style={{ marginTop: 24, alignSelf: 'stretch' }}>
            <Btn variant="ghost" icon="x" onPress={() => { game.leaveGame(); setPre('home'); }}>Cancel</Btn>
          </View>
        </View>
      </LinearGradient>
    );
  }

  // ── Pre-game screens ──────────────────────────────────────────────────────
  if (pre === 'home') {
    return (
      <LinearGradient colors={[C.background, '#111937', '#15112C']} style={s.screen}>
        <ScrollView contentContainerStyle={[s.homeContent, pageStyle]} showsVerticalScrollIndicator={false}>
          <View style={s.row}>
            <Brand />
            <View style={s.livePill}><View style={s.liveDot} /><Text style={s.livePillText}>PARTY MODE</Text></View>
          </View>
          {game.notice && (
            <Pressable onPress={game.clearNotice} style={[s.ruleBox, { marginTop: 18 }]}>
              <Icon name="info" color={C.accent} size={15} />
              <Text style={[s.mutedText, { flex: 1 }]}>{game.notice}</Text>
              <Icon name="x" color={C.mutedForeground} size={14} />
            </Pressable>
          )}
          <View style={{ marginTop: 58 }}>
            <Text style={s.eyebrow}>THE ROOM IS YOURS</Text>
            <Text style={s.heroTitle}>Kiwi Buzz</Text>
            <Text style={[s.subtitle, { maxWidth: 300 }]}>A live music quiz where the quickest ears win the room.</Text>
          </View>
          <View style={s.heroArt}>
            <Image
              source={require('../assets/images/kiwi-buzz-logo.png')}
              style={{ width: '100%', height: '100%' }}
              contentFit="contain"
            />
          </View>
          <View style={{ gap: 11, marginTop: 8 }}>
            <Btn icon="plus" onPress={() => { haptic(); setPre('setup'); }}>Create a game</Btn>
            <Btn icon="log-in" variant="secondary" onPress={() => { haptic(); setPre('join'); }}>Join with a code</Btn>
          </View>
          <View style={{ borderTopColor: C.border, borderTopWidth: 1, marginTop: 38, paddingTop: 22 }}>
            <Text style={s.eyebrow}>HOW IT WORKS</Text>
            {[['Listen together', 'The track starts for everyone at once.'], ['Buzz before them', 'First press wins the answer window.']].map(([title, sub]) => (
              <View key={title} style={[s.row, { marginTop: 18, alignItems: 'center', justifyContent: 'flex-start', gap: 14 }]}>
                <View style={s.stepNum}><Icon name="zap" color={C.accent} size={13} /></View>
                <View><Text style={{ color: C.text, fontWeight: '700', fontSize: 14 }}>{title}</Text><Text style={s.mutedText}>{sub}</Text></View>
              </View>
            ))}
          </View>
        </ScrollView>
      </LinearGradient>
    );
  }

  if (pre === 'setup' || pre === 'join') {
    const isSetup = pre === 'setup';
    return (
      <LinearGradient colors={[C.background, '#111937']} style={s.screen}>
        <ScrollView contentContainerStyle={[s.page, pageStyle]} keyboardShouldPersistTaps="handled">
          <Header title={isSetup ? 'Create a game' : 'Join a room'} eyebrow={isSetup ? 'HOST SETUP' : 'PLAYER CHECK-IN'}
            onBack={() => { game.clearError(); setPre('home'); }} />
          <View style={{ marginBottom: 28, marginTop: 32 }}>
            <Text style={[s.heroTitle, { fontSize: 34, letterSpacing: -1.2 }]}>{isSetup ? 'Make some noise.' : 'Ready when you are.'}</Text>
            <Text style={[s.subtitle, { marginTop: 10 }]}>{isSetup ? 'Pick the vibe, then invite your crew.' : "Enter your name and the host's room code."}</Text>
          </View>

          {(error || joinError) && <ErrorBanner message={(error || joinError)!} onDismiss={game.clearError} />}

          <Text style={s.inputLabel}>YOUR NAME</Text>
          <TextInput value={playerName} onChangeText={setPlayerName} placeholder="e.g. Alex" placeholderTextColor={C.mutedForeground} style={s.input} autoCapitalize="words" testID="player-name-input" />

          {!isSetup && (
            <>
              <Text style={s.inputLabel}>ROOM CODE</Text>
              <TextInput value={joinCode} onChangeText={t => setJoinCode(t.toUpperCase())} placeholder="6 character code" placeholderTextColor={C.mutedForeground} style={[s.input, { fontSize: 22, fontWeight: '800', letterSpacing: 4 }]} autoCapitalize="characters" maxLength={6} testID="room-code-input" />
            </>
          )}

          <Text style={s.inputLabel}>YOUR COLOUR</Text>
          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
            {COLOR_OPTIONS.map(col => (
              <Pressable key={col} onPress={() => setSelectedColor(col)} style={[s.colorOption, { backgroundColor: PLAYER_COLORS[col], borderWidth: selectedColor === col ? 3 : 0, borderColor: '#fff' }]}>
                {selectedColor === col && <Icon name="check" color={col === 'yellow' || col === 'mint' ? C.deep : '#fff'} size={16} />}
              </Pressable>
            ))}
          </View>

          {isSetup && (
            <>
              <View style={[s.row, { marginTop: 22, borderBottomColor: C.border, borderBottomWidth: 1, paddingBottom: 16 }]}>
                <View><Text style={s.inputLabel}>ROUNDS</Text><Text style={s.mutedText}>How long should the party last?</Text></View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: C.deep, borderRadius: 12, padding: 4 }}>
                  <Pressable onPress={() => setRounds(r => Math.max(5, r - 5))} style={[s.stepperBtn]}><Text style={{ color: C.text, fontSize: 20 }}>−</Text></Pressable>
                  <Text style={{ color: C.text, fontWeight: '800', fontSize: 16, minWidth: 22, textAlign: 'center' }}>{rounds}</Text>
                  <Pressable onPress={() => setRounds(r => Math.min(20, r + 5))} style={[s.stepperBtn]}><Text style={{ color: C.text, fontSize: 20 }}>+</Text></Pressable>
                </View>
              </View>
              <Text style={s.inputLabel}>MUSIC</Text>
              <View style={{ gap: 10 }}>
                <Pressable
                  testID="music-itunes"
                  onPress={() => setMusicSource('itunes')}
                  style={[s.musicOption, musicSource === 'itunes' && s.musicOptionOn]}
                >
                  <Icon name="music" color={musicSource === 'itunes' ? C.accent : C.softText} size={18} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.musicOptionTitle}>Song previews</Text>
                    <Text style={s.mutedText}>30-second clips play on every phone. No account needed.</Text>
                  </View>
                  {musicSource === 'itunes' && <Icon name="check-circle" color={C.accent} size={18} />}
                </Pressable>

                <Pressable
                  testID="music-spotify"
                  onPress={() => { if (Platform.OS === 'web' || nativeSpotify) setMusicSource('spotify'); }}
                  style={[s.musicOption, musicSource === 'spotify' && s.musicOptionOn, Platform.OS !== 'web' && !nativeSpotify && { opacity: 0.5 }]}
                >
                  <Icon name="speaker" color={musicSource === 'spotify' ? C.accent : C.softText} size={18} />
                  <View style={{ flex: 1 }}>
                    <Text style={s.musicOptionTitle}>Spotify Host Mode</Text>
                    <Text style={s.mutedText}>
                      {Platform.OS === 'web'
                        ? 'Full tracks play on YOUR device from your Spotify Premium account. Players just buzz.'
                        : nativeSpotify
                          ? 'Full tracks play through the Spotify app on THIS phone. Players just buzz.'
                          : 'Available when hosting from a web browser or the Kiwi Buzz Android app.'}
                    </Text>
                  </View>
                  {musicSource === 'spotify' && <Icon name="check-circle" color={C.accent} size={18} />}
                </Pressable>

                {musicSource === 'spotify' && nativeSpotify && (
                  <View style={{ gap: 8 }}>
                    {spotifyAuthError && <ErrorBanner message={spotifyAuthError} onDismiss={() => setSpotifyAuthError(null)} />}
                    {nativeConnected ? (
                      <View style={[s.musicOption, { borderColor: C.accent }]}>
                        <Icon name="check-circle" color={C.accent} size={18} />
                        <View style={{ flex: 1 }}>
                          <Text style={s.musicOptionTitle}>Spotify connected</Text>
                          <Text style={s.mutedText}>Tracks will play through the Spotify app on this phone.</Text>
                        </View>
                      </View>
                    ) : (
                      <Btn icon="log-in" variant="secondary" onPress={async () => {
                        setSpotifyAuthError(null);
                        const ok = await nativeReconnect();
                        if (!ok) setSpotifyAuthError('Spotify connection failed — check the Spotify app is installed and try again.');
                      }}>Connect Spotify</Btn>
                    )}
                  </View>
                )}

                {musicSource === 'spotify' && Platform.OS === 'web' && (
                  <View style={{ gap: 8 }}>
                    {spotifyAuthError && <ErrorBanner message={spotifyAuthError} onDismiss={() => setSpotifyAuthError(null)} />}
                    {spotifySession ? (
                      <View style={[s.musicOption, { borderColor: spotifySession.premium ? C.accent : C.border }]}>
                        <Icon name={spotifySession.premium ? 'check-circle' : 'alert-circle'} color={spotifySession.premium ? C.accent : '#FF9F45'} size={18} />
                        <View style={{ flex: 1 }}>
                          <Text style={s.musicOptionTitle}>Connected as {spotifySession.name}</Text>
                          <Text style={s.mutedText}>
                            {spotifySession.premium
                              ? 'Premium confirmed — you are good to go.'
                              : 'Not a Premium account — previews will be used instead.'}
                          </Text>
                        </View>
                        <Pressable onPress={connectSpotify} hitSlop={8}><Text style={{ color: C.softText, fontSize: 12, fontWeight: '700' }}>SWITCH</Text></Pressable>
                      </View>
                    ) : (
                      <Btn icon="log-in" variant="secondary" onPress={connectSpotify}>Connect Spotify</Btn>
                    )}
                  </View>
                )}
              </View>

              <Text style={s.inputLabel}>CATEGORIES</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {CATEGORIES.map(cat => {
                  const on = selectedCategories.includes(cat);
                  return (
                    <Pressable key={cat} onPress={() => toggleCategory(cat)} style={[s.catChip, on && s.catChipOn]}>
                      <Text style={[s.catChipText, on && { color: C.deep }]}>{cat}</Text>
                      {on && <Icon name="check" color={C.deep} size={13} />}
                    </Pressable>
                  );
                })}
              </View>
            </>
          )}

          <View style={{ marginTop: 28, gap: 12 }}>
            <Btn icon={isSetup ? 'arrow-right' : 'log-in'} disabled={connecting || !playerName.trim() || (!isSetup && joinCode.trim().length < 4)}
              onPress={isSetup ? onCreateRoom : onJoinRoom}>
              {connecting ? 'Connecting…' : isSetup ? 'Create room' : 'Join room'}
            </Btn>
          </View>
        </ScrollView>
      </LinearGradient>
    );
  }

  return null;
}

// ── styles ────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  musicOption: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: C.deep, borderRadius: 14, borderWidth: 1, borderColor: C.border, padding: 14 },
  musicOptionOn: { borderColor: C.accent },
  musicOptionTitle: { color: C.text, fontWeight: '700', fontSize: 14 },
  homeContent: { flexGrow: 1, paddingHorizontal: 22 },
  page: { flexGrow: 1, paddingHorizontal: 22 },
  gameWrap: { flex: 1, paddingHorizontal: 22 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },

  // brand
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandMark: { width: 34, height: 34, borderRadius: 11, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  brandPulse: { position: 'absolute', width: 13, height: 13, borderRadius: 10, backgroundColor: C.primary, opacity: 0.7, top: 4, left: 4 },
  brandName: { color: C.text, fontSize: 15, fontWeight: '800', letterSpacing: 1.7 },

  // header
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44 },
  backBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { color: C.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },

  // hero
  heroTitle: { color: C.text, fontSize: 54, fontWeight: '800', letterSpacing: -2.6, lineHeight: 57, marginTop: 12 },
  heroArt: { height: 205, alignItems: 'center', justifyContent: 'center', marginTop: 16 },
  heroGlow: { position: 'absolute', width: 250, height: 180, borderRadius: 120, backgroundColor: C.primary, opacity: 0.11 },
  heroRecord: { width: 166, height: 166, borderRadius: 83, backgroundColor: '#232A51', borderWidth: 1, borderColor: '#43507F', alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-12deg' }] },
  recordCenter: { width: 66, height: 66, borderRadius: 33, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  heroNote: { position: 'absolute', width: 38, height: 38, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  noteOne: { backgroundColor: C.primary, top: 11, right: 52, transform: [{ rotate: '14deg' }] },
  noteTwo: { backgroundColor: C.blue, bottom: 12, left: 54, transform: [{ rotate: '-12deg' }] },

  // badges
  livePill: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: '#17203A', borderRadius: 20, paddingHorizontal: 11, paddingVertical: 7 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.mint },
  livePillText: { color: C.softText, fontSize: 10, fontWeight: '800', letterSpacing: 1.1 },
  loadingPill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#1C2038', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6 },
  loadingPillText: { color: C.accent, fontSize: 10, fontWeight: '700' },

  // buttons
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, backgroundColor: C.primary, borderRadius: 17, minHeight: 58, paddingHorizontal: 20 },
  btnSec: { backgroundColor: C.secondary, borderWidth: 1, borderColor: C.border },
  btnGhost: { backgroundColor: 'transparent' },
  btnDanger: { backgroundColor: C.destructive },
  btnDisabled: { opacity: 0.38 },
  pressed: { opacity: 0.78, transform: [{ scale: 0.985 }] },
  btnText: { color: C.primaryForeground, fontSize: 16, fontWeight: '800', letterSpacing: -0.2 },
  btnTextAlt: { color: C.text },

  // pill
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: C.secondary, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 6 },
  pillActive: { backgroundColor: C.accent },
  pillDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.deep },
  pillText: { color: C.softText, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  pillTextActive: { color: C.deep },

  // waveform
  waveform: { position: 'absolute', bottom: 12, flexDirection: 'row', gap: 4, alignItems: 'center', height: 60, width: '100%', justifyContent: 'center' },
  waveBar: { width: 4, borderRadius: 4, backgroundColor: C.accent },

  // card
  card: { backgroundColor: C.card, borderRadius: 18, borderWidth: 1, borderColor: C.border },

  // inputs
  inputLabel: { color: C.mutedForeground, fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginTop: 18, marginBottom: 9 },
  input: { backgroundColor: C.deep, borderColor: C.border, borderWidth: 1, borderRadius: 14, color: C.text, fontSize: 17, minHeight: 56, paddingHorizontal: 16 },

  // color picker
  colorOption: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },

  // categories
  catChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: C.deep, borderColor: C.border, borderWidth: 1, borderRadius: 11, paddingHorizontal: 12, paddingVertical: 11 },
  catChipOn: { backgroundColor: C.accent, borderColor: C.accent },
  catChipText: { color: C.softText, fontSize: 12, fontWeight: '600' },

  // stepper
  stepperBtn: { width: 30, height: 30, borderRadius: 8, backgroundColor: C.secondary, alignItems: 'center', justifyContent: 'center' },

  // room
  roomCodeCard: { alignItems: 'center', backgroundColor: C.card, borderColor: C.border, borderRadius: 24, borderWidth: 1, marginTop: 28, paddingVertical: 24 },
  roomLabel: { color: C.mutedForeground, fontSize: 10, fontWeight: '800', letterSpacing: 2 },
  roomCode: { color: C.accent, fontSize: 42, fontWeight: '800', letterSpacing: 7, marginLeft: 7, marginTop: 10 },

  // players
  playerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 66, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: C.border },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: C.deep, fontWeight: '900' },
  playerName: { color: C.text, fontSize: 14, fontWeight: '700' },
  playerStatus: { color: C.mutedForeground, fontSize: 11, marginTop: 3 },
  readyTick: { width: 26, height: 26, borderRadius: 12, backgroundColor: '#15362F', alignItems: 'center', justifyContent: 'center' },
  ruleBox: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#1D2035', borderRadius: 14, padding: 13, marginTop: 14 },
  waitBox: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: C.secondary, borderRadius: 16, minHeight: 58 },
  waitDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: C.accent },
  waitText: { color: C.softText, fontSize: 14, fontWeight: '700' },

  // game screen
  gameMode: { color: C.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  scorePill: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: C.secondary, borderRadius: 13, paddingHorizontal: 12, paddingVertical: 9 },
  scorePillVal: { color: C.accent, fontSize: 17, fontWeight: '800' },
  scorePillLbl: { color: C.mutedForeground, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  progressTrack: { height: 5, borderRadius: 4, backgroundColor: C.secondary, overflow: 'hidden', marginTop: 18 },
  progressFill: { height: '100%', borderRadius: 4, backgroundColor: C.primary },
  albumStage: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 270 },
  albumGlow: { position: 'absolute', width: 250, height: 250, borderRadius: 160, backgroundColor: C.primary, opacity: 0.12 },
  albumArt: { width: 220, height: 220, borderRadius: 26 },

  // countdown
  countdownWrap: { alignItems: 'center', minHeight: 180 },
  countdownLabel: { color: C.softText, fontSize: 11, fontWeight: '800', letterSpacing: 2.1 },
  countdownNum: { color: C.accent, fontSize: 88, marginTop: 4 },
  countdownHint: { color: C.mutedForeground, fontSize: 12, marginTop: 4 },

  // buzz
  buzzWrap: { alignItems: 'center', minHeight: 230 },
  buzzPrompt: { color: C.softText, fontSize: 11, fontWeight: '800', letterSpacing: 1.6, marginBottom: 12 },
  buzzBtn: { width: 232, height: 232, borderRadius: 116, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center', elevation: 8 },
  buzzRing: { width: 64, height: 64, borderRadius: 32, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  buzzText: { color: C.primaryForeground, fontSize: 38, fontWeight: '900', letterSpacing: -1.8, marginTop: 8 },
  buzzSub: { color: '#FFD1D9', fontSize: 10, fontWeight: '800', letterSpacing: 1.6, marginTop: 2 },

  // eyebrow / text
  eyebrow: { color: C.accent, fontSize: 10, fontWeight: '800', letterSpacing: 1.7 },
  subtitle: { color: C.softText, fontSize: 15, lineHeight: 22, marginTop: 8 },
  mutedText: { color: C.mutedForeground, fontSize: 12, lineHeight: 18 },

  // host control
  hostSongCard: { flexDirection: 'row', gap: 14, backgroundColor: C.card, borderRadius: 20, borderWidth: 1, borderColor: C.border, padding: 12, alignItems: 'center' },
  hostAlbumArt: { width: 90, height: 90, borderRadius: 13 },
  hostSongTitle: { color: C.text, fontSize: 19, fontWeight: '800', marginTop: 4 },
  hostSongArtist: { color: C.softText, fontSize: 13, marginTop: 3, marginBottom: 6 },
  buzzedWhoCard: { flexDirection: 'row', alignItems: 'center', gap: 16, backgroundColor: '#282045', borderRadius: 20, borderWidth: 1, borderColor: '#4D3C7A', padding: 16, marginTop: 22 },
  bigAvatar: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  bigAvatarText: { color: C.deep, fontWeight: '900', fontSize: 26 },
  buzzedWhoName: { color: C.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },

  // answer / reveal
  bigTitle: { color: C.text, fontSize: 42, fontWeight: '800', letterSpacing: -1.8, lineHeight: 46, marginTop: 16 },
  timerCircle: { width: 52, height: 52, borderRadius: 26, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center' },
  timerNum: { color: C.primaryForeground, fontSize: 22, fontWeight: '900' },

  // connection status strip
  connBanner: { position: 'absolute', left: 16, right: 16, zIndex: 80, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.accent, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9 },
  connBannerText: { color: C.deep, fontSize: 12, fontWeight: '800', flex: 1 },
  soundBtn: { position: 'absolute', alignSelf: 'center', zIndex: 81, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.accent, borderRadius: 22, paddingHorizontal: 18, paddingVertical: 12 },
  soundBtnText: { color: C.deep, fontSize: 14, fontWeight: '800' },
  resultIcon: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginTop: 52 },
  revealCard: { flexDirection: 'row', gap: 14, backgroundColor: C.card, borderRadius: 20, borderWidth: 1, borderColor: C.border, padding: 12, overflow: 'hidden' },
  revealArt: { width: 110, height: 110, borderRadius: 13 },
  revealTitle: { color: C.text, fontSize: 20, fontWeight: '800', marginTop: 5 },
  revealArtist: { color: C.softText, fontSize: 12, marginTop: 3, marginBottom: 8 },

  // leaderboard
  lbRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 58 },
  lbRowMe: { backgroundColor: '#242443', marginHorizontal: -14, paddingHorizontal: 14, borderRadius: 12 },
  lbRank: { color: C.mutedForeground, fontSize: 12, fontWeight: '800', width: 22 },
  lbName: { color: C.text, fontSize: 14, fontWeight: '700' },
  lbScore: { color: C.accent, fontSize: 20, fontWeight: '800' },
  ptsLabel: { color: C.mutedForeground, fontSize: 9, fontWeight: '800', width: 23 },

  // final
  finalBurst: { alignSelf: 'center', width: 120, height: 120, borderRadius: 60, backgroundColor: '#463071', alignItems: 'center', justifyContent: 'center', marginTop: 38, transform: [{ rotate: '9deg' }] },
  finalBurstInner: { width: 80, height: 80, borderRadius: 40, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '-9deg' }] },
  winnerCard: { alignItems: 'center', backgroundColor: '#282045', borderColor: '#5C447F', borderRadius: 23, borderWidth: 1, paddingVertical: 22, gap: 8, marginBottom: 8 },
  winnerName: { color: C.text, fontSize: 21, fontWeight: '800' },
  winnerScore: { color: C.accent, fontSize: 35, fontWeight: '900' },

  // exit / end game link
  exitLink: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingVertical: 12 },
  exitLinkText: { color: C.mutedForeground, fontWeight: '700', fontSize: 13 },

  // confirmation overlay
  confirmBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(5,8,20,0.8)', alignItems: 'center', justifyContent: 'center', padding: 26, zIndex: 60 },
  confirmCard: { backgroundColor: '#161D38', borderColor: C.border, borderWidth: 1, borderRadius: 20, padding: 22, width: '100%', maxWidth: 360 },
  confirmTitle: { color: C.text, fontSize: 19, fontWeight: '800', letterSpacing: -0.4 },
  confirmBtn: { flex: 1, borderRadius: 14, paddingVertical: 13, alignItems: 'center', justifyContent: 'center' },
  confirmBtnCancel: { backgroundColor: C.secondary, borderColor: C.border, borderWidth: 1 },
  confirmBtnCancelText: { color: C.text, fontWeight: '700', fontSize: 14 },
  confirmBtnDanger: { backgroundColor: C.primary },
  confirmBtnDangerText: { color: C.primaryForeground, fontWeight: '800', fontSize: 14 },

  // player answer (host view)
  playerAnswerBox: { backgroundColor: '#282045', borderColor: '#5C447F', borderWidth: 1, borderRadius: 18, padding: 18, marginTop: 12 },
  playerAnswerText: { color: C.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.5, marginTop: 6 },

  // misc
  stepNum: { width: 38, height: 38, borderRadius: 12, backgroundColor: C.secondary, alignItems: 'center', justifyContent: 'center' },
  errorBanner: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: C.destructive, borderRadius: 14, padding: 13, marginBottom: 14 },
  errorText: { color: '#fff', fontSize: 13, flex: 1 },
});

