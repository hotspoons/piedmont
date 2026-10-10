import { defineConfig } from 'vitest/config'

// The game's tests, and the `checks` project: the services' node:test suites, oxlint, the names
// check, the pull-policy check and the link check (scripts/checks/). The arcade packages' own tests
// run in the arcade.
export default defineConfig({
  test: {
    projects: ['apps/*/vitest.config.ts', 'scripts/checks/vitest.config.ts'],
  },
})
