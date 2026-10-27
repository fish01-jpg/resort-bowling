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

  setDebug(text) {
    this.el.debug.textContent = text;
  }
}
