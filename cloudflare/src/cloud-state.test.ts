import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { initialCloudConfig, normalizeCloudConfig } from './cloud-state';

test('first boot defaults auto-start and pin Priority',()=>{
 const s=initialCloudConfig({O_IDLE_DEFAULT_APPIDS:'100,200,300',O_IDLE_PRIORITY_APPIDS:'200,400',O_IDLE_AUTO_START:'1'});
 assert.deepEqual(s.selected,[200,400,100,300]);
 assert.deepEqual(s.priorityAppIds,[200,400]);
 assert.deepEqual(s.desiredIdling,[200,400,100,300]);
 assert.equal(s.idleWanted,true);
});
test('first boot without auto-start stays idle',()=>{
 const s=initialCloudConfig({O_IDLE_DEFAULT_APPIDS:'1,2',O_IDLE_AUTO_START:'0'});
 assert.equal(s.idleWanted,false);
 assert.deepEqual(s.desiredIdling,[]);
});
test('later explicit Stop remains stopped despite initial defaults',()=>{
 const s=normalizeCloudConfig({selected:[1,2],priorityAppIds:[1],desiredIdling:[],idleWanted:false});
 assert.equal(s.idleWanted,false);
 assert.deepEqual(s.selected,[1,2]);
});
test('configuration rejects unsafe and invalid app IDs',()=>{
 const s=normalizeCloudConfig({selected:[1,1,-1,0,4294967296,'oops'],priorityAppIds:[1,2]});
 assert.deepEqual(s.selected,[1,2]);
});
