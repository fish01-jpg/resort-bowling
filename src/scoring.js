// Pure bowling rules engine — no DOM, no physics. Safe to unit-test in Node.
// Frames are arrays of rolls. Frame 10 can hold up to 3 rolls.
// A roll is the number of pins knocked down by one delivery.

export const STRIKE = 'X';
export const SPARE = '/';
export const GUTTER = '-';

export class Game {
  constructor() {
    this.rolls = []; // flat list of pinfalls, in delivery order
    this.reset();
  }

  reset() {
    this.rolls = [];
  }

  /** Split the flat roll list into frames for display. */
  frames() {
    const frames = [];
    let i = 0;
    for (let f = 0; f < 10; f++) {
      const frame = [];
      if (f < 9) {
        // Frames 1-9
        if (this.rolls[i] === undefined) {
          frames.push(frame); // not started
          continue;
        }
        frame.push(this.rolls[i]);
        if (this.rolls[i] === 10) {
          // strike — one roll, frame complete
        } else if (this.rolls[i + 1] !== undefined) {
          frame.push(this.rolls[i + 1]);
        }
        if (this.rolls[i] === 10) {
          i += 1;
        } else {
          i += 2;
          // if second roll missing, next frame hasn't started; i points beyond array — fine
        }
      } else {
        // Frame 10: up to 3 rolls
        for (let k = 0; k < 3; k++) {
          if (this.rolls[i + k] === undefined) break;
          frame.push(this.rolls[i + k]);
        }
        i += 3;
      }
      frames.push(frame);
    }
    return frames;
  }

  /** Frame-by-frame cumulative scores. null = pending (needs future rolls). */
  scores() {
    const frames = this.frames();
    const out = [];
    let total = 0;
    let pending = false;
    for (let f = 0; f < 10; f++) {
      const fr = frames[f];
      if (pending || fr.length === 0) {
        pending = true;
        out.push(null);
        continue;
      }
      const first = fr[0];
      if (f < 9) {
        if (first === 10) {
          // strike: needs next two rolls
          const next = this._rollsAfter(f);
          if (next.length >= 2) {
            total += 10 + next[0] + next[1];
            out.push(total);
          } else {
            pending = true;
            out.push(null);
          }
        } else if (fr.length === 2) {
          if (first + fr[1] === 10) {
            const next = this._rollsAfter(f);
            if (next.length >= 1) {
              total += 10 + next[0];
              out.push(total);
            } else {
              pending = true;
              out.push(null);
            }
          } else {
            total += first + fr[1];
            out.push(total);
          }
        } else {
          pending = true;
          out.push(null);
        }
      } else {
        // 10th frame scoring
        const need = this._tenthNeeds();
        if (fr.length < need) {
          pending = true;
          out.push(null);
        } else {
          total += fr.reduce((a, b) => a + b, 0);
          out.push(total);
        }
      }
    }
    return out;
  }

  /** How many rolls the 10th frame needs to be complete (2 or 3). */
  _tenthNeeds() {
    const frames = this.frames();
    const fr = frames[9];
    if (fr.length === 0) return 3; // unknown yet; treat as needing 3 for pending logic
    const first = fr[0];
    if (first === 10 || first + (fr[1] ?? -1) === 10) {
      return 3; // strike or spare → bonus roll
    }
    return 2;
  }

  /** Rolls that happened after frame f (flat index helper). */
  _rollsAfter(f) {
    const frames = this.frames();
    let count = 0;
    for (let k = 0; k <= f; k++) count += frames[k].length;
    return this.rolls.slice(count);
  }

  /** True when the game is over (all frames complete). */
  isComplete() {
    const frames = this.frames();
    for (let f = 0; f < 9; f++) {
      const fr = frames[f];
      if (fr.length === 0) return false;
      if (fr[0] === 10) continue; // strike
      if (fr.length < 2) return false;
    }
    const t = frames[9];
    if (t.length === 0) return false;
    if (t[0] === 10 || (t.length >= 2 && t[0] + t[1] === 10)) return t.length >= 3;
    return t.length >= 2;
  }

  /** Total score, or null if pending. */
  totalScore() {
    const s = this.scores();
    return s[9] ?? null;
  }

  /** Standard display symbol for a roll within a frame. */
  static symbol(frameRolls, index, frameIndex) {
    const v = frameRolls[index];
    if (v === undefined) return '';
    if (frameIndex === 9) {
      if (v === 10) return STRIKE;
      if (index > 0 && frameRolls[index - 1] !== 10 && frameRolls[index - 1] + v === 10) return SPARE;
      if (index === 2 && frameRolls[1] !== 10 && frameRolls[0] !== 10 && frameRolls[1] + v === 10) return SPARE;
      return v === 0 ? GUTTER : String(v);
    }
    if (v === 10) return STRIKE;
    if (index === 1 && frameRolls[0] + v === 10) return SPARE;
    return v === 0 ? GUTTER : String(v);
  }
}
