import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const jose = vi.hoisted(() => ({
  jwtVerify: vi.fn(),
  createRemoteJWKSet: vi.fn(() => ({})),
}));
vi.mock("jose", () => jose);
import {
  actorFor,
  authPage,
  beginGoogle,
  calendarScopes,
  finishGoogle,
  getSession,
  localDevelopment,
  logout,
  requireBrowserWrite,
  type Session,
} from "../src/worker/auth";
import { decryptSecret, digest } from "../src/integrations/crypto";
import type { AppEnv } from "../src/worker/env";

function fixture() {
  const values = new Map<string, string>();
  const get = vi.fn(async (name: string, format?: string) => {
    const value = values.get(name);
    return value === undefined
      ? null
      : format === "json"
        ? JSON.parse(value)
        : value;
  });
  const put = vi.fn(async (name: string, value: string, _options?: unknown) => {
    values.set(name, value);
  });
  const remove = vi.fn(async (name: string) => {
    values.delete(name);
  });
  const connectAccount = vi.fn(
    async (_input: Record<string, unknown>) => undefined,
  );
  const getByName = vi.fn(() => ({ connectAccount }));
  const env = {
    ENVIRONMENT: "production",
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    OWNER_EMAIL: "owner@example.com",
    TOKEN_ENCRYPTION_KEY: btoa(
      String.fromCharCode(...new Uint8Array(32).fill(7)),
    ),
    OAUTH_KV: { get, put, delete: remove },
    ORGANIZER: { getByName },
  } as unknown as AppEnv;
  return { env, values, get, put, remove, connectAccount, getByName };
}
const owner: Session = {
  id: "session-id",
  sub: "owner-sub",
  email: "owner@example.com",
  csrf: "csrf-value",
  expiresAt: Date.now() + 3600000,
};
async function loginFlow(
  f: ReturnType<typeof fixture>,
  kind: "login" | "calendar" = "login",
  role?: "personal" | "work",
) {
  const response = await beginGoogle(
    new Request(
      `https://organizer.example/auth/${kind === "login" ? "login" : `calendar/${role}`}`,
    ),
    f.env,
    kind === "calendar" ? owner : null,
    kind,
    role,
  );
  const authorization = new URL(response.headers.get("Location")!);
  const state = authorization.searchParams.get("state")!;
  const cookie = response.headers.getSetCookie()[0].split(";")[0];
  const persisted = JSON.parse(
    f.values.get(`google-flow:${await digest(state)}`)!,
  );
  return {
    response,
    authorization,
    state,
    cookie,
    persisted,
    callback: () =>
      new Request(
        `https://organizer.example/auth/callback?state=${state}&code=authorization-code`,
        { headers: { Cookie: cookie } },
      ),
  };
}
function tokens(scope = "openid email", refresh = "refresh-secret") {
  return {
    id_token: "verified-by-jose",
    access_token: "access-secret",
    refresh_token: refresh,
    expires_in: 3600,
    scope,
  };
}
function verified(nonce: string, overrides: Record<string, unknown> = {}) {
  jose.jwtVerify.mockResolvedValue({
    payload: {
      nonce,
      email: "owner@example.com",
      email_verified: true,
      sub: "owner-sub",
      ...overrides,
    },
  });
}
beforeEach(() => {
  jose.jwtVerify.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("owner browser authentication", () => {
  it("allows local development only with explicit development mode and a loopback URL", async () => {
    const f = fixture();
    expect(localDevelopment(new Request("http://localhost:8787/"), f.env)).toBe(
      false,
    );
    expect(
      await getSession(new Request("http://localhost:8787/"), f.env),
    ).toBeNull();
    const dev = { ...f.env, ENVIRONMENT: "development" };
    for (const origin of [
      "http://localhost:8787",
      "http://127.0.0.1:8787",
      "http://[::1]:8787",
    ]) {
      expect(localDevelopment(new Request(`${origin}/`), dev)).toBe(true);
      expect((await getSession(new Request(`${origin}/`), dev))?.sub).toBe(
        "local-owner",
      );
    }
    expect(
      await getSession(
        new Request("https://organizer.example/", {
          headers: { Host: "localhost" },
        }),
        dev,
      ),
    ).toBeNull();
    expect(
      localDevelopment(new Request("http://localhost.attacker.example/"), dev),
    ).toBe(false);
  });

  it("rejects cross-origin, cross-site and missing custom-header browser writes", () => {
    const request = (headers: Record<string, string>) =>
      new Request("https://organizer.example/api/commands", {
        method: "POST",
        headers,
      });
    expect(() =>
      requireBrowserWrite(
        request({
          Origin: "https://attacker.example",
          "X-Organizer-Request": "1",
        }),
      ),
    ).toThrow("Organizer");
    expect(() =>
      requireBrowserWrite(
        request({ Origin: "null", "X-Organizer-Request": "1" }),
      ),
    ).toThrow("Organizer");
    expect(() =>
      requireBrowserWrite(request({ Origin: "https://organizer.example" })),
    ).toThrow("Organizer");
    expect(() =>
      requireBrowserWrite(
        request({
          Origin: "https://organizer.example",
          "Sec-Fetch-Site": "cross-site",
          "X-Organizer-Request": "1",
        }),
      ),
    ).toThrow("Organizer");
    expect(() =>
      requireBrowserWrite(
        request({
          Origin: "https://organizer.example",
          "X-Organizer-Request": "1",
        }),
      ),
    ).not.toThrow();
  });

  it("starts identity-only OIDC login with browser binding, nonce and PKCE", async () => {
    const f = fixture();
    const flow = await loginFlow(f);
    const params = flow.authorization.searchParams;
    expect(flow.authorization.origin).toBe("https://accounts.google.com");
    expect(params.get("scope")).toBe("openid email");
    expect(params.has("access_type")).toBe(false);
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBe(
      await digest(flow.persisted.verifier),
    );
    expect(params.get("nonce")).toBe(flow.persisted.nonce);
    expect(flow.response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(flow.response.headers.get("Set-Cookie")).toContain("Secure");
    expect(flow.response.headers.get("Set-Cookie")).toContain("SameSite=Lax");
    expect(flow.persisted.binding).not.toBe(flow.cookie.split("=")[1]);
  });

  it.each([
    "https://attacker.example/steal",
    "//attacker.example/steal",
    "/\\attacker.example/steal",
  ])("rejects unsafe return destinations: %s", async (destination) => {
    const f = fixture();
    const response = await beginGoogle(
      new Request(
        `https://organizer.example/auth/login?returnTo=${encodeURIComponent(destination)}`,
      ),
      f.env,
      null,
      "login",
    );
    const state = new URL(response.headers.get("Location")!).searchParams.get(
      "state",
    )!;
    expect(
      JSON.parse(f.values.get(`google-flow:${await digest(state)}`)!).returnTo,
    ).toBe("/");
  });

  it("requires owner login before calendar connection and requests role-specific least privilege", async () => {
    const f = fixture();
    const anonymous = await beginGoogle(
      new Request("https://organizer.example/auth/calendar/work"),
      f.env,
      null,
      "calendar",
      "work",
    );
    expect(new URL(anonymous.headers.get("Location")!).pathname).toBe(
      "/auth/login",
    );
    expect(f.put).not.toHaveBeenCalled();
    for (const role of ["personal", "work"] as const) {
      const flow = await loginFlow(f, "calendar", role);
      expect(flow.authorization.searchParams.get("scope")).toBe(
        `openid email ${calendarScopes[role]}`,
      );
      expect(flow.authorization.searchParams.get("scope")).not.toContain(
        "https://www.googleapis.com/auth/calendar ",
      );
      expect(flow.authorization.searchParams.get("access_type")).toBe(
        "offline",
      );
      expect(flow.persisted.ownerSub).toBe(owner.sub);
      expect(flow.persisted.role).toBe(role);
      expect(flow.persisted.returnTo).toBe("/#/settings");
    }
  });

  it("creates a hashed owner session only after verified claims, and consumes callback state", async () => {
    const f = fixture(),
      flow = await loginFlow(f);
    verified(flow.persisted.nonce);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(tokens()));
    vi.stubGlobal("fetch", fetcher);
    const response = await finishGoogle(flow.callback(), f.env, null);
    expect(response.status).toBe(302);
    expect(f.values.get("owner:google-sub")).toBe("owner-sub");
    expect(jose.jwtVerify).toHaveBeenCalledWith(
      "verified-by-jose",
      expect.anything(),
      {
        audience: "google-client",
        issuer: ["https://accounts.google.com", "accounts.google.com"],
      },
    );
    const sessionCookie = response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("organizer_session="))!
      .split(";")[0];
    const rawId = sessionCookie.split("=")[1];
    expect(f.values.has(`session:${rawId}`)).toBe(false);
    expect(f.values.has(`session:${await digest(rawId)}`)).toBe(true);
    const session = await getSession(
      new Request("https://organizer.example/", {
        headers: { Cookie: sessionCookie },
      }),
      f.env,
    );
    expect(session?.sub).toBe("owner-sub");
    expect(actorFor(session!).scopes).toContain("review:write");
    await expect(
      finishGoogle(flow.callback(), f.env, null),
    ).rejects.toMatchObject({ code: "AUTH_STATE_INVALID" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    { email: "other@example.com", sub: "owner-sub" },
    { email: "owner@example.com", sub: "replacement-sub" },
  ])(
    "rejects a non-owner or a different pinned Google subject",
    async (claims) => {
      const f = fixture();
      f.env.OWNER_GOOGLE_SUB = "owner-sub";
      const flow = await loginFlow(f);
      verified(flow.persisted.nonce, claims);
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(Response.json(tokens())),
      );
      await expect(
        finishGoogle(flow.callback(), f.env, null),
      ).rejects.toMatchObject({ code: "OWNER_REQUIRED", status: 403 });
      expect(
        [...f.values.keys()].some((name) => name.startsWith("session:")),
      ).toBe(false);
    },
  );

  it("rejects missing browser binding before contacting Google", async () => {
    const f = fixture(),
      flow = await loginFlow(f);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      finishGoogle(
        new Request(
          `https://organizer.example/auth/callback?state=${flow.state}&code=code`,
        ),
        f.env,
        null,
      ),
    ).rejects.toMatchObject({ code: "AUTH_STATE_INVALID" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(jose.jwtVerify).not.toHaveBeenCalled();
  });

  it.each([{ nonce: "wrong-nonce" }, { email_verified: false }])(
    "rejects invalid OIDC nonce or unverified email",
    async (claims) => {
      const f = fixture(),
        flow = await loginFlow(f);
      verified(flow.persisted.nonce, claims);
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(Response.json(tokens())),
      );
      await expect(
        finishGoogle(flow.callback(), f.env, null),
      ).rejects.toMatchObject({ code: "IDENTITY_INVALID" });
      expect(
        [...f.values.keys()].some((name) => name.startsWith("session:")),
      ).toBe(false);
    },
  );

  it("requires granted calendar scope and a refresh token before storing a connection", async () => {
    const f = fixture();
    const missingScope = await loginFlow(f, "calendar", "work");
    verified(missingScope.persisted.nonce);
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(tokens("openid email"))),
    );
    await expect(
      finishGoogle(missingScope.callback(), f.env, owner),
    ).rejects.toMatchObject({ code: "CALENDAR_SCOPE_REQUIRED" });
    const missingRefresh = await loginFlow(f, "calendar", "work");
    verified(missingRefresh.persisted.nonce);
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(tokens(`openid email ${calendarScopes.work}`, "")),
        ),
    );
    await expect(
      finishGoogle(missingRefresh.callback(), f.env, owner),
    ).rejects.toMatchObject({ code: "REFRESH_TOKEN_REQUIRED" });
    expect(f.connectAccount).not.toHaveBeenCalled();
  });

  it("binds calendar grants to the owner session and encrypts a separate Work identity with no write calendar", async () => {
    const f = fixture(),
      wrongOwnerFlow = await loginFlow(f, "calendar", "work");
    verified(wrongOwnerFlow.persisted.nonce);
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(tokens(`openid email ${calendarScopes.work}`)),
        ),
    );
    await expect(
      finishGoogle(wrongOwnerFlow.callback(), f.env, {
        ...owner,
        sub: "another-owner",
      }),
    ).rejects.toMatchObject({ code: "SESSION_REQUIRED" });
    expect(f.connectAccount).not.toHaveBeenCalled();
    const flow = await loginFlow(f, "calendar", "work");
    verified(flow.persisted.nonce, {
      email: "work@example.com",
      sub: "work-subject",
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(tokens(`openid email ${calendarScopes.work}`)),
        ),
    );
    await finishGoogle(flow.callback(), f.env, owner);
    expect(f.getByName).toHaveBeenCalledWith(owner.sub);
    const record = f.connectAccount.mock.calls[0][0] as unknown as {
      role: string;
      email: string;
      googleSubject: string;
      writeCalendarId?: string;
      encryptedCredentials: string;
    };
    expect(record).toMatchObject({
      role: "work",
      email: "work@example.com",
      googleSubject: "work-subject",
      writeCalendarId: undefined,
    });
    expect(record.encryptedCredentials).not.toContain("refresh-secret");
    expect(
      await decryptSecret(
        record.encryptedCredentials,
        f.env.TOKEN_ENCRYPTION_KEY!,
      ),
    ).toMatchObject({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
    });
    expect(
      [...f.values.keys()].some((name) => name.startsWith("session:")),
    ).toBe(false);
  });

  it("ignores expired sessions and requires CSRF protection before logout revocation", async () => {
    const f = fixture();
    const raw = "a".repeat(43),
      lookup = `session:${await digest(raw)}`;
    f.values.set(
      lookup,
      JSON.stringify({ ...owner, expiresAt: Date.now() - 1 }),
    );
    const request = new Request("https://organizer.example/auth/logout", {
      method: "POST",
      headers: { Cookie: `organizer_session=${raw}` },
    });
    expect(await getSession(request, f.env)).toBeNull();
    await expect(logout(request, f.env)).rejects.toMatchObject({
      code: "CSRF_REJECTED",
    });
    expect(f.values.has(lookup)).toBe(true);
    const response = await logout(
      new Request(request, {
        headers: {
          Cookie: `organizer_session=${raw}`,
          Origin: "https://organizer.example",
          "X-Organizer-Request": "1",
        },
      }),
      f.env,
    );
    expect(response.status).toBe(204);
    expect(f.values.has(lookup)).toBe(false);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("escapes title content and prevents framing/cache of authorization pages", async () => {
    const response = authPage(
      "<img src=x onerror=alert(1)>",
      "<p>Trusted application body</p>",
    );
    expect(await response.text()).not.toContain("<img");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
