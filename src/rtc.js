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
// MULTI-PHONE: the host runs one session per phone slot (up to 4). Each slot
// gets its own signaling doc (own token + 4-char code) and its own
// RTCPeerConnection, so several phones can bowl on the same game — each slot
// is told its number (1-based) via 'phase' messages. Per-slot sessions also
// allow a disconnected phone to re-pair without disturbing the others.
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

/**
 * Multi-phone host. Each phone slot (0-based) is an independent session with
 * its own signaling doc and RTCPeerConnection.
 *
 * onState(slot, { seq, roll, yaw })  — live phone tilt (roll -> ball position,
 *                                      yaw -> aim), relative to calibration
 * onThrow(slot, { power, spin, id }) — release event (id for dedup)
 * onStatus(slot, 'waiting'|'connected'|'disconnected'|'error', detail)
 * onLatency(slot, ms)                 — round-trip over the ctl channel
 * onUiClick(slot, key)                — the phone pressed a mirrored on-screen
 *                                        button (key from the 'ui' list)
 */
export class PhoneHost {
  constructor({ onState, onThrow, onStatus, onLatency, onUiClick } = {}) {
    this.onState = onState || (() => {});
    this.onThrow = onThrow || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onLatency = onLatency || (() => {});
    this.onUiClick = onUiClick || (() => {});
    this.sessions = []; // [{ slot, pc, stateCh, ctlCh, docId, code, unsub,
                         //   seenThrows, lastSeq, pingTimer, connected }]
  }

  /** True once ANY phone is connected. */
  get connected() {
    return this.sessions.some((s) => s.connected);
  }

  /** 0-based slot numbers with a live phone. */
  connectedSlots() {
    return this.sessions.filter((s) => s.connected).map((s) => s.slot);
  }

  _session(slot) {
    return this.sessions.find((s) => s.slot === slot) || null;
  }

  /**
   * Start pairing for one slot (0-based). Any previous session for that slot
   * is torn down first (fresh token/code — safe re-pair). Returns
   * { code, url, slot } once the offer is published.
   */
  async startPairing(baseUrl, slot = 0) {
    this.closeSlot(slot);
    const code = humanCode();
    const docId = token();
    const url = `${baseUrl}?pair=${docId}`;
    const s = {
      slot,
      docId,
      code,
      unsub: null,
      pc: null,
      stateCh: null,
      ctlCh: null,
      seenThrows: new Set(),
      lastSeq: -1,
      pingTimer: null,
      connected: false,
      closed: false, // set by closeSlot: abort in-flight pairing cleanly
    };
    this.sessions.push(s);

    s.pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    s.stateCh = s.pc.createDataChannel('state', { ordered: false, maxRetransmits: 0 });
    s.ctlCh = s.pc.createDataChannel('ctl', { ordered: true });
    this._wireChannels(s);

    s.pc.addEventListener('connectionstatechange', () => {
      if (!s.pc || s.closed) return;
      const st = s.pc.connectionState;
      if (st === 'failed' || st === 'disconnected' || st === 'closed') {
        if (s.connected) {
          s.connected = false;
          this.onStatus(slot, st === 'failed' ? 'error' : 'disconnected');
        }
        this._stopPing(s);
      }
    });

    const offer = await s.pc.createOffer();
    if (s.closed) return { cancelled: true, code, url, slot };
    await s.pc.setLocalDescription(offer);
    if (s.closed) return { cancelled: true, code, url, slot };
    await waitIce(s.pc); // non-trickle: publish the full SDP once
    if (s.closed) return { cancelled: true, code, url, slot };

    await setDoc(doc(db(), COLLECTION, docId), {
      code,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
      offer: JSON.stringify(s.pc.localDescription),
      answer: null,
      claim: null,
      status: 'waiting',
      updatedAt: serverTimestamp(),
    });
    if (s.closed) {
      // torn down while publishing — don't leave an orphan signaling doc
      deleteDoc(doc(db(), COLLECTION, docId)).catch(() => {});
      return { cancelled: true, code, url, slot };
    }

    s.unsub = onSnapshot(doc(db(), COLLECTION, docId), (snap) => {
      if (!s.pc || s.closed) return;
      const data = snap.data();
      if (!data) return;
      if (data.answer && s.pc.signalingState !== 'stable' && !s.pc.remoteDescription) {
        s.pc.setRemoteDescription(JSON.parse(data.answer)).catch((e) => {
          this.onStatus(slot, 'error', 'bad answer: ' + e.message);
        });
      }
    }, (err) => { if (!s.closed) this.onStatus(slot, 'error', err.message); });

    this.onStatus(slot, 'waiting');
    return { code, url, slot };
  }

  _wireChannels(s) {
    // "connected" only counts once the RELIABLE channel is actually open —
    // connectionState 'connected' does not guarantee that, and phase
    // messages sent before open are silently dropped.
    s.ctlCh.addEventListener('open', () => {
      s.connected = true;
      this.onStatus(s.slot, 'connected');
      this._startPing(s);
    });
    s.stateCh.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.t === 's') {
          if (m.seq > s.lastSeq) { // drop stale/out-of-order samples
            s.lastSeq = m.seq;
            this.onState(s.slot, m);
          }
        }
      } catch { /* ignore malformed */ }
    });
    s.ctlCh.addEventListener('message', (ev) => {
      if (s.closed) return;
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      switch (m.t) {
        case 'throw':
          if (m.id && s.seenThrows.has(m.id)) return; // duplicate delivery
          if (m.id) s.seenThrows.add(m.id);
          this.onThrow(s.slot, m);
          break;
        case 'cal':
          s.lastSeq = -1; // fresh reference frame
          break;
        case 'pong':
          if (m.ts) this.onLatency(s.slot, Math.max(0, Date.now() - m.ts));
          break;
        case 'uiclick':
          if (m.key) this.onUiClick(s.slot, m.key, m.rev);
          break;
      }
    });
  }

  _startPing(s) {
    this._stopPing(s);
    s.pingTimer = setInterval(() => {
      this._sendOn(s, { t: 'ping', ts: Date.now() });
    }, 2000);
  }
  _stopPing(s) {
    if (s.pingTimer) { clearInterval(s.pingTimer); s.pingTimer = null; }
  }

  _sendOn(s, obj) {
    if (s.ctlCh && s.ctlCh.readyState === 'open') {
      try { s.ctlCh.send(JSON.stringify(obj)); } catch { /* closing */ }
    }
  }

  /** Broadcast a reliable control message to every connected phone. */
  sendCtl(obj) {
    for (const s of this.sessions) this._sendOn(s, obj);
  }

  /** Reliable control message to ONE phone (slot is 0-based). */
  sendCtlSlot(slot, obj) {
    const s = this._session(slot);
    if (s) this._sendOn(s, obj);
  }

  /** Tear down one slot's session (keeps the other phones connected). */
  closeSlot(slot) {
    const s = this._session(slot);
    if (!s) return;
    s.closed = true; // abort any in-flight pairing for this slot
    this._stopPing(s);
    if (s.unsub) { s.unsub(); s.unsub = null; }
    if (s.pc) { try { s.pc.close(); } catch { /* already closed */ } s.pc = null; }
    if (s.docId) { deleteDoc(doc(db(), COLLECTION, s.docId)).catch(() => {}); }
    s.connected = false;
    this.sessions = this.sessions.filter((x) => x !== s);
  }

  /** Close every slot. */
  close() {
    for (const s of [...this.sessions]) this.closeSlot(s.slot);
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
        ch.addEventListener('open', () => {
          this.connected = true;
          this.onStatus('connected');
          this.onOpen();
        });
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

  /** Send an orientation sample (unreliable channel — latest wins on host).
   *  spin = live wrist-twist preview for the aim guide. */
  sendState(seq, steer, aim, spin = 0) {
    // state channel is created by the host; we keep a reference when opened.
    // Field names (steer/aim/spin) must match what the host's onState consumes.
    if (this._stateCh && this._stateCh.readyState === 'open') {
      try {
        this._stateCh.send(JSON.stringify({ t: 's', seq, steer, aim, spin }));
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

