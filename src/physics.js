import RAPIER from 'https://esm.sh/@dimforge/rapier3d-compat@0.12.0';
import * as THREE from 'https://esm.sh/three@0.169.0';
import { LANE, PIN_SPOTS, TUNING, gutterCrossSection } from './constants.js';

const V = new THREE.Vector3();

export class Physics {
  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / 60;
    this.ballBody = null;
    this.pinBodies = []; // indexed by pin id 0..9
    this.activeSpin = 0;
    this.lastLaunch = null;
    this.eventQueue = new RAPIER.EventQueue(true);
    this._pinHandles = new Map(); // collider handle -> pin index
    this._buildStatics();
    this._buildBall();
    this.resetRack(PIN_SPOTS.map(() => true));
  }

  _buildStatics() {
    const W = this.world;
    const fixed = () => RAPIER.RigidBodyDesc.fixed();
    const add = (desc, x, y, z, friction = 0.3, restitution = 0.05) => {
      const body = W.createRigidBody(fixed());
      // NOTE: post-creation col.setTranslation() is silently ignored by the
      // engine — the translation MUST go on the ColliderDesc to take effect.
      const col = W.createCollider(desc.setTranslation(x, y, z), body);
      col.setFriction(friction);
      col.setRestitution(restitution);
      return col;
    };
    const laneStart = LANE.approachStartZ;
    const laneEnd = LANE.deckEndZ;
    const laneLen = laneEnd - laneStart;
    const laneCz = (laneStart + laneEnd) / 2;
    // lane + approach (top surface at y=0) — must support the release point
    // AND the full pin rack (rear row at z≈19.14)
    add(RAPIER.ColliderDesc.cuboid(LANE.halfWidth, 0.05, laneLen / 2), 0, -0.05, laneCz, 0.045);
    // gutters: trimesh half-pipe channels that EXACTLY match the rendered
    // geometry — the ball rolls in the channel you see
    this._buildGutterTrimesh(-1);
    this._buildGutterTrimesh(1);
    for (const side of [-1, 1]) {
      // gutter outer wall (division cap) — flush with the lining's outer rim
      add(RAPIER.ColliderDesc.cuboid(0.05, 0.25, laneLen / 2), side * 0.84, -0.15, laneCz, 0.1);
    }
    // side walls
    for (const side of [-1, 1]) {
      add(RAPIER.ColliderDesc.cuboid(0.05, 1.5, laneLen / 2 + 3.4), side * 1.15, 0.6, laneCz + 0.7, 0.1);
    }
    // deep pit (starts at deckEndZ): floor + back wall + side walls, so
    // fallen pins and balls drop out of sight and stay in the pit
    add(RAPIER.ColliderDesc.cuboid(1.3, 0.15, 1.25), 0, LANE.pitFloorY - 0.15, LANE.pitZ + 1.25, 0.2);
    add(RAPIER.ColliderDesc.cuboid(1.2, 1.6, 0.05), 0, 0.4, LANE.pitZ + 2.35, 0.1);
    for (const side of [-1, 1]) {
      add(RAPIER.ColliderDesc.cuboid(0.05, 0.45, 1.25), side * 1.05, LANE.pitFloorY + 0.35, LANE.pitZ + 1.25, 0.1);
    }
  }

  /**
   * Fixed trimesh collider for one gutter's half-pipe channel, built from the
   * SHARED gutterCrossSection() the rendered band uses — the ball rolls on
   * exactly the surface you see. Two rings at the exact z endpoints (the
   * channel is a straight extrusion), wound so the triangles face up.
   */
  _buildGutterTrimesh(side) {
    const pts = gutterCrossSection(side, 'contact');
    const zA = LANE.approachStartZ, zB = LANE.deckEndZ;
    // bounded longitudinal subdivisions (no long thin triangles) with the
    // last ring landing EXACTLY on deckEndZ: uniform step = span / ringCount
    const rings = Math.max(2, Math.ceil((zB - zA) / 0.25));
    const dz = (zB - zA) / rings;
    const verts = [];
    const indices = [];
    const perRing = pts.length;
    for (let r = 0; r <= rings; r++) {
      const z = zA + r * dz;
      for (const [x, y] of pts) verts.push(x, y, z);
    }
    for (let r = 0; r < rings; r++) {
      for (let i = 0; i + 1 < perRing; i++) {
        const a = r * perRing + i, b = a + 1, c = a + perRing, d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const col = RAPIER.ColliderDesc.trimesh(
      new Float32Array(verts), new Uint32Array(indices)
    );
    col.setFriction(0.1);
    this.world.createCollider(col, body);
  }

  _buildBall() {
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, LANE.ballRadius, -1.8)
      .setLinearDamping(0.02)
      .setAngularDamping(0.05);
    this.ballBody = this.world.createRigidBody(desc);
    const col = RAPIER.ColliderDesc.ball(LANE.ballRadius)
      .setDensity(LANE.ballMass / ((4 / 3) * Math.PI * LANE.ballRadius ** 3))
      .setFriction(0.05)
      .setRestitution(0.1);
    this.world.createCollider(col, this.ballBody);
    this.ballBody.enableCcd(true);
  }

  _createPinBody(index) {
    const spot = PIN_SPOTS[index];
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spot.x, 0.02, spot.z)
      .setLinearDamping(0.22)
      .setAngularDamping(0.35);
    const body = this.world.createRigidBody(desc);
    // main cylinder — collision events enabled for impact sounds.
    // Densities are the authoritative pin mass (~1.41 kg total: a slightly
    // heavier pin that's harder to blast through the rack).
    const cyl = RAPIER.ColliderDesc.cylinder(LANE.pinHeight / 2 - 0.02, 0.052)
      .setTranslation(0, LANE.pinHeight / 2, 0)
      .setDensity(330)
      .setFriction(0.5)
      .setRestitution(0.12)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const c1 = this.world.createCollider(cyl, body);
    // dense base slug to lower the center of mass
    const base = RAPIER.ColliderDesc.ball(0.045)
      .setTranslation(0, 0.05, 0)
      .setDensity(1200)
      .setFriction(0.5)
      .setRestitution(0.12)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const c2 = this.world.createCollider(base, body);
    this._pinHandles.set(c1.handle, index);
    this._pinHandles.set(c2.handle, index);
    body.enableCcd(true);
    return body;
  }

  /** (Re)build the rack. standingFlags[i] = pin i should be standing at its spot. */
  resetRack(standingFlags) {
    for (let i = 0; i < 10; i++) {
      const exists = this.pinBodies[i] != null;
      if (standingFlags[i]) {
        if (!exists) this.pinBodies[i] = this._createPinBody(i);
        else {
          const spot = PIN_SPOTS[i];
          this.pinBodies[i].setTranslation({ x: spot.x, y: 0.02, z: spot.z }, true);
          this.pinBodies[i].setLinvel({ x: 0, y: 0, z: 0 }, true);
          this.pinBodies[i].setAngvel({ x: 0, y: 0, z: 0 }, true);
          this.pinBodies[i].setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
        }
      } else if (exists) {
        this.world.removeRigidBody(this.pinBodies[i]);
        this.pinBodies[i] = null;
      }
    }
    this._snapPrev(); // teleports — restart interpolation cleanly
  }

  /** Place the ball for aiming (teleports; interpolation restarts cleanly). */
  resetBall(x = 0) {
    this.ballBody.setTranslation({ x, y: LANE.ballRadius, z: -1.8 }, true);
    this.ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this._snapPrev();
  }

  removePin(index) {
    if (this.pinBodies[index]) {
      this.world.removeRigidBody(this.pinBodies[index]);
      this.pinBodies[index] = null;
    }
  }

  throwBall({ position = 0, aim = 0, power = 0.7, spin = 0 }, { scatter = true } = {}) {
    const speed = TUNING.minSpeed + power * (TUNING.maxSpeed - TUNING.minSpeed);
    // High-speed scatter: one bounded, speed-scaled release perturbation.
    // Seeded per throw; the ACTUAL (post-scatter) launch is kept in
    // lastLaunch so online replays reproduce the real trajectory.
    // Replays pass the ALREADY-scattered lastLaunch with scatter:false —
    // otherwise the replay would apply a second random perturbation.
    if (scatter && speed > TUNING.wobbleSpeed) {
      const k = Math.min(1, (speed - TUNING.wobbleSpeed) / (TUNING.maxSpeed - TUNING.wobbleSpeed));
      position += (Math.random() * 2 - 1) * TUNING.wobbleMaxPos * k;
      aim += (Math.random() * 2 - 1) * TUNING.wobbleMaxAim * k;
      spin = Math.max(-1, Math.min(1, spin + (Math.random() * 2 - 1) * TUNING.wobbleMaxSpin * k));
    }
    this.lastLaunch = { position, aim, power, spin };
    this.ballBody.setTranslation({ x: position, y: LANE.ballRadius, z: -1.8 }, true);
    this.ballBody.setLinvel({ x: Math.sin(aim) * speed, y: 0, z: Math.cos(aim) * speed }, true);
    // forward roll: rotation about +x for motion along +z
    this.ballBody.setAngvel({ x: speed / LANE.ballRadius, y: 0, z: 0 }, true);
    this.ballBody.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.activeSpin = THREE.MathUtils.clamp(spin, -1, 1);
    this._guide = this._buildGuidePath(position, aim, speed, this.activeSpin);
    this._collisions = [];
    this._snapPrev(); // launch is a teleport — restart interpolation cleanly
  }

  /**
   * The projected path shown by the aim guide: kinematic integration of
   * position + aim + spin hook (same model as the on-screen dots).
   * The assist nudges the real ball toward THIS path — where the player aimed.
   */
  _buildGuidePath(x0, aim, speed, spin) {
    const pts = [];
    let x = x0;
    let z = -1.8;
    let dxz = Math.tan(aim);
    const step = 0.3;
    while (z < LANE.deckEndZ) {
      const ramp = 0.3 + 0.7 * Math.min(1, Math.max(0, z) / LANE.pinZ) ** 2;
      const a = spin * TUNING.hookAccel * ramp;
      dxz += (a / (TUNING.hookRefSpeed * TUNING.hookRefSpeed)) * step;
      x += dxz * step;
      z += step;
      pts.push({ z, x });
    }
    return pts;
  }

  _guideXAt(z) {
    const pts = this._guide;
    if (!pts || pts.length === 0) return null;
    if (z <= pts[0].z) return pts[0].x;
    for (let i = 1; i < pts.length; i++) {
      if (z <= pts[i].z) {
        const a = pts[i - 1], b = pts[i];
        const t = (z - a.z) / (b.z - a.z);
        return a.x + (b.x - a.x) * t;
      }
    }
    return null;
  }

  ballState() {
    const p = this.ballBody.translation();
    const v = this.ballBody.linvel();
    V.set(v.x, v.y, v.z);
    return {
      x: p.x, y: p.y, z: p.z,
      speed: V.length(),
      vx: v.x, vy: v.y, vz: v.z,
      onLane: p.y < LANE.ballRadius + 0.05 && Math.abs(p.x) < LANE.halfWidth && p.z < LANE.pinZ,
    };
  }

  pinState(index) {
    const b = this.pinBodies[index];
    if (!b) return { present: false, standing: false };
    const p = b.translation();
    const q = b.rotation();
    // up vector = quaternion * (0,1,0)
    const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
    const spot = PIN_SPOTS[index];
    const disp = Math.hypot(p.x - spot.x, p.z - spot.z);
    // NOTE: no velocity term — motion is handled separately by pinsSettled().
    // A resting pin's body origin sits at y ≈ -0.005 (colliders start 0.005 above origin),
    // so the y window must extend below zero.
    const standing = upY > 0.75 && disp < 0.35 && p.y > -0.12 && p.y < 0.6;
    return { present: true, standing, x: p.x, y: p.y, z: p.z, upY, disp };
  }

  pinsSettled() {
    // Standing pins can still topple, so they must be quite still.
    // Fallen pins (deck or pit) just need to not be flying around —
    // slow residual creep in the pit must not block scoring forever.
    for (let i = 0; i < 10; i++) {
      const b = this.pinBodies[i];
      if (!b) continue;
      const v = b.linvel(), w = b.angvel();
      const speed = Math.hypot(v.x, v.y, v.z);
      const angvel = Math.hypot(w.x, w.y, w.z);
      const st = this.pinState(i);
      if (st.standing) {
        if (speed > 0.3 || angvel > 1.0) return false;
      } else if (speed > 0.6 || angvel > 2.5) {
        return false;
      }
    }
    return true;
  }

  /** Pin collision events that started this step (for sound). */
  drainPinHits() {
    const hits = [];
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const pin = this._pinHandles.get(h1) ?? this._pinHandles.get(h2);
      if (pin != null) hits.push(pin);
    });
    return hits;
  }

  step(dt) {
    const bs = this.ballState();
    // hook force while ball is on the lane
    if (this.activeSpin !== 0 && bs.onLane && bs.vz > 1) {
      const ramp = 0.3 + 0.7 * Math.min(1, bs.z / LANE.pinZ) ** 2;
      // normalize by speed so the hook CURVE is the same at every power
      // level — power changes pace, not where the ball enters the pins.
      const a = this.activeSpin * TUNING.hookAccel * ramp * (bs.vz / TUNING.hookRefSpeed) ** 2;
      this.ballBody.applyImpulse({ x: a * LANE.ballMass * dt, y: 0, z: 0 }, true);
    }
    // aim assist: gentle steering toward the projected guide path
    if (this._guide && bs.onLane && bs.z > -1.9 && bs.z < LANE.pinZ) {
      const guideX = this._guideXAt(bs.z);
      if (guideX !== null) {
        const err = bs.x - guideX;
        if (Math.abs(err) < TUNING.assistCutoff) {
          const a = THREE.MathUtils.clamp(
            -err * TUNING.assistGain, -TUNING.assistMax, TUNING.assistMax
          );
          this.ballBody.applyImpulse({ x: a * LANE.ballMass * dt, y: 0, z: 0 }, true);
        }
      }
    }
    this._prevBall = this._copyT(this.ballBody);
    this._prevPins = new Map();
    for (let i = 0; i < 10; i++) {
      const b = this.pinBodies[i];
      if (b) this._prevPins.set(i, this._copyT(b));
    }
    this.world.step(this.eventQueue);
  }

  _copyT(b) {
    const p = b.translation(), q = b.rotation();
    return { x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w };
  }

  /** Previous-step transforms for render interpolation (null = snap). */
  prevTransform(body /* 'ball' | pin index */) {
    if (body === 'ball') return this._prevBall || null;
    return (this._prevPins && this._prevPins.get(body)) || null;
  }

  /** Set interpolation history = current state (after teleports). */
  snapInterpolation() { this._snapPrev(); }

  _snapPrev() {
    this._prevBall = this._copyT(this.ballBody);
    this._prevPins = new Map();
    for (let i = 0; i < 10; i++) {
      const b = this.pinBodies[i];
      if (b) this._prevPins.set(i, this._copyT(b));
    }
  }
}
