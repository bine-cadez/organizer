import { DurableObject } from "cloudflare:workers";
import {
  DomainError,
  OrganizerEngine,
  type AccountInput,
  type DbPort,
} from "../domain/engine";
import {
  CalendarProviderError,
  GoogleCalendar,
  projectEvent,
  refreshGoogleCredentials,
  type GoogleCredentials,
} from "../integrations/calendar";
import { decryptSecret, encryptSecret } from "../integrations/crypto";
import type { Actor, CalendarRole } from "../shared/types";
import type { AppEnv } from "../worker/env";
import { addDays, dayBounds } from "../domain/time";
import {
  ALARM_ENSURE_INTERVAL_MS,
  ALARM_HORIZON_MS,
  ALARM_RECOVERY_MAX_MS,
  ALARM_RECOVERY_MS,
  CALENDAR_SYNC_INTERVAL_MS,
  CLEANUP_AT_KEY,
  CLEANUP_DAILY_ROW_BUDGET,
  CLEANUP_INTERVAL_MS,
  CLEANUP_PROGRESS_KEY,
} from "../domain/retention";

type CalendarRange = { start: string; end: string };
type CleanupProgress = { startedAt: number; deleted: number };

export class OrganizerStore extends DurableObject<AppEnv> {
  private engine: OrganizerEngine;
  private syncing = new Map<string, Promise<void>>();
  private refreshing = new Map<CalendarRole, Promise<GoogleCredentials>>();
  // The books rebuild turns foreign keys off before the first write. workerd
  // ignores PRAGMA foreign_keys=ON until a later event, and only when that
  // pragma runs before the event's first write. schemaReady stays false while
  // the engine migrates so this retry does not undo the rebuild.
  private schemaReady = false;
  private foreignKeysOn = false;
  /** Skip schedule reads briefly after confirming there is nothing to arm. */
  private nextIdleAlarmProbeAt = 0;
  /** One alarm_check log per wake interval, so a hot object does not spam. */
  private nextAlarmCheckLogAt = 0;
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    const db: DbPort = {
      all: (sql, ...bindings) => {
        this.ensureForeignKeys();
        return ctx.storage.sql.exec(sql, ...bindings).toArray();
      },
      run: (sql, ...bindings) => {
        this.ensureForeignKeys();
        ctx.storage.sql.exec(sql, ...bindings).toArray();
      },
      transaction: (callback) => {
        this.ensureForeignKeys();
        return ctx.storage.transactionSync(callback);
      },
    };
    this.engine = new OrganizerEngine(db);
    this.schemaReady = true;
    this.ensureForeignKeys();
    // Any wake (request or alarm) re-arms a platform-dropped alarm before
    // other work. getAlarm() is metadata; arm() runs when it is missing or
    // no longer a live schedule.
    ctx.blockConcurrencyWhile(() => this.ensureAlarm());
  }
  private ensureForeignKeys() {
    if (!this.schemaReady || this.foreignKeysOn) return;
    this.ctx.storage.sql.exec("PRAGMA foreign_keys=ON");
    this.foreignKeysOn =
      Number(
        this.ctx.storage.sql.exec("PRAGMA foreign_keys").toArray()[0]
          ?.foreign_keys,
      ) === 1;
  }
  async snapshot() {
    await this.ensureAlarm();
    this.ensureForeignKeys();
    return this.engine.snapshot();
  }
  private requestedRange(
    name: string,
    args: Record<string, unknown>,
  ): CalendarRange | undefined {
    if (args.date !== undefined) {
      const date = String(args.date),
        parsed = Date.parse(`${date}T12:00:00Z`);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(parsed) ||
        new Date(parsed).toISOString().slice(0, 10) !== date
      )
        return;
    }
    if (typeof args.start === "string" && typeof args.end === "string") {
      const start = Date.parse(args.start),
        end = Date.parse(args.end);
      // Invalid public intervals belong to domain validation, not a provider request.
      return Number.isFinite(start) &&
        Number.isFinite(end) &&
        end > start &&
        end - start <= 31 * 86400000
        ? { start: args.start, end: args.end }
        : undefined;
    }
    let date: string | undefined;
    if (name === "find_free_starts" || name === "get_today")
      date =
        typeof args.date === "string"
          ? args.date
          : this.engine.snapshot().localDate;
    if (name === "get_review")
      date = addDays(
        typeof args.date === "string"
          ? args.date
          : this.engine.snapshot().reviewDate,
        1,
      );
    if (name === "save_review") {
      const review = this.engine
        .snapshot()
        .reviews.find((r) => r.date === args.date);
      if (
        !review?.draft?.slippedDestinations.some(
          (choice) => choice.destination.kind === "book",
        )
      )
        return;
      date = addDays(String(args.date), 1);
    }
    if (name === "resize_booking") {
      const booking = this.engine
        .snapshot()
        .bookings.find((b) => b.id === args.bookingId);
      if (
        booking &&
        typeof args.end === "string" &&
        Number.isFinite(Date.parse(args.end)) &&
        Date.parse(args.end) > Date.parse(booking.start)
      )
        return { start: booking.start, end: args.end };
    }
    if (!date) return;
    const [start, end] = dayBounds(date);
    return {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    };
  }
  private covers(role: CalendarRole, range: CalendarRange): boolean {
    const account = this.engine.getAccountCredentials(role);
    return Boolean(
      account &&
      account.sources.every((source) => {
        const profile = this.ctx.storage.kv.get<CalendarRange>(
          `calendar-profile:${account.id}:${source.calendarId}`,
        );
        return (
          profile &&
          Date.parse(profile.start) <= Date.parse(range.start) &&
          Date.parse(profile.end) >= Date.parse(range.end) &&
          source.lastSyncedAt &&
          Date.now() - Date.parse(source.lastSyncedAt) <=
            CALENDAR_SYNC_INTERVAL_MS
        );
      }),
    );
  }
  async execute(name: string, args: Record<string, unknown>, actor: Actor) {
    await this.ensureAlarm();
    this.ensureForeignKeys();
    try {
      const replay = this.engine.replayReceipt(name, args, actor);
      if (replay !== undefined) return replay;
      const requiresFresh = [
        "find_free_starts",
        "book_ticket",
        "move_booking",
        "resize_booking",
        "save_review",
        "list_calendar_events",
        "get_today",
        "get_review",
      ].includes(name);
      let incomplete = false;
      const range = requiresFresh ? this.requestedRange(name, args) : undefined;
      if (range && args.mode !== "preview") {
        for (const connection of this.engine
          .snapshot()
          .connections.filter((c) => c.status === "connected")) {
          if (
            !this.covers(connection.role, range) ||
            name === "list_calendar_events"
          ) {
            try {
              await this.synchronize(connection.role, range);
            } catch (error) {
              incomplete = true;
              if (
                error instanceof CalendarProviderError &&
                error.needsReconnect
              )
                this.engine.setAccountStatus(
                  connection.role,
                  "needs_reconnect",
                );
            }
          }
        }
      }
      if (
        incomplete &&
        [
          "book_ticket",
          "move_booking",
          "resize_booking",
          "save_review",
        ].includes(name) &&
        args.acceptIncompleteAvailability !== true
      ) {
        throw new DomainError(
          "AVAILABILITY_INCOMPLETE",
          "Busy data for this date could not be refreshed. Retry or explicitly accept incomplete availability.",
        );
      }
      const result = this.engine.execute(name, args, actor);
      if (
        incomplete &&
        result &&
        typeof result === "object" &&
        "data" in result &&
        "meta" in result
      ) {
        const envelope = result as {
          data: Record<string, unknown>;
          meta: { warnings: unknown[] };
        };
        if (name === "find_free_starts") envelope.data.complete = false;
        envelope.meta.warnings.push({
          code: "AVAILABILITY_INCOMPLETE",
          message:
            "Requested calendar coverage could not be refreshed; cached intervals may be incomplete.",
        });
      }
      if (args.mode !== "preview") await this.arm();
      return result;
    } catch (error) {
      if (error instanceof DomainError)
        return {
          error: {
            code: error.code,
            message: error.message,
            status: error.status,
            details: error.details,
            retryable: error.retryable,
          },
        };
      throw error;
    }
  }
  async skipSetup() {
    await this.ensureAlarm();
    this.ensureForeignKeys();
    this.engine.skipSetup();
    return this.engine.snapshot();
  }
  async connectAccount(input: AccountInput) {
    this.ensureForeignKeys();
    const result = this.engine.connectAccount(input);
    // Sync immediately after a connect, but do not delay an earlier alarm.
    const now = Date.now();
    const soon = now + 100;
    const existing = await this.ctx.storage.getAlarm();
    if (
      existing == null ||
      this.alarmScheduleIsStale(existing, now) ||
      existing > soon
    )
      await this.ctx.storage.setAlarm(soon);
    return result;
  }
  async catalogPermit(identified: boolean): Promise<number> {
    await this.ensureAlarm();
    this.ensureForeignKeys();
    const now = Date.now(),
      previous = this.ctx.storage.kv.get<number>("catalog:next") || 0;
    const next = Math.max(now, previous);
    if (next - now > 10000)
      throw new Error("Book search is busy. Try again in a moment.");
    this.ctx.storage.kv.put("catalog:next", next + (identified ? 350 : 1050));
    return next - now;
  }
  private async credentials(role: CalendarRole): Promise<GoogleCredentials> {
    const inFlight = this.refreshing.get(role);
    if (inFlight) return inFlight;
    const refresh = (async () => {
      const account = this.engine.getAccountCredentials(role);
      if (!account || !this.env.TOKEN_ENCRYPTION_KEY)
        throw new CalendarProviderError(
          "Connect Google Calendar before booking.",
          "RECONNECT_REQUIRED",
          401,
          false,
          true,
        );
      const credentials = await decryptSecret<GoogleCredentials>(
        account.encryptedCredentials,
        this.env.TOKEN_ENCRYPTION_KEY,
      );
      if (credentials.expiresAt > Date.now() + 60000) return credentials;
      if (!this.env.GOOGLE_CLIENT_ID || !this.env.GOOGLE_CLIENT_SECRET)
        throw new CalendarProviderError(
          "Google Calendar is not configured.",
          "CONFIGURATION_REQUIRED",
          503,
        );
      const fresh = await refreshGoogleCredentials(
        credentials,
        this.env.GOOGLE_CLIENT_ID,
        this.env.GOOGLE_CLIENT_SECRET,
      );
      this.engine.updateAccountCredentials(
        role,
        await encryptSecret(fresh, this.env.TOKEN_ENCRYPTION_KEY),
      );
      return fresh;
    })();
    this.refreshing.set(role, refresh);
    try {
      return await refresh;
    } finally {
      this.refreshing.delete(role);
    }
  }
  private async synchronize(
    role: CalendarRole,
    range?: CalendarRange,
  ): Promise<void> {
    const baseline = this.engine.syncWindow(range);
    const key = `${role}:${baseline.start}:${baseline.end}`;
    const current = this.syncing.get(key);
    if (current) return current;
    // Different windows must not borrow each other's response or race their sync token.
    const previous = [...this.syncing.entries()]
      .filter(([k]) => k.startsWith(`${role}:`))
      .at(-1)?.[1];
    const task = (async () => {
      if (previous) await previous.catch(() => undefined);
      const account = this.engine.getAccountCredentials(role);
      if (!account || account.status === "needs_reconnect") return;
      const credentials = await this.credentials(role),
        google = new GoogleCalendar(credentials.accessToken);
      const now = Date.now();
      for (const source of account.sources) {
        const profileKey = `calendar-profile:${account.id}:${source.calendarId}`;
        const profile = this.ctx.storage.kv.get<{ start: string; end: string }>(
          profileKey,
        );
        const sameProfile =
          profile?.start === baseline.start && profile?.end === baseline.end;
        let token = sameProfile ? source.syncToken : undefined,
          full = !token;
        let result;
        try {
          result = await google.list(source.calendarId, {
            ...baseline,
            syncToken: token,
          });
        } catch (error) {
          if (
            !(error instanceof CalendarProviderError) ||
            error.code !== "SYNC_TOKEN_INVALID"
          )
            throw error;
          token = undefined;
          full = true;
          result = await google.list(source.calendarId, baseline);
        }
        const events = result.events.map(projectEvent);
        if (full) {
          const ids = new Set(result.events.map((event) => event.id));
          for (const googleEventId of this.engine
            .presentBookingEventIds(account.id, source.calendarId)
            .filter((id) => !ids.has(id))) {
            const observed = await google.get(source.calendarId, googleEventId);
            events.push(
              observed
                ? projectEvent(observed)
                : { googleEventId, deleted: true },
            );
          }
        }
        this.engine.reconcileCalendar({
          role,
          calendarId: source.calendarId,
          events,
          syncToken: result.syncToken,
          syncedAt: now,
          replace: full,
          replaceRange: baseline,
        });
        this.ctx.storage.kv.put(profileKey, baseline);
      }
    })();
    this.syncing.set(key, task);
    try {
      await task;
    } finally {
      this.syncing.delete(key);
    }
  }
  /**
   * A stored alarm the platform will not deliver. Slightly late delivery is
   * still live; more than a minute overdue is not. Daily cleanup is the
   * furthest real schedule, so anything past the horizon is not live either.
   * arm() would otherwise keep a past timestamp because it is "earlier".
   */
  private alarmScheduleIsStale(existing: number, now: number): boolean {
    return (
      existing < now - ALARM_ENSURE_INTERVAL_MS ||
      existing > now + ALARM_HORIZON_MS
    );
  }
  private noteAlarmCheck(existing: number | null, now: number) {
    if (now < this.nextAlarmCheckLogAt) return;
    this.nextAlarmCheckLogAt = now + ALARM_ENSURE_INTERVAL_MS;
    console.log(JSON.stringify({ event: "alarm_check", existing, now }));
  }
  /**
   * Restore a platform-dropped alarm. getAlarm() does not read SQL rows.
   * A live earlier alarm is left where it is. A timestamp the platform has
   * already given up on, or one further out than any schedule this object
   * sets, is replaced.
   */
  async ensureAlarm(): Promise<void> {
    try {
      const now = Date.now();
      const existing = await this.ctx.storage.getAlarm();
      this.noteAlarmCheck(existing, now);
      const stale =
        existing != null && this.alarmScheduleIsStale(existing, now);
      if (existing != null && !stale) {
        this.nextIdleAlarmProbeAt = 0;
        return;
      }
      if (!stale && now < this.nextIdleAlarmProbeAt) return;
      // ignoreAlarmAt stops arm() from keeping the dead timestamp as "earlier".
      await this.arm(
        stale ? { ignoreAlarmAt: existing ?? undefined } : undefined,
      );
      if ((await this.ctx.storage.getAlarm()) == null)
        this.nextIdleAlarmProbeAt = Date.now() + ALARM_ENSURE_INTERVAL_MS;
      else {
        this.nextIdleAlarmProbeAt = 0;
        console.log(JSON.stringify({ event: "alarm_rearmed" }));
      }
    } catch (error) {
      console.error(
        "organizer alarm ensure failed",
        error instanceof Error ? error.message : error,
      );
      try {
        const again = await this.ctx.storage.getAlarm();
        const recoveredAt = Date.now();
        // A future alarm at least a minute out, and still inside the horizon,
        // is not a hot loop. A past or far-future alarm is replaced.
        if (
          again != null &&
          !this.alarmScheduleIsStale(again, recoveredAt) &&
          again > recoveredAt + ALARM_ENSURE_INTERVAL_MS
        )
          return;
        await this.ctx.storage.setAlarm(recoveredAt + ALARM_RECOVERY_MS);
        console.log(JSON.stringify({ event: "alarm_rearmed" }));
      } catch (scheduleError) {
        console.error(
          "organizer alarm ensure could not schedule",
          scheduleError instanceof Error
            ? scheduleError.message
            : scheduleError,
        );
      }
    }
  }
  private async arm(options?: {
    failed?: boolean;
    cleanupPending?: boolean;
    claimedNothing?: boolean;
    /** When this alarm began. Used to tell a row that was already due from one queued while the alarm was awaiting. */
    alarmStartedAt?: number;
    /** Recovery alarm this handler just scheduled. A command may have replaced it; that sooner alarm must stay. */
    ignoreAlarmAt?: number;
    /** Failure backoff chosen for this attempt. Never below 15 minutes. */
    recoveryMs?: number;
  }) {
    if (options?.failed) {
      // The daily rows-read limit outlives a short retry. Keeping a sooner
      // alarm would run this handler again immediately, so failure always
      // waits out the backoff. Success still refuses to delay an earlier alarm.
      const delay = Math.min(
        ALARM_RECOVERY_MAX_MS,
        Math.max(ALARM_RECOVERY_MS, options.recoveryMs ?? ALARM_RECOVERY_MS),
      );
      await this.ctx.storage.setAlarm(Date.now() + delay);
      return;
    }
    this.ensureForeignKeys();
    const existing = await this.ctx.storage.getAlarm();
    const keepExisting = (next: number | null) =>
      existing != null &&
      existing !== options?.ignoreAlarmAt &&
      (next == null || existing <= next);
    const earliest = this.engine.earliestPendingAttempt();
    let next =
      earliest == null
        ? this.engine.hasConnectedCalendar()
          ? Date.now() + CALENDAR_SYNC_INTERVAL_MS
          : options?.cleanupPending
            ? Date.now() + CLEANUP_INTERVAL_MS
            : null
        : Math.max(Date.now() + 100, earliest);
    // An op that was already due when the alarm started, but could not be
    // claimed, must not spin the handler. A later unheld op keeps its own time.
    if (
      options?.claimedNothing &&
      next != null &&
      earliest != null &&
      options.alarmStartedAt != null &&
      earliest <= options.alarmStartedAt
    )
      next = Math.max(next, Date.now() + CALENDAR_SYNC_INTERVAL_MS);
    if (keepExisting(next)) return;
    if (next == null) {
      if (existing != null) await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(next);
  }
  /** Failure backoff: 15 minutes, plus 15 per platform retry, capped at an hour. */
  private recoveryDelay(attempt = 0) {
    const steps = Math.min(Math.max(0, attempt), 3);
    return Math.min(ALARM_RECOVERY_MAX_MS, ALARM_RECOVERY_MS * (steps + 1));
  }
  private cleanupIfDue(): boolean {
    const now = Date.now();
    const last = this.ctx.storage.kv.get<number>(CLEANUP_AT_KEY) ?? 0;
    if (now - last < CLEANUP_INTERVAL_MS) return false;
    const stored =
      this.ctx.storage.kv.get<CleanupProgress>(CLEANUP_PROGRESS_KEY);
    const progress =
      stored != null && now - stored.startedAt < CLEANUP_INTERVAL_MS
        ? stored
        : null;
    if (progress && progress.deleted >= CLEANUP_DAILY_ROW_BUDGET) return true;
    const already = progress?.deleted ?? 0;
    const result = this.engine.cleanupBookkeeping(
      CLEANUP_DAILY_ROW_BUDGET - already,
    );
    this.ctx.storage.kv.put(CLEANUP_PROGRESS_KEY, {
      startedAt: progress?.startedAt ?? now,
      deleted: already + result.deleted,
    });
    if (!result.more) this.ctx.storage.kv.put(CLEANUP_AT_KEY, now);
    return result.more;
  }
  async alarm(alarmInfo?: AlarmInvocationInfo) {
    // setAlarm writes. On workerd that opens the event's implicit transaction
    // and every later PRAGMA foreign_keys=ON is ignored, so re-enable first.
    // A rows-read failure here must not skip scheduling.
    try {
      this.ensureForeignKeys();
    } catch (error) {
      console.error(
        "organizer alarm could not enable foreign keys",
        error instanceof Error ? error.message : error,
      );
    }
    // Schedule recovery before doing work. Platform retries are finite and
    // start at about two seconds; once they are exhausted the alarm is gone.
    // Returning after setAlarm commits the next run instead of rethrowing.
    const alarmStartedAt = Date.now();
    const recoveryMs = this.recoveryDelay(alarmInfo?.retryCount ?? 0);
    let scheduled = false;
    let recoveryAt: number | undefined;
    try {
      recoveryAt = alarmStartedAt + recoveryMs;
      await this.ctx.storage.setAlarm(recoveryAt);
      scheduled = true;
    } catch (error) {
      console.error(
        "organizer alarm could not schedule recovery",
        error instanceof Error ? error.message : error,
      );
    }
    let failed = false;
    let cleanupPending = false;
    let claimed = 0;
    try {
      cleanupPending = this.cleanupIfDue();
    } catch (error) {
      failed = true;
      console.error(
        "organizer cleanup failed",
        error instanceof Error ? error.message : error,
      );
    }
    try {
      for (const operation of this.engine.dueOperations(10)) {
        const work = this.engine.claimOperation(operation.id);
        if (!work) continue;
        claimed += 1;
        try {
          if (!work.account)
            throw new CalendarProviderError(
              "Reconnect this calendar account.",
              "RECONNECT_REQUIRED",
              401,
              false,
              true,
            );
          if (work.action === "sync") {
            await this.synchronize(work.account.role);
            this.engine.completeOperation(operation.id);
            continue;
          }
          if (work.account.role !== "personal" || !work.booking || !work.ticket)
            throw new CalendarProviderError(
              "Only Organizer ticket bookings on Personal can be changed.",
              "CALENDAR_WRITE_FORBIDDEN",
              403,
            );
          const google = new GoogleCalendar(
            (await this.credentials("personal")).accessToken,
          );
          const booking = work.booking;
          if (work.action === "delete") {
            await google.remove(booking.calendarId, booking.googleEventId);
            this.engine.completeOperation(operation.id);
          } else {
            const create = () =>
              google.create(booking.calendarId, {
                id: booking.googleEventId,
                ticketId: work.ticket!.id,
                bookingId: booking.id,
                title: String(work.payload.summary || work.ticket!.title),
                projectTitle: String(
                  work.payload.projectTitle || work.project?.title || "",
                ),
                start: String(work.payload.start || booking.start),
                end: String(work.payload.end || booking.end),
              });
            let event;
            if (work.action === "create") event = await create();
            else {
              try {
                event = await google.patch(
                  booking.calendarId,
                  booking.googleEventId,
                  {
                    start:
                      typeof work.payload.start === "string"
                        ? work.payload.start
                        : undefined,
                    end:
                      typeof work.payload.end === "string"
                        ? work.payload.end
                        : undefined,
                    title:
                      typeof work.payload.summary === "string"
                        ? work.payload.summary
                        : undefined,
                  },
                  work.expectedRemoteEtag,
                );
              } catch (error) {
                if (
                  !(error instanceof CalendarProviderError) ||
                  ![404, 410].includes(error.status)
                )
                  throw error;
                if (
                  booking.remoteStart ||
                  booking.remoteEnd ||
                  work.expectedRemoteEtag
                ) {
                  // A previously observed occurrence disappeared in Google. Never resurrect it.
                  this.engine.reconcileCalendar({
                    role: "personal",
                    calendarId: booking.calendarId,
                    events: [
                      { googleEventId: booking.googleEventId, deleted: true },
                    ],
                    partial: true,
                  });
                  this.engine.completeOperation(operation.id);
                  continue;
                }
                // Recovery for an occurrence whose original insert was never observed. Reuse
                // the same identity; a provider tombstone/identity conflict is not a new event.
                event = await create();
              }
            }
            this.engine.completeOperation(operation.id, {
              remoteEvent: projectEvent(event),
            });
          }
        } catch (error) {
          const problem =
            error instanceof CalendarProviderError
              ? error
              : new CalendarProviderError(
                  "Calendar synchronization failed. Retry after checking the connection.",
                  "PROVIDER_UNAVAILABLE",
                  503,
                  true,
                );
          if (problem.code === "VERSION_CONFLICT" && work.account) {
            try {
              await this.synchronize(work.account.role);
            } catch {
              /* The failed operation remains visible for recovery. */
            }
          }
          this.engine.failOperation(operation.id, {
            code: problem.code,
            message: problem.message,
            retryable: problem.retryable,
            needsReconnect: problem.needsReconnect,
          });
        }
      }
      for (const role of this.engine.connectionsDueForSync(
        Date.now() - CALENDAR_SYNC_INTERVAL_MS,
      )) {
        try {
          await this.synchronize(role);
        } catch (error) {
          if (error instanceof CalendarProviderError) {
            if (error.needsReconnect)
              this.engine.setAccountStatus(role, "needs_reconnect");
          } else throw error;
        }
      }
    } catch (error) {
      failed = true;
      console.error(
        "organizer alarm failed",
        error instanceof Error ? error.message : error,
      );
    }
    try {
      await this.arm({
        failed,
        cleanupPending,
        claimedNothing: claimed === 0,
        alarmStartedAt,
        ignoreAlarmAt: recoveryAt,
        recoveryMs,
      });
    } catch (error) {
      console.error(
        "organizer alarm could not reschedule",
        error instanceof Error ? error.message : error,
      );
      if (scheduled) return;
      // Opening setAlarm failed and the reschedule read failed too. One more
      // metadata write, then rethrow only if that also fails so the platform
      // can retry. A successful write must not rethrow: platform retries are
      // a few seconds apart and then the alarm is deleted.
      try {
        await this.ctx.storage.setAlarm(Date.now() + recoveryMs);
      } catch (scheduleError) {
        console.error(
          "organizer alarm could not schedule recovery",
          scheduleError instanceof Error
            ? scheduleError.message
            : scheduleError,
        );
        throw scheduleError;
      }
    }
  }
}
