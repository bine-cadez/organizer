import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import { ALARM_ENSURE_INTERVAL_MS } from "../src/domain/retention";
import {
  resetOrganizerAlarmTouchesForTests,
  touchOrganizerAlarm,
} from "../src/worker/alarm";
import worker from "../src/worker/index";

describe("organizer alarm wake", () => {
  afterEach(() => {
    resetOrganizerAlarmTouchesForTests();
    vi.restoreAllMocks();
  });

  it("wakes the durable object on the first touch and not again inside the interval", async () => {
    const ensure = vi.fn(async () => undefined);
    const started = 1_700_000_000_000;
    await touchOrganizerAlarm("owner-a", ensure, started);
    await touchOrganizerAlarm("owner-a", ensure, started + 1_000);
    await touchOrganizerAlarm(
      "owner-a",
      ensure,
      started + ALARM_ENSURE_INTERVAL_MS - 1,
    );
    expect(ensure).toHaveBeenCalledTimes(1);
    await touchOrganizerAlarm(
      "owner-a",
      ensure,
      started + ALARM_ENSURE_INTERVAL_MS,
    );
    expect(ensure).toHaveBeenCalledTimes(2);
    await touchOrganizerAlarm("owner-b", ensure, started);
    expect(ensure).toHaveBeenCalledTimes(3);
  });

  it("retries the wake after a failure instead of staying quiet", async () => {
    const ensure = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("rows_read exceeded"))
      .mockResolvedValue(undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const started = 1_700_000_000_000;
    await expect(
      touchOrganizerAlarm("owner-a", ensure, started),
    ).resolves.toBeUndefined();
    await touchOrganizerAlarm("owner-a", ensure, started + 1);
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalled();
  });
});

describe("mcp traffic reaches the organizer", () => {
  afterEach(() => {
    resetOrganizerAlarmTouchesForTests();
    vi.restoreAllMocks();
  });

  it("calls ensureAlarm from /mcp before the session does other work", async () => {
    const ensureAlarm = vi.fn(async () => undefined);
    const snapshot = vi.fn(async () => {
      throw new Error("snapshot should wait until a tool reads state");
    });
    const env = {
      ENVIRONMENT: "development",
      ORGANIZER: {
        getByName: vi.fn(() => ({
          ensureAlarm,
          snapshot,
          execute: vi.fn(),
          catalogPermit: vi.fn(),
        })),
      },
      OAUTH_KV: {
        get: vi.fn(async () => null),
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
      ASSETS: { fetch: vi.fn(async () => new Response("asset")) },
    };
    const ctx = {
      waitUntil() {},
      passThroughOnException() {},
    } as unknown as ExecutionContext;
    const response = await worker.fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test", version: "0" },
          },
        }),
      }),
      env as never,
      ctx,
    );
    expect(ensureAlarm).toHaveBeenCalledTimes(1);
    expect(env.ORGANIZER.getByName).toHaveBeenCalledWith("local-owner");
    expect(snapshot).not.toHaveBeenCalled();
    expect(response.status).toBeLessThan(500);

    const again = await worker.fetch(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
        }),
      }),
      env as never,
      ctx,
    );
    expect(again.status).toBeLessThan(500);
    expect(ensureAlarm).toHaveBeenCalledTimes(1);
  });
});
