/**
 * Non-secret cloud preferences. Steam credentials never belong in DO storage.
 * These values survive Linux Container replacement and rollouts.
 */
export interface CloudIdleConfig {
  version: 1;
  selected: number[];
  priorityAppIds: number[];
  manualAppIds: number[];
  desiredIdling: number[];
  idleWanted: boolean;
}

function appIds(input: unknown, cap = 1000): number[] {
  if (!Array.isArray(input)) return [];
  const clean = new Set<number>();
  for (const value of input) {
    const n = Number(value);
    if (Number.isSafeInteger(n) && n > 0 && n <= 4294967295) clean.add(n);
    if (clean.size >= cap) break;
  }
  return [...clean];
}
function csvIds(input?: string): number[] {
  return appIds((input || '').split(/[^0-9]+/).filter(Boolean));
}

/** Safe normalization when loading from DO storage or the Node container. */
export function normalizeCloudConfig(value: unknown): CloudIdleConfig {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const priorityAppIds = appIds(raw.priorityAppIds, 32);
  const selected = appIds([...(Array.isArray(raw.selected) ? raw.selected : []), ...priorityAppIds]);
  const desiredIdling = appIds(raw.desiredIdling);
  const idleWanted = raw.idleWanted === true && desiredIdling.length > 0;
  return {
    version: 1, selected, priorityAppIds,
    manualAppIds: appIds(raw.manualAppIds),
    desiredIdling: idleWanted ? appIds([...priorityAppIds, ...desiredIdling]) : [],
    idleWanted
  };
}

/** Optional initial defaults; dashboard updates become the durable source. */
export function initialCloudConfig(env: {
  O_IDLE_DEFAULT_APPIDS?: string;
  O_IDLE_PRIORITY_APPIDS?: string;
  O_IDLE_AUTO_START?: string;
}): CloudIdleConfig {
  const priorityAppIds = csvIds(env.O_IDLE_PRIORITY_APPIDS).slice(0, 32);
  const selected = appIds([...priorityAppIds, ...csvIds(env.O_IDLE_DEFAULT_APPIDS)]);
  return normalizeCloudConfig({
    selected, priorityAppIds, manualAppIds: [],
    desiredIdling: env.O_IDLE_AUTO_START === '1' ? selected : [],
    idleWanted: env.O_IDLE_AUTO_START === '1'
  });
}
