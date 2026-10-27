'use strict';

import type { LibraryApp, RuntimeState, SettingsFile } from './types';
import { isSteamSessionConflict, isSteamAuthRejection, recoveryBackoffMs } from './recovery';
import { canApplyIdle, hasPendingIdle, shouldYieldIdle } from './idle-policy';
import { createDiagnostics } from './diagnostics';
import { planCircularIdleBatches } from './idle-rotation';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const QRCode = require('qrcode');
const cheerio = require('cheerio');
const SteamUser = require('steam-user');
const { LoginSession, EAuthTokenPlatformType, ESessionPersistence } = require('steam-session');

const CLOUD_MODE = process.env.O_IDLE_CLOUD === '1';
const HOST = process.env.O_IDLE_HOST || (CLOUD_MODE ? '0.0.0.0' : '127.0.0.1');
const PORT = Number(process.env.PORT || 3210);
const DISABLE_BROWSER = process.env.O_IDLE_DISABLE_BROWSER === '1' || CLOUD_MODE;
const AUTO_START = process.env.O_IDLE_AUTO_START === '1';
const ENV_REFRESH_TOKEN = String(process.env.STEAM_REFRESH_TOKEN || '').trim();
const DEFAULT_APPIDS = [...new Set(String(process.env.O_IDLE_DEFAULT_APPIDS || '')
  .split(/[^0-9]+/)
  .map(Number)
  .filter(x => Number.isInteger(x) && x > 0))];
const ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const CRED_FILE = path.join(DATA, 'credentials.dat');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const EXTERNAL_RECHECK_MS = 30000;
const IDLE_RESTORE_DELAY_MS = 2500;
// Steam may send playingState(blocked=true) shortly AFTER loggedOn.
// Never advertise games until the initial concurrent-session check can arrive.
const LOGIN_PLAYING_STATE_GRACE_MS = 8000;
const UNBLOCK_RESUME_DELAY_MS = 1000;
const CONNECT_TIMEOUT_MS = 45000;
const RECONNECT_GRACE_MS = 60000;
const RECONNECT_CHECK_MS = 5000;
const STEAM_MAX_CONCURRENT_APPS = 32;
const IDLE_MAX_CONCURRENT = Math.min(STEAM_MAX_CONCURRENT_APPS, Math.max(1, Number(process.env.O_IDLE_MAX_CONCURRENT || STEAM_MAX_CONCURRENT_APPS) || STEAM_MAX_CONCURRENT_APPS));
const IDLE_ROTATE_MINUTES = Math.max(1, Number(process.env.O_IDLE_ROTATE_MINUTES || 30) || 30);
const IDLE_ROTATE_MS = IDLE_ROTATE_MINUTES * 60 * 1000;
const PLAYTIME_SYNC_MINUTES = Math.max(1, Number(process.env.O_IDLE_PLAYTIME_SYNC_MINUTES || 5) || 5);
const PLAYTIME_SYNC_MS = PLAYTIME_SYNC_MINUTES * 60 * 1000;
const LOG_FILE = path.join(DATA, 'runtime.log');
const diagnostics = createDiagnostics(path.join(DATA, 'diagnostics.jsonl'));
fs.mkdirSync(DATA, { recursive: true });

let steam: any = null;
let loginSession: any = null;
let webCookies: string[] = [];
let library: LibraryApp[] = [];
let state: RuntimeState = {
  connected: false,
  connecting: false,
  qrDataUrl: null,
  qrStatus: 'idle',
  steamID: null,
  accountName: null,
  selected: [],
  idling: [],
  libraryReady: false,
  libraryError: null,
  cardScanReady: false,
  cardScanRunning: false,
  cardScanError: null,
  cardGames: 0,
  cardDropsRemaining: 0,
  message: 'Ready',
  externalPlaying: false,
  externalPlayingApp: 0,
  idleSuspended: false,
  sessionConflict: false,
  reconnecting: false,
  reconnectCount: 0,
  recoveryAttempts: 0,
  recoveryNextRetryAt: null,
  recoveryLastReason: null,
  recoveryBlocked: false,
  connectingSince: null,
  sessionConflictCount: 0,
  lastSessionConflictAt: null,
  lastDisconnect: null,
  lastConnectedAt: null,
  idleWanted: false,
  desiredIdling: [],
  idleBatchIndex: 0,
  idleBatchCount: 0,
  idleRotationAt: null,
  playtimeSyncing: false,
  playtimeSyncAt: null,
  playtimeRevision: 0,
  playtimeSyncError: null,
  shuttingDown: false,
  runtimeMode: CLOUD_MODE ? 'cloud' : 'local'
};

let steamLogonID = 0;
let manualAppIds = new Set<number>(DEFAULT_APPIDS);
let priorityAppIds = new Set<number>();

function generateLogonID(): number {
  let id = crypto.randomBytes(4).readUInt32LE(0) >>> 0;
  if (!id) id = 1442;
  return id;
}

function loadSettings() {
  try {
    const x = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) as SettingsFile;
    state.selected = Array.isArray(x.selected) ? x.selected.map(Number).filter(Number.isFinite) : [];
    const savedPriority = Array.isArray(x.priorityAppIds)
      ? x.priorityAppIds.map(Number).filter(id => Number.isInteger(id) && id > 0).slice(0, IDLE_MAX_CONCURRENT)
      : [];
    priorityAppIds = new Set(savedPriority);
    if (Array.isArray(x.manualAppIds)) {
      for (const id of x.manualAppIds.map(Number)) {
        if (Number.isInteger(id) && id > 0) manualAppIds.add(id);
      }
    }
    const savedLogonID = Number(x.logonID);
    steamLogonID = Number.isInteger(savedLogonID) && savedLogonID > 0 && savedLogonID <= 0xFFFFFFFF
      ? savedLogonID >>> 0
      : generateLogonID();
  } catch (_) {
    steamLogonID = generateLogonID();
  }
  if (!state.selected.length && DEFAULT_APPIDS.length) state.selected = DEFAULT_APPIDS.slice();
  state.selected = [...new Set([...priorityAppIds, ...state.selected])];
  saveSettings();
}
function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
    selected: state.selected,
    manualAppIds: [...manualAppIds].sort((a, b) => a - b),
    priorityAppIds: [...priorityAppIds].sort((a, b) => a - b),
    logonID: steamLogonID
  }, null, 2));
}
loadSettings();

try {
  if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
    try { fs.unlinkSync(`${LOG_FILE}.1`); } catch (_) {}
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  }
} catch (_) {}

function diagnostic(event: string, extra: Record<string, unknown> = {}) {
  diagnostics.emit(event, {
    connected: state.connected, connecting: state.connecting, reconnecting: state.reconnecting,
    idleWanted: state.idleWanted, idleSuspended: state.idleSuspended,
    externalPlaying: state.externalPlaying, externalPlayingApp: state.externalPlayingApp,
    activeCount: state.idling.length, desiredCount: state.desiredIdling.length,
    selectedCount: state.selected.length, priorityCount: priorityAppIds.size,
    batchIndex: state.idleBatchIndex, batchCount: state.idleBatchCount,
    reconnectCount: state.reconnectCount, recoveryAttempts: state.recoveryAttempts,
    sessionConflictCount: state.sessionConflictCount, recoveryBlocked: state.recoveryBlocked,
    ...extra
  });
}
function runtimeLog(level: 'INFO' | 'WARN' | 'ERROR', message: string) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
  try { fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8'); } catch (_) {}
}

type CloudBootstrap = {
  selected: number[];
  priorityAppIds: number[];
  manualAppIds: number[];
  desiredIdling: number[];
  idleWanted: boolean;
};
let cloudBootConfig: CloudBootstrap | null = null;
function normalizeCloudAppIds(values: unknown): number[] {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(Number).filter(n => Number.isSafeInteger(n) && n > 0 && n <= 4294967295))].slice(0, 1000);
}
function tryCloudAutoStart() {
  if (!CLOUD_MODE || !cloudBootConfig || !cloudBootConfig.idleWanted ||
      !state.connected || !state.libraryReady || state.idleWanted || !steam) return;
  const desired = cloudBootConfig.desiredIdling;
  const missing = desired.filter(id => !library.some(a => a.appid === id));
  if (missing.length) {
    for (const id of missing) manualAppIds.add(id);
    // Discovery may exclude F2P AppIDs; pending manual entries will be loaded
    // when the library refresh completes. Don't discard desired selections.
    refreshLibrary().then(() => {
      const remaining = desired.filter(id => !library.some(a => a.appid === id));
      if (remaining.length) runtimeLog('WARN', `Cloud auto-start: ${remaining.length} AppIDs unavailable in Steam library`);
      try { startIdle(desired); } catch (err) { runtimeLog('WARN', `Cloud auto-start failed: ${err.message}`); }
    }).catch(err => runtimeLog('WARN', `Cloud library restoration failed: ${err.message}`));
    return;
  }
  try { startIdle(desired); } catch (err) { runtimeLog('WARN', `Cloud auto-start failed: ${err.message}`); }
}
let idleRestoreTimer = null;
let idleRotationTimer = null;
function cancelIdleRestore() {
  if (idleRestoreTimer) clearTimeout(idleRestoreTimer);
  idleRestoreTimer = null;
}
function cancelIdleRotation() {
  if (idleRotationTimer) clearTimeout(idleRotationTimer);
  idleRotationTimer = null;
  state.idleRotationAt = null;
}
function planIdleBatches(appids: number[]) {
  return planCircularIdleBatches(appids, [...priorityAppIds], IDLE_MAX_CONCURRENT);
}

function scheduleIdleRotation(client: any) {
  cancelIdleRotation();
  const plan = planIdleBatches(state.desiredIdling);
  if (!state.idleWanted || state.idleSuspended || state.shuttingDown || plan.batches.length <= 1) return;
  state.idleRotationAt = Date.now() + IDLE_ROTATE_MS;
  idleRotationTimer = setTimeout(() => {
    idleRotationTimer = null;
    state.idleRotationAt = null;
    if (steam !== client || !state.connected || !state.idleWanted || state.idleSuspended || state.shuttingDown) return;
    if (state.externalPlaying || client.playingState?.blocked) return;
    try {
      const currentPlan = planIdleBatches(state.desiredIdling);
      const next = currentPlan.batches.length ? (state.idleBatchIndex + 1) % currentPlan.batches.length : 0;
      applyIdleBatch(client, next, 'rotation');
    } catch (err) {
      state.message = `Idle rotation failed: ${err.message}`;
      runtimeLog('ERROR', `Idle rotation failed: ${err.message}`);
    }
  }, IDLE_ROTATE_MS);
  idleRotationTimer.unref?.();
}
function applyIdleBatch(client: any, batchIndex = 0, reason = 'start') {
  // Ownership/cache snapshots can become temporarily incomplete after WARP
  // recovery. Start Idle validates ownership; never silently discard desired
  // AppIDs while reconciling an existing session.
  const desired = state.desiredIdling.filter(appid => Number.isInteger(appid) && appid > 0);
  if (!desired.length) throw new Error('No desired AppIDs available');
  state.desiredIdling = [...new Set(desired)];
  const plan = planIdleBatches(state.desiredIdling);
  if (plan.priority.length >= IDLE_MAX_CONCURRENT && plan.rotating.length) {
    throw new Error(`${IDLE_MAX_CONCURRENT} priority games occupy every Steam slot. Unpin at least one priority game to rotate the rest.`);
  }
  const index = ((Number(batchIndex) || 0) % plan.batches.length + plan.batches.length) % plan.batches.length;
  const batch = plan.batches[index];
  if (!batch.length) throw new Error('No games available for the active idle batch');
  diagnostic('idle.batch.request', { reason, nextBatchIndex: index, activeAppIds: batch, priorityAppIds: plan.priority });
  client.gamesPlayed(batch, false);
  state.idling = batch.slice();
  diagnostic('idle.batch.applied', { reason, activeAppIds: batch });
  state.idleBatchIndex = index;
  state.idleBatchCount = plan.batches.length;
  const queued = state.desiredIdling.length - batch.length;
  const priorityText = plan.priority.length ? ` · ${plan.priority.length} priority pinned` : '';
  state.message = plan.batches.length > 1
    ? `Idling ${batch.length}/${state.desiredIdling.length}${priorityText} · batch ${index + 1}/${plan.batches.length} · ${queued} queued · rotates every ${IDLE_ROTATE_MINUTES}m`
    : `Idling ${batch.length} game${batch.length === 1 ? '' : 's'}${priorityText}`;
  runtimeLog('INFO', `Idle batch ${index + 1}/${plan.batches.length} applied after ${reason}: ${batch.length}/${state.desiredIdling.length} games, priority=${plan.priority.length}`);
  scheduleIdleRotation(client);
}

function scheduleIdleRestore(client: any, reason = 'reconnect', delayMs = IDLE_RESTORE_DELAY_MS) {
  cancelIdleRestore();
  cancelIdleRotation();
  if (!hasPendingIdle(state)) return;

  idleRestoreTimer = setTimeout(() => {
    idleRestoreTimer = null;
    if (steam !== client || state.shuttingDown || !hasPendingIdle(state)) return;
    if (!state.connected) return; // watchdog will retry on reconnect.

    if (!canApplyIdle({
      ...state,
      clientBlocked: !!client.playingState?.blocked
    })) {
      state.idleSuspended = true;
      state.idling = [];
      state.message = 'Waiting: another Steam session is playing. Idle will resume automatically when it stops.';
      runtimeLog('INFO', `Idle deferred after ${reason}: Steam playing session still active`);
      return;
    }

    // An earlier playingState(blocked=true) must not require manual Start.
    state.idleSuspended = false;
    state.externalPlaying = false;
    state.externalPlayingApp = 0;
    try {
      applyIdleBatch(client, state.idleBatchIndex, `resume/${reason}`);
    } catch (err) {
      // Keep desired selection even if gamesPlayed temporarily fails.
      state.idling = [];
      state.message = `Idle resume failed: ${err.message}; will retry.`;
      runtimeLog('WARN', state.message);
    }
  }, delayMs);
  idleRestoreTimer.unref?.();
}

function ps(script: string, input = '') {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
}

function protectToken(token: string): Buffer {
  if (process.platform !== 'win32') {
    return Buffer.from(JSON.stringify({ mode: 'plain', token }), 'utf8');
  }
  const script = [
    '$ErrorActionPreference="Stop";',
    'Add-Type -AssemblyName System.Security;',
    '$s=[Console]::In.ReadToEnd();',
    '$b=[Text.Encoding]::UTF8.GetBytes($s);',
    '$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
    '[Console]::Out.Write([Convert]::ToBase64String($p));'
  ].join('');
  const r = ps(script, token);
  if (r.status !== 0) throw new Error(`DPAPI protect failed: ${r.stderr || r.stdout}`);
  return Buffer.from(JSON.stringify({ mode: 'dpapi', blob: r.stdout.trim() }), 'utf8');
}

function unprotectToken(buf: Buffer): string {
  const payload = JSON.parse(buf.toString('utf8'));
  if (payload.mode === 'plain') return payload.token;
  if (payload.mode !== 'dpapi' || process.platform !== 'win32') throw new Error('Unsupported credential format');
  const script = [
    '$ErrorActionPreference="Stop";',
    'Add-Type -AssemblyName System.Security;',
    '$s=[Console]::In.ReadToEnd().Trim();',
    '$b=[Convert]::FromBase64String($s);',
    '$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
    '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($p));'
  ].join('');
  const r = ps(script, payload.blob);
  if (r.status !== 0) throw new Error(`DPAPI unprotect failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function saveRefreshToken(token: string) {
  // Local mode persists with DPAPI on Windows. Cloud containers may also keep a
  // temporary copy on ephemeral disk, while the durable source should remain a
  // Cloudflare Worker secret (STEAM_REFRESH_TOKEN).
  fs.writeFileSync(CRED_FILE, protectToken(token));
}
function loadRefreshToken() {
  if (fs.existsSync(CRED_FILE)) return unprotectToken(fs.readFileSync(CRED_FILE));
  return ENV_REFRESH_TOKEN || null;
}
function forgetRefreshToken() {
  try { fs.unlinkSync(CRED_FILE); } catch (_) {}
}
function hasSavedLogin() {
  return fs.existsSync(CRED_FILE) || !!ENV_REFRESH_TOKEN;
}

function sanitizeState() {
  const active = new Set(state.idling);
  return {
    ...state,
    runtimeMode: CLOUD_MODE ? 'cloud' : 'local',
    priorityAppIds: [...priorityAppIds].sort((a, b) => a - b),
    priorityCount: priorityAppIds.size,
    queuedIdling: state.idleWanted ? state.desiredIdling.filter(appid => !active.has(appid)) : [],
    idleMaxConcurrent: IDLE_MAX_CONCURRENT,
    idleRotateMinutes: IDLE_ROTATE_MINUTES,
    playtimeSyncMinutes: PLAYTIME_SYNC_MINUTES,
    libraryCount: library.length,
    hasSavedLogin: hasSavedLogin(),
    cloudTokenConfigured: !!ENV_REFRESH_TOKEN,
    manualAppCount: manualAppIds.size,
    autoStart: AUTO_START,
    defaultAppIds: DEFAULT_APPIDS
  };
}

// Keep desiredIdling and idleWanted intact during network-only failures.
// A stopped game or a confirmed concurrent playing session still clears intent.
function armSteamRecovery(reason: string, waitMs = RECONNECT_GRACE_MS) {
  if (state.shuttingDown || state.recoveryBlocked) return;
  const deadline = Date.now() + Math.max(0, waitMs);
  if (!state.recoveryNextRetryAt || deadline < state.recoveryNextRetryAt) {
    state.recoveryNextRetryAt = deadline;
  }
  state.recoveryLastReason = reason;
  state.reconnecting = true;
}

function retrySteamConnection(reason: string, force = false): boolean {
  if (state.shuttingDown || state.connected) return false;
  if (state.recoveryBlocked && !force) return false;
  if (force) {
    state.recoveryBlocked = false;
    state.sessionConflictCount = 0;
    state.recoveryAttempts = 0;
  }
  let token: string | null = null;
  try { token = loadRefreshToken(); }
  catch (err) {
    state.recoveryBlocked = true;
    state.reconnecting = false;
    state.connecting = false;
    state.recoveryNextRetryAt = null;
    state.message = `Saved Steam login cannot be loaded: ${err.message}. Sign in again with QR.`;
    runtimeLog('ERROR', state.message);
    return false;
  }
  if (!token) {
    state.recoveryBlocked = true;
    state.reconnecting = false;
    state.connecting = false;
    state.recoveryNextRetryAt = null;
    state.message = 'No saved Steam login. Sign in with QR.';
    return false;
  }
  state.recoveryAttempts += 1;
  state.recoveryLastReason = reason;
  state.reconnecting = true;
  state.connecting = false; // The previous login attempt may be stuck forever.
  state.recoveryNextRetryAt = Date.now() + Math.max(CONNECT_TIMEOUT_MS, recoveryBackoffMs(state.recoveryAttempts));
  diagnostic('steam.recovery_attempt', { reason, attempt: state.recoveryAttempts });
  runtimeLog('WARN', `Steam recovery attempt #${state.recoveryAttempts} (${reason}); recreating connection without clearing idle intent`);
  try {
    connectWithRefreshToken(token, true);
    return true;
  } catch (err) {
    state.connecting = false;
    state.reconnecting = true;
    state.connectingSince = null;
    state.recoveryNextRetryAt = Date.now() + recoveryBackoffMs(state.recoveryAttempts);
    state.message = `Steam recovery attempt failed: ${err.message}; retry scheduled.`;
    runtimeLog('WARN', state.message);
    return false;
  }
}

function attachSteamEvents(client: any) {
  client.on('webSession', (_sessionID, cookies) => {
    webCookies = Array.isArray(cookies) ? cookies.slice() : [];
  });

  client.on('loggedOn', () => {
    if (steam !== client) return;
    const wasReconnecting = state.reconnecting;
    state.connected = true;
    state.connecting = false;
    state.reconnecting = false;
    diagnostic('steam.logged_on');
    state.sessionConflict = false;
    state.recoveryAttempts = 0;
    state.recoveryNextRetryAt = null;
    state.recoveryLastReason = null;
    state.recoveryBlocked = false;
    state.connectingSince = null;
    state.sessionConflictCount = 0;
    state.lastSessionConflictAt = null;
    state.externalPlaying = false;
    state.externalPlayingApp = 0;
    state.steamID = client.steamID ? client.steamID.getSteamID64() : state.steamID;
    state.accountName = state.accountName || client.accountInfo?.name || null;
    state.lastConnectedAt = Date.now();
    state.message = wasReconnecting ? 'Reconnected to Steam' : 'Connected to Steam';
    state.qrDataUrl = null;
    state.qrStatus = 'done';

    runtimeLog('INFO', `${wasReconnecting ? 'Reconnected' : 'Connected'} to Steam (logonID=${steamLogonID})`);

    if (!state.libraryReady || !library.length) {
      refreshLibrary()
        .then(async () => {
          tryCloudAutoStart();
          if (!CLOUD_MODE && AUTO_START && DEFAULT_APPIDS.length && !state.idleWanted && !state.externalPlaying) {
            try {
              startIdle(DEFAULT_APPIDS);
              runtimeLog('INFO', `Cloud/default auto-start armed ${DEFAULT_APPIDS.length} AppIDs`);
            } catch (err) {
              runtimeLog('WARN', `Auto-start skipped: ${err.message}`);
            }
          }
          try {
            await refreshCardData();
          } catch (err) {
            state.cardScanError = err.message;
            state.message = `Card scan error: ${err.message}`;
          }
        })
        .catch(err => {
          state.libraryError = err.message;
          state.message = `Library error: ${err.message}`;
        });
    } else if (CLOUD_MODE) {
      tryCloudAutoStart();
    } else if (AUTO_START && DEFAULT_APPIDS.length && !state.idleWanted && !state.externalPlaying) {
      try { startIdle(DEFAULT_APPIDS); } catch (err) { runtimeLog('WARN', `Auto-start skipped: ${err.message}`); }
    }

    scheduleIdleRestore(client, wasReconnecting ? 'Steam reconnect' : 'login', LOGIN_PLAYING_STATE_GRACE_MS);
  });

  client.on('playingState', (blocked, playingApp) => {
    if (steam !== client) return;
    const wasBlocked = state.externalPlaying || state.idleSuspended;
    const appid = Number(playingApp || 0);
    state.externalPlaying = !!blocked;
    state.externalPlayingApp = blocked ? appid : 0;
    diagnostic('steam.playing_state', { blocked: !!blocked, appid });

    if (blocked) {
      cancelIdleRestore();
      cancelIdleRotation();
      if (state.idling.length) {
        try { client.gamesPlayed([]); } catch (err) {
          runtimeLog('WARN', `Could not clear idle during yield: ${err?.message || err}`);
        }
      }
      state.idling = [];
      // Never erase desiredIdling or idleWanted here. PlayingState is a
      // temporary blocker, not an explicit user Stop.
      state.idleSuspended = hasPendingIdle(state);
      state.message = appid
        ? `Yielding to Steam Desktop (App ${appid}); will auto-resume idle when it stops.`
        : 'Yielding to another Steam session; will auto-resume idle when it stops.';
      runtimeLog('INFO', `Steam reports external playing AppID=${appid}; idle armed=${state.idleWanted}, desired=${state.desiredIdling.length}`);
    } else if (wasBlocked && hasPendingIdle(state)) {
      state.idleSuspended = false;
      state.message = 'Other Steam session stopped; resuming idle...';
      runtimeLog('INFO', 'Steam reported external playing stopped; restoring idle');
      scheduleIdleRestore(client, 'Steam Desktop stopped playing', UNBLOCK_RESUME_DELAY_MS);
    } else if (wasBlocked) {
      state.idleSuspended = false;
      state.message = 'Other Steam session stopped. No idle requested.';
    }
  });

  client.on('disconnected', (eresult, msg) => {
    if (steam !== client) return;
    webCookies = [];
    state.connected = false;
    state.connecting = false;
    state.idling = [];
    state.connectingSince = null;
    // A previously blocked session is unknown after a network drop. The
    // post-login grace period + playingState event will determine whether the
    // other Steam client is still in-game.
    state.externalPlaying = false;
    state.externalPlayingApp = 0;
    cancelIdleRestore();
    cancelIdleRotation();

    if (state.shuttingDown) return;

    state.reconnecting = true;
    state.reconnectCount += 1;
    state.lastDisconnect = {
      at: Date.now(),
      eresult: Number(eresult || 0),
      message: msg || null
    };
    state.message = state.idleWanted
      ? `Steam connection lost${msg ? `: ${msg}` : ''}. Reconnecting; idle will resume automatically...`
      : `Steam connection lost${msg ? `: ${msg}` : ''}. Reconnecting...`;

    diagnostic('steam.disconnected', { eresult: Number(eresult || 0), reason: String(msg || '').slice(0,120) });
    armSteamRecovery('Steam CM disconnected', RECONNECT_GRACE_MS);
    runtimeLog('WARN', `Disconnected (EResult=${Number(eresult || 0)}${msg ? `, ${msg}` : ''}); autoRelogin active, watchdog armed`);
  });

  client.on('error', (err: any) => {
    if (steam !== client) return;
    state.connected = false;
    state.connecting = false;
    state.connectingSince = null;
    state.idling = [];
    state.externalPlaying = false;
    state.externalPlayingApp = 0;
    cancelIdleRestore();
    cancelIdleRotation();
    if (state.shuttingDown) return;

    state.lastDisconnect = {
      at: Date.now(),
      eresult: Number(err?.eresult || 0),
      message: err?.message || String(err)
    };

    diagnostic('steam.error', { eresult: Number(err?.eresult || 0), errorCode: String(err?.code || err?.message || 'unknown').slice(0,120) });
    if (isSteamSessionConflict(err)) {
      const now = Date.now();
      state.sessionConflictCount = state.lastSessionConflictAt && now - state.lastSessionConflictAt < 600000
        ? state.sessionConflictCount + 1 : 1;
      state.lastSessionConflictAt = now;
      state.sessionConflict = true;
      // LoggedInElsewhere can mean login-identity collision OR that another
      // Steam session started a game. It is not proof idle was stopped by the
      // user. Reconnect without force/kick and wait for playingState.
      steamLogonID = generateLogonID();
      saveSettings();
      const waitMs = Math.max(30000, recoveryBackoffMs(state.sessionConflictCount));
      armSteamRecovery('Steam session conflict (non-forcing probe)', waitMs);
      // armSteamRecovery only moves the retry earlier: enforce the longer
      // conflict cooldown so multiple logins never hammer the active client.
      state.recoveryNextRetryAt = now + waitMs;
      state.idleSuspended = hasPendingIdle(state);
      state.message = `Steam session conflict. Waiting ${Math.round(waitMs / 1000)}s before retry; idle selection retained.`;
      diagnostic('steam.session_conflict', { retryInMs: waitMs, logonIDChanged: true });
      runtimeLog('WARN', `LoggedInElsewhere; rotated logonID, retry in ${waitMs}ms, idle desired=${state.desiredIdling.length}`);
      return;
    }

    if (isSteamAuthRejection(err)) {
      state.recoveryBlocked = true;
      state.reconnecting = false;
      state.recoveryNextRetryAt = null;
      state.message = `Steam rejected the saved login (${err?.message || 'authentication error'}). Sign in again with QR.`;
      runtimeLog('ERROR', state.message);
      return;
    }

    armSteamRecovery('Steam client error', Math.min(30000, recoveryBackoffMs(state.recoveryAttempts + 1)));
    state.message = `Steam connection error: ${err?.message || err}. Automatic reconnect scheduled; idle selection preserved.`;
    runtimeLog('WARN', `Steam error EResult=${Number(err?.eresult || 0)}: ${err?.message || err}; recovery armed`);
  });

  client.on('refreshToken', token => {
    try {
      saveRefreshToken(token);
      runtimeLog('INFO', 'Steam refresh token renewed and saved');
    } catch (err) {
      runtimeLog('ERROR', `Credential save failed: ${err.message}`);
    }
  });
}

function disposeSteamClient() {
  if (!steam) return;
  try { steam.removeAllListeners(); } catch (_) {}
  try { steam.logOff(); } catch (_) {}
  steam = null;
}

function connectWithRefreshToken(token: string, recovering = false) {
  if (state.connected || (state.connecting && !recovering)) return;
  disposeSteamClient();

  steam = new SteamUser({
    renewRefreshTokens: true,
    enablePicsCache: true,
    autoRelogin: true
  });
  attachSteamEvents(steam);
  state.connecting = true;
  state.connectingSince = Date.now();
  state.reconnecting = recovering;
  state.sessionConflict = false;
  if (!recovering) state.recoveryNextRetryAt = Date.now() + CONNECT_TIMEOUT_MS;
  state.message = recovering ? 'Recovering Steam connection; keeping idle selection...' : 'Connecting to Steam...';
  diagnostic('steam.connect_attempt', { source: recovering ? 'recovery' : 'initial' });
  runtimeLog('INFO', `Connecting to Steam (logonID=${steamLogonID})`);
  steam.logOn({
    refreshToken: token,
    machineName: 'O-Steam-Idle',
    logonID: steamLogonID
  });
}

async function beginQRLogin(): Promise<void> {
  if (state.connected || state.connecting) throw new Error('Steam client is already connected/connecting');
  state.recoveryBlocked = false;
  state.recoveryNextRetryAt = null;
  state.recoveryAttempts = 0;
  if (loginSession) {
    try { loginSession.cancelLoginAttempt(); } catch (_) {}
  }
  state.qrDataUrl = null;
  state.qrStatus = 'creating';
  state.message = 'Creating Steam QR...';

  // SteamClient is intentional: this refresh token is directly usable by steam-user.
  loginSession = new LoginSession(EAuthTokenPlatformType.SteamClient, {
    machineName: 'O-Steam-Idle'
  });
  loginSession.loginTimeout = 120000;

  loginSession.on('remoteInteraction', () => {
    state.qrStatus = 'scanned';
    state.message = 'QR scanned. Approve the login in Steam Mobile.';
  });
  loginSession.on('timeout', () => {
    state.qrStatus = 'timeout';
    state.qrDataUrl = null;
    state.message = 'QR login timed out. Generate a new QR.';
  });
  loginSession.on('error', err => {
    state.qrStatus = 'error';
    state.qrDataUrl = null;
    state.message = `QR login failed: ${err.message}`;
    console.error('[steam-session]', err);
  });
  loginSession.on('authenticated', () => {
    try {
      const token = loginSession.refreshToken;
      if (!token) throw new Error('Steam did not return a refresh token');
      state.accountName = loginSession.accountName || null;
      state.steamID = loginSession.steamID ? loginSession.steamID.getSteamID64() : null;
      saveRefreshToken(token);
      state.qrStatus = 'approved';
      state.message = 'QR approved. Connecting Steam client...';
      connectWithRefreshToken(token);
    } catch (err) {
      state.qrStatus = 'error';
      state.message = `Could not finish login: ${err.message}`;
    }
  });

  const result = await loginSession.startWithQR({ persistence: ESessionPersistence.Persistent });
  state.qrDataUrl = await QRCode.toDataURL(result.qrChallengeUrl, {
    width: 300,
    margin: 2,
    errorCorrectionLevel: 'M'
  });
  state.qrStatus = 'waiting';
  state.message = 'Scan the QR with Steam Mobile and approve.';
}


function requestText(url: string, headers: Record<string, string> = {}, redirectsLeft = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch (err) { return reject(err); }
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(target, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Oppai-Steam-Idler/0.1.2',
        'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'close',
        ...headers
      }
    }, res => {
      const status = Number(res.statusCode || 0);
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error(`Too many redirects while requesting ${target.hostname}`));
        const next = new URL(location, target).toString();
        return resolve(requestText(next, headers, redirectsLeft - 1));
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (status < 200 || status >= 300) {
          return reject(new Error(`${target.hostname}: HTTP ${status}`));
        }
        resolve(body);
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error(`${target.hostname}: request timed out`)));
    req.on('error', err => reject(new Error(`${target.hostname}: ${err.code || err.name || 'request error'}: ${err.message}`)));
    req.end();
  });
}

function extractJsonArrayAfterMarker(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = text.indexOf('[', markerIndex + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); }
        catch (_) { return null; }
      }
    }
  }
  return null;
}

function hoursStringToMinutes(value: unknown): number {
  if (value == null) return 0;
  const n = Number(String(value).replace(/,/g, '').replace(/\s*hrs?.*$/i, '').trim());
  return Number.isFinite(n) ? Math.round(n * 60) : 0;
}

async function getProfilePlayedApps() {
  if (!steam?.steamID) throw new Error('Not connected');
  const cookies = await waitForWebSession();
  const steamID64 = steam.steamID.getSteamID64();
  const html = await requestText(
    `https://steamcommunity.com/profiles/${steamID64}/games/?tab=all&l=english`,
    { 'Cookie': cookies.join('; ') }
  );
  if (/g_steamID\s*=\s*false/i.test(html) || /login\/home/i.test(html)) {
    webCookies = [];
    throw new Error('Steam Community web session expired');
  }

  const candidates = [
    extractJsonArrayAfterMarker(html, 'var rgGames'),
    extractJsonArrayAfterMarker(html, 'rgGames ='),
    extractJsonArrayAfterMarker(html, 'rgGames'),
    extractJsonArrayAfterMarker(html, 'g_rgGameData')
  ].filter(Array.isArray);
  const games = candidates.find(x => x.length) || candidates[0] || [];
  const mapped = games.map(g => {
    const appid = Number(g.appid || g.appID || g.appId || 0);
    const playtime = Number.isFinite(Number(g.playtime_forever))
      ? Number(g.playtime_forever)
      : hoursStringToMinutes(g.hours_forever ?? g.hours ?? 0);
    const lastPlayed = Number(g.rtime_last_played || g.last_played || 0);
    const icon = g.img_icon_url || g.logo || g.icon || null;
    return {
      appid,
      name: g.name || g.friendlyURL || `App ${appid}`,
      playtime,
      lastPlayed,
      icon
    };
  }).filter(g => Number.isInteger(g.appid) && g.appid > 0);
  if (mapped.length) return mapped;

  // Steam has changed the Games page implementation several times. The XML
  // view is deprecated but remains a useful compatibility fallback when the
  // embedded rgGames payload isn't present.
  const xml = await requestText(
    `https://steamcommunity.com/profiles/${steamID64}/games/?tab=all&xml=1`,
    { 'Cookie': cookies.join('; ') }
  );
  const $xml = cheerio.load(xml, { xmlMode: true });
  const fallback = [];
  $xml('game').each((_i, el) => {
    const node = $xml(el);
    const appid = Number(node.find('appID').first().text().trim());
    if (!Number.isInteger(appid) || appid <= 0) return;
    fallback.push({
      appid,
      name: node.find('name').first().text().trim() || `App ${appid}`,
      playtime: hoursStringToMinutes(node.find('hoursOnRecord').first().text().trim()),
      lastPlayed: 0,
      icon: node.find('logoSmall').first().text().trim() || node.find('logo').first().text().trim() || null
    });
  });
  if (!fallback.length) throw new Error('Steam profile games page returned no parsable game list');
  return fallback;
}



function getProductInfoApps(appids: unknown[]): Promise<any> {
  const ids = [...new Set((appids || []).map(Number).filter(x => Number.isInteger(x) && x > 0))];
  if (!ids.length) return Promise.resolve({});
  return new Promise((resolve, reject) => {
    steam.getProductInfo(ids, [], true, (err, apps) => {
      if (err) return reject(err);
      resolve(apps || {});
    });
  });
}

async function getManualGames(): Promise<any[]> {
  const ids = [...manualAppIds];
  if (!ids.length) return [];
  let info = {};
  try { info = await getProductInfoApps(ids); }
  catch (err) { runtimeLog('WARN', `Manual AppID metadata lookup failed: ${err.message}`); }
  return ids.map(appid => {
    const appinfo = info?.[appid]?.appinfo || info?.[String(appid)]?.appinfo;
    const common = appinfo?.common || {};
    const type = String(common.type || '').toLowerCase();
    return {
      appid,
      name: common.name || `App ${appid}`,
      playtime: 0,
      lastPlayed: 0,
      icon: null,
      discoveredViaManual: true,
      manualType: type || null
    };
  });
}

async function getDynamicStoreGames(): Promise<any[]> {
  const cookies = await waitForWebSession();
  const raw = await requestText('https://store.steampowered.com/dynamicstore/userdata/?l=english', {
    'Cookie': cookies.join('; '),
    'Accept': 'application/json,text/plain,*/*',
    'User-Agent': 'Mozilla/5.0 SteamIdler/0.1.2'
  });
  let data;
  try { data = JSON.parse(raw); }
  catch (_) { throw new Error('dynamicstore/userdata returned non-JSON data'); }
  const ids: number[] = [...new Set<number>((data?.rgOwnedApps || []).map(Number).filter((x: number) => Number.isInteger(x) && x > 0))];
  if (!ids.length) return [];

  const info = await getProductInfoApps(ids);
  const games = [];
  for (const appid of ids) {
    const appinfo = info?.[appid]?.appinfo || info?.[String(appid)]?.appinfo;
    const common = appinfo?.common || {};
    const type = String(common.type || '').toLowerCase();
    if (type !== 'game') continue;
    games.push({
      appid,
      name: common.name || `App ${appid}`,
      playtime: 0,
      lastPlayed: 0,
      icon: null,
      discoveredViaDynamicStore: true
    });
  }
  runtimeLog('INFO', `Dynamic Store discovery: ${ids.length} owned app ids -> ${games.length} game apps`);
  return games;
}

function findLocalSteamPaths() {
  const out = [];
  if (process.platform !== 'win32') return out;
  try {
    const r = ps('(Get-ItemProperty -Path "HKCU:\\Software\\Valve\\Steam" -ErrorAction SilentlyContinue).SteamPath');
    const v = String(r.stdout || '').trim();
    if (v) out.push(v);
  } catch (_) {}
  const pf86 = process.env['ProgramFiles(x86)'];
  const pf = process.env.ProgramFiles;
  if (pf86) out.push(path.join(pf86, 'Steam'));
  if (pf) out.push(path.join(pf, 'Steam'));
  return [...new Set(out.map(x => path.resolve(x)).filter(x => fs.existsSync(x)))];
}

function extractAppsSection(text) {
  const lower = text.toLowerCase();
  const marker = lower.lastIndexOf('"apps"');
  if (marker < 0) return '';
  const start = text.indexOf('{', marker);
  if (start < 0) return '';
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return '';
}

function currentSteamAccountId(): number | null {
  if (!steam?.steamID) return null;
  try {
    const direct = Number(steam.steamID.accountid);
    if (Number.isInteger(direct) && direct > 0) return direct;
  } catch (_) {}
  try {
    const id64 = BigInt(steam.steamID.getSteamID64());
    const base = 76561197960265728n;
    const accountId = Number(id64 - base);
    return Number.isInteger(accountId) && accountId > 0 ? accountId : null;
  } catch (_) { return null; }
}

function parseLocalAppsWithEvidence(section) {
  const out = [];
  let i = 0;
  while (i < section.length) {
    const m = /"(\d{2,10})"\s*\{/.exec(section.slice(i));
    if (!m) break;
    const appid = Number(m[1]);
    const blockStart = i + m.index + m[0].lastIndexOf('{');
    let depth = 0, inString = false, escaped = false, end = -1;
    for (let j = blockStart; j < section.length; j++) {
      const ch = section[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end < 0) break;
    const block = section.slice(blockStart + 1, end);
    const readNum = key => {
      const mm = new RegExp(`"${key}"\\s*"(\\d+)"`, 'i').exec(block);
      return mm ? Number(mm[1]) : 0;
    };
    const lastPlayed = readNum('LastPlayed');
    const playtime = Math.max(readNum('Playtime'), readNum('Playtime2wks'), readNum('PlaytimeForever'));
    // localconfig contains lots of incidental app cache entries. Only accept
    // entries with actual per-account play evidence; this avoids importing
    // unrelated F2P/catalog apps the user never had.
    if (Number.isInteger(appid) && appid > 0 && (lastPlayed > 0 || playtime > 0)) {
      out.push({ appid, lastPlayed, playtime });
    }
    i = end + 1;
  }
  return out;
}

async function getLocalSteamHistoryGames(): Promise<any[]> {
  if (process.platform !== 'win32') return [];
  const accountId = currentSteamAccountId();
  if (!accountId) throw new Error('Could not resolve current Steam account id');

  const evidence = new Map();
  for (const steamPath of findLocalSteamPaths()) {
    // IMPORTANT: only inspect the currently logged-in Steam account. The old
    // scanner walked every userdata folder and therefore imported games from
    // other accounts / stale local cache entries.
    const file = path.join(steamPath, 'userdata', String(accountId), 'config', 'localconfig.vdf');
    if (!fs.existsSync(file)) continue;
    try {
      const section = extractAppsSection(fs.readFileSync(file, 'utf8'));
      for (const row of parseLocalAppsWithEvidence(section)) {
        const prev = evidence.get(row.appid) || { appid: row.appid, lastPlayed: 0, playtime: 0 };
        prev.lastPlayed = Math.max(prev.lastPlayed, row.lastPlayed || 0);
        prev.playtime = Math.max(prev.playtime, row.playtime || 0);
        evidence.set(row.appid, prev);
      }
    } catch (_) {}
  }

  const ids = [...evidence.keys()];
  if (!ids.length) return [];
  const info = await getProductInfoApps(ids);
  const games = [];
  for (const appid of ids) {
    const appinfo = info?.[appid]?.appinfo || info?.[String(appid)]?.appinfo;
    const common = appinfo?.common || {};
    if (String(common.type || '').toLowerCase() !== 'game') continue;
    const ev = evidence.get(appid) || {};
    games.push({
      appid,
      name: common.name || `App ${appid}`,
      playtime: Number(ev.playtime || 0),
      lastPlayed: Number(ev.lastPlayed || 0),
      icon: null,
      discoveredViaLocalSteam: true
    });
  }
  runtimeLog('INFO', `Local Steam current-account discovery: account=${accountId}; ${ids.length} played app ids -> ${games.length} game apps`);
  return games;
}

function getUserOwnedApps(): Promise<any[]> {
  return new Promise((resolve, reject) => {
    if (!steam?.steamID) return reject(new Error('Not connected'));
    steam.getUserOwnedApps(steam.steamID, { includePlayedFreeGames: true, includeFreeSub: true }, (err, result) => {
      if (err) return reject(err);
      const apps = result?.apps || result?.games || [];
      resolve(apps);
    });
  });
}

function waitForOwnershipCached(timeoutMs = 20000): Promise<number[]> {
  if (!steam) return Promise.reject(new Error('Not connected'));
  try {
    const existing = steam.getOwnedApps();
    if (Array.isArray(existing) && existing.length) return Promise.resolve(existing);
  } catch (_) {}

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for ownership cache')), timeoutMs);
    steam.once('ownershipCached', () => {
      clearTimeout(timer);
      try { resolve(steam.getOwnedApps()); }
      catch (err) { reject(err); }
    });
  });
}

async function refreshLibrary() {
  if (!state.connected || !steam) throw new Error('Not connected to Steam');
  state.libraryReady = false;
  state.libraryError = null;
  state.message = 'Scanning Steam library + played/free games...';

  let ownedApps = [];
  let profileApps = [];
  let dynamicStoreApps = [];
  let localSteamApps = [];
  let manualApps = [];
  let ownedError = null;
  let profileError = null;
  let dynamicStoreError = null;
  let localSteamError = null;

  try {
    ownedApps = await getUserOwnedApps();
  } catch (err) {
    ownedError = err;
    try {
      const ids = await waitForOwnershipCached();
      ownedApps = ids.map(appid => ({ appid: Number(appid), name: `App ${appid}` }));
    } catch (fallbackErr) {
      ownedError = new Error(`${err.message}; ownership cache: ${fallbackErr.message}`);
    }
  }

  // Steam's owned-games endpoint can omit Free-to-Play titles even when they
  // appear on the account's Games page. Merge that page so the idler can
  // discover and idle those AppIDs too.
  try {
    profileApps = await getProfilePlayedApps();
  } catch (err) {
    profileError = err;
    runtimeLog('WARN', `Profile/F2P discovery failed: ${err.message}`);
  }

  // The Community games page and GetOwnedGames can still omit F2P/free-on-demand
  // licenses. The authenticated Store endpoint exposes a broader account app set.
  // Filter it through PICS so DLC/tools aren't accidentally treated as games.
  try {
    dynamicStoreApps = await getDynamicStoreGames();
  } catch (err) {
    dynamicStoreError = err;
    runtimeLog('WARN', `Dynamic Store discovery failed: ${err.message}`);
  }

  try {
    manualApps = await getManualGames();
  } catch (err) {
    runtimeLog('WARN', `Manual AppID discovery failed: ${err.message}`);
  }

  // Last fallback for Steam Desktop users: localconfig.vdf contains app history,
  // including F2P titles that may not have a durable ownership license anymore.
  try {
    localSteamApps = await getLocalSteamHistoryGames();
  } catch (err) {
    localSteamError = err;
    runtimeLog('WARN', `Local Steam history discovery failed: ${err.message}`);
  }

  const merged = new Map();
  for (const a of ownedApps) {
    const appid = Number(a.appid);
    if (!Number.isInteger(appid) || appid <= 0) continue;
    merged.set(appid, {
      appid,
      name: a.name || `App ${appid}`,
      playtime: Number(a.playtime_forever || a.playtime || 0),
      lastPlayed: Number(a.rtime_last_played || a.lastPlayed || 0),
      icon: a.img_icon_url || a.icon || null,
      discoveredViaProfile: false,
      hasCards: null,
      cardDrops: null
    });
  }
  const mergeExtra = (apps, sourceFlag) => {
    for (const a of apps) {
      const appid = Number(a.appid);
      if (!Number.isInteger(appid) || appid <= 0) continue;
      const prev = merged.get(appid);
      if (prev) {
        merged.set(appid, {
          ...prev,
          name: (!prev.name || /^App \d+$/.test(prev.name)) ? (a.name || prev.name) : prev.name,
          playtime: Math.max(Number(prev.playtime || 0), Number(a.playtime || 0)),
          lastPlayed: Math.max(Number(prev.lastPlayed || 0), Number(a.lastPlayed || 0)),
          icon: prev.icon || a.icon || null,
          [sourceFlag]: true
        });
      } else {
        merged.set(appid, {
          ...a,
          [sourceFlag]: true,
          hasCards: null,
          cardDrops: null
        });
      }
    }
  };
  mergeExtra(profileApps, 'discoveredViaProfile');
  // Dynamic Store is useful diagnostics/corroboration, but rgOwnedApps is broader
  // than the visible game library and can include stale/free-on-demand app ownership.
  // Do not add store-only apps to the idle library.
  mergeExtra(localSteamApps, 'discoveredViaLocalSteam');
  mergeExtra(manualApps, 'discoveredViaManual');

  library = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (!library.length && ownedError) throw ownedError;

  const profileOnly = library.filter(x => x.discoveredViaProfile).length;
  const dynamicOnly = library.filter(x => x.discoveredViaDynamicStore && !ownedApps.some(a => Number(a.appid) === x.appid)).length;
  const localOnly = library.filter(x => x.discoveredViaLocalSteam && !ownedApps.some(a => Number(a.appid) === x.appid) && !dynamicStoreApps.some(a => Number(a.appid) === x.appid)).length;
  const warnings = [];
  if (ownedError) warnings.push(`owned metadata: ${ownedError.message}`);
  if (profileError) warnings.push(`F2P/profile discovery: ${profileError.message}`);
  if (dynamicStoreError) warnings.push(`dynamic store: ${dynamicStoreError.message}`);
  if (localSteamError) warnings.push(`local Steam history: ${localSteamError.message}`);
  state.libraryError = warnings.length ? `Partial scan (${warnings.join(' | ')})` : null;
  state.libraryReady = true;
  state.cardScanReady = false;
  state.cardScanError = null;
  state.cardGames = 0;
  state.cardDropsRemaining = 0;
  state.playtimeSyncAt = Date.now();
  state.playtimeRevision += 1;
  state.playtimeSyncError = null;
  state.message = `Library loaded: ${library.length} apps · owned/profile/manual = ${ownedApps.length}/${profileApps.length}/${manualApps.length}`;
  runtimeLog('INFO', `Library loaded: ${library.length} apps; sources owned=${ownedApps.length}, profile=${profileApps.length}, dynamicStoreDiag=${dynamicStoreApps.length}, localPlayed=${localSteamApps.length}, manual=${manualApps.length}; store-only ignored=${dynamicOnly}, local-added=${localOnly}`);
  return library;
}

async function refreshPlaytimeSnapshot() {
  if (!state.connected || !steam) throw new Error('Not connected to Steam');
  if (state.playtimeSyncing) return 0;
  state.playtimeSyncing = true;
  state.playtimeSyncError = null;
  try {
    const [ownedResult, profileResult] = await Promise.allSettled([getUserOwnedApps(), getProfilePlayedApps()]);
    const updates = new Map<number, { playtime: number; lastPlayed: number }>();
    const absorb = (apps: any[], ownedShape: boolean) => {
      for (const app of apps || []) {
        const appid = Number(app.appid);
        if (!Number.isInteger(appid) || appid <= 0) continue;
        const playtime = Number(ownedShape ? (app.playtime_forever || app.playtime || 0) : (app.playtime || 0));
        const lastPlayed = Number(ownedShape ? (app.rtime_last_played || app.lastPlayed || 0) : (app.lastPlayed || 0));
        const prev = updates.get(appid) || { playtime: 0, lastPlayed: 0 };
        updates.set(appid, { playtime: Math.max(prev.playtime, playtime), lastPlayed: Math.max(prev.lastPlayed, lastPlayed) });
      }
    };
    if (ownedResult.status === 'fulfilled') absorb(ownedResult.value, true);
    if (profileResult.status === 'fulfilled') absorb(profileResult.value, false);
    if (!updates.size) {
      const ownedErr = ownedResult.status === 'rejected' ? ownedResult.reason?.message || String(ownedResult.reason) : 'no owned data';
      const profileErr = profileResult.status === 'rejected' ? profileResult.reason?.message || String(profileResult.reason) : 'no profile data';
      throw new Error(`No playtime source available (owned: ${ownedErr}; profile: ${profileErr})`);
    }
    let changed = 0;
    library = library.map(app => {
      const update = updates.get(app.appid);
      if (!update) return app;
      const playtime = Math.max(Number(app.playtime || 0), update.playtime);
      const lastPlayed = Math.max(Number(app.lastPlayed || 0), update.lastPlayed);
      if (playtime !== Number(app.playtime || 0) || lastPlayed !== Number(app.lastPlayed || 0)) changed += 1;
      return { ...app, playtime, lastPlayed };
    });
    state.playtimeSyncAt = Date.now();
    state.playtimeRevision += 1;
    runtimeLog('INFO', `Playtime snapshot synced: ${updates.size} source apps, ${changed} library rows changed`);
    return changed;
  } catch (err) {
    state.playtimeSyncError = err.message || String(err);
    runtimeLog('WARN', `Playtime sync failed: ${state.playtimeSyncError}`);
    throw err;
  } finally {
    state.playtimeSyncing = false;
  }
}

function waitForWebSession(timeoutMs = 15000): Promise<string[]> {
  if (webCookies.length) return Promise.resolve(webCookies);
  if (!steam || !state.connected) return Promise.reject(new Error('Not connected to Steam'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for Steam web session'));
    }, timeoutMs);
    const onWeb = (_sessionID, cookies) => {
      cleanup();
      webCookies = Array.isArray(cookies) ? cookies.slice() : [];
      resolve(webCookies);
    };
    const cleanup = () => {
      clearTimeout(timer);
      steam?.removeListener('webSession', onWeb);
    };
    steam.on('webSession', onWeb);
    try { steam.webLogOn(); } catch (err) { cleanup(); reject(err); }
  });
}

function parseAppIdFromBadgeRow($, row) {
  const links = [
    $(row).find('.badge_row_overlay[href*="/gamecards/"]').attr('href'),
    $(row).find('.badge_title_playgame a[href*="/app/"]').attr('href'),
    $(row).find('a[href*="/gamecards/"]').first().attr('href')
  ].filter(Boolean);
  for (const href of links) {
    let m = String(href).match(/\/gamecards\/(\d+)/i);
    if (m) return Number(m[1]);
    m = String(href).match(/\/app\/(\d+)/i);
    if (m) return Number(m[1]);
  }
  return 0;
}

async function refreshCardData() {
  if (!state.connected || !steam?.steamID) throw new Error('Not connected to Steam');
  if (state.cardScanRunning) return;
  state.cardScanRunning = true;
  state.cardScanReady = false;
  state.cardScanError = null;
  state.message = 'Scanning Steam card drops...';

  try {
    const cookies = await waitForWebSession();
    const cookieHeader = cookies.join('; ');
    const steamID64 = steam.steamID.getSteamID64();
    const cardMap = new Map();
    let page = 1;
    let lastPage = 1;

    do {
      const url = `https://steamcommunity.com/profiles/${steamID64}/badges/?l=english&p=${page}`;
      const html = await requestText(url, { 'Cookie': cookieHeader });
      if (html.includes('g_steamID = false')) {
        webCookies = [];
        throw new Error('Steam web session expired; retry Refresh cards');
      }

      const $ = cheerio.load(html);
      $('.badge_row').each((_i, row) => {
        const appid = parseAppIdFromBadgeRow($, row);
        if (!appid) return;

        const info = $(row).find('.progress_info_bold').first().text().trim();
        const match = info.match(/(\d+)\s+card\s+drop/i) || info.match(/(\d+)/);
        const drops = match ? Number(match[1]) : 0;
        const prev = cardMap.get(appid);
        cardMap.set(appid, {
          hasCards: true,
          cardDrops: Number.isFinite(drops) ? drops : 0,
          // Preserve the highest number if Steam happens to show duplicate badge rows.
          ...(prev && prev.cardDrops > drops ? prev : {})
        });
      });

      const pageNums = $('.pagelink').map((_i, el) => Number($(el).text().trim())).get().filter(Number.isFinite);
      if (pageNums.length) lastPage = Math.max(lastPage, ...pageNums);
      page += 1;
    } while (page <= lastPage && page <= 200);

    let cardGames = 0;
    let dropsTotal = 0;
    library = library.map(app => {
      const card = cardMap.get(app.appid);
      if (!card) return { ...app, hasCards: null, cardDrops: null };
      cardGames += 1;
      dropsTotal += card.cardDrops;
      return { ...app, ...card };
    });

    state.cardGames = cardGames;
    state.cardDropsRemaining = dropsTotal;
    state.cardScanReady = true;
    state.message = `Cards scanned: ${cardGames} card games · ${dropsTotal} drops remaining`;
  } catch (err) {
    state.cardScanError = err.message || String(err);
    state.message = `Card scan error: ${state.cardScanError}`;
    runtimeLog('ERROR', `Card scan failed: ${state.cardScanError}`);
    throw err;
  } finally {
    state.cardScanRunning = false;
  }
}

function startIdle(appids: unknown[]) {
  if (!state.connected || !steam) throw new Error('Not connected to Steam');

  const owned = new Set(library.map(x => x.appid));
  const requested = appids.map(Number).filter(x => Number.isInteger(x) && x > 0 && owned.has(x));
  const priorityOwned = [...priorityAppIds].filter(appid => owned.has(appid));
  const clean = [...new Set([...priorityOwned, ...requested])];
  if (!clean.length) throw new Error('Select at least one owned game');
  if (priorityOwned.length >= IDLE_MAX_CONCURRENT && clean.length > IDLE_MAX_CONCURRENT) {
    throw new Error(`${IDLE_MAX_CONCURRENT} priority games occupy every Steam slot. Unpin at least one priority game before starting a larger idle set.`);
  }

  cancelIdleRestore();
  cancelIdleRotation();

  state.desiredIdling = clean.slice();
  state.idleWanted = true;
  state.selected = clean.slice();
  const blocked = shouldYieldIdle({ ...state, clientBlocked: !!steam.playingState?.blocked });
  state.idleSuspended = blocked;
  state.idleBatchIndex = 0;
  state.idleBatchCount = planIdleBatches(clean).batches.length;
  diagnostic('idle.start', { desiredAppIds: clean });
  try {
    if (blocked) {
      state.idling = [];
      state.message = 'Idle armed; waiting for Steam Desktop to stop playing.';
      runtimeLog('INFO', `Idle armed while another session is playing: ${clean.length} games`);
    } else {
      applyIdleBatch(steam, 0, 'start');
    }
  } catch (err) {
    state.idling = [];
    state.desiredIdling = [];
    state.idleWanted = false;
    state.idleBatchIndex = 0;
    state.idleBatchCount = 0;
    throw err;
  }
  if (cloudBootConfig) {
    cloudBootConfig.idleWanted = state.idleWanted;
    cloudBootConfig.desiredIdling = state.desiredIdling.slice();
  }
  saveSettings();
}

function stopIdle() {
  diagnostic('idle.stop_requested', { previousActiveCount: state.idling.length, previousDesiredCount: state.desiredIdling.length });
  cancelIdleRestore();
  cancelIdleRotation();
  if (steam && state.connected) {
    try { steam.gamesPlayed([]); } catch (_) {}
  }
  state.idling = [];
  state.desiredIdling = [];
  state.idleWanted = false;
  state.idleSuspended = false;
  state.idleBatchIndex = 0;
  state.idleBatchCount = 0;
  state.idleRotationAt = null;
  if (cloudBootConfig) {
    cloudBootConfig.idleWanted = false;
    cloudBootConfig.desiredIdling = [];
  }
  state.message = 'Idle stopped';
  runtimeLog('INFO', 'Idle stopped');
}

function logoutForget() {
  stopIdle();
  if (loginSession) {
    try { loginSession.cancelLoginAttempt(); } catch (_) {}
    loginSession = null;
  }
  if (steam) {
    try { steam.logOff(); } catch (_) {}
    steam = null;
  }
  forgetRefreshToken();
  library = [];
  state.connected = false;
  state.connecting = false;
  state.libraryReady = false;
  state.cardScanReady = false;
  state.cardScanRunning = false;
  state.cardScanError = null;
  state.cardGames = 0;
  state.cardDropsRemaining = 0;
  webCookies = [];
  state.qrDataUrl = null;
  state.qrStatus = 'idle';
  state.steamID = null;
  state.accountName = null;
  state.idling = [];
  state.externalPlaying = false;
  state.externalPlayingApp = 0;
  state.idleSuspended = false;
  state.sessionConflict = false;
  state.reconnecting = false;
  state.recoveryNextRetryAt = null;
  state.recoveryAttempts = 0;
  state.recoveryBlocked = false;
  state.connectingSince = null;
  state.idleWanted = false;
  state.desiredIdling = [];
  cancelIdleRestore();
  state.message = CLOUD_MODE && ENV_REFRESH_TOKEN
    ? 'Steam session disconnected. Cloudflare refresh-token secret is still configured.'
    : 'Logged out and saved token removed';
  runtimeLog('INFO', CLOUD_MODE && ENV_REFRESH_TOKEN
    ? 'Logged out current Steam session; cloud refresh-token secret remains configured'
    : 'Logged out and removed saved token');
}

let shutdownStarted = false;
function gracefulShutdown(reason = 'shutdown') {
  if (shutdownStarted) return;
  diagnostic('process.shutdown', { reason });
  shutdownStarted = true;
  state.shuttingDown = true;
  state.message = 'Shutting down...';
  cancelIdleRestore();
  cancelIdleRotation();
  state.idleWanted = false;
  state.desiredIdling = [];
  state.idleBatchIndex = 0;
  state.idleBatchCount = 0;

  runtimeLog('INFO', `Graceful shutdown requested (${reason})`);

  // Stop advertising games before disconnecting from Steam.
  try {
    if (steam && state.connected) steam.gamesPlayed([]);
  } catch (err) {
    console.warn('[shutdown] could not clear gamesPlayed:', err?.message || err);
  }
  state.idling = [];

  try {
    if (loginSession) loginSession.cancelLoginAttempt();
  } catch (_) {}
  loginSession = null;

  try { steam?.logOff(); } catch (_) {}

  // Stop accepting new HTTP connections. A short force-exit fallback prevents a
  // hanging Steam socket from keeping a hidden Node process alive forever.
  const forceTimer = setTimeout(() => process.exit(0), 2000);
  forceTimer.unref?.();
  try {
    server.close(() => process.exit(0));
  } catch (_) {
    process.exit(0);
  }
}

function json(res: any, code: number, body: any) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'"
  });
  res.end(data);
}

function readJson(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (_) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req: any, res: any) {
  let p = req.url === '/' ? '/index.html' : req.url;
  p = p.split('?')[0];
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(file);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
    res.writeHead(200, {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'"
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/ping' || req.url === '/health')) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('ok');
      return;
    }
    if (CLOUD_MODE && req.method === 'GET' && req.url === '/api/cloud/state') {
      return json(res, 200, {
        version: 1, selected: state.selected, manualAppIds: [...manualAppIds],
        priorityAppIds: [...priorityAppIds], desiredIdling: state.desiredIdling,
        idleWanted: state.idleWanted
      });
    }
    if (CLOUD_MODE && req.method === 'POST' && req.url === '/api/cloud/bootstrap') {
      const incoming = await readJson(req);
      const priority = normalizeCloudAppIds(incoming.priorityAppIds).slice(0, IDLE_MAX_CONCURRENT);
      const selected = normalizeCloudAppIds([...normalizeCloudAppIds(incoming.selected), ...priority]);
      const manual = normalizeCloudAppIds(incoming.manualAppIds);
      const desired = normalizeCloudAppIds(incoming.desiredIdling);
      cloudBootConfig = {
        selected, priorityAppIds: priority, manualAppIds: manual,
        desiredIdling: desired,
        idleWanted: incoming.idleWanted === true && desired.length > 0
      };
      priorityAppIds = new Set(priority);
      manualAppIds.clear();
      for (const id of [...manual, ...desired]) manualAppIds.add(id);
      state.selected = selected;
      saveSettings();
      runtimeLog('INFO', `Cloud preferences restored: ${selected.length} selected, ${priority.length} priority, auto-idle=${cloudBootConfig.idleWanted}`);
      if (state.connected) {
        if (state.libraryReady) tryCloudAutoStart();
        else refreshLibrary().then(() => tryCloudAutoStart()).catch(err => runtimeLog('WARN', `Cloud bootstrap library: ${err.message}`));
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && req.url === '/api/status') return json(res, 200, sanitizeState());
    if (req.method === 'GET' && req.url === '/api/diagnostics/recent') return json(res, 200, { events: diagnostics.recent() });
    if (req.method === 'GET' && req.url === '/api/diagnostics/export') {
      const body = Buffer.from(diagnostics.exportText(), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="o-steam-idle-diagnostics.jsonl.txt"',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(body);
    }
    if (req.method === 'GET' && req.url === '/api/library') return json(res, 200, { apps: library, ready: state.libraryReady, error: state.libraryError });

    if (req.method === 'POST' && req.url === '/api/login/qr') {
      await beginQRLogin();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/api/login/saved') {
      state.recoveryBlocked = false;
      const token = loadRefreshToken();
      if (!token) return json(res, 404, { error: 'No saved login' });
      connectWithRefreshToken(token);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/api/session/recover') {
      if (state.connected) return json(res, 200, { ok: true, connected: true });
      if (!hasSavedLogin()) return json(res, 404, { error: 'No saved login; sign in with QR' });
      const attempted = retrySteamConnection('manual dashboard retry', true);
      return json(res, attempted ? 200 : 503, { ok: attempted, reconnecting: state.reconnecting, message: state.message });
    }
    if (req.method === 'POST' && req.url === '/api/session/recheck') {
      const token = loadRefreshToken();
      if (!token) return json(res, 404, { error: 'No saved login' });
      if (state.connected || state.connecting) return json(res, 200, { ok: true, connected: state.connected });
      connectWithRefreshToken(token);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/api/library/refresh') {
      const apps = await refreshLibrary();
      await refreshCardData();
      return json(res, 200, { ok: true, count: apps.length, cardGames: state.cardGames, drops: state.cardDropsRemaining });
    }
    if (req.method === 'POST' && req.url === '/api/cards/refresh') {
      await refreshCardData();
      return json(res, 200, { ok: true, cardGames: state.cardGames, drops: state.cardDropsRemaining });
    }
    if (req.method === 'POST' && req.url === '/api/playtime/refresh') {
      const changed = await refreshPlaytimeSnapshot();
      return json(res, 200, { ok: true, changed, revision: state.playtimeRevision, syncedAt: state.playtimeSyncAt });
    }
    if (req.method === 'POST' && req.url === '/api/priority') {
      const body = await readJson(req);
      const owned = new Set(library.map(x => x.appid));
      const clean = [...new Set<number>((body.appids || []).map(Number).filter((x: number) => Number.isInteger(x) && x > 0 && (!owned.size || owned.has(x))))];
      if (clean.length > IDLE_MAX_CONCURRENT) {
        return json(res, 400, { error: `Priority is limited to ${IDLE_MAX_CONCURRENT} games because priority games stay active in every batch.` });
      }
      const desiredAfter = [...new Set([...clean, ...state.desiredIdling])];
      if (state.idleWanted && clean.length >= IDLE_MAX_CONCURRENT && desiredAfter.length > IDLE_MAX_CONCURRENT) {
        return json(res, 409, { error: `${IDLE_MAX_CONCURRENT} priority games would consume every active slot. Unpin at least one game before keeping other games in rotation.` });
      }
      priorityAppIds = new Set(clean);
      state.selected = [...new Set([...clean, ...state.selected])];
      if (state.idleWanted) {
        state.desiredIdling = desiredAfter;
        applyIdleBatch(steam, state.idleBatchIndex, 'priority update');
      }
      saveSettings();
      return json(res, 200, {
        ok: true,
        priorityAppIds: [...priorityAppIds].sort((a, b) => a - b),
        selected: state.selected,
        idling: state.idling
      });
    }
    if (req.method === 'POST' && req.url === '/api/selection') {
      const body = await readJson(req);
      const requested = (body.appids || []).map(Number).filter((x: number) => Number.isFinite(x));
      state.selected = [...new Set<number>([...priorityAppIds, ...requested])];
      saveSettings();
      return json(res, 200, { ok: true, selected: state.selected });
    }
    if (req.method === 'POST' && req.url === '/api/library/manual') {
      const body = await readJson(req);
      const before = manualAppIds.size;
      for (const id of (body.appids || []).map(Number)) {
        if (Number.isInteger(id) && id > 0) manualAppIds.add(id);
      }
      const added = manualAppIds.size - before;
      saveSettings();
      if (state.connected) await refreshLibrary();
      return json(res, 200, { ok: true, added, manualAppIds: [...manualAppIds] });
    }
    if (req.method === 'POST' && req.url === '/api/idle/start') {
      const body = await readJson(req);
      startIdle(body.appids || []);
      return json(res, 200, { ok: true, idling: state.idling });
    }
    if (req.method === 'POST' && req.url === '/api/idle/stop') {
      stopIdle();
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/api/shutdown') {
      if (CLOUD_MODE) return json(res, 409, { error: 'Exit server is disabled in Cloudflare Container mode' });
      if (state.shuttingDown) return json(res, 200, { ok: true, shuttingDown: true });
      state.shuttingDown = true;
      state.message = 'Shutting down...';
      json(res, 200, { ok: true, shuttingDown: true });
      setTimeout(() => gracefulShutdown('web/stop launcher'), 75);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/logout') {
      logoutForget();
      return json(res, 200, { ok: true });
    }

    return serveStatic(req, res);
  } catch (err) {
    console.error('[http]', err);
    return json(res, 500, { error: err.message || String(err) });
  }
});

server.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  const url = `http://${displayHost}:${PORT}`;
  console.log(`O-Steam-Idle running at ${HOST}:${PORT} (${CLOUD_MODE ? 'cloud' : 'local'} mode)`);
  // Open the default browser only for interactive local runs.
  if (!DISABLE_BROWSER) {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      try { spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref(); } catch (_) {}
    }
  }

  try {
    const token = loadRefreshToken();
    if (token) connectWithRefreshToken(token);
  } catch (err) {
    state.message = `Saved login could not be loaded: ${err.message}`;
  }
});

const steamRecoveryWatchdog = setInterval(() => {
  if (state.shuttingDown || state.connected || state.recoveryBlocked || !hasSavedLogin()) return;
  const now = Date.now();
  // steam-user normally handles short outages. Intervene only on a stalled
  // connection, or when a non-authentication fatal error left it offline.
  if (state.connecting && state.connectingSince && now - state.connectingSince < CONNECT_TIMEOUT_MS) return;
  if (!state.recoveryNextRetryAt) {
    armSteamRecovery(state.connecting ? 'initial connection timed out' : 'offline session', state.connecting ? 0 : RECONNECT_GRACE_MS);
  }
  if (state.recoveryNextRetryAt && now >= state.recoveryNextRetryAt) {
    retrySteamConnection(state.recoveryLastReason || 'watchdog timeout');
  }
}, RECONNECT_CHECK_MS);
steamRecoveryWatchdog.unref?.();

diagnostic('process.started', { reason: CLOUD_MODE ? 'cloud' : 'local' });
let lastDiagnosticState = '';
const diagnosticsHeartbeat = setInterval(() => {
  const snapshot = [state.connected, state.connecting, state.reconnecting,
    state.idleWanted, state.idleSuspended, state.externalPlaying,
    state.idling.length, state.desiredIdling.length, state.idleBatchIndex,
    state.recoveryAttempts, state.recoveryBlocked].join('|');
  if (snapshot !== lastDiagnosticState) {
    diagnostic('state.transition', { previousActiveCount: Number((lastDiagnosticState.split('|')[6] || 0)) });
    lastDiagnosticState = snapshot;
  }
  diagnostic('state.heartbeat', { blocked: !!steam?.playingState?.blocked });
}, 60000);
diagnosticsHeartbeat.unref?.();

const playtimeSyncTimer = setInterval(() => {
  if (!state.connected || !state.idleWanted || state.cardScanRunning || state.playtimeSyncing) return;
  refreshPlaytimeSnapshot().catch(() => {});
}, PLAYTIME_SYNC_MS);
playtimeSyncTimer.unref?.();

// Passive fatal-session recovery. Normal network/Steam CM outages are handled by
// steam-user autoRelogin and never reach this timer. We reconnect only after a
// fatal session conflict, and never auto-resume an idle that was yielded.
setInterval(() => {
  if (!state.sessionConflict || state.connected || state.connecting || !hasSavedLogin()) return;
  try {
    const token = loadRefreshToken();
    if (!token) return;
    state.message = 'Rechecking Steam session availability...';
    connectWithRefreshToken(token);
  } catch (err) {
    state.message = `Session recheck failed: ${err.message}`;
  }
}, EXTERNAL_RECHECK_MS);

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('unhandledRejection', (err: any) => runtimeLog('ERROR', `Unhandled rejection: ${err?.stack || err}`));
process.on('uncaughtException', err => {
  runtimeLog('ERROR', `Uncaught exception: ${err?.stack || err}`);
  gracefulShutdown('uncaughtException');
});
