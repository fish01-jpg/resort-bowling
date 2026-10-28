// Pure orientation math for the phone controller — no browser APIs, so it is
// fully unit-testable in Node.
//
// Convention (Wii-remote style grip: phone upright, screen facing you):
//   - calibrated frame = the phone's pose at calibration
//   - AIM    = rotation about the calibrated y-axis (turning the phone
//              left/right like pointing) -> positive = aims right
//   - STEER  = rotation about the calibrated z-axis (tilting it like a
//              steering wheel) -> positive = ball moves right
//
// Both angles are extracted from the RELATIVE rotation matrix, so they are
// exactly 0 at the calibration pose and smooth nearby for ANY grip.

export const DEG = Math.PI / 180;

/** W3C deviceorientation (intrinsic ZXY) -> quaternion. Angles in degrees. */
export function quatFromEuler(alpha, beta, gamma) {
  const a = (alpha * DEG) / 2, b = (beta * DEG) / 2, g = (gamma * DEG) / 2;
  const c1 = Math.cos(a), s1 = Math.sin(a);
  const c2 = Math.cos(b), s2 = Math.sin(b);
  const c3 = Math.cos(g), s3 = Math.sin(g);
  // q = qz(alpha) * qx(beta) * qy(gamma)
  return {
    w: c1 * c2 * c3 - s1 * s2 * s3,
    x: c1 * s2 * c3 - s1 * c2 * s3,
    y: c1 * c2 * s3 + s1 * s2 * c3,
    z: c1 * s2 * s3 + s1 * c2 * c3,
  };
}

export function quatConj(q) {
  return { w: q.w, x: -q.x, y: -q.y, z: -q.z };
}

export function quatMul(a, b) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

/** Rotation matrix (row-major, 3x3 flat) of quaternion q. */
export function quatToMatrix(q) {
  const { w, x, y, z } = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

/**
 * Extract { aim, steer } from the relative rotation qRel = qCalib^-1 * qNow.
 *   aim   = rotation about calibrated y (radians, + = right)
 *   steer = rotation about calibrated z (radians, + = right)
 * Euler-angle extraction from the matrix: smooth at neutral for any grip,
 * degenerate only near 90-degree compound rotations (far outside steering).
 * wrapAt2pi handles the +-180-degree wrap so a full turn doesn't jitter.
 */
export function extractAngles(qRel) {
  const m = quatToMatrix(qRel);
  // rotation about y: atan2(m02, m22); rotation about z: atan2(m10, m00).
  // Wheel-right (clockwise in the user's view) is a NEGATIVE rotation about
  // +z (which points at the user), so steer flips the sign to make
  // positive = ball moves right.
  const aim = wrapAt2pi(Math.atan2(m[0 * 3 + 2], m[2 * 3 + 2]));
  const steer = wrapAt2pi(-Math.atan2(m[1 * 3 + 0], m[0 * 3 + 0]));
  return { aim, steer };
}

export function wrapAt2pi(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Relative rotation from a calibration quaternion and the current one. */
export function relativeRotation(qCalib, qNow) {
  return quatMul(quatConj(qCalib), qNow);
}

/** Quaternion for a pure rotation about axis (x,y,z) by angle radians. */
export function axisAngle(x, y, z, angle) {
  const h = angle / 2;
  const s = Math.sin(h);
  return { w: Math.cos(h), x: x * s, y: y * s, z: z * s };
}

/**
 * Map extracted angles to controller output for a control-scheme preset.
 *   'wheel'          : wheel-tilt steers the ball, turning aims (Wii-style)
 *   'twist'          : turning steers the ball, wheel-tilt aims (swapped)
 *   'swing'          : ball stays centered; turning aims; swing throws
 *   'flick'          : like swing, but the release needs far less force
 *   'pad'            : touch steering — angles come from the drag, not sensors
 * `sensitivity` scales both angles (a gain > 1 = less tilt needed).
 */
export function applyControlScheme({ steer, aim }, scheme = 'wheel', sensitivity = 1) {
  let s = steer, a = aim;
  if (scheme === 'twist') { const t = s; s = a; a = t; }
  else if (scheme === 'swing' || scheme === 'flick') s = 0;
  // 'wheel' and 'pad' keep the extracted order (pad feeds angles by touch)
  return { steer: s * sensitivity, aim: a * sensitivity };
}
