import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiagnostics, sanitizeDiagnosticFields } from './diagnostics';

test('diagnostic whitelist does not serialize refresh tokens or QR data', () => {
 const fields = sanitizeDiagnosticFields({ connected:true, refreshToken:'secret-token', cookies:'secret', qrDataUrl:'secret', desiredCount:12, reason:'network' });
 assert.equal(fields.connected,true);
 assert.equal(fields.desiredCount,12);
 assert.equal(fields.refreshToken,undefined);
 assert.equal(fields.cookies,undefined);
 assert.equal(fields.qrDataUrl,undefined);
});
test('diagnostic output persists events and exports readable JSONL', () => {
 const dir=mkdtempSync(join(tmpdir(),'o-idle-diag-'));
 try {
  const file=join(dir,'diagnostics.jsonl');
  const log=createDiagnostics(file);
  log.emit('steam.disconnected',{connected:false,idleWanted:true,activeCount:0,desiredCount:45,refreshToken:'bad'});
  const parsed=JSON.parse(readFileSync(file,'utf8').trim());
  assert.equal(parsed.event,'steam.disconnected');
  assert.equal(parsed.desiredCount,45);
  assert.equal(parsed.refreshToken,undefined);
  assert.match(log.exportText(),/steam.disconnected/);
  assert.equal(log.recent().length,1);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
