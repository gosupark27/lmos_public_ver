let ctx: AudioContext | null = null;
let warmed = false;

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!ctx) ctx = new Ctx();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function audioReady(): boolean {
  return warmed;
}

export function wake(): void {
  const audio = context();
  if (!audio || warmed) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = "sine";
  osc.frequency.value = 92;
  gain.gain.value = 0.0001;
  osc.connect(gain);
  gain.connect(audio.destination);
  osc.start();
  const now = audio.currentTime;
  gain.gain.exponentialRampToValueAtTime(0.015, now + 1.1);
  warmed = true;
}

function tone(freq: number, seconds: number, peak: number): void {
  const audio = context();
  if (!audio) return;
  const now = audio.currentTime;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = "triangle";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(peak, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
  osc.connect(gain);
  gain.connect(audio.destination);
  osc.start(now);
  osc.stop(now + seconds + 0.05);
}

export function chime(stack: number): void {
  tone(480 + (stack % 4) * 36, 1.1, 0.035);
}

export function bell(): void {
  tone(312, 1.8, 0.05);
  tone(468, 1.5, 0.02);
}
