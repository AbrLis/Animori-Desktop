// Формы данных AniList и Shikimori: единственный источник правды для api/ и core/db.ts.
// Описаны только нужные нам поля; `?` стоит там, где внешний API не гарантирует значение.

/** Вид тайтла AniList. 'MANGA' не сужаем: он есть в ответах службы и в списках Shikimori. */
export type MediaType = 'ANIME' | 'MANGA'

/** Статусы в терминах Shikimori — к ним нормализуются и записи AniList. */
export type ShikiStatus =
  'watching' | 'rewatching' | 'planned' | 'completed' | 'on_hold' | 'dropped'

export interface AniListMediaTitle {
  romaji?: string | null
  english?: string | null
}

export interface AniListRelationEdge {
  /** 'SEQUEL' | 'PREQUEL' | 'PARENT' | ... */
  relationType: string
  node: { idMal: number | null }
}

/** Урезанный Media из AniList GraphQL (MediaListCollection.entries[].media). */
export interface AniListMediaLite {
  idMal: number | null
  title?: AniListMediaTitle
  relations?: { edges: AniListRelationEdge[] }
}

/** Полный Media из AniList GraphQL: рендер виджетов страницы тайтла. */
export interface AniListMedia {
  id: number
  type: MediaType
  idMal: number | null
  seasonYear?: number | null
  /** Шкала 0..100. */
  averageScore?: number | null
  title?: AniListMediaTitle
  mediaListEntry?: { status: string | null; progress?: number }
}

/** Общая часть записей сравнения списков; ключ — malId. */
export interface CmpEntryBase {
  malId: number
  title: string
  status: ShikiStatus | null
  /** Оценка 0..10. */
  score10: number
  progress: number
  /** Прочитано томов. У аниме всегда ноль: поле для манговых списков Shikimori. */
  volumes: number
  rewatches: number
  notes: string
}

export interface CmpAniListEntry extends CmpEntryBase {
  relations: number[]
}

export type CmpShikiEntry = CmpEntryBase

export type CmpListEntry = CmpAniListEntry | CmpShikiEntry

/** Урезанный тайтл Shikimori из `${type}_rates`. */
export interface ShikiMediaLite {
  /** Равен MyAnimeList ID. */
  id: number
  russian?: string | null
  name?: string | null
}

/**
 * Трейлер тайтла: ролик и его кадр. Форма одна для AniList и Shikimori:
 * наружу выходят готовые адреса, площадка и номер ролика не выходят.
 */
export interface MediaTrailer {
  /** Подпись для подсказки. */
  title: string
  thumb: string | null
  /** Адрес для окна встраивания или null, если площадка не встраивается: тогда наружу ведёт url. */
  embed: string | null
  url: string
}

/**
 * Кадр тайтла: уменьшенный preview для сетки и полный original для просмотра.
 * У Shikimori это разные файлы, у запасных кадров AniList — один и тот же адрес.
 */
export interface MediaShot {
  original: string
  preview: string
}

/** Ролик тайтла Shikimori: заставка, концовка, анонс, кадр серии. */
export interface MediaClip {
  /** Вид ролика словом службы: pv, op, ed, character_trailer, episode_preview. */
  kind: string
  name: string
  url: string
  /** Адрес для окна или null, если площадка не встраивается. */
  embed: string | null
  thumb: string | null
}

/**
 * Кадры и ролики тайтла для плитки «Кадры и трейлер». Ролики лежат целиком,
 * хотя показ берёт только трейлер: они приехали тем же ответом, что и кадры.
 */
export interface MediaShots {
  shots: MediaShot[]
  clips: MediaClip[]
}

/** Карточка тайтла Shikimori (GET /api/animes|mangas/:id), только нужные поля. */
export interface ShikiMedia {
  id: number
  russian?: string | null
  name?: string | null
  url?: string | null
  /** Зеркало Shikimori, с которого пришёл ответ. */
  domain?: string | null
  description?: string | null
  /** Шкала 0..10. */
  score?: number | null
  rates_scores_stats?: Array<{ name: string; value: number }>
}

/**
 * Имена сторов кэша для dbGet/dbSet. `shikiCache` — устаревший псевдоним `mediaCache`,
 * оставлен ради ветки `script` с тем же ядром; db.ts переводит его в физическое имя.
 */
export type CacheStoreName = 'mediaCache' | 'shikiCache' | 'malCache' | 'franchiseCache'

/** Запись в `mediaCache` (keyPath 'key'): карточки тайтлов, персонажей, персонала и тем. */
export interface MediaCacheRecord<T = unknown> {
  /** Составной ключ вида "ПРЕФИКС_id", например "RU4_123". */
  key: string
  data: T
  /** Протухание по CACHE_TIME. */
  ts: number
}

/** Устаревшее имя MediaCacheRecord: держится ради ветки `script` с тем же ядром. */
export type ShikiCacheRecord<T = unknown> = MediaCacheRecord<T>

/** Запись в `malCache` (keyPath 'id'): AniList ID -> AniListMedia. */
export interface MalCacheRecord {
  id: number
  data: AniListMedia
}

/** Запись в `franchiseCache` (keyPath 'id'). */
export interface FranchiseCacheRecord {
  id: number
  data: unknown
  ts?: number
  /**
   * Форма записи: склад франшизы бессрочный, а правила сборки дерева меняются,
   * поэтому запись без метки или с чужой считается промахом. Нынешняя метка — 2.
   */
  shape?: number
}

export type CacheRecord = MediaCacheRecord | MalCacheRecord | FranchiseCacheRecord

/**
 * Снимок БД для инспектора настроек и экрана журнала. Поле на каждый вид записи,
 * а не одна сумма: иначе забытый счётчик выглядит как пустой кэш.
 */
export interface DbStats {
  /**
   * Карточки тайтлов AniList: префикс MED3_. Срок свой: неделя у завершённого
   * тайтла, сутки у идущего (core/cache-life.ts).
   */
  media: number
  /** Персонажи карточки: префикс CHR3_ (core/person-title.ts). */
  characters: number
  /** Персонал карточки: префикс STF4_ (core/person-title.ts). */
  staff: number
  /** Темы открытия и закрытия: префикс THEMES2_ (api/animethemes.ts). */
  themes: number
  /** Русские названия и описания: префиксы RU4_ и NAME1_ (core/media-title.ts). */
  russianTitles: number
  /**
   * Отказы «русского имени нет»: префикс NONAME1_ (core/media-title.ts). Отдельным полем:
   * сложенные с russianTitles они показали бы имён больше, чем добыто.
   */
  noRussianNames: number
  /** Обложки, цвета и счёт частей: префикс LOOK3_ (core/media-looks.ts). */
  looks: number
  /** Оценки площадок: префикс RATE1_ (core/ratings.ts). */
  ratings: number
  /**
   * Метки «есть что смотреть»: префикс PLAY1_ (core/playable.ts). Самый многочисленный
   * вид записей: одна на каждую виденную плитку.
   */
  playable: number
  /** Соответствия релизам Aniliberty: префикс ALIB1_ (api/aniliberty.ts). */
  anilibertyLinks: number
  /** Кадры и ролики тайтла: префикс SHOT1_ (api/media-shots.ts). */
  screenshots: number
  /**
   * Записи стора malCache: соответствие номера AniList и номера MAL. Ноль здесь правда:
   * в стор никто не пишет, номера MAL добываются запросом при каждом запуске.
   */
  malMappings: number
  /** Записи склада франшиз: у него свой ключ-число, а не префикс. */
  franchises: number
  /**
   * Записи с незнакомым префиксом. Считается сознательно: новый вид записи иначе снова
   * стал бы невидимым, а крупный остаток читается как задача.
   */
  other: number
  totalCacheRecords: number
  estimatedSize: string
}

export interface DbStatsError {
  error: string
}
