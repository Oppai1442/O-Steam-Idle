import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { canApplyIdle, hasPendingIdle, shouldYieldIdle } from './idle-policy';

const initial = () => ({
  idleWanted: true, desiredIdling: [346110, 2399830],
  connected: true, externalPlaying: false, idleSuspended: false,
  shuttingDown: false, clientBlocked: false
});
test('network disconnect keeps idle intent, but cannot advertise games offline', () => {
  const s = initial(); s.connected = false;
  assert.equal(hasPendingIdle(s), true);
  assert.equal(canApplyIdle(s), false);
  s.connected = true;
  assert.equal(canApplyIdle(s), true);
});
test('Steam Desktop blocks and then unblocks without clearing intent', () => {
  const s = initial();
  s.externalPlaying = true; s.clientBlocked = true; s.idleSuspended = true;
  assert.equal(shouldYieldIdle(s), true);
  assert.equal(canApplyIdle(s), false);
  assert.equal(hasPendingIdle(s), true);
  s.externalPlaying = false; s.clientBlocked = false; s.idleSuspended = false;
  assert.equal(canApplyIdle(s), true);
});
test('Stop explicitly clears intent, preventing automatic resume', () => {
  const s = initial(); s.idleWanted = false; s.desiredIdling = [];
  assert.equal(canApplyIdle(s), false);
});
test('blocked session can have an armed selection', () => {
  const s = initial(); s.externalPlaying = true;
  assert.equal(hasPendingIdle(s), true);
  assert.equal(canApplyIdle(s), false);
});
