import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptSecret,
  digest,
  encryptSecret,
  randomToken,
} from "../src/integrations/crypto";
import {
  GoogleCalendar,
  projectEvent,
  refreshGoogleCredentials,
  type GoogleEvent,
} from "../src/integrations/calendar";
import { BookCatalog, normalizeIsbn } from "../src/integrations/books";

function cacheFixture() {
  const values = new Map<string, string>();
  const put = vi.fn(async (key: string, value: string, _options?: unknown) => {
    values.set(key, value);
  });
  const get = vi.fn(async (key: string, format?: string) => {
    const value = values.get(key);
    return value === undefined
      ? null
      : format === "json"
        ? JSON.parse(value)
        : value;
  });
  return { values, get, put, binding: { get, put } as unknown as KVNamespace };
}
const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const credentials = {
  accessToken: "old-access",
  refreshToken: "refresh-secret",
  expiresAt: 0,
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("calendar credential encryption", () => {
  it("round trips with fresh IVs and rejects ciphertext tampering and a different key", async () => {
    const encrypted = await encryptSecret(credentials, key);
    const second = await encryptSecret(credentials, key);
    expect(encrypted).not.toBe(second);
    expect(encrypted).not.toContain(credentials.refreshToken);
    expect(await decryptSecret(encrypted, key)).toEqual(credentials);
    const parts = encrypted.split(".");
    const bytes = Uint8Array.from(atob(parts[2]), (character) =>
      character.charCodeAt(0),
    );
    bytes[0] ^= 1;
    parts[2] = btoa(String.fromCharCode(...bytes));
    await expect(decryptSecret(parts.join("."), key)).rejects.toThrow();
    await expect(
      decryptSecret(
        encrypted,
        btoa(String.fromCharCode(...new Uint8Array(32).fill(8))),
      ),
    ).rejects.toThrow();
    await expect(encryptSecret(credentials, "not-a-key")).rejects.toThrow(
      "32-byte",
    );
    await expect(decryptSecret("v2.invalid.credentials", key)).rejects.toThrow(
      "Invalid",
    );
  });

  it("uses URL-safe random credentials and SHA-256 hashes for persistent lookup keys", async () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(token);
    const hash = await digest(token);
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).not.toBe(token);
    expect(await digest(token)).toBe(hash);
  });
});

describe("Google Calendar adapter", () => {
  it("calls the platform fetch function without binding an adapter as its receiver", async () => {
    const fetcher = function (this: unknown) {
      expect(this).toBeUndefined();
      return Promise.resolve(Response.json({ id: "event" }));
    } as typeof fetch;
    expect(
      (await new GoogleCalendar("access", fetcher).get("primary", "event"))?.id,
    ).toBe("event");
  });
  it("projects transparent, self-declined, cancelled and all-day events correctly", () => {
    expect(
      projectEvent({ id: "free", transparency: "transparent" }).isBusy,
    ).toBe(false);
    expect(
      projectEvent({
        id: "declined",
        attendees: [{ self: true, responseStatus: "declined" }],
      }).isBusy,
    ).toBe(false);
    expect(
      projectEvent({
        id: "other-declined",
        attendees: [{ self: false, responseStatus: "declined" }],
      }).isBusy,
    ).toBe(true);
    expect(
      projectEvent({
        id: "deleted",
        status: "cancelled",
        summary: "Do not retain",
      }),
    ).toEqual({ googleEventId: "deleted", deleted: true });
    expect(
      projectEvent({
        id: "holiday",
        start: { date: "2026-10-19" },
        end: { date: "2026-10-20" },
      }),
    ).toMatchObject({
      allDay: true,
      startDate: "2026-10-19",
      endDate: "2026-10-20",
    });
  });

  it("converges after a lost insert response and conflict using the same stable event identity", async () => {
    const remote = new Map<string, GoogleEvent>();
    const postedIds: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        postedIds.push(body.id);
        if (remote.has(body.id))
          return Response.json({ error: { code: 409 } }, { status: 409 });
        remote.set(body.id, body);
        throw new TypeError(
          "Response was lost after Google accepted the event.",
        );
      }
      return Response.json(remote.values().next().value);
    });
    const calendar = new GoogleCalendar("access-secret", fetcher);
    const event = {
      id: "organizerstable123",
      ticketId: "tkt_1",
      bookingId: "book_1",
      title: "Read chapter",
      projectTitle: "Database study",
      start: "2026-10-19T08:00:00Z",
      end: "2026-10-19T09:00:00Z",
    };
    await expect(calendar.create("primary", event)).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
    });
    const retried = await calendar.create("primary", event);
    expect(retried.id).toBe(event.id);
    expect(remote.size).toBe(1);
    expect(postedIds).toEqual([event.id, event.id]);
    expect(retried.extendedProperties?.private).toEqual({
      organizerTicketId: "tkt_1",
      organizerBookingId: "book_1",
    });
    expect(retried).not.toHaveProperty("attendees");
  });

  it("does not adopt a conflicting event with a different Organizer booking marker", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({}, { status: 409 }))
      .mockResolvedValueOnce(
        Response.json({
          id: "same-id",
          extendedProperties: {
            private: { organizerBookingId: "another-booking" },
          },
        }),
      );
    await expect(
      new GoogleCalendar("access", fetcher).create("primary", {
        id: "same-id",
        ticketId: "tkt_1",
        bookingId: "book_1",
        title: "Ticket",
        projectTitle: "Project",
        start: "2026-10-19T08:00:00Z",
        end: "2026-10-19T09:00:00Z",
      }),
    ).rejects.toMatchObject({
      code: "EVENT_IDENTITY_CONFLICT",
      retryable: false,
    });
    expect(fetcher.mock.calls.map((call) => call[1]?.method ?? "GET")).toEqual([
      "POST",
      "GET",
    ]);
  });

  it("patches with If-Match, preserves unrequested fields and reports Google concurrency conflicts", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ id: "event_1" }))
      .mockResolvedValueOnce(Response.json({}, { status: 412 }));
    const calendar = new GoogleCalendar("access", fetcher);
    await calendar.patch(
      "shared/calendar@example.com",
      "event/1",
      { title: "Updated title" },
      '"etag-1"',
    );
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toContain(
      "shared%2Fcalendar%40example.com/events/event%2F1",
    );
    expect(new Headers(init?.headers).get("If-Match")).toBe('"etag-1"');
    expect(JSON.parse(String(init?.body))).toEqual({
      summary: "Updated title",
    });
    await expect(
      calendar.patch(
        "primary",
        "event_1",
        { end: "2026-10-19T10:00:00Z" },
        '"old-etag"',
      ),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", retryable: false });
  });

  it("distinguishes Calendar quota errors from missing permission", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { error: { errors: [{ reason: "rateLimitExceeded" }] } },
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: { errors: [{ reason: "insufficientPermissions" }] } },
          { status: 403 },
        ),
      );
    const calendar = new GoogleCalendar("access", fetcher);
    await expect(calendar.get("primary", "event_1")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      needsReconnect: false,
    });
    await expect(calendar.get("primary", "event_1")).rejects.toMatchObject({
      code: "CALENDAR_SCOPE_REQUIRED",
      retryable: false,
    });
  });

  it.each([404, 410])(
    "treats delete/get absence (%i) as success",
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => Response.json({}, { status }));
      const calendar = new GoogleCalendar("access", fetcher);
      await expect(
        calendar.remove("primary", "event_1"),
      ).resolves.toBeUndefined();
      await expect(calendar.get("primary", "event_1")).resolves.toBeNull();
    },
  );

  it("paginates incremental sync without incompatible time-window arguments", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ items: [{ id: "first" }], nextPageToken: "page-2" }),
      )
      .mockResolvedValueOnce(
        Response.json({
          items: [{ id: "deleted", status: "cancelled" }],
          nextSyncToken: "new-sync",
        }),
      );
    const result = await new GoogleCalendar("access", fetcher).list("primary", {
      start: "2026-10-01T00:00:00Z",
      end: "2026-11-01T00:00:00Z",
      syncToken: "old-sync",
    });
    expect(result.events).toHaveLength(2);
    expect(result.syncToken).toBe("new-sync");
    for (const [url] of fetcher.mock.calls) {
      const params = new URL(String(url)).searchParams;
      expect(params.get("syncToken")).toBe("old-sync");
      expect(params.get("showDeleted")).toBe("true");
      expect(params.has("timeMin")).toBe(false);
      expect(params.has("timeMax")).toBe(false);
    }
    expect(
      new URL(String(fetcher.mock.calls[1][0])).searchParams.get("pageToken"),
    ).toBe("page-2");
  });

  it("distinguishes revoked refresh grants from provider failures and retains rotated refresh tokens", async () => {
    const revoked = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ error: "invalid_grant" }, { status: 400 }),
      );
    await expect(
      refreshGoogleCredentials(credentials, "client", "secret", revoked),
    ).rejects.toMatchObject({
      code: "RECONNECT_REQUIRED",
      needsReconnect: true,
      retryable: false,
    });
    const unavailable = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ error: "server_error" }, { status: 503 }),
      );
    await expect(
      refreshGoogleCredentials(credentials, "client", "secret", unavailable),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      needsReconnect: false,
      retryable: true,
    });
    const successful = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ access_token: "new-access", expires_in: 3600 }),
      );
    const refreshed = await refreshGoogleCredentials(
      credentials,
      "client",
      "secret",
      successful,
    );
    expect(refreshed.refreshToken).toBe(credentials.refreshToken);
    expect(refreshed.accessToken).toBe("new-access");
    expect(
      new URLSearchParams(String(successful.mock.calls[0][1]?.body)).get(
        "refresh_token",
      ),
    ).toBe("refresh-secret");
    const rotated = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({
          access_token: "new-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        }),
      );
    expect(
      (await refreshGoogleCredentials(credentials, "client", "secret", rotated))
        .refreshToken,
    ).toBe("rotated-refresh");
  });

  it("classifies a refresh network failure as retryable without exposing transport details", async () => {
    const offline = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new TypeError("Network details containing private infrastructure"),
      );
    await expect(
      refreshGoogleCredentials(credentials, "client", "secret", offline),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
      needsReconnect: false,
    });
  });
});

describe("Open Library adapter", () => {
  it("calls the platform fetch function without binding an adapter as its receiver", async () => {
    const fetcher = function (this: unknown) {
      expect(this).toBeUndefined();
      return Promise.resolve(Response.json({ docs: [] }));
    } as typeof fetch;
    expect(
      (
        await new BookCatalog(
          cacheFixture().binding,
          undefined,
          fetcher,
        ).search("Book")
      ).items,
    ).toEqual([]);
  });
  it("awaits the shared fetch permit on cache misses and bypasses it for cached responses", async () => {
    const cache = cacheFixture();
    let releasePermit: (() => void) | undefined;
    const beforeFetch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releasePermit = resolve;
        }),
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ docs: [] }));
    const catalog = new BookCatalog(
      cache.binding,
      "owner@example.com",
      fetcher,
      beforeFetch,
    );
    const pending = catalog.search("Atomic Habits");
    await vi.waitFor(() => expect(beforeFetch).toHaveBeenCalledTimes(1));
    expect(fetcher).not.toHaveBeenCalled();
    releasePermit!();
    await pending;
    expect(fetcher).toHaveBeenCalledTimes(1);
    await catalog.search("Atomic Habits");
    expect(beforeFetch).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("normalizes ISBN-10/13 and caches a bounded encoded search with automatic covers", async () => {
    expect(normalizeIsbn("1-4919-0306-6")).toBe("9781491903063");
    expect(normalizeIsbn("978-1-4919-0306-3")).toBe("9781491903063");
    const cache = cacheFixture();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({
          docs: [
            {
              key: "/works/OL456W",
              title: "Designing Data-Intensive Applications",
              author_name: ["Martin Kleppmann"],
              cover_i: 123,
              number_of_pages_median: 616,
              isbn: ["9781491903063"],
              editions: { docs: [{ key: "/books/OL123M" }] },
            },
          ],
        }),
      );
    const catalog = new BookCatalog(
      cache.binding,
      "owner@example.com",
      fetcher,
    );
    const first = await catalog.search("978-1-4919-0306-3", 10);
    expect((await catalog.search("978-1-4919-0306-3", 10)).items).toEqual(
      first.items,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(new URL(String(url)).origin).toBe("https://openlibrary.org");
    expect(new URL(String(url)).searchParams.get("q")).toBe(
      "isbn:9781491903063",
    );
    expect(new Headers(init?.headers).get("User-Agent")).toContain(
      "owner@example.com",
    );
    expect(cache.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { expirationTtl: 86400 },
    );
    expect(first.items[0]).toMatchObject({
      editionId: "/books/OL123M",
      workId: "/works/OL456W",
      pageCountSource: "work_median",
      coverUrl: "https://covers.openlibrary.org/b/id/123-M.jpg?default=false",
    });
  });

  it("rejects arbitrary edition URLs and ignores unsafe author references in provider data", async () => {
    const cache = cacheFixture();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith("/authors/OL12A.json"))
        return Response.json({ name: "Real Author" });
      return Response.json({
        key: "/books/OL123M",
        title: "Book",
        number_of_pages: 240,
        authors: [
          { key: "https://attacker.example/steal" },
          { key: "/authors/OL12A" },
        ],
        covers: [-1],
        works: [{ key: "/works/OL456W" }],
        isbn_10: ["1491903066"],
      });
    });
    const catalog = new BookCatalog(cache.binding, undefined, fetcher);
    await expect(
      catalog.candidate({ editionId: "https://attacker.example/book" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetcher).not.toHaveBeenCalled();
    const candidate = await catalog.candidate({ editionId: "/books/OL123M" });
    expect(candidate.authors).toEqual(["Real Author"]);
    expect(candidate.coverUrl).toBeUndefined();
    expect(candidate.pageCount).toBe(240);
    expect(candidate.isbn).toBe("9781491903063");
    expect(
      fetcher.mock.calls.every(
        ([url]) => new URL(String(url)).origin === "https://openlibrary.org",
      ),
    ).toBe(true);
  });

  it("returns a safe retriable book error on transport/rate failures", async () => {
    const catalog = new BookCatalog(
      cacheFixture().binding,
      undefined,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({}, { status: 429 })),
    );
    await expect(catalog.search("Atomic Habits")).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      retryable: true,
    });
    const offline = new BookCatalog(
      cacheFixture().binding,
      undefined,
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("private transport address")),
    );
    await expect(offline.search("The Mom Test")).rejects.toThrow(
      "Could not reach the books database",
    );
  });
});
