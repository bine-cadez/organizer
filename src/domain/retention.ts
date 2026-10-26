/** How often a connected calendar is refreshed, and how long busy data stays fresh. */
export const CALENDAR_SYNC_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Delay before the alarm runs again after a failure (for example the daily
 * rows_read limit). Long enough that recovery is not a tight retry loop.
 * Cloudflare's own alarm retries are finite, so the handler schedules this
 * itself and then returns.
 */
export const ALARM_RECOVERY_MS = 15 * 60 * 1000;

/** Automatic sync looks this far behind and ahead of the local day. */
export const CALENDAR_SYNC_PAST_MS = 7 * 24 * 60 * 60 * 1000;
export const CALENDAR_SYNC_FUTURE_MS = 28 * 24 * 60 * 60 * 1000;

/**
 * A purge that finished (nothing left) waits this long before running again.
 * A purge that stops on the daily row budget continues on a later day.
 */
export const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Rows deleted per statement. One pass never scans or deletes an unbounded set. */
export const CLEANUP_BATCH_LIMIT = 200;
/**
 * Shared cap for one purge, across every table. Cloudflare's free tier counts
 * index maintenance toward rows_written (100k/day); staying near 2k deleted
 * rows leaves room for those index writes. Leftovers continue the next day.
 */
export const CLEANUP_DAILY_ROW_BUDGET = 2000;
/** Set only when a purge finishes. A partial purge leaves this unset so the next alarm can continue. */
export const CLEANUP_AT_KEY = "maintenance:cleaned_at";
/** Rows already deleted in the current daily budget window. */
export const CLEANUP_PROGRESS_KEY = "maintenance:cleanup_progress";

/** Succeeded and superseded outbox rows, and idempotency receipts, are kept this long. */
export const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** System and command audit rows. Not user-authored notes. */
export const AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Calendar mirror retention. The past buffer is longer than the 7-day sync
 * lookback. The future bound keeps dates the week view can still show after a
 * user-driven sync; anything further ahead is outside planning range.
 */
export const CALENDAR_PAST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const CALENDAR_FUTURE_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;
