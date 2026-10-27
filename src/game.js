import { Game } from './scoring.js';
import { PIN_SPOTS, TUNING, LANE } from './constants.js';

// Phases: 'ready' (aim/charge) -> 'rolling' -> 'settling' -> 'sweep' -> 'ready' | 'gameover'
export class BowlingGame {
  constructor({ physics, scene, input, ui, audio }) {
    this.physics = physics;
    this.scene = scene;
    this.input = input;
    this.ui = ui;
    this.audio = audio;
    this.game = new Game();
    this.phase = 'ready';
    this.frameIndex = 0; // 0-based
    this.rollIndex = 0; // 0-based within frame
    this.standingBefore = 10;
    this._settleTimer = 0;
    this._sweepT = 0;
    this._sweepFallen = [];
    this._ballDone = false;
    this._firstImpactDone = false;
    this._pinSoundBudget = 0;

    this.input.onThrow = (controls) => this._throw(controls);
  }

  start() {
    this.game.reset();
    this.frameIndex = 0;
    this.rollIndex = 0;
    this.standingBefore = 10;
    this.physics.resetRack(PIN_SPOTS.map(() => true));
    this._resetBall();
    this.phase = 'ready';
    this._syncUI();
    this.ui.message('Welcome to Sunset Lanes', 'info', 1800);
  }

  _resetBall() {
    const c = this.input.controls;
    this.physics.ballBody.setTranslation(
      { x: c.position, y: LANE.ballRadius, z: -1.8 }, true
    );
    this.physics.ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.physics.ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  _throw(controls) {
    if (this.phase !== 'ready') return;
    this.physics.throwBall({
      position: controls.position,
      aim: controls.aim,
      power: Math.max(0.12, controls.power),
      spin: controls.spin,
    });
    this.standingBefore = this._countStanding();
    this.phase = 'rolling';
    this._settleTimer = 0;
    this._ballDone = false;
    this._firstImpactDone = false;
    this._pinSoundBudget = 0;
    this.ui.updateScorecard(this.game, this._displayFrame());
    this.ui.message('', '', 0);
  }

  _countStanding() {
    let n = 0;
    for (let i = 0; i < 10; i++) if (this.physics.pinState(i).standing) n++;
    return n;
  }

  /** Which frame index (0..9) to highlight in the scorecard. */
  _displayFrame() {
    return Math.min(this.frameIndex, 9);
  }

  fixedUpdate(dt) {
    const p = this.physics;

    if (this.phase === 'ready') {
      this.input.update(dt);
      // keep ball glued to input position while aiming
      this._resetBall();
      return;
    }

    if (this.phase === 'rolling' || this.phase === 'settling') {
      p.step(dt);
      this._handleSounds();

      const bs = p.ballState();
      this.audio.setRollIntensity(
        bs.z > -1 && bs.z < LANE.pinZ + 1 && bs.speed > 0.5 && bs.y < 0.4 ? bs.speed / 10 : 0
      );

      const ballDone =
        bs.z > LANE.pitZ + 0.6 || // reached the pit
        (bs.speed < 0.35 && this._settleTimer > 1.2) || // died on the lane
        bs.y < -0.4; // fell into the pit
      if (ballDone) this._ballDone = true;

      this._settleTimer += dt;
      const pinsQuiet = p.pinsSettled();
      const timeout = this._settleTimer > TUNING.settleTimeout;
      if (this._ballDone && (pinsQuiet || this._settleTimer > 1.5) || timeout) {
        this._settle();
      }
      return;
    }

    if (this.phase === 'sweep') {
      this._sweepT += dt;
      const t = Math.min(1, this._sweepT / TUNING.sweepDuration);
      // sweep bar: lower, travel back, rise
      const sweep = this.scene.sweep;
      const zStart = 17.9, zEnd = 20.6;
      if (t < 0.25) {
        sweep.position.set(0, 2.2 - (2.2 - 0.24) * (t / 0.25), zStart);
      } else if (t < 0.85) {
        const k = (t - 0.25) / 0.6;
        sweep.position.set(0, 0.24, zStart + (zEnd - zStart) * k);
        // fallen pins get dragged / dropped as the bar passes
        for (const idx of this._sweepFallen) {
          const st = this.physics.pinState(idx);
          if (st.present && st.z < sweep.position.z + 0.2 && !this._swept.includes(idx)) {
            this._swept.push(idx);
            this.physics.removePin(idx);
            this._hidePinMesh(idx, true);
          }
        }
      } else {
        const k = (t - 0.85) / 0.15;
        sweep.position.set(0, 0.24 + (2.2 - 0.24) * k, zEnd);
      }
      if (t >= 1) this._afterSweep();
    }
  }

  _handleSounds() {
    const hits = this.physics.drainPinHits();
    if (hits.length) {
      const bs = this.physics.ballState();
      const intensity = Math.min(1, bs.speed / 9);
      this.audio.pinHit(Math.max(0.35, intensity));
      if (!this._firstImpactDone) {
        this._firstImpactDone = true;
      }
    }
  }

  _settle() {
    const standing = this._countStanding();
    const knocked = Math.max(0, this.standingBefore - standing);
    this.audio.setRollIntensity(0);
    this.phase = 'sweep';
    this._sweepT = 0;
    this._swept = [];

    // record the roll
    this.game.rolls.push(knocked);

    // which pins are fallen (for the sweeper)
    this._sweepFallen = [];
    for (let i = 0; i < 10; i++) {
      const st = this.physics.pinState(i);
      if (st.present && !st.standing) this._sweepFallen.push(i);
      if (!st.present) this._hidePinMesh(i, true); // already gone
      else this._hidePinMesh(i, false);
    }

    // messages
    const wasFullRack = this.standingBefore === 10;
    if (knocked === 10 && wasFullRack) {
      this.ui.message('STRIKE!', 'strike', 2200);
      this.audio.jingle('strike');
    } else if (standing === 0 && !wasFullRack) {
      this.ui.message('SPARE!', 'spare', 2000);
      this.audio.jingle('spare');
    } else if (knocked === 0) {
      this.ui.message('GUTTER…', 'gutter', 1500);
      this.audio.jingle('none');
    }

    this._syncUI();
  }

  _afterSweep() {
    // raise sweep done; decide next rack & frame
    const frames = this.game.frames();
    const complete = this.game.isComplete();
    if (complete) {
      this.phase = 'gameover';
      this.audio.setRollIntensity(0);
      const total = this.game.totalScore() ?? 0;
      this.ui.showGameOver(total);
      this.ui.updateScorecard(this.game, -1);
      this.ui.setFrameIndicator(10, 3);
      return;
    }

    // advance frame bookkeeping
    const cur = frames[this.frameIndex] || [];
    let keepStanding = null; // null = full rack
    if (this.frameIndex < 9) {
      if (this.rollIndex === 0) {
        if (cur[0] === 10) { this.frameIndex++; this.rollIndex = 0; }
        else { this.rollIndex = 1; keepStanding = true; }
      } else {
        this.frameIndex++; this.rollIndex = 0;
      }
    } else {
      // 10th frame logic
      const t = frames[9];
      this.rollIndex = t.length; // next roll index
      if (t.length === 1) {
        keepStanding = t[0] !== 10; // after a strike, fresh rack
      } else if (t.length === 2) {
        if (t[0] === 10 && t[1] === 10) keepStanding = false;
        else if (t[0] === 10) keepStanding = true; // second ball left pins
        else if (t[0] + t[1] === 10) keepStanding = false; // spare → fresh rack
        else { this._finish(); return; }
      }
    }

    if (keepStanding === null || keepStanding === false) {
      // full rack
      this.physics.resetRack(PIN_SPOTS.map(() => true));
      this._showAllPins();
    } else {
      // keep the pins that are still standing
      const flags = [];
      for (let i = 0; i < 10; i++) flags.push(this.physics.pinState(i).standing);
      this.physics.resetRack(flags);
      this._showAllPins();
    }

    this._resetBall();
    this.phase = 'ready';
    this._syncUI();
  }

  _finish() {
    this.phase = 'gameover';
    this.audio.setRollIntensity(0);
    const total = this.game.totalScore() ?? 0;
    this.ui.showGameOver(total);
    this.ui.updateScorecard(this.game, -1);
  }

  _hidePinMesh(index, hidden) {
    const m = this.scene.pins[index];
    if (m) m.visible = !hidden;
  }

  _showAllPins() {
    for (let i = 0; i < 10; i++) {
      const st = this.physics.pinState(i);
      this.scene.pins[i].visible = st.present;
    }
  }

  _syncUI() {
    this.ui.updateScorecard(this.game, this._displayFrame());
    const frames = this.game.frames();
    this.ui.setFrameIndicator(
      Math.min(this.frameIndex + 1, 10),
      Math.min(this.rollIndex + 1, 3)
    );
  }

  /** Sync Three.js meshes with physics bodies (called every render frame). */
  syncMeshes(alpha = 1) {
    const p = this.physics;
    const bp = p.ballBody.translation();
    const bq = p.ballBody.rotation();
    this.scene.ball.position.set(bp.x, bp.y, bp.z);
    this.scene.ball.quaternion.set(bq.x, bq.y, bq.z, bq.w);
    for (let i = 0; i < 10; i++) {
      const st = p.pinState(i);
      const m = this.scene.pins[i];
      if (st.present) {
        const b = p.pinBodies[i];
        const pos = b.translation();
        const rot = b.rotation();
        m.visible = true;
        m.position.set(pos.x, pos.y - 0.02, pos.z);
        m.quaternion.set(rot.x, rot.y, rot.z, rot.w);
      } else {
        m.visible = false;
      }
    }
  }
}
