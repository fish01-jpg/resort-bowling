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

## Pending QA — user is testing manually

User chose to test the game themselves (2026-10-27) rather than have automated browser QA run. Expect feedback on: gutter balls, spares/partial racks, spin/hook feel, 10th-frame bonus balls, game-over screen, sound, and mobile layout. Fix list from QA pass 1 is already applied.

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
