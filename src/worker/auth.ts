import { createRemoteJWKSet, jwtVerify } from "jose";
import { ALL_SCOPES, type Actor, type CalendarRole } from "../shared/types";
import { digest, encryptSecret, randomToken } from "../integrations/crypto";
import type { AppEnv } from "./env";

export interface Session {
  id: string;
  sub: string;
  email: string;
  csrf: string;
  expiresAt: number;
}
interface LoginFlow {
  kind: "login" | "calendar";
  role?: CalendarRole;
  nonce: string;
  verifier: string;
  binding: string;
  returnTo: string;
  ownerSub?: string;
}
const googleKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);
const SESSION_AGE = 60 * 60 * 24 * 7;
const SESSION_COOKIE = "organizer_session";
export const calendarScopes = {
  personal: "https://www.googleapis.com/auth/calendar.events.owned",
  work: "https://www.googleapis.com/auth/calendar.events.readonly",
} as const;

export function localDevelopment(request: Request, env: AppEnv): boolean {
  return (
    env.ENVIRONMENT === "development" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(new URL(request.url).hostname)
  );
}
export function googleConfigured(env: AppEnv): boolean {
  return Boolean(
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.OWNER_EMAIL,
  );
}
export function cookieValue(
  request: Request,
  name: string,
): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
function cookie(
  request: Request,
  name: string,
  value: string,
  age: number,
): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
export async function getSession(
  request: Request,
  env: AppEnv,
): Promise<Session | null> {
  if (localDevelopment(request, env))
    return {
      id: "local-development",
      sub: "local-owner",
      email: "Local development",
      csrf: "local",
      expiresAt: Date.now() + SESSION_AGE * 1000,
    };
  const id = cookieValue(request, SESSION_COOKIE);
  if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  const session = await env.OAUTH_KV.get<Session>(
    `session:${await digest(id)}`,
    "json",
  );
  return session && session.expiresAt > Date.now() ? { ...session, id } : null;
}
export function actorFor(session: Session): Actor {
  return { id: session.sub, type: "human", scopes: [...ALL_SCOPES] };
}
export function requireBrowserWrite(request: Request): void {
  const origin = request.headers.get("origin");
  if (
    (origin && origin !== new URL(request.url).origin) ||
    request.headers.get("sec-fetch-site") === "cross-site" ||
    request.headers.get("X-Organizer-Request") !== "1"
  ) {
    throw Object.assign(new Error("This request must come from Organizer."), {
      code: "CSRF_REJECTED",
      status: 403,
    });
  }
}
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
export function authPage(
  title: string,
  body: string,
  headers = new Headers(),
): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  );
  headers.set("X-Frame-Options", "DENY");
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Organizer</title><style>:root{color-scheme:dark;font-family:system-ui,sans-serif;color:#f1e7d3;background:#15100b}body{max-width:520px;margin:10vh auto;padding:28px;line-height:1.6}h1{font-size:26px}p,li{color:#cdbd9f}button,a.button{border:0;border-radius:8px;padding:12px 20px;background:#c9a55a;color:#1a130c;font:inherit;cursor:pointer}a{color:#dbb96e}button.secondary{background:#33291f;color:#f1e7d3}label{display:block;margin:8px 0}small{color:#a8977b}form{margin-top:24px}</style><p>Organizer</p><h1>${escapeHtml(title)}</h1>${body}</html>`,
    { headers },
  );
}

// Only use provider-validated callbacks. Finish the POST before navigating past Chromium's form-action restriction.
export function oauthCallbackPage(
  redirectTo: string,
  headers: Headers,
): Response {
  headers.delete("Location");
  headers.set("Referrer-Policy", "no-referrer");
  const destination = escapeHtml(redirectTo);
  return authPage(
    "Returning to your agent",
    `<meta http-equiv="refresh" content="0;url=${destination}"><p>Your choice was saved. Returning to your agent…</p><a class="button" href="${destination}">Continue to agent</a>`,
    headers,
  );
}

export async function beginGoogle(
  request: Request,
  env: AppEnv,
  session: Session | null,
  kind: "login" | "calendar",
  role?: CalendarRole,
): Promise<Response> {
  if (!googleConfigured(env))
    return authPage(
      "Google connection is not configured",
      '<p>The app is ready for your Google credentials. Follow the connection setup in the project README, then try again.</p><a href="/">Back to Organizer</a>',
    );
  if (kind === "calendar" && !session)
    return Response.redirect(
      `${new URL(request.url).origin}/auth/login?returnTo=${encodeURIComponent(new URL(request.url).pathname + new URL(request.url).search)}`,
      302,
    );
  if (kind === "calendar" && !env.TOKEN_ENCRYPTION_KEY)
    return authPage(
      "Calendar connection is not configured",
      '<p>A calendar encryption key is required before connecting an account.</p><a href="/#/settings">Back to settings</a>',
    );
  const state = randomToken(),
    binding = randomToken(),
    verifier = randomToken();
  const requestedReturn =
    new URL(request.url).searchParams.get("returnTo") || "/";
  const returnTo =
    requestedReturn.startsWith("/") &&
    !requestedReturn.startsWith("//") &&
    !requestedReturn.includes("\\")
      ? requestedReturn
      : "/";
  const flow: LoginFlow = {
    kind,
    role,
    nonce: randomToken(),
    verifier,
    binding: await digest(binding),
    returnTo: kind === "calendar" ? "/#/settings" : returnTo,
    ownerSub: session?.sub,
  };
  await env.OAUTH_KV.put(
    `google-flow:${await digest(state)}`,
    JSON.stringify(flow),
    { expirationTtl: 600 },
  );
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${new URL(request.url).origin}/auth/callback`,
    response_type: "code",
    scope: `openid email${kind === "calendar" && role ? ` ${calendarScopes[role]}` : ""}`,
    state,
    nonce: flow.nonce,
    code_challenge: await digest(verifier),
    code_challenge_method: "S256",
    prompt: kind === "calendar" ? "consent select_account" : "select_account",
  });
  if (kind === "calendar") params.set("access_type", "offline");
  const headers = new Headers({
    Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    "Cache-Control": "no-store",
  });
  headers.append(
    "Set-Cookie",
    cookie(request, `organizer_flow_${state.slice(0, 12)}`, binding, 600),
  );
  return new Response(null, { status: 302, headers });
}
export async function finishGoogle(
  request: Request,
  env: AppEnv,
  session: Session | null,
): Promise<Response> {
  const url = new URL(request.url),
    state = url.searchParams.get("state") || "";
  const flowKey = `google-flow:${await digest(state)}`;
  const flow = await env.OAUTH_KV.get<LoginFlow>(flowKey, "json");
  const binding = cookieValue(request, `organizer_flow_${state.slice(0, 12)}`);
  if (!flow || !binding || (await digest(binding)) !== flow.binding)
    throw Object.assign(
      new Error(
        "This sign-in expired or was opened in another browser. Start again.",
      ),
      { code: "AUTH_STATE_INVALID", status: 400 },
    );
  await env.OAUTH_KV.delete(flowKey);
  if (url.searchParams.has("error"))
    return authPage(
      "Connection cancelled",
      '<p>No account was connected.</p><a href="/">Back to Organizer</a>',
    );
  const code = url.searchParams.get("code");
  if (!code)
    throw Object.assign(
      new Error("Google did not return an authorization code."),
      { code: "AUTH_CODE_MISSING", status: 400 },
    );
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      code,
      grant_type: "authorization_code",
      redirect_uri: `${url.origin}/auth/callback`,
      code_verifier: flow.verifier,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw Object.assign(
      new Error("Google could not complete sign-in. Start again."),
      { code: "GOOGLE_AUTH_FAILED", status: 400 },
    );
  const tokens = (await response.json()) as {
    id_token?: string;
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  if (!tokens.id_token)
    throw Object.assign(
      new Error("Google did not return a verified identity."),
      { code: "IDENTITY_REQUIRED", status: 400 },
    );
  const { payload } = await jwtVerify(tokens.id_token, googleKeys, {
    audience: env.GOOGLE_CLIENT_ID,
    issuer: ["https://accounts.google.com", "accounts.google.com"],
  });
  if (
    payload.nonce !== flow.nonce ||
    payload.email_verified !== true ||
    typeof payload.email !== "string" ||
    typeof payload.sub !== "string"
  )
    throw Object.assign(
      new Error("The Google identity could not be verified."),
      { code: "IDENTITY_INVALID", status: 403 },
    );
  const headers = new Headers({
    Location: `${url.origin}${flow.returnTo}`,
    "Cache-Control": "no-store",
  });
  headers.append(
    "Set-Cookie",
    cookie(request, `organizer_flow_${state.slice(0, 12)}`, "", 0),
  );
  if (flow.kind === "calendar") {
    if (!session || session.sub !== flow.ownerSub || !flow.role)
      throw Object.assign(
        new Error("Sign in to Organizer before connecting a calendar."),
        { code: "SESSION_REQUIRED", status: 401 },
      );
    if (!tokens.scope?.split(" ").includes(calendarScopes[flow.role]))
      throw Object.assign(
        new Error(
          "Allow the requested Calendar permission to connect this account.",
        ),
        { code: "CALENDAR_SCOPE_REQUIRED", status: 403 },
      );
    if (!tokens.refresh_token)
      throw Object.assign(
        new Error(
          "Google did not grant offline access. Connect again and allow Calendar access.",
        ),
        { code: "REFRESH_TOKEN_REQUIRED", status: 400 },
      );
    const encryptedCredentials = await encryptSecret(
      {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
      },
      env.TOKEN_ENCRYPTION_KEY!,
    );
    await env.ORGANIZER.getByName(session.sub).connectAccount({
      role: flow.role,
      email: payload.email,
      googleSubject: payload.sub,
      encryptedCredentials,
      calendarIds: ["primary"],
      writeCalendarId: flow.role === "personal" ? "primary" : undefined,
    });
  } else {
    if (payload.email.toLowerCase() !== env.OWNER_EMAIL!.trim().toLowerCase())
      throw Object.assign(new Error("Organizer is restricted to its owner."), {
        code: "OWNER_REQUIRED",
        status: 403,
      });
    const pinned =
      env.OWNER_GOOGLE_SUB || (await env.OAUTH_KV.get("owner:google-sub"));
    if (pinned && payload.sub !== pinned)
      throw Object.assign(
        new Error("This is not the configured owner account."),
        { code: "OWNER_REQUIRED", status: 403 },
      );
    if (!pinned) await env.OAUTH_KV.put("owner:google-sub", payload.sub);
    const id = randomToken();
    const newSession = {
      sub: payload.sub,
      email: payload.email,
      csrf: randomToken(),
      expiresAt: Date.now() + SESSION_AGE * 1000,
    };
    await env.OAUTH_KV.put(
      `session:${await digest(id)}`,
      JSON.stringify(newSession),
      { expirationTtl: SESSION_AGE },
    );
    headers.append(
      "Set-Cookie",
      cookie(request, SESSION_COOKIE, id, SESSION_AGE),
    );
  }
  return new Response(null, { status: 302, headers });
}
export async function logout(request: Request, env: AppEnv): Promise<Response> {
  requireBrowserWrite(request);
  const id = cookieValue(request, SESSION_COOKIE);
  if (id) await env.OAUTH_KV.delete(`session:${await digest(id)}`);
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": cookie(request, SESSION_COOKIE, "", 0) },
  });
}
