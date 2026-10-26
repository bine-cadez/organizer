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

/** Bookkeeping purge runs at most once per this interval. */
export const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Rows deleted per statement. One pass never scans or deletes an unbounded set. */
export const CLEANUP_BATCH_LIMIT = 200;
/** How many batches one daily pass will issue for a single table. */
export const CLEANUP_MAX_BATCHES = 25;
export const CLEANUP_AT_KEY = "maintenance:cleaned_at";

/** Finished outbox rows and idempotency receipts are kept this long. */
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
