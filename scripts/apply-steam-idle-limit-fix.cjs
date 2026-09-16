'use strict';

const fs = require('fs');

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, value) { fs.writeFileSync(path, value, 'utf8'); }
function replaceOnce(source, before, after, label) {
  const idx = source.indexOf(before);
  if (idx < 0) throw new Error(`Patch target not found: ${label}`);
  if (source.indexOf(before, idx + before.length) >= 0) throw new Error(`Patch target is ambiguous: ${label}`);
  return source.slice(0, idx) + after + source.slice(idx + before.length);
}

let server = read('src/server.ts');

server = replaceOnce(server,
`const IDLE_RESTORE_DELAY_MS = 2500;\nconst LOG_FILE = path.join(DATA, 'runtime.log');`,
`const IDLE_RESTORE_DELAY_MS = 2500;\nconst STEAM_MAX_CONCURRENT_APPS = 32;\nconst IDLE_MAX_CONCURRENT = Math.min(STEAM_MAX_CONCURRENT_APPS, Math.max(1, Number(process.env.O_IDLE_MAX_CONCURRENT || STEAM_MAX_CONCURRENT_APPS) || STEAM_MAX_CONCURRENT_APPS));\nconst IDLE_ROTATE_MINUTES = Math.max(1, Number(process.env.O_IDLE_ROTATE_MINUTES || 30) || 30);\nconst IDLE_ROTATE_MS = IDLE_ROTATE_MINUTES * 60 * 1000;\nconst PLAYTIME_SYNC_MINUTES = Math.max(1, Number(process.env.O_IDLE_PLAYTIME_SYNC_MINUTES || 5) || 5);\nconst PLAYTIME_SYNC_MS = PLAYTIME_SYNC_MINUTES * 60 * 1000;\nconst LOG_FILE = path.join(DATA, 'runtime.log');`,
'constants');

server = replaceOnce(server,
`  idleWanted: false,\n  desiredIdling: [],\n  shuttingDown: false,`,
`  idleWanted: false,\n  desiredIdling: [],\n  idleBatchIndex: 0,\n  idleBatchCount: 0,\n  idleRotationAt: null,\n  playtimeSyncing: false,\n  playtimeSyncAt: null,\n  playtimeRevision: 0,\n  playtimeSyncError: null,\n  shuttingDown: false,`,
'runtime state');

server = replaceOnce(server,
`function sanitizeState() {\n  return {\n    ...state,\n    runtimeMode: CLOUD_MODE ? 'cloud' : 'local',\n    libraryCount: library.length,`,
`function sanitizeState() {\n  const active = new Set(state.idling);\n  return {\n    ...state,\n    runtimeMode: CLOUD_MODE ? 'cloud' : 'local',\n    queuedIdling: state.idleWanted ? state.desiredIdling.filter(appid => !active.has(appid)) : [],\n    idleMaxConcurrent: IDLE_MAX_CONCURRENT,\n    idleRotateMinutes: IDLE_ROTATE_MINUTES,\n    playtimeSyncMinutes: PLAYTIME_SYNC_MINUTES,\n    libraryCount: library.length,`,
'sanitize state');

server = replaceOnce(server,
`let idleRestoreTimer = null;\nfunction cancelIdleRestore() {\n  if (idleRestoreTimer) clearTimeout(idleRestoreTimer);\n  idleRestoreTimer = null;\n}\n\nfunction scheduleIdleRestore(client, reason = 'reconnect') {`,
`let idleRestoreTimer = null;\nlet idleRotationTimer = null;\nfunction cancelIdleRestore() {\n  if (idleRestoreTimer) clearTimeout(idleRestoreTimer);\n  idleRestoreTimer = null;\n}\nfunction cancelIdleRotation() {\n  if (idleRotationTimer) clearTimeout(idleRotationTimer);\n  idleRotationTimer = null;\n  state.idleRotationAt = null;\n}\nfunction splitIdleBatches(appids: number[]): number[][] {\n  const batches: number[][] = [];\n  for (let i = 0; i < appids.length; i += IDLE_MAX_CONCURRENT) batches.push(appids.slice(i, i + IDLE_MAX_CONCURRENT));\n  return batches;\n}\nfunction scheduleIdleRotation(client: any) {\n  cancelIdleRotation();\n  if (!state.idleWanted || state.idleSuspended || state.shuttingDown || state.desiredIdling.length <= IDLE_MAX_CONCURRENT) return;\n  state.idleRotationAt = Date.now() + IDLE_ROTATE_MS;\n  idleRotationTimer = setTimeout(() => {\n    idleRotationTimer = null;\n    state.idleRotationAt = null;\n    if (steam !== client || !state.connected || !state.idleWanted || state.idleSuspended || state.shuttingDown) return;\n    if (state.externalPlaying || client.playingState?.blocked) return;\n    try {\n      const batches = splitIdleBatches(state.desiredIdling);\n      const next = batches.length ? (state.idleBatchIndex + 1) % batches.length : 0;\n      applyIdleBatch(client, next, 'rotation');\n    } catch (err) {\n      state.message = \`Idle rotation failed: \${err.message}\`;\n      runtimeLog('ERROR', \`Idle rotation failed: \${err.message}\`);\n    }\n  }, IDLE_ROTATE_MS);\n  idleRotationTimer.unref?.();\n}\nfunction applyIdleBatch(client: any, batchIndex = 0, reason = 'start') {\n  const owned = new Set(library.map(x => x.appid));\n  const desired = state.desiredIdling.filter(appid => !owned.size || owned.has(appid));\n  if (!desired.length) throw new Error('Selected games are no longer available');\n  state.desiredIdling = desired;\n  const batches = splitIdleBatches(desired);\n  const index = ((Number(batchIndex) || 0) % batches.length + batches.length) % batches.length;\n  const batch = batches[index];\n  client.gamesPlayed(batch, false);\n  state.idling = batch.slice();\n  state.idleBatchIndex = index;\n  state.idleBatchCount = batches.length;\n  const queued = desired.length - batch.length;\n  state.message = batches.length > 1\n    ? \`Idling \${batch.length}/\${desired.length} · batch \${index + 1}/\${batches.length} · \${queued} queued · rotates every \${IDLE_ROTATE_MINUTES}m\`\n    : \`Idling \${batch.length} game\${batch.length === 1 ? '' : 's'}\`;\n  runtimeLog('INFO', \`Idle batch \${index + 1}/\${batches.length} applied after \${reason}: \${batch.length}/\${desired.length} games\`);\n  scheduleIdleRotation(client);\n}\n\nfunction scheduleIdleRestore(client, reason = 'reconnect') {`,
'idle batching helpers');

server = replaceOnce(server,
`function scheduleIdleRestore(client, reason = 'reconnect') {\n  cancelIdleRestore();`,
`function scheduleIdleRestore(client, reason = 'reconnect') {\n  cancelIdleRestore();\n  cancelIdleRotation();`,
'restore cancels rotation');

server = replaceOnce(server,
`    try {\n      client.gamesPlayed(clean, false);\n      state.idling = clean.slice();\n      state.message = \`Reconnected · resumed \${clean.length} idling game\${clean.length === 1 ? '' : 's'}\`;\n      runtimeLog('INFO', \`Idle resumed after \${reason}: \${clean.length} games\`);\n    } catch (err) {`,
`    try {\n      state.desiredIdling = clean.slice();\n      applyIdleBatch(client, state.idleBatchIndex, \`reconnect/\${reason}\`);\n    } catch (err) {`,
'reconnect batch application');

server = replaceOnce(server,
`    if (blocked) {\n      cancelIdleRestore();\n\n      if (state.idling.length) {`,
`    if (blocked) {\n      cancelIdleRestore();\n      cancelIdleRotation();\n\n      if (state.idling.length) {`,
'yield cancels rotation');

server = replaceOnce(server,
`  client.on('disconnected', (eresult, msg) => {\n    webCookies = [];\n    state.connected = false;\n    state.connecting = false;\n    state.idling = [];`,
`  client.on('disconnected', (eresult, msg) => {\n    webCookies = [];\n    state.connected = false;\n    state.connecting = false;\n    state.idling = [];\n    cancelIdleRotation();`,
'disconnect cancels rotation');

server = replaceOnce(server,
`  client.on('error', err => {\n    const wasIdling = state.idleWanted || state.idling.length > 0;\n    state.connected = false;\n    state.connecting = false;\n    state.reconnecting = false;\n    state.idling = [];`,
`  client.on('error', err => {\n    const wasIdling = state.idleWanted || state.idling.length > 0;\n    state.connected = false;\n    state.connecting = false;\n    state.reconnecting = false;\n    state.idling = [];\n    cancelIdleRotation();`,
'error cancels rotation');

server = replaceOnce(server,
`  state.cardDropsRemaining = 0;\n  state.message = \`Library loaded: \${library.length} apps · owned/profile/manual = \${ownedApps.length}/\${profileApps.length}/\${manualApps.length}\`;`,
`  state.cardDropsRemaining = 0;\n  state.playtimeSyncAt = Date.now();\n  state.playtimeRevision += 1;\n  state.playtimeSyncError = null;\n  state.message = \`Library loaded: \${library.length} apps · owned/profile/manual = \${ownedApps.length}/\${profileApps.length}/\${manualApps.length}\`;`,
'library playtime revision');

server = replaceOnce(server,
`function waitForWebSession(timeoutMs = 15000): Promise<string[]> {`,
`async function refreshPlaytimeSnapshot() {\n  if (!state.connected || !steam) throw new Error('Not connected to Steam');\n  if (state.playtimeSyncing) return 0;\n  state.playtimeSyncing = true;\n  state.playtimeSyncError = null;\n  try {\n    const [ownedResult, profileResult] = await Promise.allSettled([getUserOwnedApps(), getProfilePlayedApps()]);\n    const updates = new Map<number, { playtime: number; lastPlayed: number }>();\n    const absorb = (apps: any[], ownedShape: boolean) => {\n      for (const app of apps || []) {\n        const appid = Number(app.appid);\n        if (!Number.isInteger(appid) || appid <= 0) continue;\n        const playtime = Number(ownedShape ? (app.playtime_forever || app.playtime || 0) : (app.playtime || 0));\n        const lastPlayed = Number(ownedShape ? (app.rtime_last_played || app.lastPlayed || 0) : (app.lastPlayed || 0));\n        const prev = updates.get(appid) || { playtime: 0, lastPlayed: 0 };\n        updates.set(appid, { playtime: Math.max(prev.playtime, playtime), lastPlayed: Math.max(prev.lastPlayed, lastPlayed) });\n      }\n    };\n    if (ownedResult.status === 'fulfilled') absorb(ownedResult.value, true);\n    if (profileResult.status === 'fulfilled') absorb(profileResult.value, false);\n    if (!updates.size) {\n      const ownedErr = ownedResult.status === 'rejected' ? ownedResult.reason?.message || String(ownedResult.reason) : 'no owned data';\n      const profileErr = profileResult.status === 'rejected' ? profileResult.reason?.message || String(profileResult.reason) : 'no profile data';\n      throw new Error(\`No playtime source available (owned: \${ownedErr}; profile: \${profileErr})\`);\n    }\n    let changed = 0;\n    library = library.map(app => {\n      const update = updates.get(app.appid);\n      if (!update) return app;\n      const playtime = Math.max(Number(app.playtime || 0), update.playtime);\n      const lastPlayed = Math.max(Number(app.lastPlayed || 0), update.lastPlayed);\n      if (playtime !== Number(app.playtime || 0) || lastPlayed !== Number(app.lastPlayed || 0)) changed += 1;\n      return { ...app, playtime, lastPlayed };\n    });\n    state.playtimeSyncAt = Date.now();\n    state.playtimeRevision += 1;\n    runtimeLog('INFO', \`Playtime snapshot synced: \${updates.size} source apps, \${changed} library rows changed\`);\n    return changed;\n  } catch (err) {\n    state.playtimeSyncError = err.message || String(err);\n    runtimeLog('WARN', \`Playtime sync failed: \${state.playtimeSyncError}\`);\n    throw err;\n  } finally {\n    state.playtimeSyncing = false;\n  }\n}\n\nfunction waitForWebSession(timeoutMs = 15000): Promise<string[]> {`,
'playtime sync function');

server = replaceOnce(server,
`  cancelIdleRestore();\n\n  steam.gamesPlayed(clean, false);\n  state.idling = clean.slice();\n  state.desiredIdling = clean.slice();\n  state.idleWanted = true;\n  state.selected = clean.slice();\n  state.idleSuspended = false;\n  state.externalPlaying = false;\n  state.externalPlayingApp = 0;\n  saveSettings();\n  state.message = \`Idling \${clean.length} game\${clean.length === 1 ? '' : 's'}\`;\n  runtimeLog('INFO', \`Idle started: \${clean.length} games\`);`,
`  cancelIdleRestore();\n  cancelIdleRotation();\n\n  state.desiredIdling = clean.slice();\n  state.idleWanted = true;\n  state.selected = clean.slice();\n  state.idleSuspended = false;\n  state.externalPlaying = false;\n  state.externalPlayingApp = 0;\n  state.idleBatchIndex = 0;\n  state.idleBatchCount = Math.ceil(clean.length / IDLE_MAX_CONCURRENT);\n  try {\n    applyIdleBatch(steam, 0, 'start');\n  } catch (err) {\n    state.idling = [];\n    state.desiredIdling = [];\n    state.idleWanted = false;\n    state.idleBatchIndex = 0;\n    state.idleBatchCount = 0;\n    throw err;\n  }\n  saveSettings();`,
'start idle batching');

server = replaceOnce(server,
`function stopIdle() {\n  cancelIdleRestore();\n  if (steam && state.connected) {\n    try { steam.gamesPlayed([]); } catch (_) {}\n  }\n  state.idling = [];\n  state.desiredIdling = [];\n  state.idleWanted = false;\n  state.idleSuspended = false;\n  state.message = 'Idle stopped';\n  runtimeLog('INFO', 'Idle stopped');\n}`,
`function stopIdle() {\n  cancelIdleRestore();\n  cancelIdleRotation();\n  if (steam && state.connected) {\n    try { steam.gamesPlayed([]); } catch (_) {}\n  }\n  state.idling = [];\n  state.desiredIdling = [];\n  state.idleWanted = false;\n  state.idleSuspended = false;\n  state.idleBatchIndex = 0;\n  state.idleBatchCount = 0;\n  state.idleRotationAt = null;\n  state.message = 'Idle stopped';\n  runtimeLog('INFO', 'Idle stopped');\n}`,
'stop idle batching');

server = replaceOnce(server,
`  cancelIdleRestore();\n  state.idleWanted = false;\n  state.desiredIdling = [];\n\n  runtimeLog('INFO', \`Graceful shutdown requested (\${reason})\`);`,
`  cancelIdleRestore();\n  cancelIdleRotation();\n  state.idleWanted = false;\n  state.desiredIdling = [];\n  state.idleBatchIndex = 0;\n  state.idleBatchCount = 0;\n\n  runtimeLog('INFO', \`Graceful shutdown requested (\${reason})\`);`,
'shutdown rotation cleanup');

server = replaceOnce(server,
`    if (req.method === 'POST' && req.url === '/api/cards/refresh') {\n      await refreshCardData();\n      return json(res, 200, { ok: true, cardGames: state.cardGames, drops: state.cardDropsRemaining });\n    }`,
`    if (req.method === 'POST' && req.url === '/api/cards/refresh') {\n      await refreshCardData();\n      return json(res, 200, { ok: true, cardGames: state.cardGames, drops: state.cardDropsRemaining });\n    }\n    if (req.method === 'POST' && req.url === '/api/playtime/refresh') {\n      const changed = await refreshPlaytimeSnapshot();\n      return json(res, 200, { ok: true, changed, revision: state.playtimeRevision, syncedAt: state.playtimeSyncAt });\n    }`,
'playtime endpoint');

server = replaceOnce(server,
`// Passive fatal-session recovery. Normal network/Steam CM outages are handled by`,
`const playtimeSyncTimer = setInterval(() => {\n  if (!state.connected || !state.idleWanted || state.cardScanRunning || state.playtimeSyncing) return;\n  refreshPlaytimeSnapshot().catch(() => {});\n}, PLAYTIME_SYNC_MS);\nplaytimeSyncTimer.unref?.();\n\n// Passive fatal-session recovery. Normal network/Steam CM outages are handled by`,
'playtime timer');

write('src/server.ts', server);

let types = read('src/types.ts');
types = replaceOnce(types,
`  idleWanted: boolean;\n  desiredIdling: number[];\n  shuttingDown: boolean;`,
`  idleWanted: boolean;\n  desiredIdling: number[];\n  idleBatchIndex: number;\n  idleBatchCount: number;\n  idleRotationAt: number | null;\n  playtimeSyncing: boolean;\n  playtimeSyncAt: number | null;\n  playtimeRevision: number;\n  playtimeSyncError: string | null;\n  shuttingDown: boolean;`,
'types runtime state');
write('src/types.ts', types);

let clientTypes = read('client/types.ts');
clientTypes = replaceOnce(clientTypes,
`  idleWanted?: boolean;\n  idling?: number[];\n  selected?: number[];`,
`  idleWanted?: boolean;\n  idling?: number[];\n  desiredIdling?: number[];\n  queuedIdling?: number[];\n  idleBatchIndex?: number;\n  idleBatchCount?: number;\n  idleRotationAt?: number | null;\n  idleMaxConcurrent?: number;\n  idleRotateMinutes?: number;\n  playtimeSyncing?: boolean;\n  playtimeSyncAt?: number | null;\n  playtimeRevision?: number;\n  playtimeSyncError?: string | null;\n  selected?: number[];`,
'client status types');
write('client/types.ts', clientTypes);

let client = read('client/app.ts');
client = replaceOnce(client,
`let lastCardScanReady = false;\nlet shuttingDown = false;`,
`let lastCardScanReady = false;\nlet lastPlaytimeRevision = -1;\nlet shuttingDown = false;`,
'client playtime revision');
client = replaceOnce(client,
`    if (filter === 'played') return g.playtime > 0;\n    if (filter === 'never') return g.playtime <= 0;`,
`    if (filter === 'played') return g.playtime > 0 || g.lastPlayed > 0;\n    if (filter === 'never') return g.playtime <= 0 && !g.lastPlayed;`,
'played filters');
client = replaceOnce(client,
`    const isSelected = selected.has(g.appid);\n    const isIdling = idling.has(g.appid);\n    label.className = \`game\${isSelected ? ' active' : ''}\${isIdling ? ' idling' : ''}\`;`,
`    const isSelected = selected.has(g.appid);\n    const isIdling = idling.has(g.appid);\n    const isQueued = !!status.idleWanted && isSelected && !isIdling;\n    label.className = \`game\${isSelected ? ' active' : ''}\${isIdling ? ' idling' : ''}\${isQueued ? ' queued' : ''}\`;`,
'queued row state');
client = replaceOnce(client,
`    stateTag.className = \`state-tag\${isIdling ? ' idling' : isSelected ? ' selected' : ''}\`;\n    stateTag.textContent = isIdling ? 'LIVE' : isSelected ? 'ARMED' : 'STANDBY';`,
`    stateTag.className = \`state-tag\${isIdling ? ' idling' : isQueued ? ' queued' : isSelected ? ' selected' : ''}\`;\n    stateTag.textContent = isIdling ? 'ACTIVE' : isQueued ? 'QUEUED' : isSelected ? 'ARMED' : 'STANDBY';`,
'queued state tag');
client = replaceOnce(client,
`  els.sessionText.textContent = (status.idling || []).length ? \`\${status.idling.length} ACTIVE\` : status.idleWanted ? 'PENDING' : yielding ? 'YIELD' : 'IDLE';`,
`  const activeCount = (status.idling || []).length;\n  const desiredCount = (status.desiredIdling || []).length || activeCount;\n  const batchText = Number(status.idleBatchCount || 0) > 1 ? \` · B\${Number(status.idleBatchIndex || 0) + 1}/\${status.idleBatchCount}\` : '';\n  els.sessionText.textContent = activeCount ? \`\${activeCount}/\${desiredCount} ACTIVE\${batchText}\` : status.idleWanted ? 'PENDING' : yielding ? 'YIELD' : 'IDLE';`,
'session telemetry');
client = replaceOnce(client,
`    const cardsJustFinished = !!status.cardScanReady && !lastCardScanReady;\n    if (status.libraryReady && (status.libraryCount !== lastLibraryCount || cardsJustFinished)) {\n      lastLibraryCount = status.libraryCount;\n      await loadLibrary();\n    }\n    lastCardScanReady = !!status.cardScanReady;`,
`    const cardsJustFinished = !!status.cardScanReady && !lastCardScanReady;\n    const playtimeRevision = Number(status.playtimeRevision || 0);\n    const playtimeChanged = playtimeRevision !== lastPlaytimeRevision;\n    if (status.libraryReady && (status.libraryCount !== lastLibraryCount || cardsJustFinished || playtimeChanged)) {\n      lastLibraryCount = status.libraryCount;\n      await loadLibrary();\n    }\n    lastCardScanReady = !!status.cardScanReady;\n    lastPlaytimeRevision = playtimeRevision;`,
'poll playtime updates');
write('client/app.ts', client);

let css = read('public/style.css');
css = replaceOnce(css,
`.state-tag.selected { color: var(--cyan-2); border-color: rgba(51,185,255,.34); }\n.state-tag.idling { color: var(--green); border-color: rgba(99,230,167,.35); background: rgba(99,230,167,.04); }`,
`.state-tag.selected { color: var(--cyan-2); border-color: rgba(51,185,255,.34); }\n.state-tag.queued { color: var(--amber); border-color: rgba(245,183,75,.34); background: rgba(245,183,75,.035); }\n.state-tag.idling { color: var(--green); border-color: rgba(99,230,167,.35); background: rgba(99,230,167,.04); }`,
'queued css');
write('public/style.css', css);

let html = read('public/index.html');
html = replaceOnce(html, `<option value="never">Never played</option>`, `<option value="never">No recorded playtime</option>`, 'never filter label');
write('public/index.html', html);

const pkgPath = 'package.json';
const pkg = JSON.parse(read(pkgPath));
pkg.version = '0.3.1';
write(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

let readme = read('README.md');
const marker = '## Cloudflare Container mode';
if (!readme.includes(marker)) throw new Error('README Cloudflare marker missing');
if (!readme.includes('Steam only tracks up to 32')) {
  readme = readme.replace(marker, `## Steam concurrency and playtime\n\nSteam only tracks up to 32 concurrently reported AppIDs. O-Steam-Idle therefore keeps at most 32 games ACTIVE at a time and round-robins larger selections in 30-minute batches by default. Games waiting for their turn are shown as QUEUED instead of LIVE. Set \\`O_IDLE_ROTATE_MINUTES\\` to change the batch duration or \\`O_IDLE_MAX_CONCURRENT\\` to use a lower cap (the app never exceeds 32).\n\nThe playtime numbers shown in the UI are Steam snapshots, not a local stopwatch. While idling, O-Steam-Idle refreshes those snapshots every 5 minutes by default (\\`O_IDLE_PLAYTIME_SYNC_MINUTES\\`). Steam can still publish playtime asynchronously, so a current ACTIVE batch may not show an immediate counter change.\n\n${marker}`);
}
write('README.md', readme);

console.log('Applied Steam 32-app batching, queue telemetry, and playtime sync fix.');
