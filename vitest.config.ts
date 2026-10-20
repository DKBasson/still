import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ENVIRONMENT: "test",
          APP_ORIGIN: "http://localhost:5173",
          BETTER_AUTH_URL: "http://localhost:5173",
          BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
          BOOTSTRAP_TOKEN: "test-bootstrap-token",
          DEV_MAILBOX: "1",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
