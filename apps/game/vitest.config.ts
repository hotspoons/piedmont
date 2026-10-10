import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'game',
    include: ['test/**/*.test.ts'],
  },
})
