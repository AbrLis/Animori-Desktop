import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Номер версии — из package.json, единственный его источник в ветке. Чтение файла,
// а не import: импорт потребовал бы resolveJsonModule и втянул файлы в проверку типов.
const readJson = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf-8'))

const { version } = readJson('./package.json') as { version: string }

// Сборка одна: своё веб-приложение со своим index.html внутри окна Tauri.
// defineConfig принимает объект, а не функцию: mode больше не читается.
export default defineConfig({
  // Корень сборки — src/app: там лежит свой index.html. Разметка держится вне
  // корня репозитория сознательно: корневой index.html Vite подхватывает сам.
  root: fileURLToPath(new URL('./src/app', import.meta.url)),
  resolve: {
    alias: {
      // Плеер берёт лёгкую сборку hls.js: полная приносила в экран просмотра
      // около 594 КБ. Шов, а не импорт 'hls.js/light': нет своего .d.ts — TS7016.
      'hls.js': fileURLToPath(new URL('./node_modules/hls.js/dist/hls.light.mjs', import.meta.url)),
      // Пункт 3.4: реализация моста подставляется сборкой. Шов оставлен: вырезание
      // потребовало бы правки импортов. Ключ идёт до '@': совпадение по порядку.
      '@bridge-impl': fileURLToPath(new URL('./src/shared/bridge/TauriBridge.ts', import.meta.url)),
      // Пункт 1.3: имена модулей при переезде в shared не менялись, сменилось
      // только место. Порядок ключей обязателен: побеждает первое совпадение.
      '@/api': fileURLToPath(new URL('./src/shared/api', import.meta.url)),
      '@/bridge': fileURLToPath(new URL('./src/shared/bridge', import.meta.url)),
      '@/core': fileURLToPath(new URL('./src/shared/core', import.meta.url)),
      '@/utils': fileURLToPath(new URL('./src/shared/utils', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  define: {
    // Платформа одна. Значение оставлено, а не вырезано: по нему ветвится общий
    // код ядра, а впереди Android — там появится второе значение.
    __ANIMORI_PLATFORM__: JSON.stringify('app'),
    // Пункт 5.3.5: номер версии нужен рантайму для заголовка User-Agent
    // нашего канала (src/shared/bridge/TauriBridge.ts) и для экранов приложения.
    __ANIMORI_VERSION__: JSON.stringify(version),
    // Этап 2: флаги сборки Vue. Без них рантаим сыплет предупреждения в консоль.
    // Options API нигде не используется — только Composition API, поэтому false.
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  plugins: [vue()],
  build: {
    // Путь абсолютный: корень сборки — src/app, и относительный 'dist' уехал бы
    // внутрь исходников. Именно на dist/app смотрит frontendDist в tauri.conf.json.
    outDir: fileURLToPath(new URL('./dist/app', import.meta.url)),
    // Теперь можно без оглядки: в dist пишет один продукт, а тауринная сборка
    // не сносит уже собранный animori.user.js.
    emptyOutDir: true,
    minify: 'esbuild',
    target: 'es2022',
  },
})
