// Глобальные константы: только неизменяемые значения.
// Состояние сессии — паузы и инстанс БД — живёт в своих модулях, не здесь.

/** Зеркала Shikimori: `.io` впереди — `.rip` за Cloudflare не пускает. Порядок стартовый: рабочее зеркало запоминается в хранилище. */
export const SHIKI_DOMAINS: readonly string[] = ['shikimori.io', 'shikimori.rip']

/** anime365 (smotret-anime) — фоллбэк для тайтлов/описаний. */
export const ANIME365_DOMAINS: readonly string[] = ['smotret-anime.online', 'anime365.ru']
/** подряд-сбоев -> отключение источника на сессию */
export const ANIME365_FAIL_LIMIT = 5

/** Кэш бессрочный: склад лежит на своём диске и чистится руками из настроек. */
export const CACHE_TIME = Number.POSITIVE_INFINITY

export const DB_NAME = 'AniMoriSuperDB'
/** Версия схемы: шестая переносит склад из shikiCache в mediaCache. Поднятие — единственный способ запустить миграцию. */
export const DB_VERSION = 6
