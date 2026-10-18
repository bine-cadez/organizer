import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export type AppEnv = Omit<Env, "ENVIRONMENT"> & {
  ENVIRONMENT: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  OWNER_EMAIL?: string;
  OWNER_GOOGLE_SUB?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  CONTACT_EMAIL?: string;
  APP_ORIGIN?: string;
  OAUTH_PROVIDER?: OAuthHelpers;
};
