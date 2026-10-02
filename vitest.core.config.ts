import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

// Наборы общего ядра: одни на оба продукта. Копий больше нет, поэтому идут отдельно от
// экранов — экран у каждого продукта свой, а проверять его над `@/app` своего продукта.
// Заглушка моста лежит рядом с ядром: она проверяет контракт моста, а не экран.
export default defineConfig({
  resolve: {
    alias: {
      '@/api': fileURLToPath(new URL('./packages/core/src/api', import.meta.url)),
      // Ключ повторён намеренно, как и раньше: последнее совпадение побеждает, и `@/bridge`
      // в проверках ведёт в заглушку, а не в настоящий мост.
      '@/bridge': fileURLToPath(new URL('./packages/core/src/bridge', import.meta.url)),
      '@/core': fileURLToPath(new URL('./packages/core/src/core', import.meta.url)),
      '@/utils': fileURLToPath(new URL('./packages/core/src/utils', import.meta.url)),
      '@': fileURLToPath(new URL('./packages/core/src', import.meta.url)),
      '@bridge-impl': fileURLToPath(new URL('./packages/core/tests/mocks/bridge.ts', import.meta.url)),
      '@/bridge': fileURLToPath(new URL('./packages/core/tests/mocks/bridge-module.ts', import.meta.url)),
    },
  },
  define: {
    __ANIMORI_PLATFORM__: JSON.stringify('app'),
    __ANIMORI_VERSION__: JSON.stringify('test'),
  },
  test: {
    environment: 'happy-dom',
    include: ['packages/core/tests/**/*.test.ts'],
  },
})