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
  applyControlScheme, DEG,
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
const tilt = $('tilt-indicator'), tiltBg = $('tilt-fill');
const modeBtn = $('mode-btn'), throwBtn = $('throw-btn'), calBtn = $('cal-btn');
const swingHint = $('swing-hint');

let client = null;

function show(screen) {
  for (const s of [pairScreen, motionScreen, ctlScreen]) s.classList.remove('active');
  screen.classList.add('active');
}

function setStatus(kind, text) {
  statusDot.className = 'dot ' + kind;
  statusText.textContent = text;
}

// ------------------------------ pairing ----------------------------------
pairBtn.addEventListener('click', async () => {
  pairErr.textContent = '';
  const code = codeInput.value.trim();
  if (code.length < 4) { pairErr.textContent = 'Enter the 4-letter code from the game.'; return; }
  pairBtn.disabled = true;
  try {
    await connect(code);
  } catch (e) {
    pairErr.textContent = e.message || 'Could not connect.';
    pairBtn.disabled = false;
  }
});
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') pairBtn.click(); });

async function connect(codeOrToken) {
  client = new PhoneClient({
    onOpen() { show(motionScreen); requestMotion(); },
    onStatus(kind, detail) {
      if (kind === 'connected') setStatus('ok', 'Connected');
      else if (kind === 'disconnected') {
        setStatus('warn', 'Connection lost — swipe down to reload');
        canThrow = false; // permission is meaningless while disconnected
        updateThrowUI();
      }
      else if (kind === 'error') setStatus('err', 'Error: ' + (detail || ''));
      else if (kind === 'connecting') setStatus('warn', 'Connecting…');
    },
    onCtl(m) {
      if (m.t === 'phase') {
        canThrow = !!m.canThrow;
        waitText = m.waitText || null;
        if (!canThrow) resetSwing(); // a swing must not carry across a turn
        // slot = which phone we are (1-based); phones = how many are connected
        if (m.slot) {
          slotBadge.textContent = m.phones > 1 ? `P${m.slot}/${m.phones}` : `P${m.slot}`;
          slotBadge.classList.remove('hidden');
        }
        updateThrowUI();
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
  connect(params.get('pair')).catch((e) => {
    pairErr.textContent = e.message || 'Could not pair from the QR code.';
    pairBtn.disabled = false;
  });
}

// ------------------------------ motion permission -------------------------
async function requestMotion() {
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
    show(motionScreen);
  }
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

function onOrient(e) {
  if (e.alpha == null) return;
  qNow = quatFromEuler(e.alpha, e.beta, e.gamma);
  if (!qCal) qCal = qNow; // auto-calibrate on first sample
  if (calSamples.length) calSamples.push(qNow); // RECENTER in progress

  const rel = relativeRotation(qCal, qNow);
  angles = extractAngles(rel);

  // visual (through the active scheme preset)
  const m = mappedAngles();
  tilt.style.transform = `translate(${(m.steer / MAX_STEER) * 130}%, ${(m.aim / MAX_AIM) * 130}%)`;
  tiltBg.style.opacity = String(Math.min(1, Math.abs(m.steer / MAX_STEER) + Math.abs(m.aim / MAX_AIM) / 2));
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
  client && client.sendCtl({ t: 'cal' });
  setStatus('ok', 'Calibrated');
}

const MAX_STEER = 0.35; // radians of wheel tilt for full lane travel
const MAX_AIM = 0.45;   // radians of turn for full aim

// ------------------------------ swing detection --------------------------
// devicemotion-based state machine: idle -> swinging -> released.
const SWING_ON = 4.5;    // m/s^2 linear acceleration deviation to start a swing
const SWING_OFF = 2.5;   // ...to end it
const MIN_SWING_MS = 90;
const COOLDOWN_MS = 700;
const MAX_PEAK = 20;     // m/s^2 deviation mapped to power 1.0

let swinging = false, swingStart = 0, swingPeak = 0, spinAccum = 0;

let lastMotionTs = 0;
function onMotion(e) {
  // swing detection only runs while we're allowed to throw — a swing must
  // never accumulate while waiting and release the moment a turn starts
  if (!canThrow) {
    if (swinging) resetSwing();
    return;
  }
  const acc = e.accelerationIncludingGravity;
  const rot = e.rotationRate;
  if (!acc || acc.x == null) return;
  const mag = Math.hypot(acc.x, acc.y, acc.z);
  const dev = Math.abs(mag - 9.81);
  const now = performance.now();
  const dt = lastMotionTs ? Math.min(0.1, (now - lastMotionTs) / 1000) : 0;
  lastMotionTs = now;

  if (swinging) {
    swingPeak = Math.max(swingPeak, dev);
    if (rot && rot.alpha != null) spinAccum += (rot.alpha * DEG) * dt; // real dt
    if (dev < SWING_OFF && now - swingStart > MIN_SWING_MS) {
      // release
      const power = clamp((swingPeak - SWING_ON) / (MAX_PEAK - SWING_ON), 0.15, 1);
      const spin = clamp(spinAccum / 1.4, -1, 1);
      latestPower = power; latestSpin = spin; // remembered for button mode
      if (!buttonMode) sendThrow(power, spin);
      swinging = false;
      swingPeak = 0; spinAccum = 0;
      setTimeout(() => { swingHint.classList.remove('armed'); }, COOLDOWN_MS);
    }
  } else if (dev > SWING_ON && now - lastThrowAt > COOLDOWN_MS) {
    swinging = true;
    swingStart = now; swingPeak = dev; spinAccum = 0;
    swingHint.classList.add('armed');
  }
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Abort any in-progress swing (permission lost / turn handed over). */
function resetSwing() {
  swinging = false;
  swingPeak = 0;
  spinAccum = 0;
  swingHint.classList.remove('armed');
}

let lastThrowAt = 0;
function sendThrow(power, spin) {
  // gate on the mirrored turn permission too — the host stays authoritative,
  // but this keeps the phone from showing "Thrown" for a rejected swing
  if (!client || !client.connected || !canThrow) return;
  lastThrowAt = performance.now();
  // snapshot the release orientation together with power/spin so the host
  // maps the throw atomically instead of racing the 30Hz tilt stream
  const m = mappedAngles();
  client.sendCtl({
    t: 'throw', id: Math.random().toString(36).slice(2), power, spin,
    steer: m.steer, aim: m.aim,
  });
  setStatus('ok', 'Thrown');
  setTimeout(() => setStatus('ok', 'Connected'), 900);
}

// ------------------------------ settings ---------------------------------
// Control-scheme presets + sensitivity. Persisted when the browser allows it
// (private-mode Safari etc. silently falls back to defaults for the session).
const SCHEME_DESC = {
  wheel: 'Tilt the phone like a steering wheel to move the ball. Turn it left/right to aim.',
  twist: 'Turn the phone left/right to move the ball. Tilt it to aim.',
  swing: 'Ball stays centered — just turn to aim and swing to throw. Easiest.',
};
const settings = { scheme: 'wheel', sens: 1 };
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

const settingsScreen = $('settings-screen');
$('setup-btn').addEventListener('click', () => { show(settingsScreen); refreshSettingsUI(); });
$('settings-back').addEventListener('click', () => show(ctlScreen));
$('scheme-row').querySelectorAll('.seg-btn').forEach((b) => {
  b.addEventListener('click', () => {
    settings.scheme = b.dataset.scheme;
    saveSettings(); refreshSettingsUI(); updateThrowUI();
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

// ------------------------------ controls ---------------------------------
let buttonMode = false;  // false = swing throw (default), true = button throw
let canThrow = false;    // mirrored from the game via phase messages
let waitText = null;      // why we're waiting (from the game), or null
let latestPower = 0.62, latestSpin = 0;

modeBtn.addEventListener('click', () => {
  buttonMode = !buttonMode;
  modeBtn.textContent = buttonMode ? 'MODE: BUTTON' : 'MODE: SWING';
  throwBtn.classList.toggle('hidden', !buttonMode);
  updateThrowUI();
});

calBtn.addEventListener('click', calibrate);

throwBtn.addEventListener('click', () => {
  const power = swinging ? clamp((swingPeak - SWING_ON) / (MAX_PEAK - SWING_ON), 0.15, 1)
                         : (latestPower > 0 ? latestPower : 0.62);
  sendThrow(power, latestSpin);
});

function updateThrowUI() {
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
  if (client && client.connected && now - lastSent >= 33) {
    lastSent = now;
    const m = mappedAngles();
    client.sendState(++seq, clamp(m.steer, -MAX_STEER, MAX_STEER), clamp(m.aim, -MAX_AIM, MAX_AIM));
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
