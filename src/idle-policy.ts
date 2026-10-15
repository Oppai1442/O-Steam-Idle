/** Pure idle-state guards shared by Steam event handlers and tests. */
export interface IdleStateLike {
  idleWanted: boolean;
  desiredIdling: number[];
  shuttingDown: boolean;
  connected: boolean;
  externalPlaying: boolean;
  idleSuspended: boolean;
  clientBlocked?: boolean;
}
export function hasPendingIdle(state: Pick<IdleStateLike, 'idleWanted' | 'desiredIdling' | 'shuttingDown'>): boolean {
  return state.idleWanted && state.desiredIdling.length > 0 && !state.shuttingDown;
}
export function shouldYieldIdle(state: Pick<IdleStateLike, 'externalPlaying' | 'clientBlocked'>): boolean {
  return !!state.externalPlaying || !!state.clientBlocked;
}
export function canApplyIdle(state: IdleStateLike): boolean {
  return hasPendingIdle(state) && state.connected && !shouldYieldIdle(state);
}
