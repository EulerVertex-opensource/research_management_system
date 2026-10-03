/** What the dashboard's Sync button shows: local git state only (no fetch), cheap to recompute. */
export interface SyncBadge {
  /** False when the project is not a git repository or the sync remote is not set up; `reason` says why. */
  available: boolean;
  /** A sync started from the dashboard is running. */
  busy: boolean;
  remote?: string;
  branch?: string;
  /** Uncommitted changes under the shared research paths. */
  changed: number;
  /** Local commits not yet on the remote. */
  ahead: number;
  /** Remote commits not yet pulled (as of the last fetch). */
  behind: number;
  conflict: boolean;
  reason?: string;
}

export interface SyncNotice {
  level: 'info' | 'warning';
  message: string;
  details?: string[];
}
