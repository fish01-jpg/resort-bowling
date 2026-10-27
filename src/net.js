// Online multiplayer adapter: rooms synced through Firestore.
// One authoritative room document per match; rolls are appended inside a
// transaction that verifies turn + revision, so two clients can never commit
// the same roll. The thrower's simulated result is accepted as the score
// (casual game — the rules validate state transitions, not physics honesty).

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getFirestore, doc, onSnapshot, runTransaction, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { applyRollToRoom, FULL_RACK } from './match.js';

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBDYH16UPlCBIarBorBAMiyc7Mbn6_v9cw',
  authDomain: 'database-3-9462a.firebaseapp.com',
  projectId: 'database-3-9462a',
  storageBucket: 'database-3-9462a.firebasestorage.app',
  messagingSenderId: '381377295126',
  appId: '1:381377295126:web:b919eadb9ce0d3c50a9637',
  measurementId: 'G-181H9BHDVG',
};

const COLLECTION = 'bowlingRooms';

/** A player who hasn't acted this long is skipped (gutter recorded). */
export const TURN_TIMEOUT_MS = 90000;

/** Unambiguous 4-char room codes. */
function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

export class RoomClient {
  /**
   * onRoom(room|null) — every snapshot (room is the plain doc data)
   * onError(message) — friendly connection/permission errors
   * onReplayDone() — the local replay of a remote throw finished (visuals)
   */
  constructor({ onRoom, onError, onReplayDone } = {}) {
    this.app = initializeApp(FIREBASE_CONFIG);
    this.db = getFirestore(this.app);
    this.uid = (globalThis.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'u' + Math.random().toString(36).slice(2, 12);
    this.name = '';
    this.code = null;
    this.unsub = null;
    this.room = null;
    this.onRoom = onRoom || (() => {});
    this.onError = onError || ((m) => console.error('[net]', m));
    this.onReplayDone = onReplayDone || (() => {});
  }

  get myTurn() {
    return !!(this.room && this.room.status === 'playing' &&
      this.room.turn && this.room.turn.uid === this.uid);
  }

  /** Create a fresh room; returns the 4-char code. */
  async createRoom(name) {
    this.name = name;
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = roomCode();
      const ref = doc(this.db, COLLECTION, code);
      try {
        await runTransaction(this.db, async (tx) => {
          const snap = await tx.get(ref);
          if (snap.exists()) throw new Error('CODE_TAKEN');
          tx.set(ref, {
            v: 1,
            status: 'lobby',
            revision: 0,
            players: [{ uid: this.uid, name }],
            rolls: {},
            rack: FULL_RACK.slice(),
            turn: null,
            lastThrow: null,
            winner: null,
            absent: [],
            createdAt: Date.now(),
            updatedAt: serverTimestamp(),
          });
        });
        this._listen(code);
        return code;
      } catch (e) {
        if (e.message === 'CODE_TAKEN') continue;
        throw e;
      }
    }
    throw new Error('Could not allocate a room code — try again');
  }

  /** Join by code. Rejoining with the same name returns to your old seat. */
  async joinRoom(code, name) {
    this.name = name;
    code = String(code || '').trim().toUpperCase();
    const ref = doc(this.db, COLLECTION, code);
    await runTransaction(this.db, async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('Room not found — check the code');
      const room = snap.data();
      if (room.status !== 'lobby') throw new Error('That match already started');
      const players = room.players || [];
      const existing = players.find((p) => p.name === name && !((room.absent || []).includes(p.uid)));
      if (existing) {
        // same name: reclaim the old seat (keeps rolls after a refresh)
        this.uid = existing.uid;
        tx.update(ref, { absent: (room.absent || []).filter((u) => u !== this.uid), updatedAt: serverTimestamp() });
        return;
      }
      if (players.length >= 6) throw new Error('Room is full');
      tx.update(ref, { players: [...players, { uid: this.uid, name }], updatedAt: serverTimestamp() });
    });
    this._listen(code);
  }

  _listen(code) {
    if (this.unsub) this.unsub();
    this.code = code;
    const ref = doc(this.db, COLLECTION, code);
    this.unsub = onSnapshot(ref,
      (snap) => {
        this.room = snap.exists() ? snap.data() : null;
        this.onRoom(this.room);
      },
      (err) => this.onError('Connection problem: ' + (err.message || err.code)));
  }

  /** Leave: removed from lobby, or marked absent once playing. */
  async leaveRoom() {
    if (!this.code) return;
    const ref = doc(this.db, COLLECTION, this.code);
    try {
      await runTransaction(this.db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) return;
        const room = snap.data();
        if (room.status === 'lobby') {
          const players = (room.players || []).filter((p) => p.uid !== this.uid);
          if (players.length === 0) { tx.delete(ref); return; }
          tx.update(ref, { players, updatedAt: serverTimestamp() });
        } else {
          tx.update(ref, {
            absent: [...new Set([...(room.absent || []), this.uid])],
            updatedAt: serverTimestamp(),
          });
        }
      });
    } finally {
      this.stop();
      this.room = null;
      this.code = null;
    }
  }

  /** Host starts the match (roster freezes, first player is up). */
  async startMatch() {
    const ref = doc(this.db, COLLECTION, this.code);
    await runTransaction(this.db, async (tx) => {
      const snap = await tx.get(ref);
      const room = snap.data();
      if (!room || room.status !== 'lobby') throw new Error("Can't start now");
      if (!room.players || room.players[0].uid !== this.uid) throw new Error('Only the host can start');
      tx.update(ref, {
        status: 'playing',
        revision: (room.revision || 0) + 1,
        rolls: {},
        rack: FULL_RACK.slice(),
        turn: { uid: room.players[0].uid, frame: 0, ball: 0, startedAt: Date.now() },
        lastThrow: null,
        winner: null,
        absent: [],
        updatedAt: serverTimestamp(),
      });
    });
  }

  /**
   * Commit our simulated result. The transaction is the single scoring
   * authority: it verifies it is our turn, applies the roll, derives the next
   * turn/rack, and bumps the revision atomically.
   */
  async submitRoll({ params, knocked, standingAfter }) {
    const ref = doc(this.db, COLLECTION, this.code);
    try {
      await runTransaction(this.db, async (tx) => {
        const snap = await tx.get(ref);
        const room = snap.data();
        if (!room || room.status !== 'playing') throw new Error('Match is not active');
        if (!room.turn || room.turn.uid !== this.uid) throw new Error('Not your turn');
        const baseRevision = room.revision || 0;
        const next = applyRollToRoom(room, this.uid, knocked, standingAfter);
        tx.update(ref, {
          ...next,
          lastThrow: {
            uid: this.uid, name: this.name, seq: baseRevision + 1,
            params, knocked, standingAfter,
          },
          revision: baseRevision + 1,
          updatedAt: serverTimestamp(),
        });
      });
    } catch (e) {
      this.onError('Roll not saved — ' + e.message);
    }
  }

  /** Anyone may skip a turn that exceeded the timeout (records a gutter). */
  async skipTurn() {
    const ref = doc(this.db, COLLECTION, this.code);
    try {
      await runTransaction(this.db, async (tx) => {
        const snap = await tx.get(ref);
        const room = snap.data();
        if (!room || room.status !== 'playing' || !room.turn) return;
        if (Date.now() - (room.turn.startedAt || 0) < TURN_TIMEOUT_MS) return;
        const next = applyRollToRoom(room, room.turn.uid, 0, room.rack);
        tx.update(ref, {
          ...next,
          lastThrow: null,
          revision: (room.revision || 0) + 1,
          updatedAt: serverTimestamp(),
        });
      });
    } catch (e) {
      this.onError('Skip failed — ' + e.message);
    }
  }

  /** Host: return everyone to the lobby with the same roster. */
  async playAgain() {
    const ref = doc(this.db, COLLECTION, this.code);
    try {
      await runTransaction(this.db, async (tx) => {
        const snap = await tx.get(ref);
        const room = snap.data();
        if (!room || room.status !== 'done') return;
        if (!room.players || room.players[0].uid !== this.uid) throw new Error('Only the host can restart');
        tx.update(ref, {
          status: 'lobby',
          revision: (room.revision || 0) + 1,
          rolls: {},
          rack: FULL_RACK.slice(),
          turn: null,
          lastThrow: null,
          winner: null,
          absent: [],
          updatedAt: serverTimestamp(),
        });
      });
    } catch (e) {
      this.onError(e.message);
    }
  }

  stop() {
    if (this.unsub) { this.unsub(); this.unsub = null; }
  }
}
