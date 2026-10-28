// Phone controller entry — runs on phone.html (small page: no Three/Rapier).
// The phone IS the controller: gyroscope tilt steers (Wii-remote style) and a
// forward swing releases the ball (or tap THROW in button mode).

import {
  getFirestore, doc, collection, where, query, limit, getDocs,
  deleteDoc, serverTimestamp, updateDoc,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { PhoneClient } from './rtc.js';
import {
  quatFromEuler, quatConj, quatMul, relativeRotation, extractAngles,
  applyControlScheme,
} from './orientation.js';

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
const modeBtn = $('mode-btn'), throwBtn = $('throw-btn'), calBtn = $('cal-btn');
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
  // sensor-driven swings/throws pause while a modal screen is up
  controlsSuspended = (screen === settingsScreen || screen === motionScreen);
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
        if (!canThrow) resetSwing(); // a swing must not carry across a turn
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

function onOrient(e) {
  if (settings.scheme === 'pad') return; // touch pad: sensors don't drive the aim
  if (e.alpha == null) return;
  sawOrient = true;
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

// ------------------------------ swing detection --------------------------
// devicemotion-based state machine: idle -> swinging -> released.
// CONTROLLER FEEL — explicit aim states:
//   LIVE    phone held still in stance -> aim follows the phone on screen
//   LOCKED  after a short dwell the pose is CAPTURED; the on-phone
//           indicator, the transmitted aim, and the thrown aim are the same
//           value. Lowering the phone to your side, carrying it, or
//           mid-swing cannot change it. Re-opening aiming is ALWAYS an
//   -> LIVE explicit action (the RE-AIM button, RECENTER, the mode toggle,
//           or a fresh turn) — never motion itself, so a pick-up can never
//           re-aim the ball.
// Phone rotation comes from WRIST TWIST at the release flick (the final
// active motion sample) — rotating the phone while carrying or picking it
// up can never become hook; only the deliberate twist at release does.
const SWING_ON = 4.5;    // m/s^2 linear acceleration deviation to start a swing
const SWING_OFF = 2.5;   // ...to end it
const MIN_ACTIVE_MS = 120;   // sustained acceleration required for a real swing
const SWING_MIN_PEAK = 6.0;  // weaker motions are pick-up jolts, not throws
// FLICK scheme: a much gentler release — some devices' accelerometers
// under-report, and not everyone wants to whip the phone
const FLICK_ON = 2.6, FLICK_OFF = 1.4, FLICK_MIN_PEAK = 3.6;
const swingCfg = () => settings.scheme === 'flick'
  ? { on: FLICK_ON, off: FLICK_OFF, minPeak: FLICK_MIN_PEAK }
  : { on: SWING_ON, off: SWING_OFF, minPeak: SWING_MIN_PEAK };
const COOLDOWN_MS = 700;
const MAX_PEAK = 20;     // m/s^2 deviation mapped to power 1.0
const AIM_STILL_DEV = 2.5; // base stillness threshold (m/s^2 of deviation)
const AIM_LATCH_MS = 400;   // dwell before the aim locks for the throw
const RELATCH_MOVE = 0.06;  // rad of pose change that counts as a deliberate re-aim
const AIM_RELATCH_MS = 500; // hold the new pose this long to re-open live aiming
const TWIST_DEADZONE = 40;  // deg/s — smaller wrist motion is noise, not spin
const TWIST_FULL = 300;     // deg/s of release twist for full hook

let lastDev = 0; // latest acceleration deviation (freshness for the stillness gate)
let calmDev = 0;  // EMA of the accelerometer's calm noise floor (adaptive gate)
const stillEnough = () => lastDev < Math.max(AIM_STILL_DEV, calmDev * 1.8);
let aimLocked = false;      // LOCKED state — aim captured, frozen
let lockedAngles = null;    // the captured pose
let lastLiveAngles = { steer: 0, aim: 0 }; // last live pose shown on screen
let aimLiveSince = 0; // when the current live-aiming dwell began (0 = not aiming)
let relatchSince = 0; // when a deliberate pose change away from the lock began
let liveTwist = 0;    // smoothed wrist-twist rate (deg/s) — aim-guide preview
let releaseTwist = 0;  // twist rate at the release flick (the throw's spin)

function unlockAim() {
  aimLocked = false;
  lockedAngles = null;
  aimLiveSince = 0;
}

/**
 * The angles to steer/aim with — the SAME value a throw uses (throwAngles),
 * so the screen can never diverge from the ball's line. LIVE while held
 * still in stance; after a short dwell the pose is CAPTURED (LOCKED).
 * Carrying the phone or picking it up freezes it (out of range / not still).
 * The lock is no longer sticky: deliberately hold a NEW still in-stance pose
 * for ~0.5s and live aiming re-opens by itself; the RE-AIM button, RECENTER
 * and the mode toggle always work too. TOUCH PAD mode skips the latch — the
 * thumb is the intent. The stance gate uses the RAW extracted angles (the
 * mapped steer is zeroed in swing/flick schemes, so it can't gate anything)
 * and an ADAPTIVE stillness threshold (a noisy accelerometer no longer locks
 * the controls permanently).
 */
function currentControlAngles() {
  // TOUCH PAD: always live, never latches
  if (settings.scheme === 'pad') {
    const m = normalizedPose(mappedAngles());
    lastLiveAngles = m;
    if (tiltLabel.textContent !== 'DRAG TO AIM') tiltLabel.textContent = 'DRAG TO AIM';
    return m;
  }
  const label = aimLocked ? 'AIM LOCKED' : 'TILT TO AIM';
  if (tiltLabel.textContent !== label) tiltLabel.textContent = label;
  if (swinging) { aimLiveSince = 0; relatchSince = 0; return throwAngles(); } // mid-swing: frozen
  const raw = angles; // RAW extracted pose — the stance gate (pre-scheme)
  const inRange = Math.abs(raw.steer) <= MAX_STEER * 1.25 && Math.abs(raw.aim) <= MAX_AIM * 1.25;
  const still = stillEnough();
  if (!inRange || !still) { aimLiveSince = 0; relatchSince = 0; return throwAngles(); } // carried / at side
  // accepted pose: normalized ONCE — the indicator, the transmitted state and
  // the throw all use this exact value
  const m = normalizedPose(mappedAngles());
  if (aimLocked && lockedAngles) {
    // AUTO RE-AIM: deliberately hold a DIFFERENT still in-stance pose and
    // live aiming re-opens by itself — the lock can't stick anymore
    const moved = Math.abs(m.steer - lockedAngles.steer) + Math.abs(m.aim - lockedAngles.aim);
    if (moved > RELATCH_MOVE) {
      if (!relatchSince) relatchSince = performance.now();
      else if (performance.now() - relatchSince >= AIM_RELATCH_MS) unlockAim();
    } else relatchSince = 0;
    if (aimLocked && lockedAngles) return lockedAngles; // still LOCKED: frozen
  }
  // still, in stance, not locked: LIVE aiming
  if (!aimLiveSince) aimLiveSince = performance.now();
  if (performance.now() - aimLiveSince >= AIM_LATCH_MS) {
    lockedAngles = m; aimLocked = true; aimLiveSince = 0; relatchSince = 0;
    lastLiveAngles = m; // commit + transmit + throw the same pose
    return lockedAngles;
  }
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

let swinging = false, swingStart = 0, swingPeak = 0;
let swingActiveMs = 0; // how long the swing has actually been accelerating

let lastMotionTs = 0;
let lastTwistAt = 0;    // when a rotation sample last arrived (freshness gate)
const TWIST_FRESH_MS = 400; // older than this = stale, spin reads 0

/**
 * Invalidate the twist series: missing sensor data must read as zero spin.
 * Called the moment a sample is unusable, on turn handover, RE-AIM, mode
 * change, RECENTER, and disconnect — never only on the timeout below.
 */
function resetTwist() {
  liveTwist = 0;
  releaseTwist = 0;
  lastTwistAt = 0; // the watchdog fails until a NEW sample arrives
}

/** Stale twist reads as zero — a sensor dropout can never replay an old flick. */
function freshTwist(v) {
  return (performance.now() - lastTwistAt <= TWIST_FRESH_MS) ? v : 0;
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
  const mag = Math.hypot(acc.x, acc.y, acc.z);
  const dev = Math.abs(mag - 9.81);
  lastDev = dev; // freshness for the aim stillness gate (always, even off-turn)
  // track the sensor's calm noise floor (adaptive stillness threshold)
  if (dev < 4) calmDev = calmDev ? calmDev * 0.9 + dev * 0.1 : dev;

  // a modal screen (SETUP / motion permission) is up: pause sensor control
  // so a swing can't throw while you're in the menus
  if (controlsSuspended) {
    if (swinging) resetSwing();
    resetTwist();
    return;
  }

  // swing detection only runs while we're allowed to throw — a swing must
  // never accumulate while waiting and release the moment a turn starts
  if (!canThrow) {
    if (swinging) resetSwing();
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

  if (swinging) {
    swingPeak = Math.max(swingPeak, dev);
    const cfg = swingCfg();
    const active = dev > cfg.off; // still accelerating — the swing itself
    if (active) {
      swingActiveMs += dt * 1000; // ms of sustained acceleration
      // snapshot the SHARED smoothed series; the final active sample (the
      // release flick) is the one that survives — carry rotation is overwritten
      releaseTwist = liveTwist;
    } else {
      // motion stopped. A real swing SUSTAINS acceleration for a while; a
      // pick-up jolt is a brief spike — those are discarded, not thrown.
      if (swingActiveMs >= MIN_ACTIVE_MS && swingPeak >= cfg.minPeak) {
        const power = clamp((swingPeak - cfg.on) / (MAX_PEAK - cfg.on), 0.15, 1);
        latestPower = power; // remembered for button mode
        if (!usesButtonThrow()) sendThrow(power, spinFromTwist(freshTwist(releaseTwist)));
      }
      swinging = false;
      swingPeak = 0; swingActiveMs = 0; releaseTwist = 0;
      swingHint.classList.remove('armed');
    }
  } else if (dev > swingCfg().on && now - lastThrowAt > COOLDOWN_MS) {
    // swing starting: if we were still live-aiming, lock the posed aim now
    if (aimLiveSince) { lockedAngles = lastLiveAngles; aimLocked = true; }
    swinging = true;
    swingStart = now; swingPeak = dev; swingActiveMs = 0; releaseTwist = 0;
    swingHint.classList.add('armed');
  }
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

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

/** Abort any in-progress swing (permission lost / turn handed over). */
function resetSwing() {
  swinging = false;
  swingPeak = 0;
  swingActiveMs = 0;
  resetTwist(); // turn handed over — no stale preview or button-throw spin
  swingHint.classList.remove('armed');
}

let lastThrowAt = 0;
function sendThrow(power, spin) {
  // gate on the mirrored turn permission too — the host stays authoritative,
  // but this keeps the phone from showing "Thrown" for a rejected swing
  if (!client || !client.connected || !canThrow) return;
  lastThrowAt = performance.now();
  // exactly what the screen shows: the locked pose once the dwell latched,
  // otherwise the live pose — never a mid-swing orientation. Picking the
  // phone up from your side never wrecks the aim. spin = wrist twist at
  // the release flick (see spinFromTwist).
  const m = throwAngles();
  client.sendCtl({
    t: 'throw', id: Math.random().toString(36).slice(2), power, spin,
    steer: m.steer, aim: m.aim,
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
  wheel: 'Tilt the phone like a steering wheel to move the ball. Turn it left/right to aim.',
  twist: 'Turn the phone left/right to move the ball. Tilt it to aim.',
  swing: 'Ball stays centered — just turn to aim and swing to throw. Easiest.',
  flick: 'Ball stays centered — turn to aim; a gentle flick throws (needs less force).',
  pad: 'No gyroscope needed — drag your thumb on the pad to aim, then tap THROW.',
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
    // scheme change: the old pose/swing/twist state is void
    unlockAim(); resetSwing(); resetTwist();
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
let buttonMode = false;  // false = swing throw (default), true = button throw
const usesButtonThrow = () => settings.scheme === 'pad' || buttonMode; // pad = always button
let canThrow = false;    // mirrored from the game via phase messages
let waitText = null;      // why we're waiting (from the game), or null
let latestPower = 0.62;  // remembered from the last real swing (button mode)

modeBtn.addEventListener('click', () => {
  buttonMode = !buttonMode;
  modeBtn.textContent = buttonMode ? 'MODE: BUTTON' : 'MODE: SWING';
  unlockAim();
  resetTwist(); // mode change — the old twist series is void
  updateThrowUI();
});

calBtn.addEventListener('click', () => {
  calibrate();
  unlockAim(); // the neutral changed — re-aim from scratch
  resetTwist();
});

reaimBtn.addEventListener('click', () => {
  unlockAim(); // explicit re-aim: back to live aiming
  resetTwist();
  if (navigator.vibrate) navigator.vibrate(10);
});

throwBtn.addEventListener('click', () => {
  const power = swinging ? clamp((swingPeak - SWING_ON) / (MAX_PEAK - SWING_ON), 0.15, 1)
                         : (latestPower > 0 ? latestPower : 0.62);
  // button throw: the CURRENT wrist twist is the spin (twist while tapping)
  sendThrow(power, spinFromTwist(freshTwist(liveTwist)));
});

function updateThrowUI() {
  // pad mode: the drag surface must not scroll/zoom the page
  tiltStage.classList.toggle('pad-mode', settings.scheme === 'pad');
  // THROW button visible whenever the throw is a button (pad = always)
  throwBtn.classList.toggle('hidden', !usesButtonThrow());
  if (settings.scheme === 'pad') {
    swingHint.textContent = canThrow
      ? 'Drag the pad to aim — tap THROW'
      : (waitText || 'Waiting for your turn…');
    throwBtn.disabled = !canThrow;
    return;
  }
  const aimWord = settings.scheme === 'twist' ? 'tilt' : 'turn';
  swingHint.textContent = canThrow
    ? (buttonMode ? `${aimWord[0].toUpperCase() + aimWord.slice(1)} to aim — tap THROW`
                 : `${aimWord[0].toUpperCase() + aimWord.slice(1)} to aim — SWING to throw`)
    : (waitText || 'Waiting for your turn…');
  throwBtn.disabled = !canThrow;
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
