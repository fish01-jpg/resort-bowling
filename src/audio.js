// Procedural WebAudio: rolling rumble, pin clatter, jingles, gentle marimba loop.
// AudioContext must be resumed on first user gesture.

export class AudioFX {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.rollNode = null;
    this.rollGain = null;
    this._musicTimer = null;
    this._nextNoteTime = 0;
    this._noteIndex = 0;
  }

  init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(this.ctx.destination);
    // rolling rumble: looped filtered noise
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 220;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
    this.rollGain = gain;
    this.rollNode = src;
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.linearRampToValueAtTime(m ? 0 : 1, this.ctx.currentTime + 0.1);
  }

  setRollIntensity(v) {
    if (this.rollGain && this.ctx) {
      this.rollGain.gain.linearRampToValueAtTime(Math.min(0.5, v * 0.5), this.ctx.currentTime + 0.08);
    }
  }

  pinHit(intensity = 1) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    // woody knock: bandpass noise burst
    const len = Math.floor(this.ctx.sampleRate * 0.12);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700 + Math.random() * 900;
    bp.Q.value = 2;
    const g = this.ctx.createGain();
    g.gain.value = Math.min(0.55, 0.2 + intensity * 0.4);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t);
    // plus a short pitched tick
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 500 + Math.random() * 400;
    const og = this.ctx.createGain();
    og.gain.setValueAtTime(0.12 * intensity, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    osc.connect(og).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  jingle(kind) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime;
    const notes = kind === 'strike' ? [523, 659, 784, 1047] : kind === 'spare' ? [523, 659, 784] : [392, 330];
    notes.forEach((f, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const g = this.ctx.createGain();
      const t = t0 + i * 0.09;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.55);
    });
  }

  click() {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 900;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.06, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.07);
  }

  // gentle marimba-ish pentatonic loop
  startMusic() {
    if (!this.ctx || this._musicTimer) return;
    const scale = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25]; // C pentatonic-ish
    const pattern = [0, 2, 4, 2, 5, 4, 2, 1];
    const bass = [130.81, 0, 0, 0, 98.0, 0, 0, 0];
    const step = 0.42;
    this._nextNoteTime = this.ctx.currentTime + 0.1;
    const schedule = () => {
      while (this._nextNoteTime < this.ctx.currentTime + 0.5) {
        const t = this._nextNoteTime;
        const i = this._noteIndex % pattern.length;
        // melody note
        const osc = this.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = scale[pattern[i]];
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.045, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0008, t + 0.38);
        osc.connect(g).connect(this.master);
        osc.start(t);
        osc.stop(t + 0.4);
        // soft bass
        if (bass[i]) {
          const b = this.ctx.createOscillator();
          b.type = 'sine';
          b.frequency.value = bass[i];
          const bg = this.ctx.createGain();
          bg.gain.setValueAtTime(0.0001, t);
          bg.gain.exponentialRampToValueAtTime(0.05, t + 0.03);
          bg.gain.exponentialRampToValueAtTime(0.0008, t + 0.8);
          b.connect(bg).connect(this.master);
          b.start(t);
          b.stop(t + 0.85);
        }
        this._nextNoteTime += step;
        this._noteIndex++;
      }
    };
    schedule();
    this._musicTimer = setInterval(schedule, 180);
  }
}
