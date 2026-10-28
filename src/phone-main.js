// Phone controller entry — runs on phone.html (small page: no Three/Rapier).
// The phone IS the controller: gyroscope tilt steers (Wii-remote style) and a
// HOLD of the THROW button + swing releases the ball. A tap can no longer
// throw: press-and-hold captures the aim, your motion while holding IS the
// throw (power, spin, and loft), and releasing the button bowls the ball.

import {
  getFirestore, doc, collection, where, query, limit, getDocs,
  deleteDoc, serverTimestamp, updateDoc,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { PhoneClient } from './rtc.js?v=2';
import {
  quatFromEuler, quatConj, quatMul, relativeRotation, extractAngles,
  applyControlScheme,
} from './orientation.js?v=2';

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBDYH16UPlCBIarBorBAMiyc7Mbn6_v9cw',
  authDomain: 'database-3-9462a.firebaseapp.com',
  projectId: 'database-3-9462a',
  storageBucket: 'database-3-9462a.firebasestorage.app',
  messagingSenderId: '381377295126',
  appId: '1:381377295126:web:b919eadb9ce0d3c50a9637',
  measurementId: 'G-181H9BHDVG',
};

const app = initializeApp(FIREBASE_CONFIG);
const db = getFirestore(app);

// ------------------------------ element handles ---------------------------
const $ = (id) => document.getElementById(id);
const pairScreen = $('pair-screen'), motionScreen = $('motion-screen'), ctlScreen = $('ctl-screen');
const codeInput = $('pair-code'), pairBtn = $('pair-btn'), pairErr = $('pair-err');
const enableBtn = $('enable-motion');
const statusDot = $('status-dot'), statusText = $('status-text'), latency = $('latency');
const slotBadge = $('slot-badge');
const tilt = $('tilt-indicator'), tiltBg = $('tilt-fill'), tiltStage = $('tilt-stage');
const tiltLabel = $('tilt-label');
const throwBtn = $('throw-btn'), calBtn = $('cal-btn');
const reaimBtn = $('reaim-btn');
const swingHint = $('swing-hint');
const gameButtons = $('game-buttons');

let client = null;
let opened = false; // true once the data channel is open (status then goes to the header)
let lastPairRef = null; // last code/token — CONNECT retries reuse it (QR users)
let controlsSuspended = false; // SETUP / motion-permission screen is up: sensor input paused

const settingsScreen = $('settings-screen');
const ALL_SCREENS = [pairScreen, motionScreen, ctlScreen, settingsScreen];

function show(screen) {
  // hide EVERY screen — the old list missed the settings screen, so after
  // leaving SETUP its elements stayed stacked on top of the controls (the
  // "parts of setup don't hide" + "controls feel locked" glitch)
  for (const s of ALL_SCREENS) s.classList.remove('active');
  screen.classList.add('active');
  // sensor-driven holds/throws pause while a modal screen is up — cancel
  // SYNCHRONOUSLY: releasing the button before the next motion event must
  // never throw while a menu is open
  controlsSuspended = (screen === settingsScreen || screen === motionScreen);
  if (controlsSuspended) cancelHold();
}

function setStatus(kind, text) {
  statusDot.className = 'dot ' + kind;
  statusText.textContent = text;
}

// ------------------------------ pairing ----------------------------------
pairBtn.addEventListener('click', async () => {
  pairErr.textContent = '';
  const code = codeInput.value.trim() || lastPairRef; // QR users have no code typed
  if (!code) { pairErr.textContent = 'Enter the 4-letter code from the game.'; return; }
  pairBtn.disabled = true;
  pairBtn.textContent = 'CONNECTING…';
  try {
    await connect(code);
  } catch (e) {
    pairErr.textContent = e.message || 'Could not connect.';
    pairBtn.disabled = false;
    pairBtn.textContent = 'CONNECT';
  }
});
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') pairBtn.click(); });

async function connect(codeOrToken) {
  if (client) { try { client.close(); } catch { /* already dead */ } } // retry: don't leak the old connection
  opened = false;
  lastPairRef = codeOrToken;
  client = new PhoneClient({
    onOpen() {
      // first open: move to the motion/permission flow. On RECONNECT (host
      // refreshed its offer) stay on whatever screen is up.
      if (!opened) {
        opened = true;
        pairBtn.disabled = false;
        pairBtn.textContent = 'CONNECT';
        show(motionScreen);
        requestMotion();
      }
    },
    onStatus(kind, detail) {
      if (opened) {
        if (kind === 'connected') setStatus('ok', 'Connected');
        else if (kind === 'disconnected') {
          setStatus('warn', 'Connection lost — swipe down to reload');
          canThrow = false; // permission is meaningless while disconnected
          cancelHold(); // a hold can't survive the connection dropping
          resetTwist();
          updateThrowUI();
        }
        else if (kind === 'error') setStatus('err', 'Error: ' + (detail || ''));
        else if (kind === 'connecting') setStatus('warn', 'Connecting…');
      } else {
        // BEFORE the channel opens we are still on the pairing screen — the
        // status header isn't visible there, so surface progress/errors on
        // the pairing screen itself and re-enable CONNECT so the user can
        // retry (this was the "stuck on the loading screen" bug)
        if (kind === 'connecting') {
          pairErr.textContent = 'Connecting…';
        } else {
          pairErr.textContent = kind === 'error'
            ? 'Error: ' + (detail || 'connection failed')
            : 'Connection lost — tap CONNECT to retry';
          pairBtn.disabled = false;
          pairBtn.textContent = 'CONNECT';
        }
      }
    },
    onCtl(m) {
      if (m.t === 'phase') {
        const wasMyTurn = canThrow;
        canThrow = !!m.canThrow;
        waitText = m.waitText || null;
        if (!canThrow) cancelHold(); // a hold must not carry across a turn
        else if (!wasMyTurn) { unlockAim(); resetTwist(); } // fresh turn: twist from scratch too
        // slot = which phone we are (1-based); phones = how many are connected
        if (m.slot) {
          slotBadge.textContent = m.phones > 1 ? `P${m.slot}/${m.phones}` : `P${m.slot}`;
          slotBadge.classList.remove('hidden');
        }
        updateThrowUI();
      } else if (m.t === 'ui') {
        renderGameButtons(m.buttons || [], m.values, m.rev);
      }
    },
  });
  if (String(codeOrToken).startsWith('?')) codeOrToken = new URLSearchParams(String(codeOrToken)).get('pair');
  if (/^[0-9a-f]{24,}$/i.test(String(codeOrToken))) await client.connectByToken(codeOrToken);
  else await client.connectByCode(codeOrToken);
}

// QR auto-pair: ?pair=TOKEN in the URL
const params = new URLSearchParams(location.search);
if (params.has('pair')) {
  pairBtn.disabled = true;
  pairBtn.textContent = 'CONNECTING…';
  connect(params.get('pair')).catch((e) => {
    pairErr.textContent = e.message || 'Could not pair from the QR code.';
    pairBtn.disabled = false;
    pairBtn.textContent = 'CONNECT';
  });
}

// ------------------------------ motion permission -------------------------
async function requestMotion() {
  // TOUCH PAD mode needs no sensors at all — skip the permission gate
  if (settings.scheme === 'pad') { startSensors(); return; }
  const needsPermission =
    (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') ||
    (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function');
  if (needsPermission) {
    show(motionScreen); // ask via a real user gesture
    return;
  }
  startSensors();
}

enableBtn.addEventListener('click', async () => {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') throw new Error('orientation denied');
    }
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') throw new Error('motion denied');
    }
    startSensors();
  } catch (e) {
    setStatus('err', 'Motion permission denied — a gyro is required.');
    $('motion-err').textContent = 'Motion permission denied — use TOUCH MODE below.';
    show(motionScreen);
  }
});

// No gyro / permission denied? TOUCH PAD mode works without any sensors.
$('touch-mode-btn').addEventListener('click', () => {
  settings.scheme = 'pad';
  saveSettings();
  refreshSettingsUI();
  startSensors();
});

// ------------------------------ sensor math -------------------------------
// Calibrated relative orientation: rel = qCalib^-1 * qNow, decomposed into
//   steer (wheel tilt -> ball position) and aim (turn -> aim direction).
// See orientation.js (unit-tested in Node) for the extraction and signs.

let qNow = null;         // latest orientation quaternion (or null)
let qCal = null;         // calibration quaternion (or null until set)
let angles = { aim: 0, steer: 0 }; // latest extracted angles, radians

// stable-calibration state: collect samples, require low spread
let calSamples = [];     // [quaternion, ...]
let calDeadline = 0;
const CAL_NEED = 8;      // samples
const CAL_WINDOW_MS = 1500;

function quatAngleBetween(a, b) {
  const d = Math.abs(quatMul(a, quatConj(b)).w);
  return 2 * Math.acos(Math.min(1, Math.max(-1, d)));
}

let sawOrient = false, sawMotion = false; // any sensor data at all? (pad-mode hint)
let lastOrientAt = 0;   // last usable deviceorientation sample (loft freshness)

function onOrient(e) {
  if (settings.scheme === 'pad') return; // touch pad: sensors don't drive the aim
  if (e.alpha == null) return;
  sawOrient = true;
  lastOrientAt = performance.now();
  qNow = quatFromEuler(e.alpha, e.beta, e.gamma);
  if (!qCal) qCal = qNow; // auto-calibrate on first sample
  if (calSamples.length) calSamples.push(qNow); // RECENTER in progress

  const rel = relativeRotation(qCal, qNow);
  angles = extractAngles(rel);
  // the tilt-pad indicator is rendered in tick() from the committed pose
  // (currentControlAngles) so it can never diverge from the thrown aim
}

/**
 * Recalibrate: require a stable pose (samples must stay within a few degrees
 * of the first) before accepting the new neutral. Falls back to the last
 * sample if the window expires.
 */
function calibrate() {
  calSamples = [qNow].filter(Boolean);
  calDeadline = Date.now() + CAL_WINDOW_MS;
  setStatus('warn', 'Calibrating — hold phone neutral');
}

function calTick() {
  if (!calSamples.length) return;
  if (calSamples.length < CAL_NEED && Date.now() < calDeadline) return; // keep collecting
  const first = calSamples[0];
  let stable = true;
  for (const q of calSamples) {
    if (quatAngleBetween(q, first) > 5 * Math.PI / 180) { stable = false; break; }
  }
  if (!stable && Date.now() < calDeadline) return; // wait for steadier hand
  qCal = calSamples[calSamples.length - 1]; // accept the newest sample
  calSamples = [];
  angles = { aim: 0, steer: 0 };
  resetTwist(); // new grip — old twist history is void
  client && client.sendCtl({ t: 'cal' });
  setStatus('ok', 'Calibrated');
}

const MAX_STEER = 0.35; // radians of wheel tilt for full lane travel
const MAX_AIM = 0.45;   // radians of turn for full aim

// ------------------------------ throw button -----------------------------
// HOLD-TO-THROW: a tap can no longer throw the ball. Line up the aim first,
// then PRESS AND HOLD the THROW button — the moment it is pressed the aim is
// CAPTURED (frozen) and everything you do with the phone afterwards controls
// the throw, none of the aiming:
//   - swing harder  -> more power (peak acceleration while held)
//   - wrist twist   -> hook/spin (twist at the moment of release)
//   - swing UPWARD, like tossing the phone up -> the ball LOFTS: it launches
//     into the air and hops onto the lane like a lobbed golf ball (measured
//     from the integrated world-upward velocity of the phone while held)
// RELEASE the button to throw with everything you just did.
// TOUCH PAD mode (no gyroscope) charges power the longer you hold instead.
const SWING_ON = 3.6;    // m/s^2 deviation that counts as a real throwing motion
const FLICK_ON = 2.6;    // FLICK scheme: gentler motions count (weaker sensors)
const HOLD_MIN_MS = 250;    // holds shorter than this are taps, not throws
const TAP_MS = 180;          // a hold under this with no motion = a tap -> NO throw
const HOLD_MOTION_MS = 80;   // SUSTAINED motion required — one jolt is not a throw
const COOLDOWN_MS = 700;
const MAX_PEAK = 20;     // m/s^2 deviation mapped to power 1.0
const UP_FULL = 2.2;     // m/s of upward phone velocity for full loft
const UP_MAX = 4.0;      // ...and the clamp — a violent toss can't launch the ball
const PAD_CHARGE_MS = 1500;  // TOUCH PAD: hold this long for full power
const TWIST_DEADZONE = 40;  // deg/s — smaller wrist motion is noise, not spin
const TWIST_FULL = 300;     // deg/s of release twist for full hook

let aimLocked = false;      // true while the THROW button is held (pose captured at press)
let lockedAngles = null;    // the captured release pose
let lastLiveAngles = { steer: 0, aim: 0 }; // last live pose shown on screen
let liveTwist = 0;    // smoothed wrist-twist rate (deg/s) — aim-guide preview

function unlockAim() {
  aimLocked = false;
  lockedAngles = null;
}

/**
 * The angles to steer/aim with — the SAME value a throw uses (throwAngles),
 * so the screen can never diverge from the ball's line. LIVE whenever the
 * phone is in stance; mid-swing and while carried it freezes at the
 * captured pose. TOUCH PAD mode is always live — the thumb is the intent.
 * The stance gate uses the RAW extracted angles (the mapped steer is
 * zeroed in swing/flick schemes, so it can't gate anything).
 */
function currentControlAngles() {
  // HOLD IN PROGRESS: the aim was captured the moment the button was
  // pressed — everything after that controls the THROW, none of the aiming.
  // Tilting or dragging mid-hold can never re-aim the ball.
  if (holdActive) {
    if (tiltLabel.textContent !== 'ARMED') tiltLabel.textContent = 'ARMED';
    return throwAngles();
  }
  // TOUCH PAD: always live
  if (settings.scheme === 'pad') {
    const m = normalizedPose(mappedAngles());
    lastLiveAngles = m;
    if (tiltLabel.textContent !== 'DRAG TO AIM') tiltLabel.textContent = 'DRAG TO AIM';
    return m;
  }
  // when the game has this phone paused (not its turn / ball in play /
  // re-arming), the big label must SAY so — a stale label there is what
  // made the controls look permanently locked
  const label = !canThrow ? 'WAITING' : 'TILT TO AIM';
  if (tiltLabel.textContent !== label) tiltLabel.textContent = label;
  const raw = angles; // RAW extracted pose — the stance gate (pre-scheme)
  const inRange = Math.abs(raw.steer) <= MAX_STEER * 1.25 && Math.abs(raw.aim) <= MAX_AIM * 1.25;
  if (!inRange) return throwAngles(); // carried / at side: hold the last stance pose
  // in stance: LIVE aiming — no dwell, no auto-lock. The pose is captured
  // when the THROW button is PRESSED (see the hold detector), so the throw
  // is exactly what the screen showed the moment you started your hold.
  const m = normalizedPose(mappedAngles());
  lastLiveAngles = m;
  return m;
}

/** Exactly what the screen shows — the throw can never diverge from the aim. */
function throwAngles() {
  return (aimLocked && lockedAngles) ? lockedAngles : lastLiveAngles;
}

/** Clamp a pose to the steer/aim limits — the ONE normalization point. */
function normalizedPose(m) {
  return { steer: clamp(m.steer, -MAX_STEER, MAX_STEER), aim: clamp(m.aim, -MAX_AIM, MAX_AIM) };
}

// hold-to-throw state: everything the button-hold gesture measures
let holdActive = false;     // THROW button held: aim captured, motion IS the throw
let holdPointerId = null;   // the pointer that started the hold (others are ignored)
let holdStartTs = 0;        // when the button was pressed
let holdPeakDev = 0;        // peak accel deviation while held -> power
let holdUpVel = 0;          // integrated world-upward velocity while held -> loft
let holdActiveMs = 0;       // ms of SUSTAINED throwing motion during the hold

let lastMotionTs = 0;
let lastTwistAt = 0;    // when a rotation sample last arrived (freshness gate)
const TWIST_FRESH_MS = 400; // older than this = stale, spin reads 0

/**
 * Invalidate the twist series: missing sensor data must read as zero spin.
 * Called the moment a sample is unusable, on turn handover, RECENTER, mode
 * change, and disconnect — never only on the timeout below.
 */
function resetTwist() {
  liveTwist = 0;
  lastTwistAt = 0; // the watchdog fails until a NEW sample arrives
}

/** Stale twist reads as zero — a sensor dropout can never replay an old flick. */
function freshTwist(v) {
  return (performance.now() - lastTwistAt <= TWIST_FRESH_MS) ? v : 0;
}

/**
 * Rotate a vector by a quaternion (v' = q v q*): q maps device frame ->
 * world ENU frame (+Z is up), so this turns a device-frame acceleration
 * into a world-frame one. Standard formula: t = 2*(qv x v); v' = v + w*t + qv x t.
 */
function rotateByQuat(q, v) {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + q.y * tz - q.z * ty,
    y: v.y + q.w * ty + q.z * tx - q.x * tz,
    z: v.z + q.w * tz + q.x * ty - q.y * tx,
  };
}

/**
 * World-frame upward acceleration of the phone (m/s^2), or null when it
 * can't be trusted (no orientation sample in the last 300ms, or no usable
 * acceleration data). This is what makes loft possible: start with the
 * phone low, swing/toss it UP while holding THROW, and the in-game ball
 * launches into the air instead of rolling out — the integrated upward
 * velocity at release becomes the ball's loft.
 */
function worldUpAccel(e) {
  if (!qNow || performance.now() - lastOrientAt > 300) return null; // stale pose
  const lin = e.acceleration; // gravity-free, device frame (preferred)
  if (lin && lin.x != null) return rotateByQuat(qNow, lin).z; // ENU: +Z is up
  const ig = e.accelerationIncludingGravity;
  if (!ig || ig.x == null) return null;
  return rotateByQuat(qNow, ig).z - 9.81; // remove gravity (world up is +Z)
}

function onMotion(e) {
  const rot = e.rotationRate;
  // a motion event WITHOUT usable rotation data invalidates the twist series
  // immediately — a missing sample reads as zero spin, never a replayed flick.
  // (The 400ms watchdog only covers the case where events stop arriving.)
  const twistValid = Number.isFinite(rot?.alpha);
  if (!twistValid) resetTwist();
  const acc = e.accelerationIncludingGravity;
  if (!acc || acc.x == null) return;
  sawMotion = true; // usable data only — null-reading events don't count

  // a modal screen (SETUP / motion permission) is up: pause sensor control
  // so a hold can't throw while you're in the menus
  if (controlsSuspended) {
    if (holdActive) cancelHold();
    resetTwist();
    return;
  }

  // a hold must never survive losing the turn — it cancels, never throws
  if (!canThrow) {
    if (holdActive) cancelHold();
    resetTwist(); // off-turn: never show or throw a stale twist
    return;
  }
  const now = performance.now();

  // ONE bounded twist series feeds BOTH the preview and the release capture.
  // rotationRate.alpha is rotation about the phone's OWN screen normal, so it
  // reads the wrist twist however the phone is carried: pure pitch has no
  // alpha component, so carrying the phone cannot show up as hook (the
  // separation is this model's design; real-handset feel is untested).
  if (twistValid) {
    liveTwist = liveTwist * 0.65 + rot.alpha * 0.35;
    lastTwistAt = now;
  }

  const dt = lastMotionTs ? Math.min(0.1, (now - lastMotionTs) / 1000) : 0;
  lastMotionTs = now;
  const dev = Math.abs(Math.hypot(acc.x, acc.y, acc.z) - 9.81);

  // HOLD-TO-THROW: while the button is held, the motion IS the throw.
  // Motion magnitude = gravity-free linear acceleration (fallback: the IG
  // deviation) -> power; integrated world-up velocity -> loft; the wrist
  // twist at release -> spin (captured in the pointerup handler).
  if (holdActive) {
    // honest motion measure: | |IG| - g | squares away most horizontal
    // acceleration, so prefer the gravity-free linear magnitude
    const lin = e.acceleration;
    const mag = (lin && Number.isFinite(lin.x) && Number.isFinite(lin.y) && Number.isFinite(lin.z))
      ? Math.hypot(lin.x, lin.y, lin.z) : dev;
    holdPeakDev = Math.max(holdPeakDev, mag);
    const off = settings.scheme === 'flick' ? FLICK_OFF : SWING_OFF;
    if (mag > off) {
      holdActiveMs += dt * 1000; // SUSTAINED motion — one jolt is not a throw
      // integrate upward acceleration only while the throw motion is ACTIVE
      // and within the first 4s of the hold — drift stays bounded no matter
      // how long the button is held
      if (now - holdStartTs <= 4000) {
        const up = worldUpAccel(e);
        if (up !== null) holdUpVel = clamp(holdUpVel + up * dt, -UP_MAX, UP_MAX);
      }
    }
  }
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const FLICK_OFF = 1.4, SWING_OFF = 1.9; // m/s^2 — active-motion gate (power/loft)

/** Wrist twist (deg/s, grip-relative) -> spin: deadzone then a gentle ramp
 *  to full hook. Sign follows the steering wheel: twisting the phone LEFT
 *  (counterclockwise, positive rotation about the calibrated screen normal)
 *  hooks the ball LEFT (spin < 0 curves left in the physics). */
function spinFromTwist(degPerSec) {
  const a = Math.abs(degPerSec);
  if (a < TWIST_DEADZONE) return 0;
  const s = (a - TWIST_DEADZONE) / (TWIST_FULL - TWIST_DEADZONE);
  return -Math.sign(degPerSec) * clamp(s, 0, 1);
}

/** Abort an in-progress hold WITHOUT throwing (turn lost, screen up,
 *  permission lost, disconnect) — the aim unlocks and nothing is sent. */
function cancelHold() {
  if (!holdActive) return;
  holdActive = false;
  holdPointerId = null;
  holdPeakDev = 0;
  holdUpVel = 0;
  holdActiveMs = 0;
  unlockAim(); // hold over — back to live aiming
  swingHint.classList.remove('armed');
  throwBtn.classList.remove('armed');
  updateThrowUI();
}

let lastThrowAt = 0;
function sendThrow(power, spin, loft = 0, pose = throwAngles()) {
  // gate on the mirrored turn permission too — the host stays authoritative,
  // but this keeps the phone from showing "Thrown" for a rejected hold
  if (!client || !client.connected || !canThrow) return;
  lastThrowAt = performance.now();
  // `pose` is the aim captured at button press, handed in BEFORE the aim lock
  // is released — nothing done while holding can re-aim the ball.
  // spin = wrist twist at release; loft = upward phone motion while held.
  client.sendCtl({
    t: 'throw', id: Math.random().toString(36).slice(2), power, spin, loft,
    steer: pose.steer, aim: pose.aim,
  });
  setStatus('ok', 'Thrown');
  setTimeout(() => setStatus('ok', 'Connected'), 900);
}

// --------------------- mirrored on-screen buttons --------------------------
// The game mirrors its visible buttons here; tapping sends the press back
// (with the snapshot revision, so stale taps are rejected by the host).
// `values` shows the current selector values (games/bowlers) so the player
// can see what the − / + buttons are changing.
let uiRev = 0;
function renderGameButtons(buttons, values, rev) {
  if (Number.isFinite(rev)) uiRev = rev;
  gameButtons.innerHTML = '';
  gameButtons.classList.toggle('hidden', buttons.length === 0);
  // a full menu on the phone: collapse the tilt pad so everything fits
  tiltStage.classList.toggle('hidden', buttons.length > 2);
  const names = { games: 'GAMES', soloGames: 'GAMES', bowlers: 'BOWLERS' };
  const valEntries = Object.entries(values || {})
    .filter(([k]) => k in names)
    .map(([k, v]) => `${names[k]} ${v}`);
  if (valEntries.length) {
    const line = document.createElement('p');
    line.className = 'gb-values';
    line.textContent = valEntries.join(' · ');
    gameButtons.appendChild(line);
  }
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className = 'phone-btn small gb-btn';
    btn.type = 'button';
    btn.textContent = b.label || 'BUTTON';
    btn.addEventListener('click', () => {
      if (client && client.connected) {
        client.sendCtl({ t: 'uiclick', key: b.key, rev: uiRev });
        if (navigator.vibrate) navigator.vibrate(12);
      }
    });
    gameButtons.appendChild(btn);
  }
}

// ------------------------------ settings ---------------------------------
// Control-scheme presets + sensitivity. Persisted when the browser allows it
// (private-mode Safari etc. silently falls back to defaults for the session).
const SCHEME_DESC = {
  wheel: 'Tilt the phone like a steering wheel to move the ball. Turn it left/right to aim. Hold THROW & swing to bowl.',
  twist: 'Turn the phone left/right to move the ball. Tilt it to aim. Hold THROW & swing to bowl.',
  swing: 'Ball stays centered — just turn to aim. Hold THROW, swing your arm (upward = loft), release to bowl. Easiest.',
  flick: 'Ball stays centered — turn to aim; hold THROW and a gentle flick throws (needs less force).',
  pad: 'No gyroscope needed — drag your thumb on the pad to aim, then hold THROW to charge power and release to bowl.',
};
// DEFAULTS: SWING scheme + LOW sensitivity (new out-of-the-box behavior).
// Deliberately saved choices are preserved; only absent/invalid saved
// settings fall back to these.
const DEFAULT_SETTINGS = { scheme: 'swing', sens: 0.6 };
const settings = { ...DEFAULT_SETTINGS };
try {
  const saved = JSON.parse(localStorage.getItem('sl-phone-settings') || 'null');
  if (saved && saved.scheme in SCHEME_DESC && Number.isFinite(saved.sens)) {
    settings.scheme = saved.scheme;
    settings.sens = saved.sens;
  }
} catch { /* no storage — defaults are fine */ }
function saveSettings() {
  try { localStorage.setItem('sl-phone-settings', JSON.stringify(settings)); } catch { /* ignore */ }
}

/** Map raw extracted angles through the active scheme preset. */
function mappedAngles() {
  return applyControlScheme(angles, settings.scheme, settings.sens);
}

$('setup-btn').addEventListener('click', () => { show(settingsScreen); refreshSettingsUI(); });
$('settings-back').addEventListener('click', () => show(ctlScreen));
$('scheme-row').querySelectorAll('.seg-btn').forEach((b) => {
  b.addEventListener('click', () => {
    settings.scheme = b.dataset.scheme;
    saveSettings(); refreshSettingsUI(); updateThrowUI();
    // scheme change: the old pose/hold/twist state is void
    cancelHold(); unlockAim(); resetTwist();
  });
});
$('sens-row').querySelectorAll('.seg-btn').forEach((b) => {
  b.addEventListener('click', () => {
    settings.sens = Number(b.dataset.sens);
    saveSettings(); refreshSettingsUI();
  });
});
function refreshSettingsUI() {
  $('scheme-row').querySelectorAll('.seg-btn').forEach((b) =>
    b.classList.toggle('selected', b.dataset.scheme === settings.scheme));
  $('sens-row').querySelectorAll('.seg-btn').forEach((b) =>
    b.classList.toggle('selected', Number(b.dataset.sens) === settings.sens));
  $('scheme-desc').textContent = SCHEME_DESC[settings.scheme];
}

// --------------------- TOUCH PAD scheme (no gyro needed) ------------------
// Drag on the tilt pad to steer/aim; the pose persists after lifting the
// finger. Works on devices with no gyroscope or denied motion permission.
let padTouchId = null;
function padFromEvent(e) {
  const r = tiltStage.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const nx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
  const ny = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
  angles.steer = nx * MAX_STEER;
  angles.aim = ny * MAX_AIM;
}
tiltStage.addEventListener('pointerdown', (e) => {
  if (settings.scheme !== 'pad') return;
  e.preventDefault();
  padTouchId = e.pointerId;
  try { tiltStage.setPointerCapture(e.pointerId); } catch { /* fine */ }
  padFromEvent(e);
});
tiltStage.addEventListener('pointermove', (e) => {
  if (settings.scheme !== 'pad' || e.pointerId !== padTouchId) return;
  padFromEvent(e);
});
const padEnd = (e) => { if (e.pointerId === padTouchId) padTouchId = null; };
tiltStage.addEventListener('pointerup', padEnd);
tiltStage.addEventListener('pointercancel', padEnd);

// ------------------------------ controls ---------------------------------
// HOLD-TO-THROW (every scheme): press-and-hold the THROW button to arm the
// throw — the aim is captured at press, the phone motion while holding IS
// the throw, and releasing the button bowls the ball. A tap does NOT throw.
let canThrow = false;    // mirrored from the game via phase messages
let waitText = null;      // why we're waiting (from the game), or null

calBtn.addEventListener('click', () => {
  calibrate();
  cancelHold(); // a recenter mid-hold would re-aim — never allowed
  unlockAim(); // the neutral changed — re-aim from scratch
  resetTwist();
});

reaimBtn.addEventListener('click', () => {
  // quick RECENTER: re-zero the neutral to the current stance (same as the
  // settings-screen button, without the trip through SETUP)
  calibrate();
  cancelHold();
  unlockAim();
  resetTwist();
  if (navigator.vibrate) navigator.vibrate(10);
});

/** On-threshold for "did the player actually make a throwing motion". */
const onThresh = () => (settings.scheme === 'flick' ? FLICK_ON : SWING_ON);

/** Throw power implied by the hold so far (sensor schemes). */
function holdPower() {
  return clamp((holdPeakDev - onThresh()) / (MAX_PEAK - onThresh()), 0.15, 1);
}

/**
 * PRESS: capture the aim NOW and start measuring the throw. Everything the
 * phone does between here and the button release is the throw itself.
 */
throwBtn.addEventListener('pointerdown', (e) => {
  if (!canThrow || controlsSuspended) return;
  if (performance.now() - lastThrowAt < COOLDOWN_MS) return; // rapid re-press
  if (holdActive) return; // one hold at a time — extra fingers can't restart it
  e.preventDefault();
  try { throwBtn.setPointerCapture(e.pointerId); } catch { /* fine */ }
  holdActive = true;
  holdPointerId = e.pointerId;
  holdStartTs = performance.now();
  holdPeakDev = 0; holdUpVel = 0; holdActiveMs = 0;
  lockedAngles = lastLiveAngles; aimLocked = true; // the aim, captured
  swingHint.classList.add('armed');
  throwBtn.classList.add('armed');
  if (navigator.vibrate) navigator.vibrate(15);
});

// long-press must not open the context menu / text-select on mobile
throwBtn.addEventListener('contextmenu', (e) => e.preventDefault());

/** RELEASE: bowl the ball with everything the hold measured. */
throwBtn.addEventListener('pointerup', (e) => {
  if (!holdActive || e.pointerId !== holdPointerId) return; // only OUR pointer
  holdPointerId = null;
  const heldMs = performance.now() - holdStartTs;
  holdActive = false;
  throwBtn.classList.remove('armed');
  swingHint.classList.remove('armed');
  // the captured pose, read BEFORE the aim lock is released — the packet is
  // built from this explicit copy, never from a fallback
  const pose = throwAngles();
  const finish = () => { unlockAim(); updateThrowUI(); };
  if (!client || !client.connected || !canThrow || controlsSuspended) { finish(); return; }

  if (settings.scheme === 'pad') {
    // TOUCH PAD: no sensors — the hold itself charges the power
    if (heldMs < TAP_MS) { finish(); return; } // a tap is not a throw
    const power = clamp(0.15 + 0.85 * Math.min(1, heldMs / PAD_CHARGE_MS), 0.15, 1);
    sendThrow(power, 0, 0, pose);
    finish();
    return;
  }

  // sensor schemes: a quick tap, a hold without SUSTAINED throwing motion, or
  // a release after the sensors went quiet does NOT throw — the phone motion
  // while holding IS the throw
  const sensorsFresh = performance.now() - lastMotionTs <= 500;
  if (heldMs < TAP_MS || heldMs < HOLD_MIN_MS || holdActiveMs < HOLD_MOTION_MS || !sensorsFresh) {
    setStatus('warn', heldMs < TAP_MS ? 'Hold THROW, then swing'
      : 'No motion — hold and swing');
    setTimeout(() => { if (canThrow) setStatus('ok', 'Connected'); }, 1300);
    finish();
    return;
  }
  // power = peak acceleration, spin = wrist twist at release,
  // loft = integrated upward phone velocity (swing up = the ball hops)
  sendThrow(
    holdPower(),
    spinFromTwist(freshTwist(liveTwist)),
    clamp(holdUpVel / UP_FULL, 0, 1),
    pose,
  );
  finish();
});

// a cancelled press (browser took over, gesture interrupted) never throws
throwBtn.addEventListener('pointercancel', cancelHold);
throwBtn.addEventListener('lostpointercapture', cancelHold);

function updateThrowUI() {
  // pad mode: the drag surface must not scroll/zoom the page
  tiltStage.classList.toggle('pad-mode', settings.scheme === 'pad');
  // the THROW button is always visible now — holding it is the throw
  throwBtn.classList.remove('hidden');
  throwBtn.disabled = !canThrow;
  if (settings.scheme === 'pad') {
    swingHint.textContent = canThrow
      ? 'Drag the pad to aim — HOLD THROW to charge, release to bowl'
      : (waitText || 'Waiting for your turn…');
    return;
  }
  const aimWord = settings.scheme === 'twist' ? 'Tilt' : 'Turn';
  swingHint.textContent = canThrow
    ? `${aimWord} to aim — HOLD THROW & swing, release to bowl`
    : (waitText || 'Waiting for your turn…');
}

// Orientation stream to the game (30Hz, unreliable channel, host drops stale).
let lastSent = 0;
let seq = 0; // monotonic sample counter for stale-sample dropping
function tick() {
  const now = performance.now();
  // the committed pose: LIVE while aiming, LOCKED once the dwell latches —
  // the on-phone indicator, the transmitted state, and the throw all use it
  const m = currentControlAngles();
  tilt.style.transform = `translate(${(m.steer / MAX_STEER) * 130}%, ${(m.aim / MAX_AIM) * 130}%)`;
  tiltBg.style.opacity = String(Math.min(1, Math.abs(m.steer / MAX_STEER) + Math.abs(m.aim / MAX_AIM) / 2));
  if (client && client.connected && now - lastSent >= 33) {
    lastSent = now;
    // live wrist twist rides along so the game's aim guide can preview the hook
    client.sendState(++seq, clamp(m.steer, -MAX_STEER, MAX_STEER), clamp(m.aim, -MAX_AIM, MAX_AIM), spinFromTwist(freshTwist(liveTwist)));
  }
  // live throw readout on the button while holding: the player sees the
  // power (and the loft, when they swing upward) build in real time
  if (holdActive) {
    if (settings.scheme === 'pad') {
      const p = clamp(0.15 + 0.85 * Math.min(1, (now - holdStartTs) / PAD_CHARGE_MS), 0.15, 1);
      throwBtn.textContent = `THROW ${Math.round(p * 100)}%`;
    } else {
      const loft = clamp(holdUpVel / UP_FULL, 0, 1);
      throwBtn.textContent = `PWR ${Math.round(holdPower() * 100)}%`
        + (loft > 0.08 ? ` LOFT ${Math.round(loft * 100)}%` : '');
    }
  } else if (throwBtn.textContent !== 'THROW') {
    throwBtn.textContent = 'THROW';
  }
  calTick();
  requestAnimationFrame(tick);
}

function startSensors() {
  window.addEventListener('deviceorientation', onOrient);
  window.addEventListener('devicemotion', onMotion);
  show(ctlScreen);
  setStatus('warn', 'Connected');
  requestAnimationFrame(tick);
  updateThrowUI();
  // no sensor data at all (gyro-less device, denied permission)? point at
  // TOUCH PAD mode instead of leaving a dead controller
  setTimeout(() => {
    if (!sawOrient && !sawMotion && settings.scheme !== 'pad') {
      setStatus('warn', 'No motion sensors — SETUP → TOUCH PAD');
    }
  }, 4000);
}

// Latency display comes from the game's perspective; we also show our own
// connection state. Reuse onCtl ping? The game pings us; we pong — the game
// knows the RTT. Simple local display refresh:
setInterval(() => {
  if (client && client.connected) {
    latency.textContent = 'live';
  }
}, 2000);

// Lock portrait where possible (best effort).
if (screen.orientation && screen.orientation.lock) {
  screen.orientation.lock('portrait').catch(() => {});
}
