import RAPIER from 'https://esm.sh/@dimforge/rapier3d-compat@0.12.0';
import * as THREE from 'https://esm.sh/three@0.169.0';
import { LANE, PIN_SPOTS, TUNING } from './constants.js';

const V = new THREE.Vector3();

export class Physics {
  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / 60;
    this.ballBody = null;
    this.pinBodies = []; // indexed by pin id 0..9
    this.activeSpin = 0;
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
      const col = W.createCollider(desc, body);
      col.setTranslation({ x, y, z });
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
    // gutters (floor top at gutterFloorY)
    for (const side of [-1, 1]) {
      add(
        RAPIER.ColliderDesc.cuboid(0.12, 0.05, laneLen / 2),
        side * 0.645, LANE.gutterFloorY - 0.05, laneCz, 0.1
      );
      // gutter outer wall
      add(RAPIER.ColliderDesc.cuboid(0.05, 0.25, laneLen / 2), side * 0.80, -0.15, laneCz, 0.1);
    }
    // side walls
    for (const side of [-1, 1]) {
      add(RAPIER.ColliderDesc.cuboid(0.05, 1.1, laneLen / 2 + 2), side * 1.15, 1.0, laneCz, 0.1);
    }
    // pit floor + back wall (pit starts at deckEndZ)
    add(RAPIER.ColliderDesc.cuboid(1.0, 0.05, 1.1), 0, -0.35, LANE.pitZ + 1.1, 0.2);
    add(RAPIER.ColliderDesc.cuboid(1.1, 0.8, 0.05), 0, 0.3, LANE.pitZ + 2.35, 0.1);
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
      .setRestitution(0.08);
    this.world.createCollider(col, this.ballBody);
    this.ballBody.enableCcd(true);
  }

  _createPinBody(index) {
    const spot = PIN_SPOTS[index];
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spot.x, 0.02, spot.z)
      .setLinearDamping(0.35)
      .setAngularDamping(0.35);
    const body = this.world.createRigidBody(desc);
    // main cylinder — collision events enabled for impact sounds
    const cyl = RAPIER.ColliderDesc.cylinder(LANE.pinHeight / 2 - 0.02, 0.052)
      .setTranslation(0, LANE.pinHeight / 2, 0)
      .setDensity(310) // ~1.2 kg
      .setFriction(0.4)
      .setRestitution(0.05)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const c1 = this.world.createCollider(cyl, body);
    // dense base slug to lower the center of mass
    const base = RAPIER.ColliderDesc.ball(0.045)
      .setTranslation(0, 0.05, 0)
      .setDensity(1150) // ~0.44 kg
      .setFriction(0.4)
      .setRestitution(0.05)
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
  }

  removePin(index) {
    if (this.pinBodies[index]) {
      this.world.removeRigidBody(this.pinBodies[index]);
      this.pinBodies[index] = null;
    }
  }

  throwBall({ position = 0, aim = 0, power = 0.7, spin = 0 }) {
    const speed = TUNING.minSpeed + power * (TUNING.maxSpeed - TUNING.minSpeed);
    this.ballBody.setTranslation({ x: position, y: LANE.ballRadius, z: -1.8 }, true);
    this.ballBody.setLinvel({ x: Math.sin(aim) * speed, y: 0, z: Math.cos(aim) * speed }, true);
    // forward roll: rotation about +x for motion along +z
    this.ballBody.setAngvel({ x: speed / LANE.ballRadius, y: 0, z: 0 }, true);
    this.ballBody.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.activeSpin = THREE.MathUtils.clamp(spin, -1, 1);
    this._collisions = [];
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
    for (let i = 0; i < 10; i++) {
      const b = this.pinBodies[i];
      if (!b) continue;
      const v = b.linvel(), w = b.angvel();
      if (Math.hypot(v.x, v.y, v.z) > 0.28 || Math.hypot(w.x, w.y, w.z) > 0.6) return false;
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
    // hook force while ball is on the lane
    const bs = this.ballState();
    if (this.activeSpin !== 0 && bs.onLane && bs.vz > 1) {
      const ramp = 0.3 + 0.7 * Math.min(1, bs.z / LANE.pinZ) ** 2;
      const a = this.activeSpin * TUNING.hookAccel * ramp;
      this.ballBody.applyImpulse({ x: a * LANE.ballMass * dt, y: 0, z: 0 }, true);
    }
    this.world.step(this.eventQueue);
  }
}
