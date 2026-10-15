import * as fs from 'node:fs';
import * as path from 'node:path';

export type DiagnosticValue = string | number | boolean | null | number[] | undefined;
export type DiagnosticFields = Record<string, DiagnosticValue>;
const ALLOWED_FIELDS = new Set([
  'connected','connecting','reconnecting','idleWanted','idleSuspended','externalPlaying',
  'externalPlayingApp','blocked','activeCount','desiredCount','selectedCount','priorityCount',
  'batchIndex','batchCount','reconnectCount','recoveryAttempts','sessionConflictCount',
  'recoveryBlocked','eresult','appid','durationMs','retryInMs','reason','source',
  'outcome','errorCode','logonIDChanged','nextBatchIndex','attempt','clientCurrent',
  'activeAppIds','desiredAppIds','priorityAppIds','previousActiveCount',
  'previousDesiredCount','previousIdleWanted','previousBlocked','lastConnectedAgeMs'
]);
const MAX_SIZE = 1024 * 1024;
const MAX_RECENT = 250;
const MAX_FIELD_LEN = 160;
export function sanitizeDiagnosticFields(fields: Record<string, unknown>): DiagnosticFields {
  const result: DiagnosticFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(key)) continue;
    if (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (typeof value === 'string') result[key] = value.slice(0, MAX_FIELD_LEN).replace(/(Bearer\s+|refreshToken[=:\s]+)[^\s]+/gi, '$1[REDACTED]');
    else if (Array.isArray(value) && (key === 'activeAppIds' || key === 'desiredAppIds' || key === 'priorityAppIds'))
      result[key] = value.filter(x => Number.isInteger(x) && x > 0).slice(0, 32);
  }
  return result;
}
export function createDiagnostics(file: string) {
  const recent: string[] = [];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  function emit(event: string, fields: Record<string, unknown> = {}) {
    const entry = JSON.stringify({
      at: new Date().toISOString(),
      event: /^[a-z][a-z0-9_.-]{0,63}$/i.test(event) ? event : 'invalid_event',
      ...sanitizeDiagnosticFields(fields)
    });
    recent.push(entry);
    if (recent.length > MAX_RECENT) recent.shift();
    try {
      if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(entry) > MAX_SIZE) {
        const older = file + '.1';
        if (fs.existsSync(older)) fs.unlinkSync(older);
        fs.renameSync(file, older);
      }
      fs.appendFileSync(file, entry + '\n', 'utf8');
    } catch { /* Diagnostics must never stop the idler. */ }
  }
  function exportText() {
    // Never include credentials.dat, runtime.log, cookies, QR or Steam tokens.
    const parts = ['# O-Steam-Idle diagnostics (redacted, JSONL)'];
    for (const f of [file + '.1', file]) {
      try { if (fs.existsSync(f)) parts.push(fs.readFileSync(f, 'utf8')); } catch {}
    }
    if (parts.length === 1) parts.push(...recent);
    return parts.join('\n');
  }
  return { emit, exportText, recent: () => recent.slice(-80).map(line => JSON.parse(line)) };
}
