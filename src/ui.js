import { Game } from './scoring.js';

// All DOM/HUD work: scorecard table, power meter, spin dial, messages,
// frame indicator, title screen, game-over panel.

export class UI {
  constructor() {
    this.el = {
      scorecard: document.getElementById('scorecard'),
      frameIndicator: document.getElementById('frame-indicator'),
      powerFill: document.getElementById('power-fill'),
      powerMeter: document.getElementById('power-meter'),
      spinNeedle: document.getElementById('spin-needle'),
      spinDial: document.getElementById('spin-dial'),
      message: document.getElementById('message'),
      overlay: document.getElementById('overlay'),
      overlayTitle: document.getElementById('overlay-title'),
      overlaySub: document.getElementById('overlay-sub'),
      overlayBtn: document.getElementById('overlay-btn'),
      finalPanel: document.getElementById('final-panel'),
      finalScore: document.getElementById('final-score'),
      finalRank: document.getElementById('final-rank'),
      playAgain: document.getElementById('play-again'),
      debug: document.getElementById('debug'),
      muteBtn: document.getElementById('mute-btn'),
      restartBtn: document.getElementById('restart-btn'),
      turnBanner: document.getElementById('turn-banner'),
      matchPanel: document.getElementById('match-panel'),
      menuPanel: document.getElementById('menu-panel'),
      menuMain: document.getElementById('menu-main'),
      menuLocal: document.getElementById('menu-local'),
      menuOnline: document.getElementById('menu-online'),
      menuLobby: document.getElementById('menu-lobby'),
      menuPhone: document.getElementById('menu-phone'),
      phoneQr: document.getElementById('phone-qr'),
      phoneCode: document.getElementById('phone-code'),
      phoneStatus: document.getElementById('phone-status'),
      phoneDone: document.getElementById('btn-phone-done'),
      phoneDisconnect: document.getElementById('btn-phone-disconnect'),
      phonePairRow: document.getElementById('phone-pair-row'),
      phoneSlots: document.getElementById('phone-slots'),
      phoneConnectedNote: document.getElementById('phone-connected-note'),
      phoneMenuNote: document.getElementById('phone-menu-note'),
      localNames: document.getElementById('local-names'),
      onlineName: document.getElementById('online-name'),
      joinCode: document.getElementById('join-code'),
      onlineError: document.getElementById('online-error'),
      lobbyCode: document.getElementById('lobby-code'),
      lobbyPlayers: document.getElementById('lobby-players'),
      lobbyWaiting: document.getElementById('lobby-waiting'),
      btnStartMatch: document.getElementById('btn-start-match'),
      finalStandings: document.getElementById('final-standings'),
    };
    this._msgTimer = null;
    this._buildScorecard();
  }

  _buildScorecard() {
    const table = this.el.scorecard;
    table.innerHTML = '';
    const head = document.createElement('tr');
    head.className = 'frame-labels';
    for (let f = 0; f < 10; f++) {
      const th = document.createElement('th');
      th.textContent = f + 1;
      head.appendChild(th);
    }
    const totalTh = document.createElement('th');
    totalTh.textContent = 'TOTAL';
    totalTh.className = 'total-label';
    head.appendChild(totalTh);
    table.appendChild(head);

    const rolls = document.createElement('tr');
    rolls.className = 'rolls';
    for (let f = 0; f < 10; f++) {
      const td = document.createElement('td');
      td.className = 'frame-rolls';
      const inner = document.createElement('div');
      inner.className = 'frame-rolls-inner';
      const n = f === 9 ? 3 : 2;
      for (let k = 0; k < n; k++) {
        const span = document.createElement('span');
        span.className = 'roll';
        inner.appendChild(span);
      }
      td.appendChild(inner);
      rolls.appendChild(td);
    }
    const totalRolls = document.createElement('td');
    totalRolls.className = 'frame-rolls total-rolls';
    rolls.appendChild(totalRolls);
    table.appendChild(rolls);

    const totals = document.createElement('tr');
    totals.className = 'totals';
    for (let f = 0; f < 10; f++) {
      const td = document.createElement('td');
      td.className = 'frame-total';
      totals.appendChild(td);
    }
    const totalTd = document.createElement('td');
    totalTd.className = 'frame-total grand-total';
    totals.appendChild(totalTd);
    table.appendChild(totals);
  }

  updateScorecard(game, currentFrame) {
    const frames = game.frames();
    const scores = game.scores();
    const rows = this.el.scorecard.querySelectorAll('tr');
    const rollCells = rows[1].querySelectorAll('.frame-rolls');
    const totalCells = rows[2].querySelectorAll('.frame-total');
    for (let f = 0; f < 10; f++) {
      const fr = frames[f];
      const spans = rollCells[f].querySelectorAll('.roll');
      for (let k = 0; k < spans.length; k++) {
        spans[k].textContent = Game.symbol(fr, k, f);
      }
      rollCells[f].classList.toggle('current', f === currentFrame);
      const s = scores[f];
      totalCells[f].textContent = s === null ? '' : String(s);
    }
    const total = game.totalScore();
    totalCells[10] && (totalCells[10].textContent = total === null ? '' : String(total));
    const grand = rows[2].querySelector('.grand-total');
    if (grand) grand.textContent = total === null ? '—' : String(total);
  }

  setFrameIndicator(frame, ball) {
    this.el.frameIndicator.textContent = `Frame ${Math.min(frame, 10)} · Ball ${ball}`;
  }

  updateMeters(controls, charging, phase) {
    const show = phase === 'ready';
    this.el.powerMeter.style.opacity = show ? 1 : 0.35;
    this.el.spinDial.style.opacity = show ? 1 : 0.35;
    this.el.powerFill.style.height = `${Math.round(controls.power * 100)}%`;
    this.el.spinNeedle.style.left = `${50 + controls.spin * 45}%`;
  }

  message(text, cls = '', duration = 1600) {
    const m = this.el.message;
    m.textContent = text;
    m.className = 'show ' + cls;
    clearTimeout(this._msgTimer);
    if (duration > 0) {
      this._msgTimer = setTimeout(() => { m.className = ''; }, duration);
    }
  }

  showOverlay(title, sub, btnText) {
    this.el.overlayTitle.textContent = title;
    this.el.overlaySub.textContent = sub;
    this.el.overlayBtn.textContent = btnText;
    this.el.overlay.classList.add('show');
  }

  hideOverlay() {
    this.el.overlay.classList.remove('show');
    this.el.finalPanel.classList.remove('show');
    this.el.overlayTitle.parentElement.style.display = '';
  }

  showGameOver(total) {
    const rank =
      total === 300 ? 'PERFECT GAME' :
      total >= 200 ? 'PRO BOWLER' :
      total >= 150 ? 'SHARP SHOOTER' :
      total >= 100 ? 'SOLID GAME' :
      total >= 60 ? 'WARMING UP' : 'KEEP ROLLING';
    this.el.finalScore.textContent = String(total);
    this.el.finalRank.textContent = rank;
    this.el.finalPanel.classList.add('show');
    this.el.overlayTitle.parentElement.style.display = 'none';
    this.el.overlay.classList.add('show');
  }

  // ---------------- multiplayer ----------------

  /** Show one menu screen: 'main' | 'local' | 'online' | 'lobby' | null (hide all). */
  showMenu(screen) {
    this.el.menuPanel.classList.toggle('hidden', screen == null);
    for (const [key, id] of [['main', 'menuMain'], ['local', 'menuLocal'], ['online', 'menuOnline'], ['lobby', 'menuLobby'], ['phone', 'menuPhone']]) {
      this.el[id].classList.toggle('hidden', screen !== key);
    }
    if (screen === 'online') this.el.onlineError.classList.add('hidden');
  }

  /** Title screen (solo start). */
  showTitle() {
    this.el.overlayTitle.parentElement.style.display = '';
    this.el.overlay.classList.add('show');
    this.showMenu(null);
  }

  onlineError(msg) {
    this.el.onlineError.textContent = msg;
    this.el.onlineError.classList.remove('hidden');
  }

  /** Lobby: room code + roster + host start button. */
  showLobby(room, myUid) {
    this.showMenu('lobby');
    this.el.lobbyCode.textContent = room.code || '----';
    const ul = this.el.lobbyPlayers;
    ul.innerHTML = '';
    (room.players || []).forEach((p, i) => {
      const li = document.createElement('li');
      li.textContent = p.name;
      if (i === 0) li.classList.add('host');
      if (p.uid === myUid) li.textContent += ' (you)';
      ul.appendChild(li);
    });
    const isHost = room.players && room.players[0].uid === myUid;
    this.el.btnStartMatch.style.display = isHost ? '' : 'none';
    this.el.lobbyWaiting.classList.toggle('hidden', isHost);
  }

  /** Build the local-setup name inputs for N players. */
  buildLocalNames(count) {
    const wrap = this.el.localNames;
    wrap.innerHTML = '';
    for (let i = 0; i < count; i++) {
      const input = document.createElement('input');
      input.className = 'menu-input';
      input.maxLength = 12;
      input.placeholder = 'Bowler ' + (i + 1);
      input.dataset.slot = i;
      if (i === 0) input.autofocus = true;
      wrap.appendChild(input);
    }
  }

  setTurnBanner(text, sub = '') {
    const b = this.el.turnBanner;
    if (!text) { b.classList.add('hidden'); return; }
    b.innerHTML = '';
    b.append(text);
    if (sub) {
      const sp = document.createElement('span');
      sp.className = 'sub';
      sp.textContent = sub;
      b.append(sp);
    }
    b.classList.remove('hidden');
  }

  /**
   * Standings sidebar. rows: [{name, total, done, active}]
   */
  updateMatchPanel(rows) {
    const panel = this.el.matchPanel;
    if (!rows || rows.length < 2) { panel.classList.add('hidden'); return; }
    panel.innerHTML = '';
    const h = document.createElement('h3');
    h.textContent = 'Standings';
    panel.appendChild(h);
    for (const r of rows) {
      const div = document.createElement('div');
      div.className = 'mp-row' + (r.active ? ' active' : '') + (r.done ? ' done' : '');
      const name = document.createElement('span');
      name.textContent = r.name;
      const total = document.createElement('span');
      total.className = 'mp-total';
      total.textContent = r.total;
      div.append(name, total);
      panel.appendChild(div);
    }
    panel.classList.remove('hidden');
  }

  /** Multiplayer game over: standings with winner on top. */
  showMatchOver(standings) {
    const el = this.el.finalStandings;
    el.innerHTML = '';
    standings.forEach((row, i) => {
      const div = document.createElement('div');
      div.className = 'fs-row' + (i === 0 ? ' winner' : '');
      const name = document.createElement('span');
      name.textContent = row.name + (i === 0 ? ' 🏆' : '');
      const total = document.createElement('span');
      total.textContent = row.total;
      div.append(name, total);
      el.appendChild(div);
    });
    el.classList.remove('hidden');
    this.el.finalPanel.classList.add('show');
    this.el.overlayTitle.parentElement.style.display = 'none';
    this.el.overlay.classList.add('show');
    this.setTurnBanner('');
  }

  setDebug(text) {
    this.el.debug.textContent = text;
  }
}
