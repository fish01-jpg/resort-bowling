import { TUNING } from './constants.js';

// Keyboard + mouse controls for the pre-throw phase.
// controls.position: lateral ball placement (m), controls.aim: radians,
// controls.power: 0..1 (oscillates while charging), controls.spin: -1..1
export class Input {
  constructor() {
    this.keys = new Set();
    this.charging = false;
    this.chargeT = 0;
    this.controls = { position: 0, aim: 0, power: 0, spin: 0 };
    this.onThrow = null; // set by game
    this._lastCharging = false;
    this._attach();
  }

  _attach() {
    window.addEventListener('keydown', (e) => {
      if (['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
      if (e.code === 'Space' && !e.repeat) this.charging = true;
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Space' && this.charging) {
        this.charging = false;
        this.chargeT = 0;
        if (this.onThrow) this.onThrow({ ...this.controls });
      }
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      if (this.charging) { this.charging = false; this.chargeT = 0; }
    });
  }

  /** dt in seconds. Call once per fixed step during the 'ready' phase. */
  update(dt) {
    const c = this.controls;
    const left = this.keys.has('KeyA') || this.keys.has('ArrowLeft');
    const right = this.keys.has('KeyD') || this.keys.has('ArrowRight');
    const up = this.keys.has('KeyW') || this.keys.has('ArrowUp');
    const down = this.keys.has('KeyS') || this.keys.has('ArrowDown');
    // A/D (or arrows) move position only; Q/E adjust aim only.
    // (Previously A/D also steered the aim — caused unintended gutter shots.)
    const aimL = this.keys.has('KeyQ');
    const aimR = this.keys.has('KeyE');

    if (this.charging) {
      // while charging, up/down adjust spin; left/right still position
      if (up) c.spin = Math.min(1, c.spin + dt * 1.6);
      if (down) c.spin = Math.max(-1, c.spin - dt * 1.6);
      if (left) c.position = Math.max(-TUNING.maxPosition, c.position - dt * 0.5);
      if (right) c.position = Math.min(TUNING.maxPosition, c.position + dt * 0.5);
      this.chargeT += dt;
      // ping-pong power
      const phase = (this.chargeT / TUNING.chargePeriod) % 2;
      c.power = phase < 1 ? phase : 2 - phase;
    } else {
      if (left) c.position = Math.max(-TUNING.maxPosition, c.position - dt * 0.55);
      if (right) c.position = Math.min(TUNING.maxPosition, c.position + dt * 0.55);
      if (aimL) c.aim = Math.max(-TUNING.maxAim, c.aim - dt * 0.06);
      if (aimR) c.aim = Math.min(TUNING.maxAim, c.aim + dt * 0.06);
      c.power = 0;
    }
  }

  /** Direct programmatic control (used by BowlingAPI / future controllers). */
  setControls(partial) {
    Object.assign(this.controls, partial);
  }
}
