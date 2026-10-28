import { applyControlScheme } from '../src/orientation.js';
import assert from 'node:assert';

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`FAIL  ${name}`); }
}

const pose = { steer: 0.2, aim: -0.1 };

console.log('T1: control schemes map extracted angles');
check('wheel keeps order', JSON.stringify(applyControlScheme(pose, 'wheel', 1)) === JSON.stringify({ steer: 0.2, aim: -0.1 }));
check('twist swaps order', JSON.stringify(applyControlScheme(pose, 'twist', 1)) === JSON.stringify({ steer: -0.1, aim: 0.2 }));
check('swing zeroes steer', JSON.stringify(applyControlScheme(pose, 'swing', 1)) === JSON.stringify({ steer: 0, aim: -0.1 }));
check('flick zeroes steer like swing', JSON.stringify(applyControlScheme(pose, 'flick', 1)) === JSON.stringify({ steer: 0, aim: -0.1 }));
check('pad keeps order (touch feeds angles)', JSON.stringify(applyControlScheme(pose, 'pad', 1)) === JSON.stringify({ steer: 0.2, aim: -0.1 }));

console.log('T2: sensitivity scales both angles');
check('low sens 0.6 scales', JSON.stringify(applyControlScheme(pose, 'swing', 0.6)) === JSON.stringify({ steer: 0, aim: -0.06 }));
check('high sens 1.6 scales', JSON.stringify(applyControlScheme(pose, 'wheel', 1.6)) === JSON.stringify({ steer: 0.32000000000000004, aim: -0.16000000000000003 }));

console.log('T3: defaults for unknown scheme fall through safely');
check('unknown scheme acts like wheel', JSON.stringify(applyControlScheme(pose, 'nope', 1)) === JSON.stringify({ steer: 0.2, aim: -0.1 }));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
