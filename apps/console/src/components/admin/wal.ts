// WAL archiving is healthy when it is on and the most recent archive is newer than the most recent failure. Postgres keeps the failure
// count since its statistics were reset, so a single old failure must not show as a problem forever.
interface Wal { mode?: string; failed_count?: number; last_failed_time?: string | null; last_archived_time?: string | null }
export const walHealthy = (w: Wal): boolean => {
  if (w.mode !== 'on') return false;
  if (!w.failed_count) return true;
  return !!w.last_archived_time && !!w.last_failed_time && Date.parse(w.last_archived_time) > Date.parse(w.last_failed_time);
};
export const walText = (w: Wal): string => {
  if (w.mode !== 'on') return `archiving is ${w.mode ?? 'unknown'}`;
  if (!w.failed_count) return 'on · no failures';
  const since = walHealthy(w) ? 'recovered: archived since the last failure' : 'the latest archive attempt failed';
  return `on · ${w.failed_count} failure${w.failed_count === 1 ? '' : 's'} in total, ${since}`;
};
