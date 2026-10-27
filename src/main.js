import * as THREE from 'https://esm.sh/three@0.169.0';
import RAPIER from 'https://esm.sh/@dimforge/rapier3d-compat@0.12.0';
import { createScene } from './scene.js';
import { Physics } from './physics.js';
import { Input } from './input.js';
import { UI } from './ui.js';
import { AudioFX } from './audio.js';
import { BowlingGame } from './game.js';
import { LANE, TUNING } from './constants.js';

const FIXED_DT = 1 / 60;
let accumulator = 0;
let lastTime = performance.now();
let lastAdvanceAt = -1e9;
let started = false;

// debug overlay
let _frames = 0, _last = performance.now(), _fps = 0, _ft = 0, _prev = 0;
function updateDebug() {
  _frames++;
  const n = performance.now();
  _ft = n - (_prev || n);
  _prev = n;
  if (n - _last >= 1000) {
    _fps = (_frames * 1000) / (n - _last);
    _frames = 0;
    _last = n;
  }
}

async function boot() {
  await RAPIER.init();
  const scene = createScene(document.body);
  const physics = new Physics();
  const input = new Input();
  const ui = new UI();
  const audio = new AudioFX();
  const game = new BowlingGame({ physics, scene, input, ui, audio });

  // camera state
  const camPos = new THREE.Vector3(0, 1.5, -3.2);
  const camLook = new THREE.Vector3(0, 0.4, 8);
  const tmpPos = new THREE.Vector3();
  const tmpLook = new THREE.Vector3();

  function updateCamera(dt) {
    const bs = physics.ballState();
    const c = input.controls;
    if (game.phase === 'ready') {
      tmpPos.set(c.position * 0.5, 0.95, -4.6);
      tmpLook.set(c.position * 0.3 + Math.sin(c.aim) * 6, 0.3, 9);
    } else if (game.phase === 'rolling') {
      if (bs.z < 14.5) {
        // tight chase cam behind the ball
        tmpPos.set(THREE.MathUtils.clamp(bs.x * 0.6, -0.8, 0.8), 1.05, bs.z - 3.0);
        tmpLook.set(bs.x * 0.8, 0.22, bs.z + 2.2);
      } else {
        // pin-deck cam for the impact
        tmpPos.set(0, 1.5, 14.3);
        tmpLook.set(0, 0.35, LANE.pinZ + 0.6);
      }
    } else {
      tmpPos.set(0.55, 1.5, 14.3);
      tmpLook.set(0, 0.35, LANE.pinZ + 0.6);
    }
    const k = 1 - Math.exp(-dt * 5.0);
    camPos.lerp(tmpPos, k);
    camLook.lerp(tmpLook, k);
    scene.camera.position.copy(camPos);
    scene.camera.lookAt(camLook);
  }

  // Aim guide: fading dots along the projected path — position, aim direction,
  // and the approximate hook curve from spin (same model as the physics).
  function updateAimGuide() {
    const g = scene.aimGuide;
    const show = game.phase === 'ready';
    g.group.visible = show;
    if (!show) return;
    const c = input.controls;
    const power = input.charging ? Math.max(0.12, c.power) : 0.7;
    const speed = TUNING.minSpeed + power * (TUNING.maxSpeed - TUNING.minSpeed);
    let x = c.position;
    let z = -1.8;
    let dxz = Math.tan(c.aim); // dx/dz
    const step = 0.3;
    const dots = g.dots;
    let di = 0;
    for (let i = 0; i < 1100 && di < dots.length; i++) {
      const ramp = 0.3 + 0.7 * Math.min(1, Math.max(0, z) / LANE.pinZ) ** 2;
      const a = c.spin * TUNING.hookAccel * ramp;
      dxz += (a / (speed * speed)) * step;
      x += dxz * step;
      z += step;
      const target = -1.8 + (di + 1) * 1.05;
      if (z >= target && z < 17.6) {
        dots[di].position.set(x, 0.006, z);
        di++;
      }
    }
    for (let i = di; i < dots.length; i++) {
      dots[i].position.set(x, 0.006, Math.min(z, 17.5));
    }
  }

  function fixedUpdate() {
    game.fixedUpdate(FIXED_DT);
  }

  function render() {
    game.syncMeshes();
    scene.renderer.render(scene.scene, scene.camera);
  }

  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now();
    let delta = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;
    updateDebug();

    const manual = now - lastAdvanceAt < 2500; // playwright advanceTime active
    if (!manual) {
      accumulator += delta;
      while (accumulator >= FIXED_DT) {
        fixedUpdate();
        accumulator -= FIXED_DT;
      }
    }
    updateCamera(delta);
    updateAimGuide();
    render();
    ui.updateMeters(input.controls, input.charging, game.phase);
    ui.setDebug(`FPS:${_fps.toFixed(0)} ${_ft.toFixed(1)}ms\n${game.phase} f${game.frameIndex + 1} r${game.rollIndex + 1}`);
  }

  // ---- title screen / start ----
  const overlayBtn = document.getElementById('overlay-btn');
  overlayBtn.addEventListener('click', () => {
    audio.init();
    audio.ctx.resume().then(() => audio.startMusic());
    audio.click();
    ui.hideOverlay();
    started = true;
    game.start();
  });

  // ---- keyboard shortcuts ----
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR' && !e.repeat) {
      audio.init();
      ui.hideOverlay();
      game.start();
    }
    if (e.code === 'KeyM' && !e.repeat) {
      audio.init();
      audio.setMuted(!audio.muted);
      ui.el.muteBtn.classList.toggle('muted', audio.muted);
    }
  });

  // ---- buttons ----
  ui.el.muteBtn.addEventListener('click', () => {
    audio.init();
    audio.setMuted(!audio.muted);
    ui.el.muteBtn.classList.toggle('muted', audio.muted);
    if (!audio.muted) audio.startMusic();
  });
  ui.el.restartBtn.addEventListener('click', () => {
    audio.init();
    audio.click();
    ui.hideOverlay();
    game.start();
  });
  document.getElementById('play-again').addEventListener('click', () => {
    audio.click();
    ui.hideOverlay();
    game.start();
  });

  // initial UI state (title screen visible)
  ui.showOverlay('SUNSET LANES', 'Resort Bowling — 10 frames, real rules, real physics', 'PLAY');
  ui.updateScorecard(game.game, 0);

  // ---- testing / automation hooks ----
  window.advanceTime = (ms) => {
    lastAdvanceAt = performance.now();
    const steps = Math.max(1, Math.round(ms / (1000 / 60)));
    for (let i = 0; i < steps; i++) fixedUpdate();
    updateCamera(1 / 30);
    render();
    ui.updateMeters(input.controls, input.charging, game.phase);
  };

  window.render_game_to_text = () => {
    const bs = physics.ballState();
    const standing = [];
    for (let i = 0; i < 10; i++) if (physics.pinState(i).standing) standing.push(i + 1);
    return JSON.stringify({
      phase: game.phase,
      frame: Math.min(game.frameIndex + 1, 10),
      ball: Math.min(game.rollIndex + 1, 3),
      standingPins: standing,
      pinsStanding: standing.length,
      rolls: game.game.rolls,
      scores: game.game.scores(),
      total: game.game.totalScore(),
      message: document.getElementById('message').textContent,
      controls: {
        position: +input.controls.position.toFixed(3),
        aim: +input.controls.aim.toFixed(3),
        power: +input.controls.power.toFixed(3),
        spin: +input.controls.spin.toFixed(3),
        charging: input.charging,
      },
      ballState: {
        x: +bs.x.toFixed(2), y: +bs.y.toFixed(2), z: +bs.z.toFixed(2),
        speed: +bs.speed.toFixed(2),
      },
      coordinateSystem: 'origin at foul line center; +z down the lane toward pins; +x right; +y up',
    });
  };

  // Programmatic control for future controllers (touch, motion, gamepad).
  window.BowlingAPI = {
    setControls(partial) { input.setControls(partial); },
    throwNow() {
      if (game.phase !== 'ready') return false;
      game._throw({ ...input.controls });
      return true;
    },
    deliverBall({ position = 0, aim = 0, power = 0.7, spin = 0 } = {}) {
      if (game.phase !== 'ready') return false;
      game._throw({ position, aim, power, spin });
      return true;
    },
    restart() { ui.hideOverlay(); game.start(); },
    state() { return JSON.parse(window.render_game_to_text()); },
  };

  frame();
}

boot();
