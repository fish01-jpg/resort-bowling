// Phone controller entry — runs on phone.html (small page: no Three/Rapier).
// The phone IS the controller: gyroscope tilt steers (Wii-remote style) and a
// forward swing releases the ball (or tap THROW in button mode).

import {
  getFirestore, doc, collection, where, query, limit, getDocs,
  deleteDoc, serverTimestamp, updateDoc,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { PhoneClient } from './rtc.js';

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
      else if (kind === 'disconnected') setStatus('warn', 'Connection lost — swipe down to reload');
      else if (kind === 'error') setStatus('err', 'Error: ' + (detail || ''));
      else if (kind === 'connecting') setStatus('warn', 'Connecting…');
    },
    onCtl(m) {
      if (m.t === 'phase') {
        canThrow = !!m.canThrow;
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
if (params.has('pair')) connect(params.get('pair'));

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
// Calibrated, screen-rotation-robust orientation via quaternions.
// rel = qCalib^-1 * qNow; roll (device z) steers position, yaw (y) steers aim.
const DEG = Math.PI / 180;
let qCal = null;               // calibration quaternion (or null until set)
let roll = 0, yaw = 0;         // current relative angles, radians
let seq = 0;

function quatFromEuler(alpha, beta, gamma) {
  // W3C deviceorientation: intrinsic ZXY rotation -> quaternion.
  // q = qz(alpha) * qx(beta) * qy(gamma), angles in degrees.
  const a = alpha * DEG / 2, b = beta * DEG / 2, g = gamma * DEG / 2;
  const c1 = Math.cos(a), s1 = Math.sin(a);
  const c2 = Math.cos(b), s2 = Math.sin(b);
  const c3 = Math.cos(g), s3 = Math.sin(g);
  return {
    w: c1 * c2 * c3 - s1 * s2 * s3,
    x: c1 * s2 * c3 - s1 * c2 * s3,
    y: c1 * c2 * s3 + s1 * s2 * c3,
    z: c1 * s2 * s3 + s1 * c2 * c3,
  };
}
function quatConj(q) { return { w: q.w, x: -q.x, y: -q.y, z: -q.z }; }
function quatMul(a, b) {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}
function apply(q, v) { // rotate vector v by quaternion q
  const { w, x, y, z } = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

function onOrient(e) {
  if (e.alpha == null) return;
  const q = quatFromEuler(e.alpha, e.beta, e.gamma);
  if (!qCal) qCal = q; // auto-calibrate on first sample
  const rel = quatMul(quatConj(qCal), q);
  // device z-axis (screen normal) in calibrated frame -> roll/steer
  const z = apply(rel, [0, 0, 1]);
  const y = apply(rel, [0, 1, 0]);
  roll = Math.atan2(z[0], z[2]);   // left/right tilt of screen normal
  yaw = Math.atan2(y[0], y[2]);    // left/right twist of device y-axis
  // visual
  tilt.style.transform = `translate(${(roll / MAX_ROLL) * 130}%, ${(yaw / MAX_YAW) * 130}%)`;
  tiltBg.style.opacity = String(Math.min(1, Math.abs(roll / MAX_ROLL) + Math.abs(yaw / MAX_YAW) / 2));
}

function calibrate() {
  qCal = null; // next sample re-zeroes
  client && client.sendCtl({ t: 'cal' });
  setStatus('warn', 'Calibrating — hold phone neutral');
}

const MAX_ROLL = 0.35; // radians of tilt for full lane travel
const MAX_YAW = 0.45;

// ------------------------------ swing detection --------------------------
// devicemotion-based state machine: idle -> swinging -> released.
const SWING_ON = 4.5;    // m/s^2 linear acceleration deviation to start a swing
const SWING_OFF = 2.5;   // ...to end it
const MIN_SWING_MS = 90;
const COOLDOWN_MS = 700;
const MAX_PEAK = 20;     // m/s^2 deviation mapped to power 1.0

let swinging = false, swingStart = 0, swingPeak = 0, spinAccum = 0;

function onMotion(e) {
  const acc = e.accelerationIncludingGravity;
  const rot = e.rotationRate;
  if (!acc || acc.x == null) return;
  const mag = Math.hypot(acc.x, acc.y, acc.z);
  const dev = Math.abs(mag - 9.81);
  const now = performance.now();

  if (swinging) {
    swingPeak = Math.max(swingPeak, dev);
    if (rot && rot.alpha != null) spinAccum += (rot.alpha * DEG) * (1 / 30); // ~30Hz
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

let lastThrowAt = 0;
function sendThrow(power, spin) {
  if (!client || !client.connected) return;
  lastThrowAt = performance.now();
  client.sendCtl({ t: 'throw', id: Math.random().toString(36).slice(2), power, spin });
  setStatus('ok', 'Thrown');
  setTimeout(() => setStatus('ok', 'Connected'), 900);
}

// ------------------------------ controls ---------------------------------
let buttonMode = false;  // false = swing throw (default), true = button throw
let canThrow = false;    // mirrored from the game via phase messages
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
  swingHint.textContent = canThrow
    ? (buttonMode ? 'Aim with tilt — tap THROW' : 'Aim with tilt — SWING to throw')
    : 'Waiting for your turn…';
  throwBtn.disabled = !canThrow;
}

// Orientation stream to the game (30Hz, unreliable channel, host drops stale).
let lastSent = 0;
function tick() {
  const now = performance.now();
  if (client && client.connected && now - lastSent >= 33) {
    lastSent = now;
    client.sendState(++seq, clamp(roll, -MAX_ROLL, MAX_ROLL), clamp(yaw, -MAX_YAW, MAX_YAW));
  }
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
