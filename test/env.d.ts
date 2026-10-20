/// <reference types="@cloudflare/vitest-plugin/types" />

declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: { name: string; queries: string[] }[];
    BETTER_AUTH_SECRET: string;
    BOOTSTRAP_TOKEN: string;
    DEV_MAILBOX?: string;
  }
}
