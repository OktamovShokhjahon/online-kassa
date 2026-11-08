/** Audible feedback for the cashier: scan OK, unknown barcode, error. Uses WebAudio, no files. */
let ctx: AudioContext | null = null;

function beep(freq: number, ms: number, delay = 0, type: OscillatorType = 'sine', gain = 0.15) {
  try {
    ctx ??= new (window.AudioContext || (window as any).webkitAudioContext)();
    const t = ctx.currentTime + delay / 1000;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + ms / 1000 + 0.02);
  } catch { /* audio blocked until the first user gesture: ignore */ }
}

export const sounds = {
  ok: () => beep(1180, 70),
  unknown: () => { beep(260, 140, 0, 'square', 0.12); beep(200, 220, 160, 'square', 0.12); },
  error: () => { beep(320, 180, 0, 'sawtooth', 0.12); beep(240, 260, 200, 'sawtooth', 0.12); },
  done: () => { beep(880, 90); beep(1320, 140, 100); },
};
