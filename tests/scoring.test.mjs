import { Game } from '../src/scoring.js';
import assert from 'node:assert';

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`FAIL  ${name}`); }
}

// Helper: play a sequence of rolls through the game (verifying legality implicitly by construction)
function play(rolls) {
  const g = new Game();
  for (const r of rolls) g.rolls.push(r);
  return g;
}

console.log('T1: 12 strikes → 300');
check('total is 300', play([10,10,10,10,10,10,10,10,10,10,10,10]).totalScore() === 300);

console.log('T2: 10 frames of 9,0 → 90');
{
  const rolls = [];
  for (let i = 0; i < 10; i++) rolls.push(9, 0);
  check('total is 90', play(rolls).totalScore() === 90);
}

console.log('T3: 10 frames of 5,5 + final 5 → 150');
{
  const rolls = [];
  for (let i = 0; i < 10; i++) rolls.push(5, 5);
  rolls.push(5);
  const g = play(rolls);
  check('total is 150', g.totalScore() === 150);
  check('game complete', g.isComplete() === true);
}

console.log('T4: all gutters → 0');
{
  const rolls = [];
  for (let i = 0; i < 20; i++) rolls.push(0);
  const g = play(rolls);
  check('total is 0', g.totalScore() === 0);
  check('game complete', g.isComplete() === true);
}

console.log('T5: pending scores before bonuses');
{
  const g = play([10]); // single strike
  const s = g.scores();
  check('frame 1 pending', s[0] === null);
  check('all later pending', s.slice(1).every((v) => v === null));
  check('total null', g.totalScore() === null);
  check('not complete', g.isComplete() === false);
}

console.log('T6: spare then 3 then open 4,2');
{
  const g = play([5, 5, 3, 4, 2]);
  const s = g.scores();
  check('frame 1 = 13', s[0] === 13);
  check('frame 2 = 13+7=20', s[1] === 20);
  check('frame 3 pending', s[2] === null);
}

console.log('T7: 10th frame — strike then non-strike leaves pins for 3rd ball');
{
  // 9 frames of 9,0 (90), then 10th: strike, 7, then 3rd ball at remaining 3 pins
  const rolls = [];
  for (let i = 0; i < 9; i++) rolls.push(9, 0);
  rolls.push(10, 7);
  let g = play(rolls);
  check('incomplete after X,7', g.isComplete() === false);
  check('10th pending', g.scores()[9] === null);
  rolls.push(3); // picks the 3 standing pins (7+3 = full rack cleared → but 7+3=10 shows spare)
  g = play(rolls);
  check('complete', g.isComplete() === true);
  check('total 81+10+7+3=101', g.totalScore() === 101);
}

console.log('T8: 10th frame — open frame ends game at 2 rolls');
{
  const rolls = [];
  for (let i = 0; i < 9; i++) rolls.push(9, 0);
  rolls.push(4, 2);
  const g = play(rolls);
  check('complete', g.isComplete() === true);
  check('total 81+6=87', g.totalScore() === 87);
}

console.log('T9: frames() splitting');
{
  const g = play([10, 3, 4, 5, 5]);
  const fr = g.frames();
  check('frame 1 = [10]', JSON.stringify(fr[0]) === '[10]');
  check('frame 2 = [3,4]', JSON.stringify(fr[1]) === '[3,4]');
  check('frame 3 = [5,5]', JSON.stringify(fr[2]) === '[5,5]');
  check('frame 4 empty', fr[3].length === 0);
}

console.log('T10: symbols');
{
  const g = play([10, 9, 1, 0, 0]);
  const fr = g.frames();
  check('strike symbol', Game.symbol(fr[0], 0, 0) === 'X');
  check('spare symbol', Game.symbol(fr[1], 1, 1) === '/');
  check('gutter symbol', Game.symbol(fr[2], 0, 2) === '-');
}

console.log('T11: 10th frame triple');
{
  const rolls = [];
  for (let i = 0; i < 9; i++) rolls.push(9, 0);
  rolls.push(10, 10, 10);
  const g = play(rolls);
  check('complete', g.isComplete() === true);
  check('total 81+30=111', g.totalScore() === 111);
}

console.log('T12: strike then gutter-gutter (frame value 10)');
{
  const g = play([10, 0, 0]);
  check('frame 1 = 10', g.scores()[0] === 10);
  check('running total after frame 2 = 10', g.scores()[1] === 10);
  check('totalScore null while incomplete', g.totalScore() === null);
  check('not complete', g.isComplete() === false);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
