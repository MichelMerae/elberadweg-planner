/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    environment: 'node',
    // .claude holds agent scratch space, including git worktrees of older
    // branches. Those carry their own copy of the suite, so without this the
    // run silently doubles and reports stale code as if it were this checkout.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
  },
});
