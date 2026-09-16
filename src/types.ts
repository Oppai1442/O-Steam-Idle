export type RuntimeMode = 'local' | 'cloud';
export type QrStatus = 'idle' | 'creating' | 'waiting' | 'scanned' | 'approved' | 'done' | 'timeout' | 'error';

export interface LibraryApp {
  appid: number;
  name: string;
  playtime: number;
  lastPlayed: number;
  icon: string | null;
  discoveredViaProfile?: boolean;
  discoveredViaDynamicStore?: boolean;
  discoveredViaLocalSteam?: boolean;
  discoveredViaManual?: boolean;
  manualType?: string | null;
  hasCards: boolean | null;
  cardDrops: number | null;
}

export interface LastDisconnect {
  at: number;
  eresult: number;
  message: string | null;
}

export interface RuntimeState {
  connected: boolean;
  connecting: boolean;
  qrDataUrl: string | null;
  qrStatus: QrStatus;
  steamID: string | null;
  accountName: string | null;
  selected: number[];
  idling: number[];
  libraryReady: boolean;
  libraryError: string | null;
  cardScanReady: boolean;
  cardScanRunning: boolean;
  cardScanError: string | null;
  cardGames: number;
  cardDropsRemaining: number;
  message: string;
  externalPlaying: boolean;
  externalPlayingApp: number;
  idleSuspended: boolean;
  sessionConflict: boolean;
  reconnecting: boolean;
  reconnectCount: number;
  lastDisconnect: LastDisconnect | null;
  lastConnectedAt: number | null;
  idleWanted: boolean;
  desiredIdling: number[];
  idleBatchIndex: number;
  idleBatchCount: number;
  idleRotationAt: number | null;
  playtimeSyncing: boolean;
  playtimeSyncAt: number | null;
  playtimeRevision: number;
  playtimeSyncError: string | null;
  shuttingDown: boolean;
  runtimeMode: RuntimeMode;
}

export interface SettingsFile {
  selected?: unknown[];
  manualAppIds?: unknown[];
  logonID?: unknown;
}
