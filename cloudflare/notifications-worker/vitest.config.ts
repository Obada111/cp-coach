import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const configDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          API_SECRET: 'test-backend-secret',
          VAPID_PUBLIC_KEY: 'test-vapid-public',
          VAPID_PRIVATE_KEY: 'test-vapid-private',
          VAPID_SUBJECT: 'mailto:tests@example.com',
          TEST_MIGRATIONS: await readD1Migrations(path.join(configDirectory, 'migrations')),
        },
      },
    })),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
