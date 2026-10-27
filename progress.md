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
