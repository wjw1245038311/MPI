/**
 * Completion chime for the renderer.
 *
 * Synthesized with WebAudio so no audio asset has to ship in the package.
 * Chromium keeps an AudioContext suspended until a user gesture, so the app
 * primes it on the first pointerdown (unlockAudio); if it is still locked when
 * a turn settles we skip the sound silently instead of failing loudly.
 */

let ctx: AudioContext | null = null;

function ensureCtx(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    return ctx;
  } catch {
    return null;
  }
}

/** Prime the audio context on the first user gesture. Returns a cleanup fn. */
export function unlockAudio(): () => void {
  const handler = () => {
    ensureCtx();
  };
  window.addEventListener("pointerdown", handler, { passive: true });
  return () => window.removeEventListener("pointerdown", handler);
}

function tone(ac: AudioContext, freq: number, startAt: number, duration: number, peak: number): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  osc.connect(gain).connect(ac.destination);
  osc.start(startAt);
  osc.stop(startAt + duration + 0.05);
}

/** Short two-note "ding" played when an agent turn completes. */
export function playCompletionChime(): void {
  const ac = ensureCtx();
  if (!ac || ac.state !== "running") return; // still locked: skip silently
  try {
    const t0 = ac.currentTime + 0.01;
    tone(ac, 830.61, t0, 0.28, 0.18); // E5
    tone(ac, 1244.51, t0 + 0.14, 0.4, 0.16); // C6
  } catch {
    /* audio is best-effort */
  }
}
