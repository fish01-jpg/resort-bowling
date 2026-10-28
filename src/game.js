import { Game } from './scoring.js';
import * as THREE from 'https://esm.sh/three@0.169.0';
import { PIN_SPOTS, TUNING, LANE } from './constants.js';
import { Match, playerProgress, FULL_RACK } from './match.js';

const _qA = new THREE.Quaternion();
const _qB = new THREE.Quaternion();

// Phases: 'ready' (aim/charge) -> 'rolling' -> 'settling' -> 'sweep' -> 'ready' | 'gameover'
// Modes: solo (no match/net), local hot-seat (match), online (net).
export class BowlingGame {
  constructor({ physics, scene, input, ui, audio, match = null, net = null }) {
    this.physics = physics;
    this.scene = scene;
    this.input = input;
    this.ui = ui;
    this.audio = audio;
    this.net = net;          // online: submits rolls to the room, never scores locally
    this.match = match;      // local hot-seat: turn rotation across players
    this.game = new Game();
    this.replay = false;     // replaying a remote player's throw (visuals only)
    this._replayRack = null;
    this._replayKnocked = null;
    this._replayLabel = '';
    this._lastThrowParams = null;
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
    this._prepareNextDelivery();
    this._resetBall();
    this.phase = 'ready';
    this._syncUI();
    this.ui.message('Welcome to Sunset Lanes', 'info', 1800);
  }

  /** Hot-seat: begin (or restart) a local match. */
  startWithMatch(match) {
    this.match = match;
    this.net = null;
    this.game = match.players[0].game;
    this.frameIndex = 0;
    this.rollIndex = 0;
    this.standingBefore = 10;
    this.physics.resetRack(FULL_RACK.slice());
    this._showAllPins();
    this._prepareNextDelivery();
    this._resetBall();
    this.phase = 'ready';
    this._syncUI();
    this.ui.message(`${match.players[0].name} up — Frame 1`, 'info', 2000);
  }

  /** Online: adopt the room context — my game, the authoritative rack, frame/ball. */
  adoptOnlineContext({ game, rack, frame, ball }) {
    this.match = null;
    this.game = game;
    this.frameIndex = frame;
    this.rollIndex = ball;
    this.physics.resetRack(rack);
    this._showAllPins();
    this._prepareNextDelivery();
    this._resetBall();
    this.phase = 'ready';
    this._syncUI();
  }

  /**
   * Prepare for the next delivery: neutral controls so the player can't just
   * repeat the previous throw. Called on every path that returns to aiming
   * (solo continuation, hot-seat handover, online turn adoption, restart).
   * NOT called on remote replay completion (that would wipe the local
   * player's pending input while it isn't their turn).
   */
  _prepareNextDelivery() {
    if (this.input.resetControls) this.input.resetControls();
  }

  _resetBall() {
    const c = this.input.controls;
    this.physics.resetBall(c.position || 0);
  }

  _throw(controls) {
    if (this.phase !== 'ready') return;
    this._lastThrowParams = { ...controls };
    // capture the room revision AT THROW TIME — the settle path submits
    // against this, not whatever revision happens to be current at settle
    if (this.net) this._throwRevision = this.net.revision;
    this.physics.throwBall({
      position: controls.position,
      aim: controls.aim,
      power: Math.max(0.12, controls.power),
      spin: controls.spin,
    }, { scatter: !this._replaying });
    this.standingBefore = this._countStanding();
    this.phase = 'rolling';
    this._settleTimer = 0;
    this._postBallT = 0;
    this._quietT = 0;
    this._ballDone = false;
    this._firstImpactDone = false;
    this._pinSoundBudget = 0;
    this.ui.updateScorecard(this.game, this._displayFrame());
    this.ui.message('', '', 0);
  }

  /**
   * Replay a remote player's throw: real physics for visuals only — the roll is
   * never recorded locally; after the sweep the rack snaps to the authoritative
   * standing set from the room.
   */
  replayThrow(params, standingAfter, knocked, label = '') {
    if (this.phase !== 'ready') return false;
    this.replay = true;
    this._replayRack = standingAfter;
    this._replayKnocked = knocked;
    this._replayLabel = label;
    // params are the ALREADY-scattered launch (physics.lastLaunch) — do not
    // apply the high-power perturbation a second time
    this._replaying = true;
    this._throw({ ...params });
    this._replaying = false;
    return true;
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
      if (this._ballDone) this._postBallT += dt;
      const pinsQuiet = p.pinsSettled();
      const timeout = this._settleTimer > TUNING.settleTimeout;
      // Score only after the pins have been STILL for settleQuiet seconds
      // straight — mid-air or still-tumbling pins must not be frozen/scored.
      // _quietT accumulates continuous stillness; any motion resets it.
      // Force-settle at settleTimeout (15s) no matter what.
      this._quietT = pinsQuiet ? this._quietT + dt : 0;
      const readyToScore =
        this._ballDone &&
        this._postBallT > 0.35 &&
        this._quietT > TUNING.settleQuiet;
      if (readyToScore || timeout) {
        this._settle();
      }
      return;
    }

    if (this.phase === 'sweep') {
      this._sweepT += dt;
      const t = Math.min(1, this._sweepT / TUNING.sweepDuration);
      // pinsetter sweep: drop in front of the rack, lift any standing pins
      // clear, sweep the deadwood back into the pit, rise.
      const sweep = this.scene.sweep;
      const zStart = 17.9, zEnd = 20.8;
      const liftPin = (idx, k) => {
        const b = this.physics.pinBodies[idx];
        if (!b) return;
        const pos = b.translation();
        const y0 = this._sweepLift.get(idx) ?? 0;
        b.setTranslation({ x: pos.x, y: y0 + (0.75 - y0) * k, z: pos.z }, true);
      };
      if (t < 0.15) {
        const k = t / 0.15;
        sweep.position.set(0, 2.2 - (2.2 - 0.19) * k, zStart);
      } else if (t < 0.3) {
        // pinsetter lifts the standing pins clear of the sweep bar (from rest,
        // so k starts at exactly 0 when the branch begins)
        const k = (t - 0.15) / 0.15;
        for (const idx of this._sweepLift.keys()) liftPin(idx, k);
        sweep.position.set(0, 0.19, zStart);
      } else if (t < 0.8) {
        const k = (t - 0.3) / 0.5;
        sweep.position.set(0, 0.19, zStart + (zEnd - zStart) * k);
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
        // bar rises while the lifted pins come back down to their saved
        // positions — even on game-ending paths, so nothing is left floating
        const k = (t - 0.8) / 0.2;
        for (const idx of this._sweepLift.keys()) liftPin(idx, 1 - k);
        sweep.position.set(0, 0.19 + (2.2 - 0.19) * k, zEnd);
      }
      // the sweep teleports bodies (pin lift) — keep interpolation snapped
      // so lifted pins don't smear between their old and new poses
      this.physics.snapInterpolation();
      if (t >= 1) {
        // force exact endpoints before the rack decision reads positions
        for (const idx of this._sweepLift.keys()) liftPin(idx, 0);
        sweep.position.set(0, 2.2, zEnd);
        this.physics.snapInterpolation();
        this._afterSweep();
      }
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
    let knocked = Math.max(0, this.standingBefore - standing);
    if (this.replay && this._replayKnocked != null) knocked = this._replayKnocked;
    this.audio.setRollIntensity(0);
    this.phase = 'sweep';
    this._sweepT = 0;
    this._swept = [];
    // snapshot the standing set NOW: the sweep lifts pins (pinState changes),
    // so the rack decision must not re-read it afterwards
    this._sweepStanding = [];
    this._sweepLift = new Map();
    for (let i = 0; i < 10; i++) {
      const st = this.physics.pinState(i);
      this._sweepStanding.push(st.standing);
      if (st.standing) this._sweepLift.set(i, st.y);
    }

    if (this.net && !this.replay) {
      // online: the room is the single scoring authority — submit and let the
      // room snapshot drive the next rack/turn. Never record locally.
      const standingAfter = [];
      for (let i = 0; i < 10; i++) standingAfter.push(this.physics.pinState(i).standing);
      const submitted = this.net.submitRoll({
        params: this.physics.lastLaunch || this._lastThrowParams,
        knocked,
        standingAfter,
        expectedRevision: this._throwRevision != null ? this._throwRevision : this.net.revision,
      });
      if (submitted && submitted.catch) {
        submitted.catch(() => {
          if (this.onNetSubmitFailed) this.onNetSubmitFailed();
        });
      }
    } else if (!this.replay) {
      // record the roll (solo + local hot-seat)
      this.game.rolls.push(knocked);
    }

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
    const label = this.replay ? this._replayLabel + ': ' : '';
    if (knocked === 10 && wasFullRack) {
      this.ui.message(label + 'STRIKE!', 'strike', 2200);
      this.audio.jingle('strike');
    } else if (standing === 0 && !wasFullRack) {
      this.ui.message(label + 'SPARE!', 'spare', 2000);
      this.audio.jingle('spare');
    } else if (knocked === 0) {
      this.ui.message(label + 'GUTTER…', 'gutter', 1500);
      this.audio.jingle('none');
    }

    this._syncUI();
  }

  _afterSweep() {
    // replay of a remote throw: snap to the authoritative rack, no bookkeeping
    if (this.replay) {
      this.replay = false;
      this.physics.resetRack(this._replayRack || FULL_RACK.slice());
      this._showAllPins();
      this._resetBall();
      this.phase = 'ready';
      this._syncUI();
      if (this.net && this.net.onReplayDone) this.net.onReplayDone();
      return;
    }

    // online: the room snapshot re-applies rack/turn context after our
    // submission — lock input; the room re-enables it when it's our turn again
    if (this.net) {
      this._prepareNextDelivery();
      this._resetBall();
      this.phase = 'ready';
      this.input.setEnabled(false);
      this._syncUI();
      return;
    }

    // raise sweep done; decide next rack & frame
    const bowledFrame = this.frameIndex;
    const frames = this.game.frames();
    const complete = this.game.isComplete();
    if (complete && this.match) {
      if (this.match.allDone()) { this._matchOver(); return; }
      this._switchPlayer();
      return;
    }
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

    // hot-seat: if the active player's frame is complete, pass the turn
    // (fresh rack for the next player)
    if (this.match && this.match.turnEnded(this.game, bowledFrame)) {
      if (this.match.allDone()) { this._matchOver(); return; }
      this._switchPlayer();
      return;
    }

    if (keepStanding === null || keepStanding === false) {
      // full rack
      this.physics.resetRack(PIN_SPOTS.map(() => true));
      this._showAllPins();
    } else {
      // keep the pins that were standing when the sweep started (they were
      // lifted by the pinsetter — pinState can't be trusted anymore)
      this.physics.resetRack(this._sweepStanding.slice());
      this._showAllPins();
    }

    this._prepareNextDelivery();
    this._resetBall();
    this.phase = 'ready';
    this._syncUI();
  }

  /** Hot-seat: hand the lane to the next player with a fresh rack. */
  _switchPlayer() {
    const next = this.match.advanceTurn();
    if (!next) { this._matchOver(); return; }
    this.game = next.game;
    const prog = playerProgress(next.game);
    this.frameIndex = prog.frame;
    this.rollIndex = prog.ball;
    this.standingBefore = 10;
    this.physics.resetRack(FULL_RACK.slice());
    this._showAllPins();
    this._prepareNextDelivery();
    this._resetBall();
    this.phase = 'ready';
    this._syncUI();
    this.ui.message(`${next.name} up — Frame ${prog.frame + 1}`, 'info', 2000);
  }

  _matchOver() {
    this.phase = 'gameover';
    this.audio.setRollIntensity(0);
    if (this.ui.showMatchOver) this.ui.showMatchOver(this.match.standings());
    this.ui.updateScorecard(this.game, -1);
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
    if (this.match && this.ui.updateMatchPanel) {
      const rows = this.match.players.map((p) => ({
        name: p.name,
        total: p.game.totalScore() ?? 0,
        done: p.game.isComplete(),
        active: p === this.match.active,
      }));
      this.ui.updateMatchPanel(rows);
    }
    const frames = this.game.frames();
    this.ui.setFrameIndicator(
      Math.min(this.frameIndex + 1, 10),
      Math.min(this.rollIndex + 1, 3)
    );
  }

  /** Sync Three.js meshes with physics bodies (call every render frame).
   * alpha ∈ [0,1] interpolates between the previous and current physics
   * step — smooth motion at any frame rate (no stepping stutter). */
  syncMeshes(alpha = 1) {
    const p = this.physics;
    const bp = p.ballBody.translation();
    const bq = p.ballBody.rotation();
    const prevB = p.prevTransform('ball');
    if (prevB && alpha < 1) {
      this.scene.ball.position.set(
        prevB.x + (bp.x - prevB.x) * alpha,
        prevB.y + (bp.y - prevB.y) * alpha,
        prevB.z + (bp.z - prevB.z) * alpha
      );
      _qA.set(prevB.qx, prevB.qy, prevB.qz, prevB.qw);
      _qB.set(bq.x, bq.y, bq.z, bq.w);
      _qA.slerp(_qB, alpha);
      this.scene.ball.quaternion.copy(_qA);
    } else {
      this.scene.ball.position.set(bp.x, bp.y, bp.z);
      this.scene.ball.quaternion.set(bq.x, bq.y, bq.z, bq.w);
    }
    for (let i = 0; i < 10; i++) {
      const st = p.pinState(i);
      const m = this.scene.pins[i];
      if (st.present) {
        const b = p.pinBodies[i];
        const pos = b.translation();
        const rot = b.rotation();
        m.visible = true;
        const prev = p.prevTransform(i);
        if (prev && alpha < 1) {
          m.position.set(
            prev.x + (pos.x - prev.x) * alpha,
            prev.y + (pos.y - prev.y) * alpha,
            prev.z + (pos.z - prev.z) * alpha
          );
          _qA.set(prev.qx, prev.qy, prev.qz, prev.qw);
          _qB.set(rot.x, rot.y, rot.z, rot.w);
          _qA.slerp(_qB, alpha);
          m.quaternion.copy(_qA);
        } else {
          // lathe geometry starts at the pin base = body origin
          m.position.set(pos.x, pos.y, pos.z);
          m.quaternion.set(rot.x, rot.y, rot.z, rot.w);
        }
      } else {
        m.visible = false;
      }
    }
  }
}
