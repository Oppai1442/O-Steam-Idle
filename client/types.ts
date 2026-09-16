export interface ClientGame {
  appid: number;
  name: string;
  playtime: number;
  lastPlayed: number;
  icon: string | null;
  discoveredViaProfile?: boolean;
  discoveredViaLocalSteam?: boolean;
  discoveredViaManual?: boolean;
  hasCards: boolean | null;
  cardDrops: number | null;
}

export interface ClientStatus {
  runtimeMode?: 'local' | 'cloud';
  accountName?: string | null;
  connected?: boolean;
  connecting?: boolean;
  reconnecting?: boolean;
  sessionConflict?: boolean;
  externalPlaying?: boolean;
  externalPlayingApp?: number;
  reconnectCount?: number;
  idleWanted?: boolean;
  idling?: number[];
  desiredIdling?: number[];
  queuedIdling?: number[];
  priorityAppIds?: number[];
  priorityCount?: number;
  idleBatchIndex?: number;
  idleBatchCount?: number;
  idleRotationAt?: number | null;
  idleMaxConcurrent?: number;
  idleRotateMinutes?: number;
  playtimeSyncing?: boolean;
  playtimeSyncAt?: number | null;
  playtimeRevision?: number;
  playtimeSyncError?: string | null;
  selected?: number[];
  hasSavedLogin?: boolean;
  qrDataUrl?: string | null;
  qrStatus?: string;
  libraryCount?: number;
  libraryReady?: boolean;
  libraryError?: string | null;
  cardScanReady?: boolean;
  cardScanRunning?: boolean;
  cardScanError?: string | null;
  cardGames?: number;
  cardDropsRemaining?: number;
  message?: string;
}
