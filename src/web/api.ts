import {
  formatAudiobookProgress,
  formatDuration,
  isAudiobook,
  progressPercent,
  splitDuration,
} from "../shared/duration";
import type {
  Snapshot,
  Item,
  Ticket,
  Booking,
  CalendarEvent,
} from "../shared/types";

export {
  formatAudiobookProgress,
  formatDuration,
  isAudiobook,
  progressPercent,
  splitDuration,
};

export class ApiError extends Error {
  code: string;
  details: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init });
  const value = (await response.json()) as {
    error?: { code?: string; message?: string; details?: unknown };
  };
  if (!response.ok || value.error)
    throw new ApiError(
      value.error?.code ?? "REQUEST_FAILED",
      value.error?.message ?? "Something went wrong. Please try again.",
      value.error?.details,
    );
  return value as T;
}
export async function query<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await request<{ data?: T } & T>(`/api/commands/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Organizer-Request": "1" },
    body: JSON.stringify(args),
  });
  return result.data ?? result;
}
export type Command = (
  name: string,
  args?: Record<string, unknown>,
  quiet?: boolean,
) => Promise<any>;
export const zone = "Europe/Ljubljana";
export const dateOf = (instant: string | Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
export const timeOf = (instant: string | Date) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(instant));
export const longDate = (date: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(`${date}T12:00:00Z`));
export const shortDate = (date: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(new Date(`${date}T12:00:00Z`));
export function addDays(date: string, count: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}
export function monday(date: string) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -(day === 0 ? 6 : day - 1));
}
export function localInstant(date: string, time: string) {
  const target = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(target))
    throw new Error("Choose a valid date and time.");
  let result = target;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(result));
    const part = (name: string) => parts.find((p) => p.type === name)?.value;
    const represented = Date.parse(
      `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}Z`,
    );
    result = target - (represented - result);
  }
  if (dateOf(new Date(result)) !== date || timeOf(new Date(result)) !== time)
    throw new Error("That local time does not exist. Choose another time.");
  return new Date(result).toISOString();
}
export function todayTickets(state: Snapshot, date = state.localDate) {
  const dayStart = Date.parse(localInstant(date, "00:00"));
  const dayEnd = Date.parse(localInstant(addDays(date, 1), "00:00"));
  const active = new Set(
    state.items
      .filter((i) => i.kind === "project" && i.state === "active")
      .map((i) => i.id),
  );
  return state.tickets.filter(
    (t) =>
      active.has(t.projectId) &&
      t.status !== "closed" &&
      (t.status === "in_progress" ||
        t.plannedFor === date ||
        (t.status === "done" && t.doneAt && dateOf(t.doneAt) === date) ||
        state.bookings.some(
          (b) =>
            b.ticketId === t.id &&
            b.desiredPresence === "present" &&
            Date.parse(b.start) < dayEnd &&
            Date.parse(b.end) > dayStart,
        )),
  );
}
export function currentBooking(
  state: Snapshot,
  ticket: Ticket,
): Booking | undefined {
  return state.bookings.find(
    (b) => b.id === ticket.currentBookingId && b.desiredPresence === "present",
  );
}
export function itemProgress(state: Snapshot, item: Item) {
  if (item.kind === "book" && isAudiobook(item))
    return {
      current: item.positionMinutes ?? 0,
      total: item.durationMinutes ?? 0,
      label: formatAudiobookProgress(
        item.positionMinutes ?? 0,
        item.durationMinutes ?? 0,
      ),
    };
  if (item.kind === "book")
    return {
      current: item.currentPage ?? 0,
      total: item.pageCount ?? 0,
      label: `p. ${item.currentPage ?? 0} of ${item.pageCount ?? "?"}`,
    };
  const tickets = state.tickets.filter((t) => t.projectId === item.id);
  const done = tickets.filter((t) => t.status === "done").length;
  return {
    current: done,
    total: tickets.length,
    label: `${done} of ${tickets.length} tickets done · ${tickets.filter((t) => t.status === "in_progress").length} in progress`,
  };
}
export function eventsForDay(
  state: Snapshot,
  date: string,
): (CalendarEvent & { booking?: Booking; areaId?: string })[] {
  const dayStart = Date.parse(localInstant(date, "00:00"));
  const dayEnd = Date.parse(localInstant(addDays(date, 1), "00:00"));
  const events = state.events.filter(
    (e) =>
      !e.allDay &&
      e.start &&
      e.end &&
      Date.parse(e.start) < dayEnd &&
      Date.parse(e.end) > dayStart,
  );
  const result = events.map((e) => ({
    ...e,
    booking: state.bookings.find(
      (b) =>
        b.googleEventId === e.googleEventId &&
        b.accountId === e.accountId &&
        b.calendarId === e.calendarId,
    ),
    areaId: undefined as string | undefined,
  }));
  for (const booking of state.bookings.filter(
    (b) =>
      b.desiredPresence === "present" &&
      Date.parse(b.start) < dayEnd &&
      Date.parse(b.end) > dayStart,
  )) {
    const ticket = state.tickets.find((t) => t.id === booking.ticketId);
    const item = state.items.find((i) => i.id === ticket?.projectId);
    const existing = result.find(
      (e) =>
        e.googleEventId === booking.googleEventId &&
        e.accountId === booking.accountId &&
        e.calendarId === booking.calendarId,
    );
    if (existing) {
      existing.booking = booking;
      existing.areaId = item?.areaId;
      continue;
    }
    result.push({
      id: booking.id,
      accountId: booking.accountId,
      role: "personal",
      calendarId: booking.calendarId,
      googleEventId: booking.googleEventId,
      title: ticket?.title ?? "Booked ticket",
      start: booking.start,
      end: booking.end,
      allDay: false,
      isBusy: true,
      booking,
      areaId: item?.areaId,
    });
  }
  return result;
}
export const safe = (promise: Promise<unknown>) => {
  void promise.catch(() => undefined);
};
