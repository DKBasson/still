export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  APP_ORIGIN: string;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  BOOTSTRAP_TOKEN?: string;
  DEV_MAILBOX?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  TEST_MIGRATIONS?: { name: string; queries: string[] }[];
}

export type AppEnv = { Bindings: Env };
