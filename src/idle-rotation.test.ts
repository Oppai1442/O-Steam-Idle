import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { planCircularIdleBatches } from './idle-rotation';

test('80 selected / 12 pinned always occupies 32 Steam slots, including last batch', () => {
  const desired = Array.from({length:80},(_,i)=>i+1);
  const pinned=desired.slice(0,12);
  const plan=planCircularIdleBatches(desired,pinned,32);
  assert.equal(plan.batches.length,4);
  for (const batch of plan.batches) {
    assert.equal(batch.length,32);
    assert.equal(new Set(batch).size,32);
    assert.deepEqual(batch.slice(0,12),pinned);
  }
  assert.deepEqual(plan.batches[3].slice(12),[73,74,75,76,77,78,79,80,13,14,15,16]);
  assert.equal(new Set(plan.batches.flat()).size,80);
});
test('110 selected / 5 pinned always fills batches without duplicates', () => {
 const desired=Array.from({length:110},(_,i)=>i+1);
 const plan=planCircularIdleBatches(desired,desired.slice(0,5),32);
 assert.equal(plan.batches.length,4);
 for(const b of plan.batches){assert.equal(b.length,32);assert.equal(new Set(b).size,32);}
 assert.equal(new Set(plan.batches.flat()).size,110);
});
test('smaller-than-capacity selection only sends available games',()=>{
 assert.deepEqual(planCircularIdleBatches([1,2,3],[1],32).batches,[[1,2,3]]);
 assert.deepEqual(planCircularIdleBatches([1,2,2,3],[1],3).batches,[[1,2,3]]);
});
test('all priority games consume slots without duplicating AppIDs',()=>{
 const plan=planCircularIdleBatches([1,2,3],[1,2,3],3);
 assert.deepEqual(plan.batches,[[1,2,3]]);
});
test('non-priority rotation covers every game with no internal duplicates',()=>{
 for(let n=33;n<=115;n++){
  const plan=planCircularIdleBatches(Array.from({length:n},(_,i)=>i+1),[],32);
  for(const b of plan.batches){assert.equal(b.length,32);assert.equal(new Set(b).size,32);}
  assert.equal(new Set(plan.batches.flat()).size,n);
 }
});
