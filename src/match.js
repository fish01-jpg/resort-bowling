// Match layer: multi-player turn logic shared by local hot-seat and online.
// Pure logic only — no DOM, no physics, no Firebase. Safe to unit-test in Node.
//
// Bowling turn rules: each player completes their whole frame (both balls,
// including 10th-frame bonus rolls) before the turn passes to the next player.

import { Game } from './scoring.js';

export const FULL_RACK = Array.from({ length: 10 }, () => true);

/**
 * Where a player currently is in their own game.
 * Returns { frame: 0..9, ball: 0..2, done: bool } — frame/ball are the NEXT
 * roll to bowl (0-based). done = their game is complete.
 */
export function playerProgress(game) {
  const frames = game.frames();
  for (let f = 0; f < 9; f++) {
    const fr = frames[f] || [];
    if (fr.length === 0) return { frame: f, ball: 0, done: false };
    if (fr[0] !== 10 && fr.length < 2) return { frame: f, ball: 1, done: false };
  }
  // 10th frame
  const t = frames[9] || [];
  if (t.length === 0) return { frame: 9, ball: 0, done: false };
  if (t.length === 1) return { frame: 9, ball: 1, done: false };
  if (t.length === 2) {
    const needsThird = t[0] === 10 || t[0] + t[1] === 10;
    if (needsThird) return { frame: 9, ball: 2, done: false };
    return { frame: 9, ball: 2, done: true };
  }
  return { frame: 9, ball: 3, done: true };
}

/**
 * Is the frame with index `frameIdx` (0-based) complete for this game?
 * Frames 1-9: strike or two rolls. Frame 10: three rolls, or two with an
 * open frame.
 */
export function frameNowComplete(game, frameIdx) {
  const fr = (game.frames()[frameIdx] || []);
  if (frameIdx < 9) return fr[0] === 10 || fr.length >= 2;
  return fr.length === 3 || (fr.length === 2 && fr[0] !== 10 && fr[0] + t1(fr) < 10);
  function t1(fr) { return fr[1] ?? 0; }
}

/** Rebuild Game instances from a rolls map ({ uid: [pinfall, ...] }). */
export function buildGames(players, rolls) {
  const games = {};
  for (const p of players) {
    const g = new Game();
    g.rolls = (rolls && rolls[p.uid]) ? rolls[p.uid].slice() : [];
    games[p.uid] = g;
  }
  return games;
}

/**
 * Local hot-seat match controller.
 * Owns the roster and whose turn it is; each player owns their Game.
 */
export class Match {
  constructor(names) {
    this.players = names.map((name, i) => ({
      id: 'local-' + i,
      uid: 'local-' + i,
      name,
      game: new Game(),
    }));
    this.activeIdx = 0;
  }

  get active() {
    return this.players[this.activeIdx];
  }

  allDone() {
    return this.players.every((p) => p.game.isComplete());
  }

  /** Sorted standings: [{ name, total, done }] */
  standings() {
    return this.players
      .map((p) => ({ name: p.name, total: p.game.totalScore() ?? 0, done: p.game.isComplete() }))
      .sort((a, b) => b.total - a.total);
  }

  /**
   * After the active player bowled frame `bowledFrame`, has their TURN ended?
   * (Frame complete or their whole game complete.)
   */
  turnEnded(game, bowledFrame) {
    return game.isComplete() || frameNowComplete(game, bowledFrame);
  }

  /** Advance to the next player who still has rolls to bowl. Returns the player or null. */
  advanceTurn() {
    for (let k = 1; k <= this.players.length; k++) {
      const idx = (this.activeIdx + k) % this.players.length;
      if (!this.players[idx].game.isComplete()) {
        this.activeIdx = idx;
        return this.players[idx];
      }
    }
    return null;
  }
}

/**
 * Apply a roll to a plain online room state (pure — used by the Firestore
 * transaction so every client and the test harness share one code path).
 *
 * room: { players: [{uid, name}], rolls: {uid: [..]}, turn: {uid, frame, ball},
 *        rack: [bool x10], status }
 * Returns the new { rolls, rack, turn, status, winner } to write back.
 */
export function applyRollToRoom(room, uid, knocked, standingAfter) {
  const players = room.players;
  const rolls = { ...room.rolls, [uid]: [...(room.rolls[uid] || []), knocked] };
  const games = buildGames(players, rolls);
  const me = games[uid];
  const done = me.isComplete();

  const winnerUid = () =>
    players
      .slice()
      .sort((a, b) => (games[b.uid].totalScore() ?? 0) - (games[a.uid].totalScore() ?? 0))[0].uid;

  if (done && players.every((p) => games[p.uid].isComplete())) {
    return { rolls, rack: room.rack, turn: room.turn, status: 'done', winner: winnerUid() };
  }

  const bowledFrame = room.turn.frame;
  const continueSame = !done && !frameNowComplete(me, bowledFrame);

  if (continueSame) {
    const prog = playerProgress(me);
    return {
      rolls,
      rack: standingAfter,
      turn: { uid, frame: prog.frame, ball: prog.ball, startedAt: Date.now() },
      status: room.status,
      winner: null,
    };
  }

  // turn passes to the next player who isn't finished
  const activeIdx = players.findIndex((p) => p.uid === uid);
  let next = null;
  for (let k = 1; k <= players.length; k++) {
    const cand = players[(activeIdx + k) % players.length];
    if (!games[cand.uid].isComplete()) { next = cand; break; }
  }
  if (!next) {
    return { rolls, rack: room.rack, turn: room.turn, status: 'done', winner: winnerUid() };
  }
  const np = playerProgress(games[next.uid]);
  return {
    rolls,
    rack: FULL_RACK.slice(),
    turn: { uid: next.uid, frame: np.frame, ball: np.ball, startedAt: Date.now() },
    status: room.status,
    winner: null,
  };
}
