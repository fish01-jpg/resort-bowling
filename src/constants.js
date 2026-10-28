// Shared dimensions and tuning constants. Units: meters, seconds, radians.
// Coordinate system: +z points down the lane (direction of throw), +x is right, +y is up.
// Foul line at z=0, ball released around z=-1.8, pins centered near z=18.29.

export const LANE = {
  halfWidth: 0.525,        // regulation 1.05m wide
  pinZ: 18.29,            // 60 ft from foul line to headpin
  approachStartZ: -2.8,   // lane surface + collider start (behind the release point)
  deckEndZ: 19.4,         // lane surface + collider end (past the rear pin row at ~19.14)
  pitZ: 19.4,             // pit begins where the deck ends
  pitFloorY: -0.75,       // deep pit: fallen pins/balls drop out of every sightline
  ballRadius: 0.1085,
  ballMass: 5.6,          // slightly lighter ball: less punch through the rack
  pinHeight: 0.381,
  gutterRadius: 0.12,      // half-pipe channel radius (visual + physics trimesh)
  gutterCenterX: 0.645,    // channel center (rim meets the lane edge)
};

export const PIN_SPOTS = (() => {
  const spots = [];
  const dz = 0.3048 * Math.sin(Math.PI / 3); // 0.2640
  const dx = 0.3048 / 2;                     // 0.1524
  const rows = [[0], [-1, 1], [-2, 0, 2], [-3, -1, 1, 3]];
  rows.forEach((mults, r) => {
    mults.forEach((m) => spots.push({ x: m * dx, z: LANE.pinZ + r * dz }));
  });
  return spots;
})();

/**
 * Contact-surface points of one gutter half-pipe, in meters. THE single source
 * of truth for both the physics trimesh and the rendered band: the ball rolls
 * on exactly the surface you see. Points traverse increasing x (for BOTH sides)
 * so triangles wound from them face up on either side of the lane.
 * shape = 'contact' returns the ball surface; 'band' returns the closed
 * outline of the visible lining (material thickness OUTSIDE the contact arc).
 */
export function gutterCrossSection(side, kind = 'contact', segs = 12) {
  const R = LANE.gutterRadius;
  const t = 0.025;
  // points along the lower half-circle at radius r (x increasing, no side yet)
  const halfArc = (r) => {
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const a = Math.PI + (Math.PI * i) / segs;
      pts.push([LANE.gutterCenterX + Math.cos(a) * r, Math.sin(a) * r]);
    }
    return pts;
  };
  if (kind === 'contact') {
    const pts = halfArc(R).map(([x, y]) => [side * x, y]);
    if (side < 0) pts.reverse(); // keep traversal increasing x on both sides
    return pts;
  }
  // band: the FULL outer arc forward, then the FULL contact arc back — every
  // contact point (including both rims) is on the outline, so the visible
  // inner face is exactly the collision surface. Material sits outside it.
  const outer = halfArc(R + t).map(([x, y]) => [side * x, y]);
  const inner = halfArc(R).map(([x, y]) => [side * x, y]);
  return [...outer, ...inner.reverse()];
}

export const TUNING = {
  minSpeed: 5.5,
  maxSpeed: 9.6,
  maxAim: 0.045,         // ~2.6 degrees
  maxPosition: 0.44,     // lateral ball placement
  hookAccel: 0.75,       // stronger spin-directed curve: the ball visibly
                         // goes where it is spinning
  hookRefSpeed: 8.0,   // hook strength is normalized to this speed (speed-invariant entry)
  // Aim assist: gently steers the ball toward the projected guide path.
  // Capped and distance-limited so real misses still miss.
  assistGain: 1.6,        // correction acceleration per meter of error
  assistMax: 0.45,        // max correction acceleration (m/s^2)
  assistCutoff: 0.35,     // no assist beyond this much path error (m)
  chargePeriod: 1.4,     // seconds for full power cycle (up and back)
  settleQuiet: 0.75,      // seconds of continuous pin stillness before scoring
  settleTimeout: 15.0,    // absolute force-settle after this long (pins still moving)
  sweepDuration: 1.4,
  // High-speed scatter: above wobbleSpeed the release gets one bounded,
  // speed-scaled random perturbation — full power is powerful but riskier.
  wobbleSpeed: 8.6,       // m/s where scatter begins (power ~0.76)
  wobbleMaxPos: 0.035,    // max random position offset at max power (m)
  wobbleMaxAim: 0.009,    // max random aim offset at max power (rad)
  wobbleMaxSpin: 0.12,    // max random spin offset at max power
  // Random starting position: each delivery begins at a random spot on the
  // approach — the player must actually aim from wherever they start.
  startJitter: 0.8,       // fraction of maxPosition the start can reach
};
