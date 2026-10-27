// Shared dimensions and tuning constants. Units: meters, seconds, radians.
// Coordinate system: +z points down the lane (direction of throw), +x is right, +y is up.
// Foul line at z=0, ball released around z=-1.8, pins centered near z=18.29.

export const LANE = {
  halfWidth: 0.525,        // regulation 1.05m wide
  pinZ: 18.29,            // 60 ft from foul line to headpin
  approachZ: -3.0,
  pitZ: 18.7,             // where the pin deck ends
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
  maxSpeed: 10.5,
  maxAim: 0.07,          // ~4 degrees
  maxPosition: 0.44,     // lateral ball placement
  hookAccel: 0.5,        // max lateral acceleration from spin (m/s^2)
  chargePeriod: 1.4,     // seconds for full power cycle (up and back)
  settleTimeout: 7.0,    // force-settle after this long
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
