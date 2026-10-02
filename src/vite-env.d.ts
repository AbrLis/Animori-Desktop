/// <reference types="vite/client" />

// Платформа сборки (см. define в vite.config.ts). Значение одно: 'app'.
// Второе появится вместе с новой целью сборки — Android в планах есть.
declare const __ANIMORI_PLATFORM__: 'app'

// Номер версии из package.json (см. define в vite.config.ts): нужен рантайму
// для заголовка User-Agent нашего канала.
declare const __ANIMORI_VERSION__: string
