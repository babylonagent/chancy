/**
 * Chancy — Retro Game Sound System (Web Audio API)
 * Zero audio files. All synthesized. Instant load.
 * 
 * Sounds:
 *  - click:     button press blip
 *  - tileOpen:  empty tile reveal (low blip)
 *  - prize:     prize found (rising 2-note chime)
 *  - bomb:      bomb hit (harsh buzz)
 *  - win:       sweep the pot (triumphant 3-note)
 *  - lose:      game over (descending sad notes)
 *  - bgm:       subtle chiptune loop (toggleable, starts muted)
 */

let ctx = null;
let masterGain = null;
let sfxGain = null;
let bgmGain = null;
let muted = false;
let bgmPlaying = false;
let bgmInterval = null;

function ensureCtx() {
  if (ctx) return ctx;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = ctx.createGain();
  masterGain.gain.value = 0.3;
  masterGain.connect(ctx.destination);

  sfxGain = ctx.createGain();
  sfxGain.gain.value = 0.5;
  sfxGain.connect(masterGain);

  bgmGain = ctx.createGain();
  bgmGain.gain.value = 0.08;
  bgmGain.connect(masterGain);

  return ctx;
}

/** Play a single tone with envelope */
function tone(freq, duration, type = 'square', when = 0, gainNode = null) {
  const c = ensureCtx();
  const osc = c.createOscillator();
  const env = c.createGain();
  const dest = gainNode || sfxGain;

  osc.type = type;
  osc.frequency.value = freq;

  const t = c.currentTime + when;
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(0.3, t + 0.005);
  env.gain.exponentialRampToValueAtTime(0.001, t + duration);

  osc.connect(env);
  env.connect(dest);
  osc.start(t);
  osc.stop(t + duration);
}

/** Click — short square wave blip */
function click() {
  if (muted) return;
  tone(880, 0.05, 'square');
  tone(1320, 0.03, 'square', 0.02);
}

/** Back/close — descending blip (signals "leaving/closing") */
function back() {
  if (muted) return;
  tone(660, 0.06, 'square');
  tone(440, 0.08, 'square', 0.04);
}

/** Tile open — low blip */
function tileOpen() {
  if (muted) return;
  tone(220, 0.08, 'square');
}

/** Prize found — rising 2-note chime */
function prize() {
  if (muted) return;
  tone(523, 0.1, 'square');       // C5
  tone(784, 0.15, 'square', 0.1); // G5
}

/** Bomb — harsh buzz + noise */
function bomb() {
  if (muted) return;
  tone(110, 0.3, 'sawtooth');
  tone(80, 0.35, 'sawtooth', 0.05);
  // Noise burst
  const c = ensureCtx();
  const bufferSize = c.sampleRate * 0.2;
  const buffer = c.createBuffer(1, bufferSize, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 2);
  }
  const noise = c.createBufferSource();
  noise.buffer = buffer;
  const noiseGain = c.createGain();
  noiseGain.gain.value = 0.2;
  noise.connect(noiseGain);
  noiseGain.connect(sfxGain);
  noise.start(c.currentTime);
}

/** Win — triumphant 3-note */
function win() {
  if (muted) return;
  tone(523, 0.12, 'square');        // C5
  tone(659, 0.12, 'square', 0.12);  // E5
  tone(784, 0.2, 'square', 0.24);   // G5
  tone(1047, 0.3, 'square', 0.36);  // C6
}

/** Lose — descending sad notes */
function lose() {
  if (muted) return;
  tone(392, 0.15, 'square');        // G4
  tone(330, 0.15, 'square', 0.15);  // E4
  tone(262, 0.3, 'square', 0.3);    // C4
}

/** Background chiptune loop — 4 notes, slow, ambient */
const BGM_NOTES = [261.63, 329.63, 392.00, 523.25]; // C4, E4, G4, C5
let bgmNoteIdx = 0;

function startBgm() {
  if (bgmPlaying || muted) return;
  bgmPlaying = true;
  bgmNoteIdx = 0;

  bgmInterval = setInterval(() => {
    if (muted || !bgmPlaying) return;
    tone(BGM_NOTES[bgmNoteIdx], 0.4, 'triangle', 0, bgmGain);
    bgmNoteIdx = (bgmNoteIdx + 1) % BGM_NOTES.length;
  }, 600);
}

function stopBgm() {
  bgmPlaying = false;
  if (bgmInterval) {
    clearInterval(bgmInterval);
    bgmInterval = null;
  }
}

function toggleMute() {
  muted = !muted;
  if (muted) stopBgm();
  return muted;
}

function isMuted() {
  return muted;
}

/** Initialize audio context on first user interaction */
function init() {
  ensureCtx();
  if (ctx.state === 'suspended') ctx.resume();
}

export default { click, back, tileOpen, prize, bomb, win, lose, startBgm, stopBgm, toggleMute, isMuted, init };
