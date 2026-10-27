import * as THREE from 'https://esm.sh/three@0.169.0';
import RAPIER from 'https://esm.sh/@dimforge/rapier3d-compat@0.12.0';
import { createScene } from './scene.js';
import { Physics } from './physics.js';
import { Input } from './input.js';
import { UI } from './ui.js';
import { AudioFX } from './audio.js';
import { BowlingGame } from './game.js';
import { Match, playerProgress, buildGames } from './match.js';
import { RoomClient, TURN_TIMEOUT_MS } from './net.js';
import { PhoneHost } from './rtc.js';
import { LANE, TUNING } from './constants.js';

// Phones become controllers, not the game screen: redirect small touch
// devices to the lightweight controller page.
const IS_PHONE = typeof matchMedia !== 'undefined' && typeof screen !== 'undefined'
  && matchMedia('(pointer: coarse)').matches
  && Math.min(screen.width || 9999, screen.height || 9999) <= 500
  && !location.search.includes('desktop=1');
if (IS_PHONE) location.replace('phone.html');

const FIXED_DT = 1 / 60;
let accumulator = 0;
let lastTime = performance.now();
let lastAdvanceAt = -1e9;

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

  // ---- mode state ----
  let match = null;            // local hot-seat Match
  let net = null;              // online RoomClient
  let currentRoom = null;      // last room snapshot
  let localNames = [];
  let lastAppliedRevision = -1;
  let lastReplayedSeq = -1;
  let skipFiredRevision = -1;
  let prevRoomStatus = null;   // lobby -> playing overlay fix
  let revisionAtThrow = -1;    // pending-result lock

  // if our online submission fails, release the pending-result lock so the
  // player isn't frozen until the turn timeout
  game.onNetSubmitFailed = () => {
    // release the pending lock AND force re-adoption of the room's rack —
    // the local simulation has knocked pins the room never recorded
    revisionAtThrow = -1;
    lastAppliedRevision = -1; // onlineTick will re-adopt the authoritative rack
  };

  // phone controller (gyro Wii-style)
  let phoneHost = null;
  let phoneNeedsRearm = false;
  let lastPhonePhaseKey = '';

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
    const show = game.phase === 'ready' && input.enabled;
    g.group.visible = show;
    if (!show) return;
    const c = input.controls;
    let x = c.position;
    let z = -1.8;
    let dxz = Math.tan(c.aim); // dx/dz
    const step = 0.3;
    const dots = g.dots;
    let di = 0;
    for (let i = 0; i < 1100 && di < dots.length; i++) {
      const ramp = 0.3 + 0.7 * Math.min(1, Math.max(0, z) / LANE.pinZ) ** 2;
      const a = c.spin * TUNING.hookAccel * ramp;
      // speed-invariant hook: same curve at every power level
      dxz += (a / (TUNING.hookRefSpeed * TUNING.hookRefSpeed)) * step;
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

  // ---------------- mode management ----------------

  function resetHudForMatchStart() {
    ui.hideOverlay();
    ui.el.finalStandings.classList.add('hidden');
    ui.el.playAgain.textContent = 'PLAY AGAIN';
    ui.setTurnBanner('');
  }

  function startSolo() {
    match = null; game.match = null; game.net = null;
    resetHudForMatchStart();
    ui.updateMatchPanel(null);
    input.setEnabled(true);
    game.start();
  }

  function startLocal(names) {
    localNames = names.slice();
    match = new Match(names);
    resetHudForMatchStart();
    input.setEnabled(true);
    game.startWithMatch(match);
  }

  function backToMenu(note) {
    game.net = null; game.match = null;
    currentRoom = null;
    input.setEnabled(false);
    ui.updateMatchPanel(null);
    ui.setTurnBanner('');
    ui.el.overlay.classList.add('show');
    ui.el.overlayTitle.parentElement.style.display = '';
    ui.el.finalPanel.classList.remove('show');
    ui.showMenu('main');
    if (note) ui.message(note, 'info', 2200);
  }

  // ---------------- online ----------------

  function handleRoom(room) {
    currentRoom = room;
    if (!room) {
      // room deleted (everyone left)
      if (net) net.stop();
      net = null;
      backToMenu('Room closed');
      return;
    }
    const wasLobby = prevRoomStatus === 'lobby';
    prevRoomStatus = room.status;

    if (room.status === 'lobby') {
      ui.showLobby({ ...room, code: net.code }, net.uid);
      input.setEnabled(false);
      ui.setTurnBanner('');
      lastAppliedRevision = -1;
      lastReplayedSeq = -1;
      skipFiredRevision = -1;
      game.phase = 'ready';
      return;
    }
    if (room.status === 'done') {
      input.setEnabled(false);
      ui.setTurnBanner('');
      const games = buildGames(room.players, room.rolls);
      const standings = room.players
        .map((p) => ({ name: p.name, total: games[p.uid].totalScore() ?? 0 }))
        .sort((a, b) => b.total - a.total);
      ui.showMatchOver(standings);
      const isHost = room.players[0].uid === net.uid;
      ui.el.playAgain.textContent = isHost ? 'PLAY AGAIN' : 'WAITING FOR HOST…';
      return;
    }
    // playing — panels update immediately; turn context/replay in onlineTick
    if (wasLobby && room.status === 'playing') {
      // the match just started — make sure no menu/lobby overlay lingers
      ui.hideOverlay();
      ui.el.finalPanel.classList.remove('show');
      ui.el.finalStandings.classList.add('hidden');
    }
    game.net = net;
    game.match = null;
    const games = buildGames(room.players, room.rolls);
    const rows = room.players.map((p) => ({
      name: p.name,
      total: games[p.uid].totalScore() ?? 0,
      done: games[p.uid].isComplete(),
      active: room.turn && room.turn.uid === p.uid,
    }));
    ui.updateMatchPanel(rows);
    const myGame = games[net.uid];
    const prog = playerProgress(myGame);
    ui.updateScorecard(myGame, Math.min(prog.frame, 9));
  }

  async function createOnlineRoom() {
    const name = (ui.el.onlineName.value || 'Bowler').trim().slice(0, 14);
    if (!net) {
      net = new RoomClient({ onRoom: handleRoom, onError: (m) => ui.onlineError(m) });
    }
    ui.el.onlineError.classList.add('hidden');
    try {
      await net.createRoom(name);
      // snapshot listener drives the lobby UI
    } catch (e) {
      ui.onlineError(e.message || 'Could not create the room');
    }
  }

  async function joinOnlineRoom() {
    const name = (ui.el.onlineName.value || 'Bowler').trim().slice(0, 14);
    const code = ui.el.joinCode.value.trim();
    if (!net) {
      net = new RoomClient({ onRoom: handleRoom, onError: (m) => ui.onlineError(m) });
    }
    ui.el.onlineError.classList.add('hidden');
    try {
      await net.joinRoom(code, name);
    } catch (e) {
      ui.onlineError(e.message || 'Could not join the room');
    }
  }

  /** Per-fixed-step online housekeeping: turn context, replays, skips. */
  function onlineTick() {
    if (!net || !currentRoom || currentRoom.status !== 'playing') return;
    const room = currentRoom;

    // auto-skip timed-out turns (any client fires it once per revision)
    if (room.turn && Date.now() - (room.turn.startedAt || 0) > TURN_TIMEOUT_MS
        && skipFiredRevision !== room.revision) {
      skipFiredRevision = room.revision;
      net.skipTurn();
      return;
    }

    const myTurn = !!(room.turn && room.turn.uid === net.uid);
    if (myTurn) {
      if (game.phase === 'rolling' || game.phase === 'settling' || game.phase === 'sweep') {
        // pending-result lock: our throw is in flight — keep input off until
        // the room records it (revision advances past the throw)
        input.setEnabled(false);
        ui.setTurnBanner('Nice roll…', '');
      } else if (game.phase === 'ready') {
        const pending = revisionAtThrow >= 0 && room.revision <= revisionAtThrow;
        if (pending) {
          input.setEnabled(false); // still waiting for the room to accept it
        } else {
          revisionAtThrow = -1;
          input.setEnabled(true);
        }
        if (room.revision !== lastAppliedRevision) {
          const games = buildGames(room.players, room.rolls);
          lastAppliedRevision = room.revision;
          game.adoptOnlineContext({
            game: games[net.uid],
            rack: room.rack,
            frame: room.turn.frame,
            ball: room.turn.ball,
          });
        }
        ui.setTurnBanner(`Your turn — Frame ${room.turn.frame + 1}`, '');
      } else {
        ui.setTurnBanner('');
      }
    } else {
      input.setEnabled(false);
      const holder = room.players.find((p) => p.uid === (room.turn && room.turn.uid));
      const secs = Math.max(0, Math.ceil((TURN_TIMEOUT_MS - (Date.now() - ((room.turn && room.turn.startedAt) || 0))) / 1000));
      ui.setTurnBanner(
        `Waiting for ${holder ? holder.name : '…'} — Frame ${((room.turn && room.turn.frame) || 0) + 1}`,
        `auto-skip in ${secs}s`
      );
      // replay new remote throws (visuals only; the room is the authority)
      if (room.lastThrow && room.lastThrow.seq > lastReplayedSeq && game.phase === 'ready') {
        lastReplayedSeq = room.lastThrow.seq;
        if (room.lastThrow.uid !== net.uid) {
          game.replayThrow(
            room.lastThrow.params,
            room.lastThrow.standingAfter,
            room.lastThrow.knocked,
            room.lastThrow.name
          );
        }
      }
    }
  }

  // ---------------- phone controller ----------------

  const clamp01 = (v, a, b) => Math.max(a, Math.min(b, v));

  /** Phone tilt -> ball position / aim (only while aiming; re-arms at neutral). */
  function onPhoneState(m) {
    if (game.phase !== 'ready' || !input.enabled) return;
    if (phoneNeedsRearm) {
      if (Math.abs(m.steer) < 0.12 && Math.abs(m.aim) < 0.15) phoneNeedsRearm = false;
      else return; // hold the release pose until the phone comes back to neutral
    }
    input.controls.position = clamp01(m.steer / 0.35, -1, 1) * TUNING.maxPosition;
    input.controls.aim = clamp01(m.aim / 0.45, -1, 1) * TUNING.maxAim;
  }

  /** Swing release (or THROW button) from the phone. */
  function onPhoneThrow(m) {
    if (game.phase !== 'ready' || !input.enabled) return;
    if (phoneNeedsRearm) return; // phone hasn't returned to neutral since the last throw
    // use the orientation captured AT RELEASE (carried by the throw packet),
    // not whichever 30Hz tilt sample happened to arrive last
    const position = clamp01(m.steer / 0.35, -1, 1) * TUNING.maxPosition;
    const aim = clamp01(m.aim / 0.45, -1, 1) * TUNING.maxAim;
    const power = clamp01(m.power, 0.12, 1);
    const spin = clamp01(m.spin, -1, 1);
    game._throw({ position, aim, power, spin });
    phoneNeedsRearm = true; // tilt steering pauses until back near neutral
    broadcastPhonePhase();
  }

  /** Tell the phone whether swinging will throw right now. */
  function broadcastPhonePhase() {
    if (!phoneHost || !phoneHost.connected) return;
    const canThrow = game.phase === 'ready' && input.enabled && !phoneNeedsRearm;
    const key = `${game.phase}|${canThrow ? 1 : 0}`;
    if (key === lastPhonePhaseKey) return;
    lastPhonePhaseKey = key;
    phoneHost.sendCtl({ t: 'phase', phase: game.phase, canThrow });
  }

  async function renderPhoneQr(text) {
    try {
      const mod = await import('https://esm.sh/qrcode@1.5.4');
      const QR = mod.default || mod;
      await QR.toCanvas(ui.el.phoneQr, text, {
        width: 200, margin: 1,
        color: { dark: '#0b2a3d', light: '#ffffff' },
      });
      ui.el.phoneQr.classList.remove('hidden');
    } catch {
      ui.el.phoneQr.classList.add('hidden'); // code entry still works
    }
  }

  function updatePhoneNotes() {
    const connected = !!(phoneHost && phoneHost.connected);
    ui.el.phoneMenuNote.classList.toggle('hidden', !connected);
    ui.el.phoneConnectedNote.classList.toggle('hidden', !connected);
    ui.el.phonePairRow.classList.toggle('hidden', !connected);
  }

  async function startPhonePairing() {
    ui.showMenu('phone');
    ui.el.phoneDone.classList.add('hidden');
    ui.el.phonePairRow.classList.add('hidden');
    updatePhoneNotes();
    ui.el.phoneStatus.textContent = 'Starting…';
    if (!phoneHost) {
      phoneHost = new PhoneHost({
        onState: onPhoneState,
        onThrow: onPhoneThrow,
        onStatus: (kind, detail) => {
          if (kind === 'waiting') ui.el.phoneStatus.textContent = 'Waiting for your phone…';
          else if (kind === 'connected') {
            ui.el.phoneStatus.textContent = 'Connected — the QR is no longer needed';
            ui.el.phoneDone.classList.remove('hidden');
            lastPhonePhaseKey = ''; // resend the current phase to the phone
            broadcastPhonePhase();
          }
          else if (kind === 'disconnected') ui.el.phoneStatus.textContent = 'Phone disconnected — re-pair to reconnect';
          else if (kind === 'error') ui.el.phoneStatus.textContent = 'Error: ' + (detail || 'pairing failed');
          updatePhoneNotes();
        },
        onLatency: (ms) => { /* status line above; keep for future HUD */ void ms; },
      });
    }
    const base = new URL('phone.html', location.href).href;
    try {
      const { code, url } = await phoneHost.startPairing(base);
      ui.el.phoneCode.textContent = code;
      await renderPhoneQr(url);
      ui.el.phoneStatus.textContent = 'Scan the QR (or open this site on your phone and enter the code)';
    } catch (e) {
      ui.el.phoneStatus.textContent = 'Could not start pairing: ' + (e.message || e);
    }
  }

  // ---------------- main loop ----------------

  let _lastGamePhase = 'ready';
  function fixedUpdate() {
    onlineTick();
    if (net && currentRoom && currentRoom.status === 'playing'
        && _lastGamePhase !== 'rolling' && game.phase === 'rolling'
        && currentRoom.turn && currentRoom.turn.uid === net.uid) {
      // OUR throw just left the foul line (not a remote replay) — lock input
      // until the room records it
      revisionAtThrow = net.revision;
    }
    _lastGamePhase = game.phase;
    game.fixedUpdate(FIXED_DT);
    broadcastPhonePhase();
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
    const metersPhase = game.phase === 'ready' && input.enabled ? 'ready' : game.phase;
    ui.updateMeters(input.controls, input.charging, metersPhase);
    ui.setDebug(`FPS:${_fps.toFixed(0)} ${_ft.toFixed(1)}ms\n${game.phase} f${game.frameIndex + 1} r${game.rollIndex + 1}`);
  }

  // ---------------- menus ----------------

  ui.el.overlayBtn.style.display = 'none';
  ui.showMenu('main');
  ui.el.overlay.classList.add('show');

  ui.el.menuMain.querySelector('#btn-solo').addEventListener('click', () => {
    audio.init(); audio.click(); startSolo();
  });
  ui.el.menuMain.querySelector('#btn-local').addEventListener('click', () => {
    audio.init(); audio.click();
    ui.showMenu('local');
    ui.buildLocalNames(2);
    selectCount(2);
  });
  ui.el.menuMain.querySelector('#btn-online').addEventListener('click', () => {
    audio.init();
    ui.showMenu('online');
    ui.el.onlineName.focus();
  });
  ui.el.menuMain.querySelector('#btn-phone').addEventListener('click', () => {
    audio.init(); audio.click(); startPhonePairing();
  });
  ui.el.menuPhone.querySelector('#btn-phone-done').addEventListener('click', () => {
    audio.init(); audio.click();
    ui.el.phoneDone.classList.add('hidden');
    ui.showMenu('main'); // connection stays live; pick a mode and bowl
    updatePhoneNotes();
  });
  // Back HIDES the pairing screen — it only kicks the phone if pairing never
  // completed. Disconnect is explicit and separate.
  ui.el.menuPhone.querySelector('#btn-phone-back').addEventListener('click', () => {
    audio.click();
    if (phoneHost && !phoneHost.connected) { phoneHost.close(); phoneHost = null; }
    ui.el.phoneDone.classList.add('hidden');
    ui.showMenu('main');
    updatePhoneNotes();
  });
  ui.el.phoneDisconnect.addEventListener('click', () => {
    audio.click();
    if (phoneHost) { phoneHost.close(); phoneHost = null; }
    ui.el.phoneDone.classList.add('hidden');
    ui.showMenu('main');
    updatePhoneNotes();
  });

  function selectCount(n) {
    ui.el.menuLocal.querySelectorAll('.count-btn').forEach((b) => {
      b.classList.toggle('selected', Number(b.dataset.count) === n);
    });
  }
  let localCount = 2;
  ui.el.menuLocal.querySelectorAll('.count-btn').forEach((b) => {
    b.addEventListener('click', () => {
      audio.click();
      localCount = Number(b.dataset.count);
      ui.buildLocalNames(localCount);
      selectCount(localCount);
    });
  });
  ui.el.menuLocal.querySelector('#btn-local-start').addEventListener('click', () => {
    audio.click();
    const names = [];
    ui.el.localNames.querySelectorAll('input').forEach((inp) => {
      names.push((inp.value || inp.placeholder || 'Bowler').trim().slice(0, 12));
    });
    while (names.length < localCount) names.push('Bowler ' + (names.length + 1));
    startLocal(names);
  });
  ui.el.menuLocal.querySelector('#btn-local-back').addEventListener('click', () => {
    audio.click(); ui.showMenu('main');
  });

  ui.el.menuOnline.querySelector('#btn-create').addEventListener('click', () => {
    audio.init(); audio.click(); createOnlineRoom();
  });
  ui.el.menuOnline.querySelector('#btn-join').addEventListener('click', () => {
    audio.init(); audio.click(); joinOnlineRoom();
  });
  ui.el.joinCode.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { audio.init(); joinOnlineRoom(); }
  });
  ui.el.menuOnline.querySelector('#btn-online-back').addEventListener('click', () => {
    audio.click();
    if (net) { net.leaveRoom(); net = null; currentRoom = null; }
    ui.showMenu('main');
  });

  ui.el.btnStartMatch.addEventListener('click', () => {
    audio.click();
    net.startMatch().catch((e) => ui.onlineError(e.message));
  });
  ui.el.menuLobby.querySelector('#btn-leave').addEventListener('click', async () => {
    audio.click();
    await net.leaveRoom();
    net = null; currentRoom = null;
    backToMenu();
  });

  // ---- keyboard shortcuts ----
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyR' && !e.repeat) {
      audio.init();
      if (net && currentRoom) {
        net.leaveRoom().then(() => { net = null; backToMenu(); });
      } else if (match) {
        startLocal(localNames);
      } else {
        ui.hideOverlay();
        game.start();
      }
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
    if (net && currentRoom) {
      net.leaveRoom().then(() => { net = null; backToMenu(); });
    } else if (match) {
      startLocal(localNames);
    } else {
      ui.hideOverlay();
      game.start();
    }
  });
  ui.el.playAgain.addEventListener('click', () => {
    audio.click();
    if (net && currentRoom) {
      if (currentRoom.status === 'done' && currentRoom.players[0].uid === net.uid) {
        net.playAgain(); // back to lobby with the same roster
      }
      return; // non-hosts wait for the host
    }
    ui.hideOverlay();
    if (match) startLocal(localNames);
    else game.start();
  });

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
    const players = match
      ? match.players.map((p) => ({ name: p.name, rolls: p.game.rolls, total: p.game.totalScore() }))
      : currentRoom
        ? currentRoom.players.map((p) => ({ name: p.name, rolls: (currentRoom.rolls[p.uid] || []), total: null }))
        : null;
    return JSON.stringify({
      phase: game.phase,
      frame: Math.min(game.frameIndex + 1, 10),
      ball: Math.min(game.rollIndex + 1, 3),
      standingPins: standing,
      pinsStanding: standing.length,
      rolls: game.game.rolls,
      scores: game.game.scores(),
      total: game.game.totalScore(),
      players,
      message: document.getElementById('message').textContent,
      controls: {
        position: +input.controls.position.toFixed(3),
        aim: +input.controls.aim.toFixed(3),
        power: +input.controls.power.toFixed(3),
        spin: +input.controls.spin.toFixed(3),
        charging: input.charging,
        inputEnabled: input.enabled,
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
      if (game.phase !== 'ready' || !input.enabled) return false;
      game._throw({ ...input.controls });
      return true;
    },
    deliverBall({ position = 0, aim = 0, power = 0.7, spin = 0 } = {}) {
      if (game.phase !== 'ready' || !input.enabled) return false;
      game._throw({ position, aim, power, spin });
      return true;
    },
    restart() {
      if (net && currentRoom) return;
      ui.hideOverlay();
      if (match) startLocal(localNames);
      else game.start();
    },
    state() { return JSON.parse(window.render_game_to_text()); },
  };

  frame();
}

if (!IS_PHONE) boot();
