import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isSteamAuthRejection, isSteamSessionConflict, recoveryBackoffMs } from './recovery';

test('network outages and timeouts are recoverable', () => {
  for (const err of [{ eresult: 3, message: 'NoConnection' }, { code: 'ETIMEDOUT' }, { message: 'read ECONNRESET' }]) {
    assert.equal(isSteamAuthRejection(err), false);
    assert.equal(isSteamSessionConflict(err), false);
  }
});
test('logged-in-elsewhere is distinct from a network problem', () => {
  assert.equal(isSteamSessionConflict({ eresult: 6 }), true);
  assert.equal(isSteamSessionConflict({ message: 'LoggedInElsewhere' }), true);
});
test('permanent authentication failures are not retried forever', () => {
  assert.equal(isSteamAuthRejection({ eresult: 5 }), true);
  assert.equal(isSteamAuthRejection({ message: 'InvalidRefreshToken' }), true);
});
test('retry backoff is bounded', () => {
  assert.deepEqual([1,2,3,4,5,6,20].map(recoveryBackoffMs), [5000,10000,20000,40000,80000,120000,120000]);
});
