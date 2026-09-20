// Формы данных AniList и Shikimori: единственный источник правды для api/ и core/db.ts.
// Описаны только нужные нам поля, остальное из ответов сознательно не перечисляется.
// Знак вопроса у поля стоит там, где внешний API реально не гарантирует значение.

/**
 * Вид тайтла в терминах AniList.
 *
 * Приложение мангу больше не спрашивает: вид вписан в запросы словом
 * ANIME, а не переменной. Тип остался в формах ответов AniList и в сравнении
 * списков Shikimori, где манговые записи есть. Сузить его до 'ANIME' —
 * правка кода, а не комментария.
 */
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

/**
 * Полный Media из AniList GraphQL (рендер виджетов страницы тайтла).
 * Вид тайтла в форме остался: его отдаёт сам ответ AniList.
 */
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

/**
 * Общая часть нормализованных записей сканера дельты (ключ — malId).
 * Сравнение списков идёт целиком, вместе с манговыми записями Shikimori.
 */
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

/** Запись списка AniList после нормализации. */
export interface CmpAniListEntry extends CmpEntryBase {
  /** idMal связанных тайтлов. */
  relations: number[]
}

/** Запись списка Shikimori после нормализации. */
export type CmpShikiEntry = CmpEntryBase

/** Нормализованная запись любого источника. */
export type CmpListEntry = CmpAniListEntry | CmpShikiEntry

/** Урезанный тайтл Shikimori из `${type}_rates`. */
export interface ShikiMediaLite {
  /** Равен MyAnimeList ID. */
  id: number
  russian?: string | null
  name?: string | null
}

/**
 * Трейлер тайтла: ролик и его кадр.
 *
 * Приезжает из двух источников. AniList отдаёт своё поле `trailer` у карточки
 * (площадку и номер ролика), Shikimori — список роликов отдельным адресом,
 * и оттуда берётся анонс, когда AniList молчит. Форма одна на оба: разница
 * источников показу не видна и видеться не должна, поэтому ни площадки, ни
 * номера ролика здесь нет — есть готовые адреса.
 */
export interface MediaTrailer {
  /** Подпись для подсказки: «Трейлер» или имя ролика из службы. */
  title: string
  /** Кадр ролика: им нарисована плитка. */
  thumb: string | null
  /**
   * Адрес для окна, если площадка встраивается, иначе null.
   *
   * У ютюба, дейлимоушена и вимео есть страница встраивания; у прочих площадок
   * её либо нет, либо она неизвестна, и обещать окно, которое не откроется,
   * хуже, чем честно увести наружу.
   */
  embed: string | null
  /** Обычная ссылка на ролик: запасной путь, когда окно не открылось. */
  url: string
}

/**
 * Кадр тайтла: два адреса одной картинки.
 *
 * `preview` — уменьшенный, им набрана сетка плитки; `original` — полный, он
 * грузится только в просмотр. У Шикимори это разные файлы (332 по ширине против
 * полного кадра в мегабайт), у запасных кадров AniList — один и тот же адрес:
 * чужой источник второго размера не отдаёт, а выдумывать его нечем.
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
  /** Адрес наружу: им открывают ролик, если окно не открылось. */
  url: string
  /** Адрес для окна или null, если площадка не встраивается. */
  embed: string | null
  /** Кадр ролика. */
  thumb: string | null
}

/**
 * Кадры и ролики тайтла: то, что показывает плитка «Кадры и трейлер».
 *
 * Ролики лежат в записи целиком, хотя показ берёт из них только трейлер:
 * они приехали тем же ответом, что и кадры, и второй запрос за ними был бы
 * тратой чужого сервера ради уже полученного.
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
  /** Гистограмма оценок. */
  rates_scores_stats?: Array<{ name: string; value: number }>
}

/**
 * Имена сторов кэша для dbGet/dbSet.
 *
 * `mediaCache` — настоящее имя склада карточек: там давно лежат не только
 * данные Shikimori, но и обложки с AniList, темы с AnimeThemes и оценки площадок.
 *
 * `shikiCache` — устаревший псевдоним того же стора. Вызовов с ним в этой
 * ветке больше нет: все переведены на настоящее имя. Псевдоним оставлен
 * ради ветки `script`, где лежит то же ядро и где вызовы ещё старые:
 * снятие имени здесь сделало бы перенос правки заплаткой невозможным.
 * db.ts переводит псевдоним в физическое имя сам.
 */
export type CacheStoreName = 'mediaCache' | 'shikiCache' | 'malCache' | 'franchiseCache'

/**
 * Запись в `mediaCache` (keyPath 'key'): карточки тайтлов/персонажей/персонала/тем.
 * Форма одна, различаются префикс ключа и `data`.
 */
export interface MediaCacheRecord<T = unknown> {
  /** Составной ключ вида "ПРЕФИКС_id", например "RU4_123". */
  key: string
  data: T
  /** Unix-таймстамп записи (протухание по CACHE_TIME). */
  ts: number
}

/**
 * Устаревшее имя того же типа. Держится ради ветки `script`: там лежит
 * то же ядро и импорты ещё старые, а перенос правки заплаткой дешёв
 * только пока файлы совпадают.
 */
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
   * Форма записи. Склад у франшизы бессрочный, а правила сборки дерева
   * меняются: запись без метки или с чужой меткой считается промахом,
   * и дерево собирается заново. Нынешняя метка — 2: первая форма выбирала
   * запись каталога по порядку ответа службы, а не по своим правилам.
   */
  shape?: number
}

export type CacheRecord = MediaCacheRecord | MalCacheRecord | FranchiseCacheRecord

/**
 * Снимок БД для инспектора настроек и читателя склада на экране журнала.
 *
 * Поле на каждый вид записи, а не одна сумма: показанный ноль при живом кэше
 * — это не «пусто», а забытый счётчик, и отличить одно от другого можно только
 * поимённо. Ровно так молчали сначала темы, потом русские названия,
 * а потом — люди и облики плиток, когда им подняли номер префикса,
 * а таблицу в db.ts поправить забыли.
 */
export interface DbStats {
  /**
   * Карточки тайтлов AniList: префикс MED3_.
   *
   * Пишутся с тех пор, как карточка стала ложиться на склад: запись делает
   * api/anilist-media.ts после удачного ответа, а срок у неё свой — неделя
   * у завершённого тайтла, сутки у идущего (см. core/cache-life.ts).
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
   * Отказы «русского имени нет»: префикс NONAME1_ (core/media-title.ts).
   * Отдельным полем, а не внутри russianTitles: сложи их вместе — и сводка
   * покажет добытых имён больше, чем добыто. Своё число нужно и само по себе:
   * это ровно те тайтлы, за которыми клиент больше никогда не пойдёт в сеть.
   */
  noRussianNames: number
  /** Обложки, цвета и счёт частей: префикс LOOK3_ (core/media-looks.ts). */
  looks: number
  /** Оценки площадок: префикс RATE1_ (core/ratings.ts). */
  ratings: number
  /**
   * Метки «есть что смотреть»: префикс PLAY1_ (core/playable.ts).
   * Самый многочисленный вид записей на складе: одна на каждую виденную
   * плитку. До своего счётчика весь этот объём уходил в other безымянным.
   */
  playable: number
  /** Соответствия релизам Aniliberty: префикс ALIB1_ (api/aniliberty.ts). */
  anilibertyLinks: number
  /** Кадры и ролики тайтла: префикс SHOT1_ (api/media-shots.ts). */
  screenshots: number
  /**
   * Записи стора malCache: соответствие номера AniList и номера MAL.
   * Ноль здесь тоже правда: стор создан миграцией, но никто в него не пишет,
   * и номера MAL добываются запросом при каждом запуске заново.
   */
  malMappings: number
  /** Записи склада франшиз: у него свой ключ-число, а не префикс. */
  franchises: number
  /**
   * Записи с незнакомым префиксом. Считается сознательно: новый вид записи
   * иначе снова стал бы невидимым, а здесь он выйдет числом в остатке.
   * Крупный остаток читается как задача: кто-то пишет на склад мимо таблицы.
   */
  other: number
  totalCacheRecords: number
  estimatedSize: string
}

export interface DbStatsError {
  error: string
}
