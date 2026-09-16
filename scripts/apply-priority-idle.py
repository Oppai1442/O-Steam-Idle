from pathlib import Path
import json


def read(path):
    return Path(path).read_text(encoding='utf-8')


def write(path, value):
    Path(path).write_text(value, encoding='utf-8')


def replace_once(source, before, after, label):
    count = source.count(before)
    if count != 1:
        raise RuntimeError(f'{label}: expected 1 match, found {count}')
    return source.replace(before, after, 1)

server = read('src/server.ts')

server = replace_once(
    server,
    "let steamLogonID = 0;\nlet manualAppIds = new Set<number>(DEFAULT_APPIDS);",
    "let steamLogonID = 0;\nlet manualAppIds = new Set<number>(DEFAULT_APPIDS);\nlet priorityAppIds = new Set<number>();",
    'priority storage',
)

server = replace_once(
    server,
    "    state.selected = Array.isArray(x.selected) ? x.selected.map(Number).filter(Number.isFinite) : [];\n    if (Array.isArray(x.manualAppIds)) {",
    "    state.selected = Array.isArray(x.selected) ? x.selected.map(Number).filter(Number.isFinite) : [];\n    const savedPriority = Array.isArray(x.priorityAppIds)\n      ? x.priorityAppIds.map(Number).filter(id => Number.isInteger(id) && id > 0).slice(0, IDLE_MAX_CONCURRENT)\n      : [];\n    priorityAppIds = new Set(savedPriority);\n    if (Array.isArray(x.manualAppIds)) {",
    'load priorities',
)

server = replace_once(
    server,
    "  if (!state.selected.length && DEFAULT_APPIDS.length) state.selected = DEFAULT_APPIDS.slice();\n  saveSettings();",
    "  if (!state.selected.length && DEFAULT_APPIDS.length) state.selected = DEFAULT_APPIDS.slice();\n  state.selected = [...new Set([...priorityAppIds, ...state.selected])];\n  saveSettings();",
    'priority selection restore',
)

server = replace_once(
    server,
    "    selected: state.selected,\n    manualAppIds: [...manualAppIds].sort((a, b) => a - b),\n    logonID: steamLogonID",
    "    selected: state.selected,\n    manualAppIds: [...manualAppIds].sort((a, b) => a - b),\n    priorityAppIds: [...priorityAppIds].sort((a, b) => a - b),\n    logonID: steamLogonID",
    'save priorities',
)

server = replace_once(
    server,
    "    runtimeMode: CLOUD_MODE ? 'cloud' : 'local',\n    queuedIdling: state.idleWanted ? state.desiredIdling.filter(appid => !active.has(appid)) : [],",
    "    runtimeMode: CLOUD_MODE ? 'cloud' : 'local',\n    priorityAppIds: [...priorityAppIds].sort((a, b) => a - b),\n    priorityCount: priorityAppIds.size,\n    queuedIdling: state.idleWanted ? state.desiredIdling.filter(appid => !active.has(appid)) : [],",
    'sanitize priorities',
)

old_batch = """function splitIdleBatches(appids: number[]): number[][] {
  const batches: number[][] = [];
  for (let i = 0; i < appids.length; i += IDLE_MAX_CONCURRENT) batches.push(appids.slice(i, i + IDLE_MAX_CONCURRENT));
  return batches;
}
function scheduleIdleRotation(client: any) {
  cancelIdleRotation();
  if (!state.idleWanted || state.idleSuspended || state.shuttingDown || state.desiredIdling.length <= IDLE_MAX_CONCURRENT) return;
  state.idleRotationAt = Date.now() + IDLE_ROTATE_MS;
  idleRotationTimer = setTimeout(() => {
    idleRotationTimer = null;
    state.idleRotationAt = null;
    if (steam !== client || !state.connected || !state.idleWanted || state.idleSuspended || state.shuttingDown) return;
    if (state.externalPlaying || client.playingState?.blocked) return;
    try {
      const batches = splitIdleBatches(state.desiredIdling);
      const next = batches.length ? (state.idleBatchIndex + 1) % batches.length : 0;
      applyIdleBatch(client, next, 'rotation');
    } catch (err) {
      state.message = `Idle rotation failed: ${err.message}`;
      runtimeLog('ERROR', `Idle rotation failed: ${err.message}`);
    }
  }, IDLE_ROTATE_MS);
  idleRotationTimer.unref?.();
}
function applyIdleBatch(client: any, batchIndex = 0, reason = 'start') {
  const owned = new Set(library.map(x => x.appid));
  const desired = state.desiredIdling.filter(appid => !owned.size || owned.has(appid));
  if (!desired.length) throw new Error('Selected games are no longer available');
  state.desiredIdling = desired;
  const batches = splitIdleBatches(desired);
  const index = ((Number(batchIndex) || 0) % batches.length + batches.length) % batches.length;
  const batch = batches[index];
  client.gamesPlayed(batch, false);
  state.idling = batch.slice();
  state.idleBatchIndex = index;
  state.idleBatchCount = batches.length;
  const queued = desired.length - batch.length;
  state.message = batches.length > 1
    ? `Idling ${batch.length}/${desired.length} · batch ${index + 1}/${batches.length} · ${queued} queued · rotates every ${IDLE_ROTATE_MINUTES}m`
    : `Idling ${batch.length} game${batch.length === 1 ? '' : 's'}`;
  runtimeLog('INFO', `Idle batch ${index + 1}/${batches.length} applied after ${reason}: ${batch.length}/${desired.length} games`);
  scheduleIdleRotation(client);
}
"""

new_batch = """function planIdleBatches(appids: number[]) {
  const desired = [...new Set(appids.map(Number).filter(id => Number.isInteger(id) && id > 0))];
  const desiredSet = new Set(desired);
  const priority = [...priorityAppIds].filter(appid => desiredSet.has(appid)).slice(0, IDLE_MAX_CONCURRENT);
  const pinned = new Set(priority);
  const rotating = desired.filter(appid => !pinned.has(appid));
  const rotatingSlots = Math.max(0, IDLE_MAX_CONCURRENT - priority.length);
  const batches: number[][] = [];

  if (!rotating.length || rotatingSlots === 0) {
    batches.push(priority.slice());
  } else {
    for (let i = 0; i < rotating.length; i += rotatingSlots) {
      batches.push([...priority, ...rotating.slice(i, i + rotatingSlots)]);
    }
  }

  return { desired, priority, rotating, rotatingSlots, batches };
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
  const owned = new Set(library.map(x => x.appid));
  const desired = state.desiredIdling.filter(appid => !owned.size || owned.has(appid));
  if (!desired.length) throw new Error('Selected games are no longer available');
  state.desiredIdling = [...new Set(desired)];
  const plan = planIdleBatches(state.desiredIdling);
  if (plan.priority.length >= IDLE_MAX_CONCURRENT && plan.rotating.length) {
    throw new Error(`${IDLE_MAX_CONCURRENT} priority games occupy every Steam slot. Unpin at least one priority game to rotate the rest.`);
  }
  const index = ((Number(batchIndex) || 0) % plan.batches.length + plan.batches.length) % plan.batches.length;
  const batch = plan.batches[index];
  if (!batch.length) throw new Error('No games available for the active idle batch');
  client.gamesPlayed(batch, false);
  state.idling = batch.slice();
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
"""
server = replace_once(server, old_batch, new_batch, 'priority-aware batch planner')

server = replace_once(
    server,
    "  const owned = new Set(library.map(x => x.appid));\n  const clean = [...new Set(appids.map(Number).filter(x => Number.isInteger(x) && x > 0 && owned.has(x)))];\n  if (!clean.length) throw new Error('Select at least one owned game');",
    "  const owned = new Set(library.map(x => x.appid));\n  const requested = appids.map(Number).filter(x => Number.isInteger(x) && x > 0 && owned.has(x));\n  const priorityOwned = [...priorityAppIds].filter(appid => owned.has(appid));\n  const clean = [...new Set([...priorityOwned, ...requested])];\n  if (!clean.length) throw new Error('Select at least one owned game');\n  if (priorityOwned.length >= IDLE_MAX_CONCURRENT && clean.length > IDLE_MAX_CONCURRENT) {\n    throw new Error(`${IDLE_MAX_CONCURRENT} priority games occupy every Steam slot. Unpin at least one priority game before starting a larger idle set.`);\n  }",
    'start includes priorities',
)

server = replace_once(
    server,
    "  state.idleBatchIndex = 0;\n  state.idleBatchCount = Math.ceil(clean.length / IDLE_MAX_CONCURRENT);",
    "  state.idleBatchIndex = 0;\n  state.idleBatchCount = planIdleBatches(clean).batches.length;",
    'priority batch count',
)

selection_block = """    if (req.method === 'POST' && req.url === '/api/selection') {
      const body = await readJson(req);
      state.selected = [...new Set<number>((body.appids || []).map(Number).filter((x: number) => Number.isFinite(x)))];
      saveSettings();
      return json(res, 200, { ok: true });
    }
"""
priority_block = """    if (req.method === 'POST' && req.url === '/api/priority') {
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
"""
server = replace_once(server, selection_block, priority_block, 'priority endpoint')

write('src/server.ts', server)

server_types = read('src/types.ts')
server_types = replace_once(
    server_types,
    "  manualAppIds?: unknown[];\n  logonID?: unknown;",
    "  manualAppIds?: unknown[];\n  priorityAppIds?: unknown[];\n  logonID?: unknown;",
    'settings priority type',
)
write('src/types.ts', server_types)

client_types = read('client/types.ts')
client_types = replace_once(
    client_types,
    "  queuedIdling?: number[];\n  idleBatchIndex?: number;",
    "  queuedIdling?: number[];\n  priorityAppIds?: number[];\n  priorityCount?: number;\n  idleBatchIndex?: number;",
    'client priority status type',
)
write('client/types.ts', client_types)

client = read('client/app.ts')
client = replace_once(
    client,
    "  selectDropsBtn: $('#selectDropsBtn'), clearBtn: $('#clearBtn'), manualBtn: $('#manualBtn'), copyBtn: $('#copyBtn'),",
    "  selectDropsBtn: $('#selectDropsBtn'), prioritySelectedBtn: $('#prioritySelectedBtn'), clearPriorityBtn: $('#clearPriorityBtn'),\n  clearBtn: $('#clearBtn'), manualBtn: $('#manualBtn'), copyBtn: $('#copyBtn'),",
    'client priority controls',
)

client = replace_once(
    client,
    "    if (filter === 'selected') return selected.has(g.appid);\n    if (filter === 'played') return g.playtime > 0 || g.lastPlayed > 0;",
    "    if (filter === 'selected') return selected.has(g.appid);\n    if (filter === 'priority') return (status.priorityAppIds || []).includes(g.appid);\n    if (filter === 'played') return g.playtime > 0 || g.lastPlayed > 0;",
    'priority filter',
)

client = replace_once(
    client,
    "  const idling = new Set(status.idling || []);\n  els.visibleCount.textContent = apps.length;",
    "  const idling = new Set(status.idling || []);\n  const priorities = new Set(status.priorityAppIds || []);\n  els.visibleCount.textContent = apps.length;",
    'priority render set',
)

client = replace_once(
    client,
    "    const isSelected = selected.has(g.appid);\n    const isIdling = idling.has(g.appid);\n    const isQueued = !!status.idleWanted && isSelected && !isIdling;\n    label.className = `game${isSelected ? ' active' : ''}${isIdling ? ' idling' : ''}${isQueued ? ' queued' : ''}`;",
    "    const isSelected = selected.has(g.appid);\n    const isIdling = idling.has(g.appid);\n    const isPriority = priorities.has(g.appid);\n    const isQueued = !!status.idleWanted && isSelected && !isIdling;\n    label.className = `game${isSelected ? ' active' : ''}${isIdling ? ' idling' : ''}${isQueued ? ' queued' : ''}${isPriority ? ' priority' : ''}`;",
    'priority row class',
)

client = replace_once(
    client,
    "    for (const tag of sourceTags(g)) {\n      const chip = document.createElement('span');\n      chip.className = 'meta-chip';\n      chip.textContent = tag;\n      meta.append(chip);\n    }\n    if (g.lastPlayed) {",
    "    for (const tag of sourceTags(g)) {\n      const chip = document.createElement('span');\n      chip.className = 'meta-chip';\n      chip.textContent = tag;\n      meta.append(chip);\n    }\n    const priorityToggle = document.createElement('span');\n    priorityToggle.className = `priority-toggle${isPriority ? ' on' : ''}`;\n    priorityToggle.setAttribute('role', 'button');\n    priorityToggle.setAttribute('tabindex', '0');\n    priorityToggle.setAttribute('aria-label', `${isPriority ? 'Remove' : 'Set'} priority for ${g.name}`);\n    priorityToggle.title = isPriority ? 'Priority: stays active in every idle batch' : 'Pin as priority';\n    priorityToggle.textContent = isPriority ? '★ PRIORITY' : '☆ PRIORITY';\n    const doTogglePriority = async (ev) => {\n      ev.preventDefault();\n      ev.stopPropagation();\n      await togglePriority(g.appid);\n    };\n    priorityToggle.addEventListener('click', doTogglePriority);\n    priorityToggle.addEventListener('keydown', async ev => {\n      if (ev.key !== 'Enter' && ev.key !== ' ') return;\n      await doTogglePriority(ev);\n    });\n    meta.append(priorityToggle);\n    if (g.lastPlayed) {",
    'priority toggle chip',
)

client = replace_once(
    client,
    "    const stateTag = document.createElement('div');\n    stateTag.className = `state-tag${isIdling ? ' idling' : isQueued ? ' queued' : isSelected ? ' selected' : ''}`;\n    stateTag.textContent = isIdling ? 'ACTIVE' : isQueued ? 'QUEUED' : isSelected ? 'ARMED' : 'STANDBY';",
    "    const stateTag = document.createElement('div');\n    const pinnedLive = isPriority && isIdling;\n    stateTag.className = `state-tag${pinnedLive ? ' priority' : isIdling ? ' idling' : isQueued ? ' queued' : isPriority ? ' priority' : isSelected ? ' selected' : ''}`;\n    stateTag.textContent = pinnedLive ? 'PINNED' : isIdling ? 'ACTIVE' : isQueued ? 'QUEUED' : isPriority ? 'PRIORITY' : isSelected ? 'ARMED' : 'STANDBY';",
    'priority state tag',
)

client = replace_once(
    client,
    "function showError(err) { setNotice(err.message || String(err)); }\n\nasync function loadLibrary() {",
    "function showError(err) { setNotice(err.message || String(err)); }\n\nasync function setPriority(appids: number[]) {\n  const out = await api('/api/priority', { method:'POST', body: JSON.stringify({ appids }) });\n  status.priorityAppIds = Array.isArray(out.priorityAppIds) ? out.priorityAppIds : [];\n  status.priorityCount = status.priorityAppIds.length;\n  if (Array.isArray(out.selected)) selected = new Set(out.selected);\n  if (Array.isArray(out.idling)) status.idling = out.idling;\n  renderGames();\n  return out;\n}\n\nasync function togglePriority(appid: number) {\n  const next = new Set<number>(status.priorityAppIds || []);\n  if (next.has(appid)) next.delete(appid);\n  else { next.add(appid); selected.add(appid); }\n  try {\n    await setPriority([...next]);\n    setNotice(`${next.has(appid) ? 'Priority pinned' : 'Priority removed'} · App ${appid}`);\n  } catch (e) { showError(e); }\n}\n\nasync function loadLibrary() {",
    'priority client API',
)

client = replace_once(
    client,
    "  const batchText = Number(status.idleBatchCount || 0) > 1 ? ` · B${Number(status.idleBatchIndex || 0) + 1}/${status.idleBatchCount}` : '';\n  els.sessionText.textContent = activeCount ? `${activeCount}/${desiredCount} ACTIVE${batchText}` : status.idleWanted ? 'PENDING' : yielding ? 'YIELD' : 'IDLE';",
    "  const batchText = Number(status.idleBatchCount || 0) > 1 ? ` · B${Number(status.idleBatchIndex || 0) + 1}/${status.idleBatchCount}` : '';\n  const priorityText = Number(status.priorityCount || 0) ? ` · P${status.priorityCount}` : '';\n  els.sessionText.textContent = activeCount ? `${activeCount}/${desiredCount} ACTIVE${priorityText}${batchText}` : status.idleWanted ? `PENDING${priorityText}` : yielding ? 'YIELD' : `IDLE${priorityText}`;",
    'priority session telemetry',
)

client = replace_once(
    client,
    "});\nels.selectVisibleBtn.addEventListener('click', () => { visibleApps().forEach(g => selected.add(g.appid)); persistSelection(); renderGames(); });\nels.selectDropsBtn.addEventListener('click', () => { selected.clear(); library.filter(g => Number(g.cardDrops || 0) > 0).forEach(g => selected.add(g.appid)); persistSelection(); renderGames(); });\nels.clearBtn.addEventListener('click', () => { selected.clear(); persistSelection(); renderGames(); });",
    "});\nels.selectVisibleBtn.addEventListener('click', () => { visibleApps().forEach(g => selected.add(g.appid)); persistSelection(); renderGames(); });\nels.selectDropsBtn.addEventListener('click', () => { selected.clear(); library.filter(g => Number(g.cardDrops || 0) > 0).forEach(g => selected.add(g.appid)); (status.priorityAppIds || []).forEach(id => selected.add(id)); persistSelection(); renderGames(); });\nels.prioritySelectedBtn.addEventListener('click', async () => {\n  const next = new Set<number>(status.priorityAppIds || []);\n  selected.forEach(id => next.add(id));\n  try { await setPriority([...next]); setNotice(`Priority pinned: ${next.size}/${status.idleMaxConcurrent || 32}`); } catch (e) { showError(e); }\n});\nels.clearPriorityBtn.addEventListener('click', async () => {\n  try { await setPriority([]); setNotice('Priority cleared. Games remain selected and will rotate normally.'); } catch (e) { showError(e); }\n});\nels.clearBtn.addEventListener('click', () => { selected = new Set(status.priorityAppIds || []); persistSelection(); renderGames(); });",
    'priority bulk actions',
)

write('client/app.ts', client)

html = read('public/index.html')
html = replace_once(
    html,
    '        <option value="selected">Selected</option>\n        <option value="played">Played</option>',
    '        <option value="selected">Selected</option>\n        <option value="priority">Priority</option>\n        <option value="played">Played</option>',
    'priority filter option',
)
html = replace_once(
    html,
    '        <button id="selectDropsBtn" class="btn btn-ghost">Select drops</button>\n        <button id="clearBtn" class="btn btn-ghost">Clear</button>',
    '        <button id="selectDropsBtn" class="btn btn-ghost">Select drops</button>\n        <button id="prioritySelectedBtn" class="btn btn-ghost">Priority selected</button>\n        <button id="clearPriorityBtn" class="btn btn-ghost">Clear priority</button>\n        <button id="clearBtn" class="btn btn-ghost">Clear</button>',
    'priority action buttons',
)
write('public/index.html', html)

css = read('public/style.css')
css = replace_once(
    css,
    ".meta-chip { border: 1px solid #20344a; padding: 1px 4px; color: #6f87a0; font-size: 9px; text-transform: uppercase; }",
    ".meta-chip { border: 1px solid #20344a; padding: 1px 4px; color: #6f87a0; font-size: 9px; text-transform: uppercase; }\n.priority-toggle { border: 1px solid #2a3440; padding: 1px 5px; color: #63758b; font-size: 9px; font-weight: 800; letter-spacing: .04em; cursor: pointer; user-select: none; }\n.priority-toggle:hover { color: var(--amber); border-color: rgba(245,183,75,.4); }\n.priority-toggle.on { color: var(--amber); border-color: rgba(245,183,75,.45); background: rgba(245,183,75,.05); }",
    'priority chip css',
)
css = replace_once(
    css,
    ".state-tag.queued { color: var(--amber); border-color: rgba(245,183,75,.34); background: rgba(245,183,75,.035); }\n.state-tag.idling { color: var(--green); border-color: rgba(99,230,167,.35); background: rgba(99,230,167,.04); }",
    ".state-tag.queued { color: var(--amber); border-color: rgba(245,183,75,.34); background: rgba(245,183,75,.035); }\n.state-tag.priority { color: var(--amber); border-color: rgba(245,183,75,.46); background: rgba(245,183,75,.05); }\n.state-tag.idling { color: var(--green); border-color: rgba(99,230,167,.35); background: rgba(99,230,167,.04); }",
    'priority state css',
)
write('public/style.css', css)

pkg_path = Path('package.json')
pkg = json.loads(pkg_path.read_text(encoding='utf-8'))
pkg['version'] = '0.3.2'
pkg_path.write_text(json.dumps(pkg, indent=2) + '\n', encoding='utf-8')

readme = read('README.md')
old_readme = "## Steam concurrency and playtime\\n\\nSteam presence has a finite simultaneous-app capacity. O-Steam-Idle keeps at most 32 games ACTIVE at a time and round-robins larger selections in 30-minute batches by default. Games waiting for their turn are shown as QUEUED instead of LIVE.\\n\\nSet O_IDLE_ROTATE_MINUTES to change the batch duration or O_IDLE_MAX_CONCURRENT to use a lower cap. The app never requests more than 32 concurrent AppIDs.\\n\\nPlaytime shown in the UI is a Steam snapshot, not a local stopwatch. While idling, O-Steam-Idle refreshes that snapshot every 5 minutes by default (O_IDLE_PLAYTIME_SYNC_MINUTES). Steam can still publish playtime asynchronously, so an ACTIVE batch may not show an immediate counter change.\\n\\n## Cloudflare Container mode"
new_readme = """## Steam concurrency and playtime

Steam presence has a finite simultaneous-app capacity. O-Steam-Idle keeps at most 32 games ACTIVE at a time and round-robins larger selections in 30-minute batches by default. Games waiting for their turn are shown as QUEUED instead of LIVE.

Priority games are pinned into every active batch. The remaining active slots rotate through the non-priority selection. Marking a game as priority also keeps it selected; **Clear** preserves priority games, while **Clear priority** returns them to normal rotation. Priority is capped at the active-slot limit, and the UI refuses a 32-priority configuration when other games are already waiting to rotate.

Set `O_IDLE_ROTATE_MINUTES` to change the batch duration or `O_IDLE_MAX_CONCURRENT` to use a lower cap. The app never requests more than 32 concurrent AppIDs.

Playtime shown in the UI is a Steam snapshot, not a local stopwatch. While idling, O-Steam-Idle refreshes that snapshot every 5 minutes by default (`O_IDLE_PLAYTIME_SYNC_MINUTES`). Steam can still publish playtime asynchronously, so an ACTIVE batch may not show an immediate counter change.

## Cloudflare Container mode"""
readme = replace_once(readme, old_readme, new_readme, 'readme priority docs')
write('README.md', readme)

print('Applied persistent priority/pinned idle slots.')
