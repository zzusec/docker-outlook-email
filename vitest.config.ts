import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // The first dynamic import of a route module can take several seconds on a
    // slow/external volume; 5s (the default) makes those runs flaky.
    testTimeout: 20000,
  },
});
