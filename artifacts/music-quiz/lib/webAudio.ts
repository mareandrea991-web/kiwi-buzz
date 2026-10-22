/**
 * Song playback for the web version.
 *
 * Phone browsers (iPhone Safari especially) refuse to play audio that wasn't
 * started by a tap. Songs here start when the server opens the buzzers — not
 * on a tap — so we keep ONE audio element, "unlock" it during the player's
 * first taps (Join, Create, Buzz…), and reuse it for every song after that.
 */
type Listener = (blocked: boolean) => void;

// A tiny silent WAV (built in code), used to unlock the element inside a tap
function silentWav(): string {
  const samples = 800; // 0.1s at 8kHz, 8-bit mono
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) bytes[o + i] = t.charCodeAt(i); };
  str(0, 'RIFF'); view.setUint32(4, 36 + samples, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  str(36, 'data'); view.setUint32(40, samples, true);
  bytes.fill(128, 44); // 8-bit silence is the midpoint
  let bin = ''; bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return 'data:audio/wav;base64,' + btoa(bin);
}
let SILENCE = '';

let el: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
let unlocked = false;
let blocked = false;
let wantPlaying = false;
const listeners = new Set<Listener>();

function audio(): HTMLAudioElement | null {
  if (typeof window === 'undefined' || typeof Audio === 'undefined') return null;
  if (!el) {
    el = new Audio();
    el.loop = true;
    el.preload = 'auto';
    el.setAttribute('playsinline', 'true');
  }
  return el;
}

function setBlocked(v: boolean) {
  if (blocked === v) return;
  blocked = v;
  listeners.forEach((l) => l(v));
}

/** Call from inside any tap handler. Cheap after the first success. */
export function unlockWebAudio() {
  const a = audio();
  if (!a) return;
  if (unlocked && !blocked) return;
  if (wantPlaying && currentUrl) {
    // A song is waiting — this tap can start it directly
    a.play().then(() => { unlocked = true; setBlocked(false); }).catch(() => {});
    return;
  }
  if (!SILENCE) SILENCE = silentWav();
  currentUrl = null;
  a.src = SILENCE;
  a.muted = true;
  a.play()
    .then(() => { a.pause(); a.muted = false; unlocked = true; setBlocked(false); })
    .catch(() => { a.muted = false; });
}

/** Play `url` (looping). Reuses the unlocked element. */
export function playWebAudio(url: string) {
  const a = audio();
  if (!a) return;
  wantPlaying = true;
  if (currentUrl !== url) { currentUrl = url; a.src = url; }
  a.muted = false;
  a.play().then(() => setBlocked(false)).catch((err: unknown) => {
    // NotAllowedError = the browser wants a tap first
    if ((err as { name?: string })?.name === 'NotAllowedError') setBlocked(true);
  });
}

export function pauseWebAudio() {
  wantPlaying = false;
  el?.pause();
}

export function stopWebAudio() {
  wantPlaying = false;
  if (!el) return;
  // Keep the (unlocked) element and its source; the next song swaps the src
  el.pause();
  currentUrl = null;
  setBlocked(false);
}

/** Subscribe to "the browser blocked sound — show a tap-to-enable button". */
export function onWebAudioBlocked(l: Listener): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
