/// <reference types="vite/client" />

// Платформа сборки (см. define в vite.config.ts). Значение одно: 'app'. Второе появится вместе с новой целью сборки — Android в планах есть, и союз расширится здесь же.
declare const __ANIMORI_PLATFORM__: 'app'

// Номер версии из package.json (см. define в vite.config.ts). Нужен рантайму для заголовка User-Agent нашего канала.
declare const __ANIMORI_VERSION__: string

// Умения оболочки (см. define в vite.config.ts). Файл моста общий у двух продуктов, поэтому набор умений объявляет сборка: у окна Windows их пять, у телевизора — ни одного.
declare const __ANIMORI_SHELL_CAN__: {
  browser: boolean
  history: boolean
  fullscreen: boolean
  cast: boolean
  devtools: boolean
}
