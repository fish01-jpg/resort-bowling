// Shared dimensions and tuning constants. Units: meters, seconds, radians.
// Coordinate system: +z points down the lane (direction of throw), +x is right, +y is up.
// Foul line at z=0, ball released around z=-1.8, pins centered near z=18.29.

export const LANE = {
  halfWidth: 0.525,        // regulation 1.05m wide
  pinZ: 18.29,            // 60 ft from foul line to headpin
  approachStartZ: -2.8,   // lane surface + collider start (behind the release point)
  deckEndZ: 19.4,         // lane surface + collider end (past the rear pin row at ~19.14)
  pitZ: 19.4,             // pit begins where the deck ends
  ballRadius: 0.1085,
  ballMass: 7.26,
  pinHeight: 0.381,
  pinMass: 1.55,
  gutterFloorY: -0.10,
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

export const TUNING = {
  minSpeed: 5.5,
  maxSpeed: 9.6,
  maxAim: 0.045,         // ~2.6 degrees
  maxPosition: 0.44,     // lateral ball placement
  hookAccel: 0.5,
  hookRefSpeed: 8.0,   // hook strength is normalized to this speed (speed-invariant entry)        // max lateral acceleration from spin (m/s^2)
  // Aim assist: gently steers the ball toward the projected guide path.
  // Capped and distance-limited so real misses still miss.
  assistGain: 1.6,        // correction acceleration per meter of error
  assistMax: 0.45,        // max correction acceleration (m/s^2)
  assistCutoff: 0.35,     // no assist beyond this much path error (m)
  chargePeriod: 1.4,     // seconds for full power cycle (up and back)
  settleQuiet: 0.75,      // seconds of continuous pin stillness before scoring
  settleTimeout: 15.0,    // absolute force-settle after this long (pins still moving)
  sweepDuration: 1.1,
};

export const COLORS = {
  sky: '#cfe9df',
  wood: '#e6c391',
  pin: '#f8f6ef',
  accent: '#ff6b4a',
  teal: '#0e7d86',
  ink: '#173f3a',
};
