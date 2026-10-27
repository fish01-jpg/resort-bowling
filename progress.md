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
