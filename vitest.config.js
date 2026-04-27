import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'default',
          environment: 'node',
          include: ['tests/unit/**/*.test.js', 'tests/integration/**/*.test.js', 'tests/system/**/*.test.js'],
        },
      },
      {
        test: {
          name: 'perf',
          environment: 'node',
          include: ['tests/perf/**/*.test.js'],
        },
      },
    ],
  },
});
