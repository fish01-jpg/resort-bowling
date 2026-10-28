// Offline lifecycle tests for the phone connection logic (NO live testing —
// everything runs against in-memory mocks: fake Firestore store + fake
// RTCPeerConnection/data channels).
//
// Covers the regressions this PR fixes:
//   T1  generation refresh DURING initial connection reconnects cleanly and
//       the connection survives past the ORIGINAL watchdog deadline (the
//       renegotiation renews the shared waiter instead of stacking a second
//       one that would kill the healthy replacement)
//   T2  the shared connect waiter: a renewal clears the old deadline
//   T3  stale channel-close events (from a REPLACED peer) are ignored
//   T4  renegotiation timeout reports an actionable error (not silence)
//   T5  renegotiation errors report the underlying transaction failure
//   T6  stale-claim takeover only happens for sessions that are NOT live

import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as fsx from './mocks/firebase-firestore.mjs';

// ---------------------------------------------------------------------------
// Load src/rtc.js with the firebase https imports rewritten to local mocks
// ---------------------------------------------------------------------------
const here = new URL('.', import.meta.url);
let src = await readFile(new URL('../src/rtc.js', here), 'utf8');
src = src
  .replace(
    'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js',
    new URL('./mocks/firebase-app.mjs', here).href,
  )
  .replace(
    'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js',
    new URL('./mocks/firebase-firestore.mjs', here).href,
  );
await mkdir(new URL('./.tmp', here), { recursive: true });
await writeFile(new URL('./.tmp/rtc.mjs', here), src);
const rtc = await import(new URL('./.tmp/rtc.mjs', here).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COLLECTION = 'bowlingControllers';

// ---------------------------------------------------------------------------
// Fake WebRTC
// ---------------------------------------------------------------------------
class FakeChannel {
  constructor(label) {
    this.label = label;
    this.readyState = 'connecting';
    this._l = {};
    this._sent = [];
  }
  addEventListener(t, fn) { (this._l[t] ??= []).push(fn); }
  removeEventListener(t, fn) { this._l[t] = (this._l[t] || []).filter((f) => f !== fn); }
  emit(t, ev = {}) { for (const fn of [...(this._l[t] || [])]) fn(ev); }
  send(data) { this._sent.push(data); }
  close() { this.readyState = 'closed'; this.emit('close'); }
  open() { this.readyState = 'open'; this.emit('open'); }
}

class FakeRTC {
  constructor() {
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.iceGatheringState = 'complete'; // waitIce resolves immediately
    this.remoteDescription = null;
    this.localDescription = null;
    this._l = {};
    this.channels = [];
    this.closed = false;
  }
  addEventListener(t, fn) { (this._l[t] ??= []).push(fn); }
  removeEventListener(t, fn) { this._l[t] = (this._l[t] || []).filter((f) => f !== fn); }
  emit(t, ev = {}) { for (const fn of [...(this._l[t] || [])]) fn(ev); }
  createDataChannel(label) { const ch = new FakeChannel(label); this.channels.push(ch); return ch; }
  async createOffer() { return { type: 'offer', sdp: `OFFER-${Math.random()}` }; }
  async createAnswer() { return { type: 'answer', sdp: `ANSWER-${Math.random()}` }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { this.remoteDescription = d; }
  close() { this.closed = true; this.connectionState = 'closed'; }
}

globalThis.RTCPeerConnection = FakeRTC;
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.get(k) ?? null; },
  setItem(k, v) { this._m.set(k, v); },
  removeItem(k) { this._m.delete(k); },
};

/** Deliver the host's channels to the client as datachannel events. */
function wireChannels(hostPc, clientPc) {
  for (const hch of hostPc.channels) {
    const cch = new FakeChannel(hch.label);
    hch._client = cch;
    cch._host = hch;
    clientPc.emit('datachannel', { channel: cch });
  }
}

/** Open every wired channel pair (host side + client side). */
function openAll(hostPc) {
  for (const hch of hostPc.channels) {
    hch.open();
    if (hch._client) hch._client.open();
  }
}

// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); }
}

function statusLog() {
  const log = [];
  return {
    log,
    push(kind, detail) { log.push({ kind, detail }); },
    has(kind, detailRe) {
      return log.some((e) => e.kind === kind && (!detailRe || detailRe.test(e.detail || '')));
    },
  };
}

// ===========================================================================
console.log('T1: generation refresh during initial connection reconnects cleanly');
fsx._reset();
rtc._testHooks.setClientConnectTimeout(400);
{
  const hs = statusLog();
  const host = new rtc.PhoneHost({
    onStatus: (slot, kind, detail) => hs.push(kind, detail),
    onState: () => {},
    onThrow: () => {},
    onUiClick: () => {},
    onLatency: () => {},
  });
  await host.startPairing('https://game.example', 'p1');
  const session = host.sessions.find((s) => s.slot === 'p1');
  const token = session.docId;

  const cs = statusLog();
  const client = new rtc.PhoneClient({
    onStatus: (kind, detail) => cs.push(kind, detail),
    onOpen: () => {},
    onCtl: () => {},
  });
  const t0 = Date.now();
  const conn = client.connectByToken(token);
  conn.catch(() => {}); // assertion below inspects the outcome explicitly

  // let the initial negotiation complete (host applies the gen-1 answer)
  await sleep(60);
  assert(session.pc.remoteDescription, 'host should have applied the gen-1 answer');
  check('host applied initial answer', !!session.pc.remoteDescription);

  // REFRESH the host's offer LATE in the watchdog window (at ~75% of the
  // original deadline): the renegotiation renews the shared connect waiter,
  // so the connection must survive PAST the ORIGINAL deadline
  while (Date.now() - t0 < 300) await sleep(10);
  await host._refreshOffer(session);
  const gen2Host = session.pc;
  for (let i = 0; i < 50 && !gen2Host.remoteDescription; i++) await sleep(10);
  check('host applied renegotiated answer (gen 2)', !!gen2Host.remoteDescription);
  assert(gen2Host.remoteDescription, 'client renegotiated to gen 2');

  // wait until PAST the original watchdog deadline (400ms from connect
  // start) — with a broken waiter the old timer would have torn this down
  while (Date.now() - t0 < 500) await sleep(10);

  // now open the (renegotiated) channels — this must still connect
  wireChannels(session.pc, client.pc);
  openAll(session.pc);
  await sleep(50);

  const outcome = await Promise.race([conn.then(() => 'resolved'), sleep(300).then(() => 'pending')]);
  check('connect attempt survived past the ORIGINAL deadline', outcome === 'resolved', outcome);
  check('client marked connected', client.connected === true);
  check('client status shows connected', cs.has('connected'));
  check('host session marked connected', session.connected === true);
  const room = fsx._store.get(`${COLLECTION}/${token}`);
  check('host wrote status connected to the doc', room?.status === 'connected');

  // ---------------------------------------------------------------
  console.log('T3: stale channel-close events (replaced peer) are ignored');
  const before = cs.log.length;
  const oldPc = client.pc;
  client._setupPeer(); // replacement peer (what a renegotiation does)
  const oldCh = client.ctlCh; // channel that belonged to the OLD peer
  oldCh.close(); // late close event from the replaced channel
  check('client ignored the stale close', !cs.has('disconnected') && cs.log.length === before);
  check('client still connected after stale close', client.connected === true);

  // host side: replace the session's peer, then close the OLD ctl channel
  const hBefore = hs.log.length;
  const hOldPc = session.pc;
  session.pc = new FakeRTC(); // simulate a refreshed peer
  hOldPc.channels.find((c) => c.label === 'ctl')?.close();
  check('host ignored the stale close', hs.log.length === hBefore && !hs.has('disconnected'));
  session.pc = hOldPc; // restore

  client.close();
  await host.closeSlot('p1');
}

// ===========================================================================
console.log('T2: shared connect waiter — renewal clears the old deadline');
{
  const cs = statusLog();
  const c = new rtc.PhoneClient({
    onStatus: (k, d) => cs.push(k, d),
    onOpen: () => {},
    onCtl: () => {},
  });
  const p = c._awaitConnected(120);
  let rejected = false;
  p.catch(() => { rejected = true; });
  await sleep(50);
  const renewed = c._awaitConnected(2000); // must return the SAME promise
  check('renewal returns the shared promise', renewed === p);
  await sleep(200); // past the ORIGINAL 120ms deadline
  check('old deadline was cleared (no rejection)', !rejected);
  c._connWait.done();
  await p;
  check('waiter resolves on done', true);
  c.close();
}

// ===========================================================================
console.log('T4: renegotiation timeout reports an actionable error');
fsx._reset();
rtc._testHooks.setClientConnectTimeout(150);
{
  const cs = statusLog();
  const c = new rtc.PhoneClient({
    onStatus: (k, d) => cs.push(k, d),
    onOpen: () => {},
    onCtl: () => {},
  });
  await fsx.setDoc(fsx.doc(fsx.getFirestore(), COLLECTION, 't4'), {
    offer: JSON.stringify({ type: 'offer', sdp: 'X' }),
    gen: 4,
    claim: { uid: c.uid, claimedAt: Date.now() },
    expiresAt: Date.now() + 3600000,
    status: 'paired',
  });
  c.docId = 't4';
  c._gen = 4;
  await c._renegotiate(4, JSON.stringify({ type: 'offer', sdp: 'Y' }));
  await sleep(350); // deadline is 150ms — give it room to fire + report
  check('timeout reported as reconnect timed out',
        cs.has('error', /reconnect timed out/), JSON.stringify(cs.log));
  check('attempt was torn down (aborted)', c._aborted === true);
}

// ===========================================================================
console.log('T5: renegotiation errors report the transaction failure');
fsx._reset();
{
  const cs = statusLog();
  const c = new rtc.PhoneClient({
    onStatus: (k, d) => cs.push(k, d),
    onOpen: () => {},
    onCtl: () => {},
  });
  await fsx.setDoc(fsx.doc(fsx.getFirestore(), COLLECTION, 't5'), {
    offer: JSON.stringify({ type: 'offer', sdp: 'X' }),
    gen: 4, // host moved on — the client is negotiating generation 5
    claim: { uid: c.uid, claimedAt: Date.now() },
    expiresAt: Date.now() + 3600000,
    status: 'paired',
  });
  c.docId = 't5';
  c._gen = 5;
  await c._renegotiate(5, JSON.stringify({ type: 'offer', sdp: 'Y' }));
  check('gen mismatch reported', cs.has('error', /Offer changed again/), JSON.stringify(cs.log));

  // claim lost to another controller
  const cs2 = statusLog();
  const c2 = new rtc.PhoneClient({
    onStatus: (k, d) => cs2.push(k, d),
    onOpen: () => {},
    onCtl: () => {},
  });
  await fsx.setDoc(fsx.doc(fsx.getFirestore(), COLLECTION, 't5b'), {
    offer: JSON.stringify({ type: 'offer', sdp: 'X' }),
    gen: 6,
    claim: { uid: 'someone-else', claimedAt: Date.now() },
    expiresAt: Date.now() + 3600000,
    status: 'paired',
  });
  c2.docId = 't5b';
  c2._gen = 6;
  await c2._renegotiate(6, JSON.stringify({ type: 'offer', sdp: 'Y' }));
  check('claim loss reported', cs2.has('error', /Another controller claimed/), JSON.stringify(cs2.log));
}

// ===========================================================================
console.log('T6: stale-claim takeover only for sessions that are NOT live');
fsx._reset();
{
  const mkClient = () => {
    const cs = statusLog();
    const c = new rtc.PhoneClient({
      onStatus: (k, d) => cs.push(k, d),
      onOpen: () => {},
      onCtl: () => {},
    });
    return { c, cs };
  };

  // stale claim (2 min old) + session NOT live → takeover allowed
  const a = mkClient();
  await fsx.setDoc(fsx.doc(fsx.getFirestore(), COLLECTION, 't6a'), {
    offer: JSON.stringify({ type: 'offer', sdp: 'X' }),
    gen: 1,
    claim: { uid: 'crashed-phone', claimedAt: Date.now() - 120000 },
    expiresAt: Date.now() + 3600000,
    status: 'waiting',
  });
  let msgA = '';
  await a.c.connectByToken('t6a').catch((e) => { msgA = e.message; });
  check('stale claim on a dead session is taken over',
        !/Another controller/.test(msgA), msgA);

  // stale claim but the session IS live → never taken over
  const b = mkClient();
  await fsx.setDoc(fsx.doc(fsx.getFirestore(), COLLECTION, 't6b'), {
    offer: JSON.stringify({ type: 'offer', sdp: 'X' }),
    gen: 1,
    claim: { uid: 'live-phone', claimedAt: Date.now() - 120000 },
    expiresAt: Date.now() + 3600000,
    status: 'connected', // the host marked the doc while its channel is open
  });
  let msgB = '';
  await b.c.connectByToken('t6b').catch((e) => { msgB = e.message; });
  check('live session is never taken over',
        /Another controller already claimed/.test(msgB), msgB);
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
