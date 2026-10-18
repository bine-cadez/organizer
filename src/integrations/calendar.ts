import type { RemoteEvent } from "../domain/engine";

export interface GoogleCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}
export interface GoogleEvent {
  id: string;
  summary?: string;
  status?: string;
  etag?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { self?: boolean; responseStatus?: string }[];
  extendedProperties?: { private?: Record<string, string> };
}
export class CalendarProviderError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
    public retryable = false,
    public needsReconnect = false,
  ) {
    super(message);
  }
}
export function projectEvent(event: GoogleEvent): RemoteEvent {
  if (event.status === "cancelled")
    return { googleEventId: event.id, deleted: true };
  const allDay = Boolean(event.start?.date);
  return {
    googleEventId: event.id,
    title: event.summary || "Busy",
    etag: event.etag,
    allDay,
    start: event.start?.dateTime,
    end: event.end?.dateTime,
    startDate: event.start?.date,
    endDate: event.end?.date,
    isBusy:
      event.transparency !== "transparent" &&
      !event.attendees?.some(
        (person) => person.self && person.responseStatus === "declined",
      ),
  };
}
export async function refreshGoogleCredentials(
  credentials: GoogleCredentials,
  clientId: string,
  clientSecret: string,
  fetcher: typeof fetch = fetch,
): Promise<GoogleCredentials> {
  let response: Response;
  try {
    response = await fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: credentials.refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new CalendarProviderError(
      "Google Calendar is temporarily unavailable.",
      "PROVIDER_UNAVAILABLE",
      503,
      true,
    );
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    const revoked = data.error === "invalid_grant" || response.status === 401;
    throw new CalendarProviderError(
      revoked
        ? "Reconnect this Google Calendar account."
        : "Google Calendar is temporarily unavailable.",
      revoked ? "RECONNECT_REQUIRED" : "PROVIDER_UNAVAILABLE",
      response.status,
      !revoked,
      revoked,
    );
  }
  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || credentials.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}
export class GoogleCalendar {
  constructor(
    private accessToken: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  private async request(
    path: string,
    init: RequestInit = {},
    allowAbsent = false,
  ): Promise<unknown> {
    let response: Response;
    const fetcher = this.fetcher;
    try {
      response = await fetcher(
        `https://www.googleapis.com/calendar/v3${path}`,
        {
          ...init,
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
            ...init.headers,
          },
          signal: AbortSignal.timeout(15000),
        },
      );
    } catch {
      throw new CalendarProviderError(
        "Google Calendar is temporarily unavailable.",
        "PROVIDER_UNAVAILABLE",
        503,
        true,
      );
    }
    if (allowAbsent && [404, 410].includes(response.status)) return null;
    if (!response.ok) {
      const needsReconnect = response.status === 401;
      const details = (await response.json().catch(() => ({}))) as {
        error?: { errors?: { reason?: string }[] };
      };
      const limited =
        response.status === 429 ||
        details.error?.errors?.some((error) =>
          ["rateLimitExceeded", "userRateLimitExceeded"].includes(
            error.reason || "",
          ),
        );
      const code = needsReconnect
        ? "RECONNECT_REQUIRED"
        : limited
          ? "RATE_LIMITED"
          : response.status === 403
            ? "CALENDAR_SCOPE_REQUIRED"
            : response.status === 410
              ? "SYNC_TOKEN_INVALID"
              : response.status === 412
                ? "VERSION_CONFLICT"
                : response.status === 409
                  ? "EVENT_EXISTS"
                  : "PROVIDER_UNAVAILABLE";
      throw new CalendarProviderError(
        needsReconnect
          ? "Reconnect this Google Calendar account."
          : limited
            ? "Google Calendar is busy. Retrying shortly."
            : response.status === 403
              ? "Google Calendar denied access. Reconnect and allow the requested permission."
              : response.status === 412
                ? "Google changed this event. Read its current state before changing it."
                : "Google Calendar could not complete the request.",
        code,
        response.status,
        Boolean(limited) || response.status >= 500,
        needsReconnect,
      );
    }
    return response.status === 204 ? null : response.json();
  }
  private eventPath(calendarId: string, eventId?: string): string {
    return `/calendars/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}`;
  }
  async list(
    calendarId: string,
    options: { start: string; end: string; syncToken?: string },
  ): Promise<{ events: GoogleEvent[]; syncToken?: string }> {
    const events: GoogleEvent[] = [];
    let pageToken: string | undefined, syncToken: string | undefined;
    do {
      const params = new URLSearchParams({
        singleEvents: "true",
        showDeleted: "true",
        maxResults: "2500",
      });
      if (options.syncToken) params.set("syncToken", options.syncToken);
      else {
        params.set("timeMin", options.start);
        params.set("timeMax", options.end);
      }
      if (pageToken) params.set("pageToken", pageToken);
      const data = (await this.request(
        `${this.eventPath(calendarId)}?${params}`,
      )) as {
        items?: GoogleEvent[];
        nextPageToken?: string;
        nextSyncToken?: string;
      };
      events.push(...(data.items || []));
      pageToken = data.nextPageToken;
      syncToken = data.nextSyncToken;
      if (events.length > 25000)
        throw new CalendarProviderError(
          "This calendar range has too many events. Choose a shorter range.",
          "RANGE_TOO_LARGE",
          400,
        );
    } while (pageToken);
    return { events, syncToken };
  }
  get(calendarId: string, eventId: string): Promise<GoogleEvent | null> {
    return this.request(
      this.eventPath(calendarId, eventId),
      {},
      true,
    ) as Promise<GoogleEvent | null>;
  }
  async create(
    calendarId: string,
    event: {
      id: string;
      ticketId: string;
      bookingId: string;
      title: string;
      projectTitle: string;
      start: string;
      end: string;
    },
  ): Promise<GoogleEvent> {
    try {
      return (await this.request(this.eventPath(calendarId), {
        method: "POST",
        body: JSON.stringify({
          id: event.id,
          summary: event.title,
          description: `Booked from Organizer · ${event.projectTitle}`,
          start: { dateTime: event.start, timeZone: "Europe/Ljubljana" },
          end: { dateTime: event.end, timeZone: "Europe/Ljubljana" },
          extendedProperties: {
            private: {
              organizerTicketId: event.ticketId,
              organizerBookingId: event.bookingId,
            },
          },
        }),
      })) as GoogleEvent;
    } catch (error) {
      if (
        !(error instanceof CalendarProviderError) ||
        error.code !== "EVENT_EXISTS"
      )
        throw error;
      const existing = await this.get(calendarId, event.id);
      if (
        existing?.extendedProperties?.private?.organizerBookingId !==
        event.bookingId
      )
        throw new CalendarProviderError(
          "Google event identity conflict. No event was changed.",
          "EVENT_IDENTITY_CONFLICT",
          409,
        );
      return existing;
    }
  }
  patch(
    calendarId: string,
    eventId: string,
    changes: { start?: string; end?: string; title?: string },
    etag?: string,
  ): Promise<GoogleEvent> {
    return this.request(this.eventPath(calendarId, eventId), {
      method: "PATCH",
      headers: etag ? { "If-Match": etag } : undefined,
      body: JSON.stringify({
        ...(changes.start
          ? { start: { dateTime: changes.start, timeZone: "Europe/Ljubljana" } }
          : {}),
        ...(changes.end
          ? { end: { dateTime: changes.end, timeZone: "Europe/Ljubljana" } }
          : {}),
        ...(changes.title ? { summary: changes.title } : {}),
      }),
    }) as Promise<GoogleEvent>;
  }
  async remove(calendarId: string, eventId: string): Promise<void> {
    await this.request(
      this.eventPath(calendarId, eventId),
      { method: "DELETE" },
      true,
    );
  }
}
