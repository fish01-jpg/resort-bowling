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
const CLIENT_CONNECT_TIMEOUT_MS = 20000; // phone gives up + retries instead of hanging
const STALE_CLAIM_MS = 90000; // a claimed-but-never-paired session can be taken over

// STUN-only pairing fails on symmetric-NAT / strict networks (hotspots,
// school Wi-Fi). Multiple STUN providers help; a TURN relay would cover the
// rest — add your own credentials (e.g. a free Metered account) here if your
// players are on locked-down networks. No public TURN is bundled: the
// well-known openrelay credentials are not confirmed by the provider.
const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const RTC_OPTS = { iceServers: ICE_SERVERS, iceCandidatePoolSize: 4 };

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
      gen: 1,              // negotiation generation (see _refreshOffer)
      appliedAnswer: null, // the answer string this peer already applied
      refreshing: false,
    };
    this.sessions.push(s);

    this._createPeer(s);

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
      gen: s.gen,
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
      if (!data || !data.answer) return;
      if (data.answerGen !== s.gen) return; // answer to an older offer
      if (data.answer === s.appliedAnswer) return; // already applied
      if (!s.pc.remoteDescription) {
        // normal first answer for this generation
        s.appliedAnswer = data.answer;
        s.answerBy = data.answerBy || null;
        s.pc.setRemoteDescription(JSON.parse(data.answer)).catch((e) => {
          this.onStatus(slot, 'error', 'bad answer: ' + e.message);
        });
      } else {
        // rate-limit: two live tabs sharing the device uid could otherwise
        // ping-pong refreshes forever
        if (Date.now() - (s.lastRefreshAt || 0) < 2000) return;
        this._refreshOffer(s);
      }
    }, (err) => { if (!s.closed) this.onStatus(slot, 'error', err.message); });

    this.onStatus(slot, 'waiting');
    return { code, url, slot };
  }

  /** Fresh RTCPeerConnection + channels + listeners for a session. */
  _createPeer(s) {
    s.pc = new RTCPeerConnection(RTC_OPTS);
    s.stateCh = s.pc.createDataChannel('state', { ordered: false, maxRetransmits: 0 });
    s.ctlCh = s.pc.createDataChannel('ctl', { ordered: true });
    this._wireChannels(s);

    const pc = s.pc; // capture: stale callbacks must not touch a replacement peer
    pc.addEventListener('connectionstatechange', () => {
      if (s.pc !== pc || s.closed) return;
      const st = pc.connectionState;
      if (st === 'connected') {
        // transient ICE recovery: an EXISTING open channel is enough — the
        // reliable channel survives a drop/recover without a reopen event
        if (!s.connected && s.ctlCh && s.ctlCh.readyState === 'open') {
          s.connected = true;
          this.onStatus(s.slot, 'connected');
          this._startPing(s);
        }
        return;
      }
      if (st === 'failed' || st === 'disconnected' || st === 'closed') {
        if (s.connected) {
          s.connected = false;
          this.onStatus(s.slot, st === 'failed' ? 'error' : 'disconnected');
        }
        this._stopPing(s);
      }
    });
    // some mobile browsers don't fire connectionstatechange reliably —
    // watch ICE too so a dead slot is reported instead of looking 'waiting'
    pc.addEventListener('iceconnectionstatechange', () => {
      if (s.pc !== pc || s.closed) return;
      const ist = pc.iceConnectionState;
      if (ist === 'failed' && s.connected) {
        s.connected = false;
        this.onStatus(s.slot, 'error');
        this._stopPing(s);
      } else if ((ist === 'connected' || ist === 'completed')
                 && !s.connected && s.ctlCh && s.ctlCh.readyState === 'open') {
        s.connected = true;
        this.onStatus(s.slot, 'connected');
        this._startPing(s);
      }
    });
  }

  /**
   * Reconnect support: publish a FRESH offer (generation +1) on the same
   * signaling doc — same code/QR, same slot. The phone watches the doc, sees
   * the new generation, and renegotiates. Without this, a phone that reloaded
   * could pass the claim check but its new answer was ignored by the host's
   * already-negotiated peer — "worked before, now stuck on connecting".
   */
  async _refreshOffer(s) {
    if (s.closed || s.refreshing) return;
    s.refreshing = true;
    s.lastRefreshAt = Date.now();
    try {
      this._stopPing(s);
      if (s.pc) { try { s.pc.close(); } catch { /* already closed */ } s.pc = null; }
      const wasConnected = s.connected;
      s.connected = false;
      s.gen += 1;
      s.appliedAnswer = null;
      s.lastSeq = -1; // the phone reloaded: its sample counter restarts at 0
      this._createPeer(s);
      const offer = await s.pc.createOffer();
      if (s.closed) return;
      await s.pc.setLocalDescription(offer);
      if (s.closed) return;
      await waitIce(s.pc);
      if (s.closed) return;
      await updateDoc(doc(db(), COLLECTION, s.docId), {
        offer: JSON.stringify(s.pc.localDescription),
        gen: s.gen,
        answer: null,
        updatedAt: serverTimestamp(),
      });
      if (wasConnected) this.onStatus(s.slot, 'waiting'); // renegotiating
    } catch (e) {
      if (!s.closed) this.onStatus(s.slot, 'error', 'refresh failed: ' + (e.message || e));
    } finally {
      s.refreshing = false;
    }
  }

  _wireChannels(s) {
    // "connected" only counts once the RELIABLE channel is actually open —
    // connectionState 'connected' does not guarantee that, and phase
    // messages sent before open are silently dropped.
    s.ctlCh.addEventListener('open', () => {
      s.connected = true;
      this.onStatus(s.slot, 'connected');
      this._startPing(s);
      // mark the session LIVE in the doc — a connected session is never
      // taken over by the stale-claim takeover path
      updateDoc(doc(db(), COLLECTION, s.docId), {
        status: 'connected', updatedAt: serverTimestamp(),
      }).catch(() => {});
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
    // Stable per-device id: kept in localStorage so a reload/reconnect with
    // the same QR link is recognized as the SAME controller. A fresh random
    // uid per page load made every reconnect look like an impostor ("another
    // controller already claimed this session") — phones that paired fine
    // before could never reconnect to a live slot.
    this.uid = null;
    try { this.uid = localStorage.getItem('sl-phone-uid') || null; } catch { /* no storage */ }
    if (!this.uid) {
      this.uid = token();
      try { localStorage.setItem('sl-phone-uid', this.uid); } catch { /* no storage */ }
    }
    this.pc = null;
    this.ctlCh = null;
    this.docId = null;
    this.connected = false;
    this.sid = token(); // per-attempt id (distinguishes tabs sharing the device uid)
    this._connWait = null; // resolves/rejects the watchdog in _connect
    this._aborted = false;  // set by close(): late Firestore writes are dropped
    this._unsub = null;     // doc watch for host offer refreshes (reconnect)
    this._gen = 0;          // negotiation generation we answered
    this._attempt = 0;      // guards the overall-attempt timer
    this._boundTimer = null;
    this._renegotiating = false;
  }

  /** Connect via the high-entropy token from the QR link. */
  async connectByToken(pairToken) {
    await this._bounded(() => this._connect(String(pairToken).trim()));
  }

  /**
   * Connect via the 4-char human code (looks up the freshest session).
   * Accepts sessions that are still waiting OR ones this device already
   * owns (its stored uid matches the claim) — so "tap CONNECT to retry"
   * works after a failed attempt, and a reload can reconnect by code.
   */
  async connectByCode(code) {
    await this._bounded(() => this._lookupByCode(code));
  }

  async _lookupByCode(code) {
    code = String(code || '').trim().toUpperCase();
    const q = query(
      collection(db(), COLLECTION),
      where('code', '==', code),
      limit(5)
    );
    const snaps = await getDocs(q);
    if (snaps.empty) throw new Error('No session with that code');
    let best = null;
    for (const d of snaps.docs) {
      const data = d.data();
      if ((data.expiresAt || 0) < Date.now()) continue; // expired
      if (!data.offer) continue;
      const mine = data.claim && data.claim.uid === this.uid;
      if (data.status !== 'waiting' && !mine) continue; // someone else's live session
      if (!best || (data.createdAt || 0) > (best.data.createdAt || 0)) best = { id: d.id, data };
    }
    if (!best) throw new Error('That session expired — ask the host to re-pair');
    await this._connect(best.id);
  }

  /** Bound the WHOLE attempt — lookup, claim, SDP, answer, channel-open. */
  async _bounded(fn) {
    const attempt = ++this._attempt;
    const timeout = new Promise((_, reject) => {
      this._boundTimer = setTimeout(() => {
        if (attempt !== this._attempt) return; // superseded
        this._aborted = true;
        this.close();
        reject(new Error('Connection timed out — tap CONNECT to try again'));
      }, CLIENT_CONNECT_TIMEOUT_MS + 10000);
    });
    try {
      await Promise.race([fn(), timeout]);
    } finally {
      clearTimeout(this._boundTimer);
    }
  }

  async _connect(docId) {
    this.docId = docId;
    const ref = doc(db(), COLLECTION, docId);

    // Claim: first controller wins (transaction), then publish the answer.
    let offerSdp = null;
    let offerGen = 1;
    await runTransaction(db(), async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('Session not found');
      const room = snap.data();
      if ((room.expiresAt || 0) < Date.now()) throw new Error('That session expired');
      if (room.claim && room.claim.uid !== this.uid) {
        // A stale claim (claimed but never paired, sitting there for a while)
        // blocks the slot forever — usually a phone that crashed mid-pair.
        // Take it over so the slot is usable again. A PAIRED session is never
        // stolen (the phone that owns it can reconnect via its stored uid).
        const neverPaired = !room.answer && room.status !== 'paired';
        const claimAge = Date.now() - (room.claim.claimedAt || 0);
        if (!(neverPaired && claimAge > STALE_CLAIM_MS)) {
          throw new Error('Another controller already claimed this session');
        }
        tx.update(ref, { claim: { uid: this.uid, claimedAt: Date.now() } });
      }
      if (!room.offer) throw new Error('Host is not ready yet — try again in a second');
      if (!room.claim) {
        tx.update(ref, { claim: { uid: this.uid, claimedAt: Date.now() } });
      }
      offerSdp = room.offer;
      offerGen = Number.isFinite(room.gen) ? room.gen : 1;
    });
    if (this._aborted) throw new Error('cancelled');
    this._gen = offerGen;

    this.onStatus('connecting');
    this._setupPeer();

    await this.pc.setRemoteDescription(JSON.parse(offerSdp));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await waitIce(this.pc);
    if (this._aborted) throw new Error('cancelled');
    // Publish the answer TRANSACTIONALLY: only if we still own the claim and
    // the offer generation is unchanged (a superseded claimant or a stale
    // attempt must not overwrite a newer negotiation)
    await runTransaction(db(), async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error('Session not found');
      const room = snap.data();
      if ((room.expiresAt || 0) < Date.now()) throw new Error('That session expired');
      if (room.claim && room.claim.uid !== this.uid) {
        throw new Error('Another controller claimed this session');
      }
      if ((room.gen || 1) !== offerGen) throw new Error('Host restarted pairing — try again');
      tx.update(ref, {
        answer: JSON.stringify(this.pc.localDescription),
        answerGen: offerGen,
        answerBy: this.sid,
        status: 'paired',
        updatedAt: serverTimestamp(),
      });
    });
    if (this._aborted) return; // cancelled mid-write — don't subscribe

    // Subscribe BEFORE waiting for the channel: if the host refreshes its
    // offer (generation bump — e.g. it saw our reconnect answer and is
    // renegotiating), we must see it even while the channel isn't open yet.
    this._unsub = onSnapshot(ref, (snap) => {
      if (this._aborted) return;
      const data = snap.data();
      if (!data || !data.offer) return;
      if (Number.isFinite(data.gen) && data.gen > this._gen) {
        this._renegotiate(data.gen, data.offer);
      }
    }, (err) => { if (!this._aborted) this.onStatus('error', err.message); });

    // Watchdog: if the data channel never opens (bad NAT, blocked UDP,
    // dozing browser), FAIL with an actionable message instead of leaving
    // the phone stuck on the loading screen forever.
    await this._awaitConnected(CLIENT_CONNECT_TIMEOUT_MS);
    if (this._aborted) return; // the attempt was cancelled
  }

  /** Fresh RTCPeerConnection + datachannel listeners. */
  _setupPeer() {
    if (this.pc) { try { this.pc.close(); } catch { /* already closed */ } }
    this.pc = new RTCPeerConnection(RTC_OPTS);
    const pc = this.pc; // capture: callbacks must not touch a replacement peer
    pc.addEventListener('datachannel', (ev) => {
      if (this.pc !== pc || this._aborted) return;
      const ch = ev.channel;
      if (ch.label === 'state') {
        this._stateCh = ch; // unreliable channel for orientation samples
      } else if (ch.label === 'ctl') {
        this.ctlCh = ch;
        ch.addEventListener('open', () => {
          if (this.pc !== pc || this._aborted) return;
          this.connected = true;
          this.onStatus('connected');
          this.onOpen();
          if (this._connWait) this._connWait.done();
        });
        ch.addEventListener('message', (e) => {
          if (this.pc !== pc) return;
          let m; try { m = JSON.parse(e.data); } catch { return; }
          if (m.t === 'ping' && m.ts) {
            this._sendCtl({ t: 'pong', ts: m.ts });
          }
          this.onCtl(m);
        });
        ch.addEventListener('close', () => this.onStatus('disconnected'));
      }
    });
    pc.addEventListener('connectionstatechange', () => {
      if (this.pc !== pc || this._aborted) return;
      const st = pc.connectionState;
      if (st === 'connected') {
        // transient ICE recovery: the reliable channel can survive a
        // drop/recover without a reopen event — an open channel is enough
        if (!this.connected && this.ctlCh && this.ctlCh.readyState === 'open') {
          this.connected = true;
          this.onStatus('connected');
          this.onOpen();
          if (this._connWait) this._connWait.done();
        }
        return;
      }
      if (st === 'failed' || st === 'disconnected' || st === 'closed') {
        this.connected = false;
        this.onStatus(st === 'failed' ? 'error' : 'disconnected');
        if (st === 'failed' && this._connWait) this._connWait.fail();
      }
    });
    // ICE-level watch too: some mobile browsers never fire
    // connectionstatechange('failed') when the path is impossible
    pc.addEventListener('iceconnectionstatechange', () => {
      if (this.pc !== pc || this._aborted) return;
      const ist = pc.iceConnectionState;
      if (ist === 'failed') {
        this.connected = false;
        this.onStatus('error');
        if (this._connWait) this._connWait.fail();
      } else if ((ist === 'connected' || ist === 'completed')
                 && !this.connected && this.ctlCh && this.ctlCh.readyState === 'open') {
        this.connected = true;
        this.onStatus('connected');
        this.onOpen();
        if (this._connWait) this._connWait.done();
      }
    });
  }

  /** The host published a fresh offer (generation bump): reconnect to it. */
  async _renegotiate(gen, offerSdp) {
    if (this._aborted || this._renegotiating) return;
    this._renegotiating = true;
    this._gen = gen;
    try {
      this.onStatus('connecting'); // host is renegotiating (reconnect)
      this.connected = false;
      this._setupPeer();
      await this.pc.setRemoteDescription(JSON.parse(offerSdp));
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      await waitIce(this.pc);
      if (this._aborted) return;
      // transactional, same as the initial answer
      await runTransaction(db(), async (tx) => {
        const ref = doc(db(), COLLECTION, this.docId);
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error('Session not found');
        const room = snap.data();
        if (room.claim && room.claim.uid !== this.uid) {
          throw new Error('Another controller claimed this session');
        }
        if ((room.gen || 1) !== gen) throw new Error('Offer changed again');
        tx.update(ref, {
          answer: JSON.stringify(this.pc.localDescription),
          answerGen: gen,
          answerBy: this.sid,
          status: 'paired',
          updatedAt: serverTimestamp(),
        });
      });
      // reconnect is bounded too: if the refreshed negotiation never opens
      // the channel, fail with an actionable status instead of hanging
      await this._awaitConnected(CLIENT_CONNECT_TIMEOUT_MS);
    } catch (e) {
      if (!this._aborted) this.onStatus('error', 'reconnect failed: ' + (e.message || e));
    } finally {
      this._renegotiating = false;
    }
  }

  _awaitConnected(timeoutMs) {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._connWait = null;
        this.close(); // tear down so a retry starts clean
        reject(new Error('Connection timed out — tap CONNECT to try again'));
      }, timeoutMs);
      this._connWait = {
        done: () => { clearTimeout(timer); this._connWait = null; resolve(); },
        fail: () => {
          clearTimeout(timer); this._connWait = null;
          this.close(); // tear down so a retry starts clean
          reject(new Error('Could not reach the game — tap CONNECT to try again'));
        },
        cancel: () => { clearTimeout(timer); reject(new Error('Connection cancelled')); },
      };
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
    this._aborted = true;
    if (this._unsub) { this._unsub(); this._unsub = null; }
    if (this._boundTimer) { clearTimeout(this._boundTimer); this._boundTimer = null; }
    if (this._connWait) { const w = this._connWait; this._connWait = null; w.cancel(); }
    if (this.pc) { try { this.pc.close(); } catch {} this.pc = null; }
    this.connected = false;
  }
}

