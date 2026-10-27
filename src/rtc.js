// Phone-as-controller transport.
// Pairing uses Firestore ONLY for signaling (offer/answer), then all
// controller traffic flows over a WebRTC data channel — low latency,
// no database writes per movement sample.
//
// Two channels (host-created):
//   'state' — unreliable/unordered, phone -> host, 30Hz orientation samples
//             (stale samples are dropped via seq on the host)
//   'ctl'   — reliable/ordered, both ways: throws, calibration, phase, ping
//
// Security: the doc id is a high-entropy token (the QR contains the token,
// not the 4-char human code). The human code is only a lookup aid. The first
// controller to claim a session wins; later claims are rejected.

import {
  initializeApp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getFirestore, doc, setDoc, updateDoc, getDocs, deleteDoc,
  onSnapshot, runTransaction, serverTimestamp, query, collection, where, limit,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyBDYH16UPlCBIarBorBAMiyc7Mbn6_v9cw',
  authDomain: 'database-3-9462a.firebaseapp.com',
  projectId: 'database-3-9462a',
  storageBucket: 'database-3-9462a.firebasestorage.app',
  messagingSenderId: '381377295126',
  appId: '1:381377295126:web:b919eadb9ce0d3c50a9637',
  measurementId: 'G-181H9BHDVG',
};

const COLLECTION = 'bowlingControllers';
const SESSION_TTL_MS = 60 * 60 * 1000; // sessions expire after 1 hour
const ICE_GATHER_TIMEOUT_MS = 4000;

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function humanCode() {
  let c = '';
  for (let i = 0; i < 4; i++) c += CHARS[Math.floor(Math.random() * CHARS.length)];
  return c;
}
function token() {
  const t = globalThis.crypto;
  if (t && t.randomUUID) return t.randomUUID().replace(/-/g, '');
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

let _app = null;
let _db = null;
function db() {
  if (!_db) {
    _app = initializeApp(FIREBASE_CONFIG);
    _db = getFirestore(_app);
  }
  return _db;
}

/** Wait for ICE gathering to finish (or a bounded timeout). */
function waitIce(pc, timeoutMs = ICE_GATHER_TIMEOUT_MS) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { pc.removeEventListener('icegatheringstatechange', check); resolve(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(done, timeoutMs);
  });
}

// ============================ Host (the game) ============================

export class PhoneHost {
  /**
   * onState({ seq, roll, yaw })  — live phone tilt (roll -> ball position,
   *                               yaw -> aim), relative to calibration
   * onThrow({ power, spin, id }) — release event (id for dedup)
   * onStatus('waiting'|'connected'|'disconnected'|'error', detail)
   * onLatency(ms)                 — round-trip over the ctl channel
   */
  constructor({ onState, onThrow, onStatus, onLatency } = {}) {
    this.onState = onState || (() => {});
    this.onThrow = onThrow || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onLatency = onLatency || (() => {});
    this.pc = null;
    this.stateCh = null;
    this.ctlCh = null;
    this.docId = null;
    this.code = null;
    this.unsub = null;
    this._seenThrows = new Set();
    this._lastSeq = -1;
    this._pingTimer = null;
    this.connected = false;
  }

  /** Start pairing: returns { code, url } once the offer is published. */
  async startPairing(baseUrl) {
    this.close();
    this.code = humanCode();
    this.docId = token();
    const url = `${baseUrl}?pair=${this.docId}`;

    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    this.stateCh = this.pc.createDataChannel('state', { ordered: false, maxRetransmits: 0 });
    this.ctlCh = this.pc.createDataChannel('ctl', { ordered: true });
    this._wireChannels();

    this.pc.addEventListener('connectionstatechange', () => {
      const st = this.pc.connectionState;
      if (st === 'connected') { this.connected = true; this.onStatus('connected'); this._startPing(); }
      if (st === 'failed' || st === 'disconnected' || st === 'closed') {
        this.connected = false;
        this.onStatus(st === 'failed' ? 'error' : 'disconnected');
        this._stopPing();
      }
    });

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await waitIce(this.pc); // non-trickle: publish the full SDP once

    await setDoc(doc(db(), COLLECTION, this.docId), {
      code: this.code,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
      offer: JSON.stringify(this.pc.localDescription),
      answer: null,
      claim: null,
      status: 'waiting',
      updatedAt: serverTimestamp(),
    });

    this.unsub = onSnapshot(doc(db(), COLLECTION, this.docId), (snap) => {
      const data = snap.data();
      if (!data) return;
      if (data.answer && this.pc.signalingState !== 'stable' && !this.pc.remoteDescription) {
        this.pc.setRemoteDescription(JSON.parse(data.answer)).catch((e) => {
          this.onStatus('error', 'bad answer: ' + e.message);
        });
      }
    }, (err) => this.onStatus('error', err.message));

    this.onStatus('waiting');
    return { code: this.code, url };
  }

  _wireChannels() {
    this.stateCh.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.t === 's') {
          if (m.seq > this._lastSeq) { // drop stale/out-of-order samples
            this._lastSeq = m.seq;
            this.onState(m);
          }
        }
      } catch { /* ignore malformed */ }
    });
    this.ctlCh.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      switch (m.t) {
        case 'throw':
          if (m.id && this._seenThrows.has(m.id)) return; // duplicate delivery
          if (m.id) this._seenThrows.add(m.id);
          this.onThrow(m);
          break;
        case 'cal':
          this._lastSeq = -1; // fresh reference frame
          break;
        case 'pong':
          if (m.ts) this.onLatency(Math.max(0, Date.now() - m.ts));
          break;
      }
    });
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      this.sendCtl({ t: 'ping', ts: Date.now() });
    }, 2000);
  }
  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  /** Reliable control message to the phone (phase updates etc). */
  sendCtl(obj) {
    if (this.ctlCh && this.ctlCh.readyState === 'open') {
      try { this.ctlCh.send(JSON.stringify(obj)); } catch { /* closing */ }
    }
  }

  close() {
    this._stopPing();
    if (this.unsub) { this.unsub(); this.unsub = null; }
    if (this.pc) { try { this.pc.close(); } catch { /* already closed */ } this.pc = null; }
    if (this.docId) { deleteDoc(doc(db(), COLLECTION, this.docId)).catch(() => {}); }
    this.connected = false;
  }
}

// =========================== Client (the phone) ===========================

export class PhoneClient {
  /**
   * onOpen(), onStatus('connecting'|'connected'|'disconnected'|'error', detail),
   * onCtl(obj) — messages from the game (phase, ping).
   */
  constructor({ onOpen, onStatus, onCtl } = {}) {
    this.onOpen = onOpen || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onCtl = onCtl || (() => {});
    this.uid = token();
    this.pc = null;
    this.ctlCh = null;
    this.docId = null;
    this.connected = false;
  }

  /** Connect via the high-entropy token from the QR link. */
  async connectByToken(pairToken) {
    await this._connect(String(pairToken).trim());
  }

  /** Connect via the 4-char human code (looks up the freshest waiting session). */
  async connectByCode(code) {
    code = String(code || '').trim().toUpperCase();
    const q = query(
      collection(db(), COLLECTION),
      where('code', '==', code),
      where('status', '==', 'waiting'),
      limit(5)
    );
    const snaps = await getDocs(q);
    if (snaps.empty) throw new Error('No waiting session with that code');
    let best = null;
    for (const d of snaps.docs) {
      const data = d.data();
      if ((data.expiresAt || 0) < Date.now()) continue; // expired
      if (!data.offer) continue;
      if (!best || data.createdAt > best.data.createdAt) best = { id: d.id, data };
    }
    if (!best) throw new Error('That session expired — ask the host to re-pair');
    await this._connect(best.id);
  }

  async _connect(docId) {
    this.docId = docId;
    const ref = doc(db(), COLLECTION, docId);

    // Claim: first controller wins (transaction), then publish the answer.
    let offerSdp = null;
    await runTransaction(db(), async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('Session not found');
      const room = snap.data();
      if ((room.expiresAt || 0) < Date.now()) throw new Error('That session expired');
      if (room.claim && room.claim.uid !== this.uid) {
        throw new Error('Another controller already claimed this session');
      }
      if (!room.offer) throw new Error('Host is not ready yet — try again in a second');
      if (!room.claim) {
        tx.update(ref, { claim: { uid: this.uid, claimedAt: Date.now() } });
      }
      offerSdp = room.offer;
    });

    this.onStatus('connecting');
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    this.pc.addEventListener('datachannel', (ev) => {
      const ch = ev.channel;
      if (ch.label === 'state') {
        this._stateCh = ch; // unreliable channel for orientation samples
      } else if (ch.label === 'ctl') {
        this.ctlCh = ch;
        ch.addEventListener('message', (e) => {
          let m; try { m = JSON.parse(e.data); } catch { return; }
          if (m.t === 'ping' && m.ts) {
            this._sendCtl({ t: 'pong', ts: m.ts });
          }
          this.onCtl(m);
        });
        ch.addEventListener('close', () => this.onStatus('disconnected'));
      }
    });
    this.pc.addEventListener('connectionstatechange', () => {
      const st = this.pc.connectionState;
      if (st === 'connected') { this.connected = true; this.onStatus('connected'); this.onOpen(); }
      if (st === 'failed' || st === 'disconnected' || st === 'closed') {
        this.connected = false;
        this.onStatus(st === 'failed' ? 'error' : 'disconnected');
      }
    });

    await this.pc.setRemoteDescription(JSON.parse(offerSdp));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await waitIce(this.pc);
    await updateDoc(ref, {
      answer: JSON.stringify(this.pc.localDescription),
      status: 'paired',
      updatedAt: serverTimestamp(),
    });
  }

  _sendCtl(obj) {
    if (this.ctlCh && this.ctlCh.readyState === 'open') {
      try { this.ctlCh.send(JSON.stringify(obj)); } catch { /* closing */ }
    }
  }

  /** Send an orientation sample (unreliable channel — latest wins on host). */
  sendState(seq, roll, yaw) {
    // state channel is created by the host; we keep a reference when opened
    if (this._stateCh && this._stateCh.readyState === 'open') {
      try {
        this._stateCh.send(JSON.stringify({ t: 's', seq, roll, yaw }));
      } catch { /* closing */ }
    }
  }

  /** Reliable control message to the game (throws, calibration). */
  sendCtl(obj) { this._sendCtl(obj); }

  close() {
    if (this.pc) { try { this.pc.close(); } catch {} this.pc = null; }
    this.connected = false;
  }
}

