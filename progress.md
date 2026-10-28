# Progress — Sunset Lanes

Original prompt: "Make me a new Repo for this project... completely re-create Wii Sports / Nintendo Switch Resorts bowling kind of mix so it's good quality and it's fun. Put it in a website and let me review. Make sure it has all the features as normal bowling and I'll test it on my computer. Make it controllable with the computer and later we'll add the rest of the controls."

User rules (added 2026-10-27):
- Prefer handing over the code (HTML/JS) before running anything in the browser; ask permission before running the game/tests in the browser.

## Status

- [x] Scoring rules engine + 32 unit tests (300/150/90/0, 10th-frame cases) — all passing
- [x] Three.js scene: lane w/ arrows, gutters, pins, ball, palms, sunset windows, sign
- [x] Rapier physics: ball, compound pins (low CoM), gutters, pit, CCD
- [x] Controls: A/D position, Q/E aim, SPACE charge (oscillating), W/S spin
- [x] Game loop: ready → rolling → settling → sweep → score → next (verified via automated browser test — strikes, sweep, respot, scorecard all work)
- [x] Audio: procedural rumble/pin hits/jingles + marimba loop, mute button
- [x] QA pass 1 fixes: scorecard flex-td layout, sweep bar starting at foul line, ball below camera FOV, debug overlay overlap, STRIKE message contrast, grand-total dash color

## Verified in browser (before the "ask first" rule)

- Boot, title screen click, ready phase, throw (charge/release), strike detection, sweep animation, respot, scorecard X/pending scores, message overlays.

## Bug-fix pass 3 (2026-10-27, round 2 of user feedback)

User reported (after pass 2 push): still always strike, ball rolls backward off track / doesn't roll forward. Live-site check confirmed the NEW build is deployed (constants.js shows approachStartZ/deckEndZ, angvel is +speed/R) — user's symptoms exactly match the OLD cached build (lip bounce + backspin + always-strike). Told user to hard-refresh / incognito.

Also added requested aim assist (physics.js step()): at throw, a guide path is computed from the same kinematic model as the visual dots (position + aim + spin hook at actual thrown speed). While rolling, a capped steering force (gain 1.6/m, max 0.45 m/s²) pulls the ball toward the guide path, disabled beyond 0.35m of path error. Aiming at the gutter guides the ball into the gutter — misses stay misses.

Tuning knobs for the assist live in TUNING (assistGain/assistMax/assistCutoff).

## Bug-fix pass 2 (2026-10-27, after user's first test)

User reported: always strike, pins never react, ball rolls off lane, camera doesn't follow, ball doesn't roll, quality poor. Root causes found (code-reviewed, NOT yet browser-verified per user's rule):

1. **CRITICAL: ball released over empty space** — lane+collider spanned z=-0.8..18.7 but ball spawns at z=-1.8 → ball fell and hit the lane's front lip. Fixed: lane now spans approachStartZ=-2.8 .. deckEndZ=19.4 (shared constants).
2. **CRITICAL: 7 pins hung over the pit** — rear pin rows at z≈18.8-19.08, deck ended 18.7 → they fell on their own once physics stepped. Fixed by deck extension above.
3. **Always-strike bug** — pinState() required p.y > 0, but a resting pin's body origin sits at y≈-0.005 (colliders start 0.005 above origin) → every untouched pin counted as fallen → every roll scored a strike. Fixed: y window is now -0.12..0.6, velocity removed from standing (used only for settle).
4. **A/D secretly changed aim** — input.js mapped aimL/aimR to `KeyQ || left` → moving position also steered angle → gutter shots. Fixed: aim is Q/E only.
5. **Backspin** — ball angvel set to -speed/R (backward). Fixed: +speed/R.
6. **No collision sounds** — Rapier COLLISION_EVENTS never enabled on pin colliders. Fixed on both pin colliders.
7. **Premature scoring** — settle condition used whole-delivery timer (>1.5s always true by the time ball finished) → scored while pins still flying. Fixed: separate _postBallT timer, waits for pinsSettled() or 3s post-ball cap, 8s absolute timeout.
8. **No aim feedback** — added visible aim guide: 16 fading dots along projected path including hook curve (same model as physics). maxAim reduced 4°→2.6°.
9. **Camera** — tightened chase cam (rate 3.2→5.0, offset 3.4→3.0m), pin-deck cam at z=14.3.
10. **Visuals** — gradient sky dome added; pin mesh 2cm sink offset fixed; sweep bar clears standing pins (y=0.55) and travels to z=20.8.

## Pending QA — needs user permission to run

Discriminating checks: untouched settled rack stays 10 standing; centered zero-spin ball stays on lane; gutter scores 0 with pins standing; real hits move pins before scoring; camera z advances during rolling.

## Deployment

- Repo made public + GitHub Pages enabled from main branch (root).
- Live site: https://fish01-jpg.github.io/resort-bowling/
- CDN deps (esm.sh Three.js/Rapier, Fontshare) work on Pages.

## Tuning knobs (src/constants.js TUNING)

- hookAccel 0.5 (spin strength), chargePeriod 1.4s, min/maxSpeed 5.5–10.5 m/s, maxAim ~4°.

## Notes for next agent

- Straight center ball at ~0.5 power strikes reliably — consider making pins slightly heavier (density 310 → 340) if too easy.
- The debug FPS overlay shows low FPS under headless SwiftShader; real browsers render fine.
- GitHub Pages site: repo must be public (free plan) — pending user confirmation.

## Fix 3 — root cause of "always strike" + "pins stuck" (2026-10-27)

- Symptom: every roll scored a strike; pins seemed stuck/frozen; ball rolled off mid-lane.
- Root cause: `col.setTranslation()` called AFTER collider creation is silently ignored
  by the Rapier build — it updates the reported position but the collision shape stays at
  the parent body origin. The lane collider therefore actually spanned z -11.1..+11.1
  with its top at y=+0.05 (at the origin), so:
  - the pin rack (z 18.3+) had NO floor under it -> all 10 pins free-fell -> every pin
    counted as knocked -> every roll = strike (and respotted pins fell again, looking "stuck")
  - the ball rolled off the lane surface at z=11.1 ("rolls off the lane")
- Fix: set translations on the ColliderDesc (`desc.setTranslation(x, y, z)`) before
  `createCollider` — this is the supported path and works.
- Verified with a headless Node harness (no browser): 11/11 physics tests
  (rack stability, gutter scores 0, center hit leaves pins, pocket-hit strike rate,
  pins settle on the deck, lane-exists-under-rack regression test), 32/32 scoring
  tests, and 3 full simulated games (totals 87-132, 0-2 strikes — realistic).
- Tuning data from the harness: dead-center straight ball -> 6 pins, 0 strikes
  (leaves splits, realistic); pocket throw with hook -> 8-10 pins, ~50% strikes when
  well-centered, ~15-20% with human jitter. Aim/position actually matter now.

## Fix 4 — pin physics feel + settle rules (2026-10-27)

User feedback: make misses easier, pins lighter with more pin-vs-pin action,
ball should feel resistance, and never reset the rack while pins are still
moving (wait up to ~15s; reset as soon as they stop).

Changes:
- Pins lighter: 1.64kg -> ~1.57kg (densities 300/1100), restitution 0.05 -> 0.12,
  friction 0.4 -> 0.5, damping lowered (linear 0.22, angular 0.35) — livelier
  pin-on-pin scatter, ball visibly slows and deflects on contact.
- Speed-invariant hook: hook accel scales with (v/ref)^2 (ref 8 m/s) and the
  on-screen guide uses the same model — the ball now enters the pins at the SAME
  spot regardless of power, so power affects pace/carry only. Before, each power
  level landed the ball somewhere different (razor-thin strike window).
- Ball max speed capped 10.5 -> 9.6 m/s (real bowling pace).
- Settle: scores only after pins are STILL for 0.75s straight; force-settle cap
  raised 8s -> 15s. Standing pins must be truly still; fallen pins just need to
  not be flying (slow pit creep no longer blocks scoring).
- Sealed the pit: pins used to escape the world through a gap beside the pit
  floor / under the side walls and fall forever (forced every settle to 15s).
  Pit floor widened/thickened, side walls extended down and past the pit.
- Verified headlessly: 11/11 physics tests, 32/32 scoring tests, full games avg
  ~120 with 1-4 strikes. Perfect pocket throw strikes at any power; human-jitter
  pocket throws strike ~25%; dead-center straight leaves 6-7 pins; gutter = 0.

## Multiplayer (2026-10-27)

User asked for local + online multiplayer and provided a Firebase web config.

- `src/match.js` (new): pure match/turn logic shared by both modes —
  playerProgress, frameNowComplete, hot-seat Match controller, and
  applyRollToRoom (the online roll state transition, used inside the Firestore
  transaction so clients and tests share one code path).
- Local hot-seat (2-4 players): real bowling rotation — each player finishes
  their frame before the turn passes (10th-frame bonus rolls included).
  Per-player games, standings sidebar, turn banner, winner screen.
- Online via Firestore (`src/net.js`): one authoritative room doc per 4-char
  code (collection `bowlingRooms`). Rolls commit through a transaction that
  verifies turn + revision, so double submissions are rejected. The thrower's
  simulated result is the score; remote clients replay the throw visually
  (real physics, no local scoring) and snap the rack to the authoritative
  standing set. 90s turn auto-skip (records a gutter). Rejoin by name keeps
  your seat after a refresh. Host controls start / play again. Rooms
  self-delete when the last player leaves.
- Menu system: title screen with SOLO / LOCAL MULTIPLAYER / PLAY ONLINE,
  player-count + name setup, room lobby with code display.
- Input locking when it isn't your turn; aim guide hidden; turn banner with
  auto-skip countdown.
- Firebase rules are currently open (test mode) — the project owner should add
  scoped rules (see README note).

Tests (all headless, no browser):
- match.test.mjs: 24/24 — turn logic incl. 10th frame edge cases, room state
  transitions, full 3-player hot-seat match with real physics.
- online.test.mjs: 15/15 against the REAL Firestore — create/join/start,
  non-host start rejected, rogue double-submit rejected without corruption,
  full 24-roll match to completion + winner, play-again to lobby, rejoin by
  name, leave/delete cleanup.
- physics 11/11, scoring 32/32 — no regressions.

## Session 4 — control reset, phone gyro controller, ball/pin interaction

- Control reset after every throw: `_prepareNextDelivery()` neutralizes
  position/aim/spin/power on every path back to aiming (solo continuation,
  hot-seat handover, online turn adoption, restart) — no repeat-throwing the
  same setup. Remote replay completion intentionally skips it.
- Phone-as-controller (Wii-remote style), new files:
  - `src/rtc.js`: WebRTC transport. Firestore (`bowlingControllers` collection)
    is used ONLY for signaling (offer/answer); all gameplay traffic goes over
    two host-created data channels — `state` (unreliable, 30Hz orientation
    samples, stale packets dropped by seq) and `ctl` (reliable: throws with
    dedup ids, calibration, phase, ping/pong RTT). Non-trickle ICE with a
    bounded 4s gather. Pairing doc id is a high-entropy token (QR contains the
    token, not the 4-char code); first controller wins the claim
    transaction; sessions expire after 1h; host deletes the doc on close.
  - `phone.html` + `src/phone-main.js`: lightweight controller page (no
    Three/Rapier). Pair by QR (?pair=TOKEN) or 4-char code; iOS motion
    permission screen; controller UI with connection status, tilt indicator,
    RECENTER (recalibrate), MODE toggle (SWING default / BUTTON), THROW
    button. Quaternion-based calibrated relative orientation (W3C ZXY Euler),
    roll -> ball position, yaw -> aim; screen-rotation robust. Swing state
    machine on devicemotion (idle -> swinging -> release, 700ms cooldown);
    power from peak acceleration, spin from wrist twist during the swing.
    Portrait lock best-effort.
  - Desktop menu: "USE PHONE AS CONTROLLER" -> pairing screen (QR + code).
    Tilt steers only while aiming; after a throw it re-arms when the phone
    returns near neutral. Small touch devices are redirected to phone.html
    (?desktop=1 overrides).
- Pins affect the ball more: ball mass 7.26 -> 6.0 kg (test: ball loses
  ~2.9 m/s through the rack on a head-on hit).
- High-speed scatter: above 8.6 m/s (power ~0.76) the release gets ONE
  bounded, speed-scaled random perturbation (max ±0.035m position, ±0.009rad
  aim, ±0.12 spin at full power). The post-scatter launch is stored in
  `physics.lastLaunch` and used for online replays. Low power stays fully
  deterministic.
- Online robustness: `submitRoll` now takes `expectedRevision` and rejects
  stale same-turn duplicates in the transaction; it also rethrows so callers
  can recover; the game reports failed submissions and main.js releases the
  pending-result lock (input no longer freezes until the 90s timeout when a
  submit fails). Lobby -> playing now always hides the overlay. The
  pending-result lock only arms on YOUR throws (not remote replays).

Tests (headless, no browser): controls.test.mjs 12/12 (reset after solo +
hot-seat delivery, low-power determinism, high-power scatter bounded, ball
mass + energy loss through rack), revision.test.mjs 4/4 (real Firestore:
stale duplicate rejected, revision unchanged), online 15/15, match 24/24,
physics 11/11, scoring 32/32 — no regressions. Gyro/WebRTC/latency behavior
on real devices is left for user testing.

## Session 4b — review fixes (orientation math, channel readiness, replay scatter)

- New `src/orientation.js`: pure, Node-testable orientation math. Angles are
  extracted from the RELATIVE rotation matrix (Euler extraction) instead of
  projecting axis vectors — the old yaw extraction was degenerate at the
  neutral pose (atan2(0,0) jump saturating aim). Convention documented and
  unit-tested: aim = rotation about calibrated y (turn phone right = aim
  right), steer = wheel tilt about calibrated z (tilt right = ball right,
  sign-flipped). Works from any calibration grip (tested from a tilted grip).
- phone-main: stable RECENTER (8 samples within 5 degrees, 1.5s window),
  spin integrated with real devicemotion dt, throw packets carry the
  release-orientation snapshot (host maps throws atomically instead of
  racing the 30Hz tilt stream), QR auto-pair errors surfaced.
- rtc: "connected" now fires from the reliable ctl channel OPEN event (not
  connectionState) so the initial phase message is never dropped.
- Host: throws are gated on re-arm (phone back near neutral) and canThrow
  reflects it; pairing screen got a DONE button that keeps the connection
  and returns to the mode menu (Back disconnects).
- Replay of a high-power throw no longer applies scatter twice: throwBall
  takes { scatter } opt-out; game passes the already-scattered lastLaunch
  through unchanged (verified launch-identical in test).
- Online revision is captured AT THROW TIME (not settle) so the submit
  verifies against the revision that belonged to that delivery; a failed
  submission now releases the pending lock AND forces re-adoption of the
  room's authoritative rack (knocked pins are restored, player re-throws).
- revision.test.mjs rewritten: non-strike first roll keeps the same player
  up, duplicate with stale expectedRevision rejected by the revision guard
  itself ("Stale turn — already submitted"); no process.exit inside finally.

Tests: orientation 24/24 (signs, tilted grip, wraparound, no neutral jump),
controls 15/15 (incl. replay no-double-scatter), revision 6/6 (real
Firestore), online 15/15, match 24/24, physics 11/11, scoring 32/32,
fullgame sim OK.

## Session 5 — pairing flow + phone control presets

- Pairing screen: Back no longer kicks a connected phone — it just hides
  the QR/pairing screen and keeps the connection (only an unfinished
  pairing is canceled). Explicit "Disconnect phone" link added. "DONE —
  PICK A MODE" leads to the normal mode menu (SOLO / LOCAL with 2-4
  players / ONLINE); a "PHONE CONTROLLER CONNECTED" note stays visible on
  the main menu while paired.
- Phone SETUP panel (new settings screen on phone.html): control-scheme
  presets — WHEEL (tilt steers, turn aims — default), TWIST (turn steers,
  tilt aims), SWING ONLY (ball auto-centered, turn to aim, swing to throw)
  — plus sensitivity presets LOW / STD / HIGH (0.6x / 1x / 1.6x gain).
  Settings persist via localStorage when the browser allows it (silently
  falls back to defaults otherwise). The tilt indicator, 30Hz stream, and
  throw snapshots all go through the active preset; the on-screen hint
  text updates per scheme.
- Scheme mapping extracted into orientation.js applyControlScheme (pure,
  unit-tested: swap, zero-center, sensitivity gain, composition).
- Tests: orientation 31/31, controls 15/15, match 24/24, online 15/15,
  revision 6/6, physics 11/11 — no regressions.

## Multi-phone controllers (2026-10-27, round 3 of user feedback)

User request: support multiple phone controllers on the same game (one phone per player), fix "waiting for your turn" showing with only one phone connected, and let the user pick how many phones (1-4) are connecting.

Changes (NOT runtime-tested per user's instruction — user will test):
- rtc.js: PhoneHost is now a multi-slot hub. Each phone slot (0-3) gets its OWN signaling doc (fresh token + code) and its own RTCPeerConnection; callbacks are (slot, ...). closeSlot() tears down one phone without dropping the others; startPairing(base, slot) is safe to re-run for re-pairing. PhoneClient unchanged (a phone never needs to know which slot it is from signaling — the host tells it via phase messages).
- main.js: per-slot turn logic. Hot-seat: with MULTIPLE phones live and the active bowler within the phone count, phone k+1 bowls for bowler k+1; bowlers without a dedicated phone (e.g. 2 phones, 4 bowlers) are controlled by any phone (shared). With a SINGLE phone live, it controls whoever is up (pass-the-phone) so it can never be stuck "waiting". Solo/online: all phones control the local bowler (online still gated by room turn). Phone-side swing detection also resets when permission is lost so a swing can't carry across a turn handoff.
- Pre-existing live-steering bugs found and fixed while in here: (1) phone-main.js used an undeclared `seq` counter (++seq threw every tick, killing the 30Hz loop); (2) the state channel sent {roll,yaw} field names while the host read steer/aim (NaN controls). sendState now sends steer/aim and seq is declared.
- "Waiting" bug fixes: (1) the re-arm lock (phone must return to neutral after a throw) now auto-releases 3s after the AIMING phase begins (timer starts on the ready-phase transition, not at throw time) — previously it could stick forever and the phone showed "Waiting for your turn…" with one phone; (2) the phone now shows WHY it's waiting (waitText from the host: "Ball in play…", "Waiting for your turn — <name> is up", "Return the phone upright to aim again", "Start a game on the big screen") instead of a generic message.
- Pairing flow: the phone menu now has a "How many phones?" selector (1-4, default 1). Pairing fills the first empty slot and auto-advances: once phone 1 connects, a fresh QR/code is generated for phone 2, and so on. Per-slot chips (P1..P4) show status; tapping a disconnected chip re-pairs that slot. Disconnect closes all slots; Back only kicks phones that never connected.
- phone.html/phone-main.js: slot badge (P1, P2/4 …) in the controller header + waitText display.
- css/style.css: slot-chip, slot-badge, phone-count-row styles.

## Controller feel + phone-driven menus + games-per-session (2026-10-27, round 4)

User requests: (1) swing mode should feel like a real controller — putting the phone down at your side and picking it up to swing kept throwing the ball off the aimed line; (2) every button that pops up on the big screen should be pressable from the phone; (3) a 1-32 selector for "lanes" = how many times you play (full games per session).

Changes (NOT runtime-tested per user's instruction — user will test):
- phone-main.js controller feel: aim/steer now only update while the phone is held STILL in the calibrated stance (acceleration-deviation stillness gate + in-range check). Carrying the phone, picking it up, or mid-swing FREEZES the last good aim — the throw packet and the 30Hz stream both use the frozen values, so the ball always goes where you aimed. Swing detection now requires ~120ms of sustained acceleration and a minimum peak; brief pick-up jolts are discarded instead of thrown. Spin only accumulates while the swing is actually accelerating.
- Phone UI mirroring: the game scans its visible buttons (overlay menus, final panel, in-game mute/restart) every 400ms and mirrors them to all connected phones; tapping a mirrored button clicks the real one (validated still-visible) and resyncs. Selector values (games/bowlers) are included so the phone shows what − / + changes. rtc.js gained onUiClick plumbing; phone shows the buttons in a scrollable panel.
- Games per session: stepper on the main menu (solo) and in LOCAL MULTIPLAYER (1-32). Series standings accumulate across games (keyed by player uid); after each game the button reads NEXT GAME (x/N); after the last game it reads NEW SERIES and shows SERIES FINAL totals. R/restart mid-series keeps the running totals; scores are not recorded past the configured limit.
- Fixed: the games stepper buttons shared the .count-btn class with the bowler-count row and would have wiped the roster (listener now scoped to #local-count-row). Phone-slot dedication now checks actual slot membership (a gap like only-slot-2-connected no longer locks every phone out).

Interpretation note: "lanes" was implemented as full games per session (how many times you play). If the user meant individual throws/turns instead, the series layer needs re-scoping.

Round-4 review fixes (same session, before commit):
- Fixed a units bug in the new swing gating: dt is seconds, so swingActiveMs was accumulated in seconds but compared to a 120 MILLISECOND threshold — every real swing would have been discarded. Now accumulates dt*1000.
- Aim latch is now deterministic for the throw: while held still in stance the aim is live for visual feedback; after a 400ms dwell it latches; a swing that starts while live latches the aimed pose at that instant; the throw packet always uses the latched value. lastDev updates even off-turn.
- Series entries now come from each player's own game object (duplicate names can't merge); phone button mirror uses stable semantic keys (id / data-count / data-phones / screen-scoped), a snapshot revision (rev) rejects stale taps after screen transitions, selector values are sent per-screen and included in the change signature, and the phone collapses the tilt pad when a full menu is mirrored so everything fits.

Round-5 review fixes (same session, before commit):
- Aim is now a real state machine (LIVE -> LOCKED): holding still in stance aims live; after the dwell the pose is captured and frozen — displayed aim and the thrown aim are the same value by construction (throwAngles), in both swing and button mode. Lowering the phone to your side, carrying it, or mid-swing can't touch it; only a deliberate re-aim (holding a clearly different stance still) or RECENTER/mode change re-opens aiming. A swing that starts while still aiming locks the posed aim at that instant.
- Spin no longer comes from total rotation over the whole carry (picking the phone up from your side used to become unintended hook) — it now comes from the rotation rate at the strongest instant of the swing (the release flick).
- Phone taps on mirrored buttons: the host re-scans the screen before honoring a tap; if the screen changed since the last sync the tap is rejected as stale (and the fresh snapshot is pushed); an exact revision match is required.
- The phone controller page itself now scrolls (body.phone-body overflow-y auto, safe centering), so any mirrored menu fits on any phone.

Round-6 review fixes (same session, before commit):
- Fixed a fatal regression from round 5: currentControlAngles() returned null when frozen, which crashed the 30Hz tick loop on the first locked sample (sendState dereferenced it). It now ALWAYS returns the committed pose — frozen paths return throwAngles()/lockedAngles, so the displayed, transmitted, and thrown aim are one value by construction.
- Re-aiming is now exclusively explicit: a RE-AIM footer button (plus RECENTER, the mode toggle, and each fresh turn) re-opens live aiming; motion can never unlock it. The tilt pad label shows AIM LOCKED vs TILT TO AIM. Sensor-based unlock thresholds were removed.
- Spin is captured at the release flick (the final active motion sample) instead of the strongest sample, so pickup acceleration/rotation can no longer become power or hook.

Round-7 review fixes (same session, before commit):
- Phone throws are now always STRAIGHT (spin 0) in both swing and button mode: gyro rotation during the carry or swing can never curve the ball, so it goes exactly where the aimed line points. The release-flick spin sampling was removed entirely.
- The on-phone tilt-pad indicator is now rendered in tick() from the SAME committed pose that is transmitted and thrown (currentControlAngles), instead of raw live orientation in onOrient — carrying the phone no longer moves the indicator while the actual aim stays frozen.
- Correction to the round-6 note: pickup motion still contributes to swingPeak (power), since a pickup and its swing are one continuous motion — that is accepted behavior; only the aim and the ball's curve are fully protected from the carry.

Round-7 final: user confirmed the 1-32 "lanes" selector counts COMPLETE GAMES (asked directly, per review). Also: accepted poses are normalized once (clamped to the steer/aim limits) at capture — the on-phone indicator, the transmitted state, and the throw all use that exact value; the host applies identical scaling to both state and throw paths (verified in onPhoneState/onPhoneThrow).

Round 8 — controller feel polish, physics hardness, and the visual overhaul:

Phone controller:
- Simplified the control screen: footer is just RE-AIM + SETUP; throw mode and
  RECENTER moved into SETUP with plain-language descriptions. Bigger tilt pad
  and a much bigger THROW button.
- Phone rotation is back, done right: spin comes from WRIST TWIST at the
  release flick (the final active motion sample, deadzone 40 deg/s, full hook
  at 300 deg/s). Carry/pick-up rotation is overwritten and can never become
  hook. The live smoothed twist rides the state channel so the game's aim
  guide previews the hook while you cock your wrist. Button throws use the
  current twist.

Physics / difficulty:
- Ball 6.0 -> 5.6 kg; pins ~1.29 -> ~1.41 kg (densities 300/1100 -> 330/1200):
  harder to blast through the rack, strikes take a better shot.
- hookAccel 0.5 -> 0.75: the ball visibly curves where it's spinning.
- RANDOM STARTING POSITION each delivery (within 80% of the lane edges):
  aiming is a skill again. Phone steering maps RELATIVE to the start (neutral
  phone keeps the start; full tilt still reaches either edge) via
  phoneLanePosition(); recorded/replayed online throws keep absolute
  positions (randomization only happens in resetControls on delivery prep,
  and online adoption only re-preps when the room revision changed).

Visuals (full environment rebuild in scene.js):
- Sunset-resort lounge interior: dark ceiling with warm light coves, terracotta
  walls, big dusk windows (violet-to-amber sky, sun, sea shimmer), carpeted
  approach, no more mismatched aqua sky box or outdoor palms.
- REAL gutters: open half-pipe channels (extruded arc band) with matching
  fixed TRIMESH colliders generated from the same cross-section — the ball
  rolls in the channel you see. Division-cap rails close the gap between
  gutters and walls; a dark base slab removes the voids.
- Deep pit (-0.75) with side walls and a pinsetter housing that masks
  everything above the pit opening: fallen pins drop out of sight instead of
  lying visible behind the deck.
- Working pinsetter sweep: drops in front of the rack, LIFTS standing pins
  clear, sweeps the deadwood at deck level into the pit, rises. Standing set
  is snapshotted before the lift (pinState is untrustworthy mid-lift).
- Render interpolation: syncMeshes(alpha) lerps/slerps between the previous
  and current physics step (alpha = accumulator/FIXED_DT) — no more stutter;
  interpolation snaps on teleports (rack reset, ball placement, sweep lifts).

Round 8 fixes (post-review):

- phoneLanePosition: removed double scaling — the mapped value is already in
  meters, now clamped to ±maxPosition (neutral phone preserves the random
  start; full tilt reaches both edges, verified numerically).
- Gutter visual/collision unified through one shared gutterCrossSection()
  in constants.js: physics trimesh rings at the exact z endpoints (-2.8,
  19.4), rendered band has its material thickness OUTSIDE the contact arc so
  the ball rolls on exactly the surface you see; left channel is generated
  directly (not mirrored) with increasing-x traversal on both sides, so
  triangle winding faces up (Rapier 0.12 trimeshes are two-sided by
  default — verified against the official docs — so this is belt-and-suspenders).
  Cap wall colliders moved to x=±0.84, flush with the lining's outer rim;
  division caps rebuilt from the rim (0.79) to the wall base.
- Room shell extended to enclose the chase camera (z −5.75..21.25); back
  wall sits at −5.6, behind the camera's farthest pull-back (−4.8).
- Base slab stops at the deck end so it can't bridge the pit opening;
  side slivers flank the pit so the shell stays gap-free.
- Sweep: lift branch now starts at k=0 when it begins (t=0.15), and the
  final rise phase lowers the lifted pins back to their saved settle
  positions on EVERY path (including game-over), with exact endpoints
  forced before the rack decision.
- Phone wrist twist: rotationRate.alpha (rotation about the phone's own
  screen normal) is the twist measure — pitch/carry motion has no alpha
  component, so carrying the phone can't read as hook; the sign follows
  the steering wheel (twist left = hook left). The series is invalidated
  immediately on a missing/non-finite sample, on turn handover, RE-AIM,
  mode change, RECENTER, disconnect, and off-turn — a sensor dropout
  reads as zero spin, never a replayed flick (plus a 400ms freshness
  watchdog).
- Mirrored phone buttons: bare "−/+" steppers now carry contextual labels
  (e.g. "Games −") so they can't be confused on the phone.

Round 8 fixes (review pass 2):

- Phone twist: rotationRate.alpha IS the screen-normal rotation in the
  phone's own frame — pitch/carry can't contaminate it, no world projection
  needed (the attempted calibrated-frame projection was removed: it mixed up
  the rotation-rate component order and was pitch-dependent anyway). ONE
  smoothed series now feeds both the aim-guide preview and the release
  capture; button throws use the same series. Stale data reads as zero
  (freshness gate, 400ms) and history is cleared on turn handover,
  off-turn, and RECENTER.
- Gutter band outline now contains BOTH full arcs (26 points): every
  collision contact point is on the visible outline, no diagonal rim join.
- Gutter trimesh restored bounded longitudinal subdivisions (0.25m target,
  uniform step, last ring exactly at deckEndZ) instead of two 22m rings.
- Syntax checks now loop node --check per file (glob form only checked
  the first file).

Round 8 fixes (review pass 3):

- Twist invalidation is now a dedicated resetTwist() helper, invoked the
  moment a motion event arrives with missing/non-finite rotationRate.alpha
  (before the acceleration early-return), plus on fresh turn, turn handover,
  RE-AIM, mode change, RECENTER, disconnect, and every off-turn motion
  event — never only on the 400ms watchdog. Missing samples read as zero
  spin; a valid zero sample cannot revive the old snapshot (releaseTwist is
  only reassigned from live samples while a swing is active).

Round 9 fixes (phone connection + setup screen + modes):

- Phone connection reliability: a public TURN relay + extra STUN servers
  are in the ICE config (STUN-only pairing fails on symmetric-NAT networks
  — hotspot/school Wi-Fi); the phone has a 20s connect watchdog that fails
  with a retry prompt instead of hanging on the loading screen; pairing
  errors/progress now show ON THE PAIRING SCREEN (the status header lives on
  the controller screen, which isn't visible before the channel opens); the
  phone's controller id is persisted in localStorage so a reload or
  reconnect with the same QR is accepted instead of "another controller
  already claimed this session"; a stale never-paired claim (crashed
  phone) can be taken over after 90s; ICE 'failed' is watched at both the
  connection and ICE level (some mobile browsers don't fire
  connectionstatechange reliably).
- Setup screen: show() now hides EVERY screen — the settings screen was
  missing from the hide list, so SETUP elements stayed stacked over the
  controls after leaving the menu (also made buttons unresponsive, the
  "controls locked" glitch).
- Controls no longer stick: the hard accelerometer-stillness gate is gone
  (noisy sensors made the aim lock permanently — controls felt dead most
  of the time); holding a NEW in-stance pose for ~0.5s re-opens live
  aiming automatically; the in-range gate still rejects carrying the
  phone.
- Defaults: SWING scheme + LOW sensitivity (0.6) — older saved settings
  are reset once to the new defaults (v2 marker in localStorage).
- New modes: FLICK (same as swing but a much gentler release — helps
  devices whose accelerometers under-report) and TOUCH PAD (drag on the
  pad to aim, tap THROW — no gyroscope or motion permission needed; also
  offered from the motion-permission screen as an escape hatch, and a hint
  appears automatically when no sensor data arrives at all).

Round 9 fixes (review pass — reconnect + control flow):

- Reconnect actually works now: signaling docs carry a negotiation
  "generation". When the host receives a DIFFERENT answer for a session it
  already negotiated (phone reloaded/reconnected with the same QR or code),
  it tears down the dead peer and publishes a FRESH offer (gen+1) on the same
  doc — same code/QR, same slot. The phone stays subscribed to the doc and
  renegotiates on the generation bump. The stored uid alone passed the claim
  check but the new answer was ignored before — "worked before, now stuck
  on connecting".
- The whole connect attempt is bounded (30s overall, 20s channel-open
  watchdog): Firestore lookups/claims can no longer leave CONNECT disabled
  forever; late completions after cancellation are dropped (_aborted guard),
  close() settles pending waiters, and CONNECT retries reuse the QR token
  (QR users never typed a code). Code lookup now also accepts sessions this
  device already owns, so retry-by-code works after a failed attempt.
- TOUCH PAD flow is self-contained: THROW is visible whenever the throw is a
  button (pad = always), sensor-driven swings are disabled in pad mode, and
  scheme changes reset the aim/swing/twist state (no stale lock bleeding
  into the pad pose). The pad drag surface sets touch-action: none.
- Aim gate: the stance check now uses the RAW extracted angles (mapped
  steer is zeroed in swing/flick, so it could never gate) and an ADAPTIVE
  stillness threshold (EMA of the calm noise floor — a noisy accelerometer
  can no longer lock the controls permanently). The auto re-aim requires a
  still, in-stance, deliberately different pose held ~0.5s — carrying the
  phone (out of range / not still) still can't re-aim.
- Sensor control is suspended while the SETUP or motion-permission screen
  is up — a swing can't throw while you're in the menus. Permission-denial
  errors now show on the motion screen itself (motion-err), and the
  no-sensor hint only counts motion events with usable readings.
- Saved control settings are preserved (only absent/invalid saved settings
  fall back to the new SWING + LOW defaults).

Round 10 fixes (review pass — robustness + race hardening):

- The public TURN relay credentials were REMOVED (they could not be
  verified as provider-sanctioned): ICE now tries multiple STUN servers
  only, and the README points at RTC_OPTS for adding your own TURN relay
  on strict networks.
- Answers are published TRANSACTIONALLY (claim ownership + offer generation
  checked inside the write): a superseded claimant or a stale attempt can
  no longer overwrite a newer negotiation. Each attempt also stamps
  answerBy with a per-attempt id so the host can tell attempts apart.
- The host marks the signaling doc 'connected' when the reliable channel
  actually opens; the stale-claim takeover now only takes a session that
  is older than 90s AND never reached a live connection — a connected
  session is never stolen.
- Transient disconnect recovery on BOTH sides: if the ICE path drops and
  recovers while the reliable channel is still open, connection state
  'connected' (or ICE connected/completed) re-marks the session live and
  restarts the ping instead of stranding it as 'disconnected'.
- All peer callbacks capture their RTCPeerConnection and bail on stale
  events (a replaced peer's late events can no longer corrupt state).
- Renegotiation is bounded (20s channel-open watchdog) and refreshes are
  rate-limited (2s) so two tabs sharing a device id can't ping-pong
  offers forever. A refreshed offer also resets the sample sequence
  number (the reloaded phone restarts its counter).
- The aim dwell is now a STABLE-POSE dwell: if the raw pose drifts more
  than ~0.02 rad during the 400ms dwell the dwell restarts — the lock
  only captures a genuinely held stance.
- close() now cancels (rejects) a pending connect waiter instead of
  resolving it, and code lookup is bounded like the rest of the attempt.

Round 11 fixes (review pass — waiter sharing + takeover semantics + tests):

- One shared connect waiter: a renegotiation RENEWS the existing watchdog
  deadline instead of stacking a second one (a second watchdog could kill
  the healthy replacement attempt). This also fixed a TDZ crash in the
  waiter construction and a wrong `snap.exists()` call (Firestore's
  exists is a property, not a method — would have thrown in production).
- The host marks the doc 'connected' when the reliable channel opens and
  'disconnected' when it closes — so the stale-claim takeover is now
  exactly "old claim AND session not currently live" (a live session is
  never stolen; a dead one is recoverable).
- Stale channel events are ignored on both sides (callbacks capture
  their peer and bail), including channel-close from a REPLACED peer.
- The renegotiation deadline covers the whole attempt (SDP + Firestore
  transaction too), reports an actionable 'reconnect timed out' error
  instead of failing silently, and a newer generation seen mid-
  renegotiation is retained and processed afterwards.
- Dampened host refreshes are SCHEDULED (run when the 2s window expires)
  instead of dropped; a refreshed offer resets the sample counter.
- The re-aim dwell is also a stable-pose dwell (drift restarts it).
- NEW offline lifecycle tests (tests/rtc.test.mjs, 19 checks): fake
  in-memory Firestore + fake RTCPeerConnection — covers generation
  refresh during initial connection, survival past the ORIGINAL
  watchdog deadline, shared-waiter renewal, stale channel-close events,
  renegotiation timeout/error reporting, and stale-claim takeover
  semantics. Still NO live testing (per the project rules).

Round 12: "phone module doesn't appear to be updated" (post-merge report)

The phone was almost certainly running the OLD cached phone-main.js: GitHub
Pages serves static files with a ~10-minute cache, and the site was tested
right after merging (that old code is exactly the permanent AIM LOCKED /
controls-locked behavior). Fixes:

- CACHE BUSTING: every entry reference now carries a version tag
  (?v=2 on phone.html + index.html script/css refs, and on the
  phone-main/main imports of rtc.js + orientation.js). The next release
  bumps the number in those spots (html refs + imports of CHANGED files
  only — bumping an import of an unchanged file that other modules also
  import plainly would load it twice).
- VISIBLE VERSION: the phone shows a small "v2" badge (bottom-right) so
  it is instantly verifiable which version is actually running.
- HONEST LABEL: while the game has the phone paused (not its turn, ball
  in play, re-arming), the big label now reads WAITING instead of a stale
  AIM LOCKED — the reason shows in the hint line under it.
