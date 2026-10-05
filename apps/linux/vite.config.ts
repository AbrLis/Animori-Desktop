import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Сборка чужих экранов: корень указывает на src/app приложения windows, копий нет.
const require = createRequire(import.meta.url)
const { version } = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'),
) as { version: string }

export default defineConfig({
  root: fileURLToPath(new URL('../windows/src/app', import.meta.url)),
  resolve: {
    alias: {
      'hls.js': require.resolve('hls.js/dist/hls.light.mjs'),
      '@bridge-impl': fileURLToPath(
        new URL('../../packages/core/src/bridge/TauriBridge.ts', import.meta.url),
      ),
      '@/api': fileURLToPath(new URL('../../packages/core/src/api', import.meta.url)),
      '@/bridge': fileURLToPath(new URL('../../packages/core/src/bridge', import.meta.url)),
      '@/core': fileURLToPath(new URL('../../packages/core/src/core', import.meta.url)),
      '@/utils': fileURLToPath(new URL('../../packages/core/src/utils', import.meta.url)),
      '@': fileURLToPath(new URL('../windows/src', import.meta.url)),
    },
  },
  define: {
    __ANIMORI_PLATFORM__: JSON.stringify('app'),
    __ANIMORI_VERSION__: JSON.stringify(version),
    // cast и devtools выключены: панели трансляции и консоли WebView2 в WebKitGTK нет.
    __ANIMORI_SHELL_CAN__: JSON.stringify({
      browser: true,
      history: true,
      fullscreen: true,
      cast: false,
      devtools: false,
    }),
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  plugins: [vue()],
  build: {
    outDir: fileURLToPath(new URL('./dist/app', import.meta.url)),
    emptyOutDir: true,
    minify: 'oxc',
    target: 'es2022',
  },
})