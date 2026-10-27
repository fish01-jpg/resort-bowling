# Sunset Lanes — Resort Bowling

A polished, browser-based 3D bowling game inspired by the feel of Wii Sports Resort / Nintendo Switch Sports bowling. Full 10-frame bowling rules, real physics, keyboard + mouse controls — built to later add touch, gamepad, and motion controls.

Play: **https://fish01-jpg.github.io/resort-bowling/** (GitHub Pages)

## Features

- **Real bowling rules** — strikes, spares, splits, 10th-frame bonus balls, pending scores shown until bonuses resolve. Rules engine is unit-tested (32 tests, including 300 / 150 / 90 / 0 score verification).
- **Real physics** — Rapier (WASM) rigid-body simulation: ball–pin and pin–pin collisions, tipping pins, gutters, hook/spin that ramps up on the dry back end of the lane.
- **Wii-style throw** — position the ball, aim, hold SPACE to charge power (oscillating meter), set spin while charging, release to bowl.
- **Aim assist** — the on-screen dot trail shows your projected path (including hook), and a gentle capped steering force nudges the ball toward that path. Misses still miss: aim at the gutter and the ball follows your aim there.
- **Resort atmosphere** — sunset lighting, wood lane with arrows, palm trees, procedural sound (rolling rumble, pin clatter, strike/spare jingles, gentle marimba loop).
- **Full scorecard HUD** — frame-by-frame rolls (X, /, -), running totals, current-frame highlight, frame/ball indicator.
- **Automation hooks** — `window.render_game_to_text()`, `window.advanceTime(ms)`, and `window.BowlingAPI.deliverBall({position, aim, power, spin})` for scripted play and future controllers.

## Controls

| Key | Action |
| --- | --- |
| A / D | Move ball left / right |
| Q / E | Aim left / right |
| SPACE (hold) | Charge power — release to throw |
| W / S | Spin (hook) while charging |
| M | Mute |
| R | Restart game |

## Tech

- Three.js (WebGL2) rendering, Rapier physics, Web Audio API for all sound. No build step — plain ES modules served statically.
- Libraries load from CDN (esm.sh); everything else is original code and procedurally generated textures/sounds.

## Development

```bash
# run locally
python3 -m http.server 8000
# open http://localhost:8000

# run the scoring unit tests (Node 18+)
node tests/scoring.test.mjs
```

## Project structure

```
index.html          — shell + HUD markup
css/style.css       — design system (Chillax / General Sans, resort palette)
src/constants.js    — lane dimensions, pin spots, tuning
src/scoring.js      — pure rules engine (unit-tested)
src/physics.js      — Rapier world: lane, gutters, ball, pins, hook forces
src/scene.js        — Three.js scene: lane, pins, ball, resort dressing
src/input.js        — keyboard/mouse controls
src/game.js         — state machine: ready → rolling → settling → sweep → score
src/ui.js           — scorecard, meters, messages, overlays
src/audio.js        — procedural sound effects + music
src/main.js         — bootstrap, game loop, camera, automation hooks
tests/scoring.test.mjs — rules engine tests
```

## Roadmap

- Touch controls, gamepad support, motion (device-orientation) controls
- Multiplayer (pass-and-play), online play
- Lane oil patterns, ball selection, spin practice mode
