// Рекомендации главной (пункт 3.11): профиль вкуса по любимым жанрам,
// советы «по мотивам», бесконечная лента подбора, отбор показанного
// и список «не интересует».
// Кэш живёт в памяти запуска: пересчёт на каждый запуск — решение реестра.
//
// ПАЧКА ВМЕСТО ТРЁХ ПОХОДОВ
// Сезон, тренд и лучшее спрашиваются одним запросом и раздаются трём полкам
// из общего обещания. Раньше это были три захода подряд через общую паузу
// клиента, и витрина собиралась ступеньками по несколько секунд.
//
// ЛЕНТА ОТДАЁТ РОВНУЮ ПОРЦИЮ
// Своё, скрытое и взрослое выбрасываются после ответа сервера, и страница
// из сорока аниме у человека с большим списком легко тает до трёх.
// Поэтому «Показать ещё» просит не страницу, а нужное число плиток.
//
// И ровно нужное: набранное сверх порции ждёт в остатке ленты, а не едет
// в сетку случайным хвостом. Сетка раскладывает плитки по рядам, и лишние
// три-пять штук оставляли нижний ряд недобранным всю ленту насквозь.
//
// ПОЛКА НЕ ПУСТЕЕТ ОТ «НЕ ИНТЕРЕСНО»
// Отметка убирает одно аниме, а не полку: полка добирает следующее из
// запаса той же выборки, а кончился запас — берёт следующую страницу.
// Отбор показа — своё, скрытое, взрослое — применяется на выдаче, а не
// при приезде страницы: иначе аниме, с которого сняли метку, не вернулось
// бы на полку до перезапуска.

import { Bridge } from '@/bridge'
import type { MediaBrief } from '../api/anilist-media'
import {
  fetchFeed,
  fetchGenreMap,
  fetchRecsFor,
  fetchShelf,
  fetchShelfPack,
  fetchTags,
  type BriefPage,
  type CatalogPick,
  type CatalogTag,
  type PackKind,
  type ShelfPack,
} from '../api/anilist-catalog'
import { Logger } from '../utils/logger'
import { keepAllowed } from './adult'
import { getEntry } from './collection'
import { selectEntries } from './collection-view'

/** Сколько любимых записей участвуют в профиле вкуса. */
const TASTE_DEPTH = 30

/** Сколько жанров вкуса идёт в подбор: один шумит, четыре размывают. */
const TASTE_GENRES = 2

/** Сколько семян «по мотивам» опрашивается за круг: советы пары склеиваются. */
const SEED_COUNT = 2

/** Сколько любимых идёт в семена: по паре на круг, каждый запуск в новом
    порядке. Число кратно `SEED_COUNT`, иначе последний круг остался бы
    без пары. */
const SEED_POOL = 8

/** Оценка, с которой запись считается любимой. */
const LOVED_SCORE = 8

/** Сколько страниц берётся за один «Показать ещё». Потолок обязателен:
    узкий отбор вроде «меха до 1990» иначе уведёт в десятки запросов подряд. */
const FEED_TRIES = 3

/** Сколько страниц добирает полка за одну просьбу о наполнении. Запас
    страницы закрывает отметки «не интересно» без сети, так что второй
    заход нужен лишь когда подчистили и его. */
const SHELF_TRIES = 2

/** Сколько кругов семян «по мотивам» опрашивается, прежде чем полка
    признаёт советы исчерпанными: каждый круг — новая пара любимых. */
const SEED_ROUNDS = 4

/** Ключ хранилища скрытого. Пользовательские данные, а не настройка. */
const HIDE_KEY = 'am_recs_hidden'

/** Потолок списка скрытого: без него годы «не интересует» раздуют запись. */
const HIDE_LIMIT = 500

/** Скрытые номера. Пустота до подъёма значит «ещё не читали». */
let hidden: Set<number> | null = null

/** Профиль вкуса запуска. null значит «ещё не считали», пустота — «считали, нету». */
let taste: string[] | null = null

/** Общее обещание пачки полок: три полки ждут один и тот же ответ. */
let packRun: Promise<ShelfPack> | null = null

/** Справочник тэгов запуска: меню отбора открывают много раз за сеанс. */
let tagsRun: Promise<CatalogTag[]> | null = null

/** Полки витрины: по имени экран просит наполнение, а не ходит в сеть сам. */
export type ShelfName = 'taste' | 'motif' | 'airing' | 'trending' | 'top'

/**
 * Запас полки: сырые плитки взятых страниц. Отбор показа применяется
 * на выдаче, поэтому запас не устаревает ни от отметки «не интересно»,
 * ни от тумблера взрослого.
 */
interface Stock {
  raw: MediaBrief[]
  /** Сколько страниц выборки уже взято. */
  page: number
  /** Каталог кончился: добирать нечего. */
  over: boolean
  /** Страница выборки по номеру. Номер идёт от единицы и растёт подряд. */
  more: (page: number) => Promise<BriefPage>
}

/** Запасы полок этого запуска: одна полка — один запас на весь сеанс. */
const stocks = new Map<ShelfName, Stock>()

/** Поднимает список скрытого из хранилища один раз за запуск. */
async function loadHidden(): Promise<Set<number>> {
  if (hidden !== null) return hidden

  try {
    const stored = await Bridge.storage.get<number[]>(HIDE_KEY, [])
    hidden = new Set(Array.isArray(stored) ? stored.filter((id) => Number.isFinite(id)) : [])
  } catch (e) {
    // Без списка скрытого витрина работает: просто покажет всё.
    Logger('WARN', 'Рекомендации: скрытое не поднялось', e)
    hidden = new Set()
  }

  return hidden
}

/** Прячет аниме из рекомендаций насовсем. Запись идёт вдогонку за памятью. */
export async function hideRec(mediaId: number): Promise<void> {
  const known = await loadHidden()
  known.add(mediaId)

  // Старые вытесняются: древнее «не интересует» давно неактуально.
  const list = Array.from(known).slice(-HIDE_LIMIT)
  hidden = new Set(list)

  try {
    await Bridge.storage.set(HIDE_KEY, list)
  } catch (e) {
    Logger('WARN', 'Рекомендации: скрытое не записалось', e)
  }
}

/**
 * Снимает метку «не интересно» со всех аниме. Зовётся при очистке памяти:
 * отметка лежит в том же хранилище, что и настройки, и одной очисткой
 * кэша названий её не снять.
 */
export async function clearHidden(): Promise<void> {
  hidden = new Set()

  try {
    await Bridge.storage.set(HIDE_KEY, [])
  } catch (e) {
    Logger('WARN', 'Рекомендации: скрытое не снялось', e)
  }
}

/** Любимые жанры хозяина: взвешены оценкой, плоский счёт хвалил бы мусор. */
async function tasteGenres(): Promise<string[]> {
  if (taste !== null) return taste

  let genres: string[] = []
  const loved = selectEntries(
    { onlyRated: true, minScore: LOVED_SCORE },
    { key: 'score' },
    { limit: TASTE_DEPTH },
  )

  if (loved.length > 0) {
    try {
      const map = await fetchGenreMap(loved.map((entry) => entry.mediaId))
      const weight = new Map<string, number>()
      for (const entry of loved) {
        for (const genre of map.get(entry.mediaId) ?? []) {
          weight.set(genre, (weight.get(genre) ?? 0) + entry.score10)
        }
      }
      genres = Array.from(weight.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, TASTE_GENRES)
        .map(([name]) => name)
    } catch (e) {
      Logger('WARN', 'Рекомендации: жанры вкуса не доехали', e)
    }
  }

  taste = genres
  return genres
}

/**
 * Любимые, из которых берутся семена «по мотивам». Порядок случаен и
 * запоминается на запуск: полка спрашивает семена парами, и каждая
 * следующая пара обязана быть новой, а не той же.
 */
let seedPool: number[] | null = null

function lovedIds(): number[] {
  if (seedPool !== null) return seedPool

  const loved = selectEntries(
    { onlyRated: true, minScore: LOVED_SCORE },
    { key: 'score' },
    { limit: SEED_POOL },
  )

  seedPool = loved
    .slice()
    .sort(() => Math.random() - 0.5)
    .map((entry) => entry.mediaId)

  return seedPool
}

/** Что не показываем: своё, скрытое и взрослое при выключенном показе. */
async function visible(briefs: MediaBrief[]): Promise<MediaBrief[]> {
  const hiddenSet = await loadHidden()
  return keepAllowed(
    briefs.filter(
      (brief) => getEntry(brief.mediaId) === undefined && !hiddenSet.has(brief.mediaId),
    ),
    (brief) => brief.isAdult,
  ).slice()
}

/**
 * Пачка полок каталога одним запросом. Провал сбрасывает обещание: витрина
 * пересобирается при возврате на главную, и после обрыва сети вторая попытка
 * обязана уйти в сеть, а не вернуть запомненную пустоту.
 */
function loadPack(): Promise<ShelfPack> {
  if (packRun !== null) return packRun

  packRun = fetchShelfPack().catch((e: unknown) => {
    Logger('WARN', 'Рекомендации: пачка полок не доехала', e)
    packRun = null
    return emptyPack()
  })

  return packRun
}

/** Пачка, в которой ни одна полка не встанет. */
function emptyPack(): ShelfPack {
  return {
    airing: { items: [], hasNext: false },
    trending: { items: [], hasNext: false },
    top: { items: [], hasNext: false },
  }
}

/** Запас полки каталога: первая страница едет общей пачкой, глубокая одна. */
function catalogStock(kind: PackKind): Stock {
  return {
    raw: [],
    page: 0,
    over: false,
    async more(page) {
      if (page === 1) return (await loadPack())[kind]
      return await fetchShelf(kind, undefined, page)
    },
  }
}

/** Запас подбора «под ваш вкус». Без оценок 8+ добирать нечего. */
function tasteStock(): Stock {
  return {
    raw: [],
    page: 0,
    over: false,
    async more(page) {
      const genres = await tasteGenres()
      if (genres.length === 0) return { items: [], hasNext: false }
      return await fetchShelf('genre', genres, page)
    },
  }
}

/**
 * Запас советов «по мотивам»: повторы склеиваются суммой весов.
 *
 * Каждый круг — новая пара семян: у одного тайтла советов набирается
 * немного, и полка, опустевшая после отметок, берёт следующую пару,
 * а не признаёт тему закрытой. Внутри круга семена спрашиваются разом:
 * друг от друга они не зависят, а очередью и темпом ведает клиент AniList.
 */
function motifStock(): Stock {
  return {
    raw: [],
    page: 0,
    over: false,
    async more(page) {
      const seeds = lovedIds().slice((page - 1) * SEED_COUNT, page * SEED_COUNT)
      if (seeds.length === 0) return { items: [], hasNext: false }

      const packs = await Promise.all(
        seeds.map(async (seed) => {
          try {
            return await fetchRecsFor(seed)
          } catch (e) {
            Logger('WARN', `Рекомендации: советы для ${seed} не доехали`, e)
            return []
          }
        }),
      )

      const weight = new Map<number, { brief: MediaBrief; rating: number }>()
      for (const recs of packs) {
        for (const rec of recs) {
          const known = weight.get(rec.brief.mediaId)
          if (known !== undefined) known.rating += rec.rating
          else weight.set(rec.brief.mediaId, { brief: rec.brief, rating: rec.rating })
        }
      }

      return {
        items: Array.from(weight.values())
          .sort((a, b) => b.rating - a.rating)
          .map((rec) => rec.brief),
        hasNext: page < SEED_ROUNDS,
      }
    },
  }
}

/** Запас полки запуска: создаётся один раз, дальше только пополняется. */
function stockOf(name: ShelfName): Stock {
  const known = stocks.get(name)
  if (known !== undefined) return known

  const stock =
    name === 'motif' ? motifStock() : name === 'taste' ? tasteStock() : catalogStock(name)

  stocks.set(name, stock)
  return stock
}

/** Берёт в запас следующую страницу. false — добрать не удалось. */
async function grow(stock: Stock): Promise<boolean> {
  if (stock.over) return false

  const page = stock.page + 1

  try {
    const got = await stock.more(page)
    stock.page = page
    if (!got.hasNext) stock.over = true

    const known = new Set(stock.raw.map((brief) => brief.mediaId))
    for (const brief of got.items) {
      if (known.has(brief.mediaId)) continue
      known.add(brief.mediaId)
      stock.raw.push(brief)
    }

    return got.items.length > 0
  } catch (e) {
    // Страница не засчитана: следующий добор возьмёт её же.
    Logger('WARN', 'Рекомендации: полку добрать не вышло', e)
    return false
  }
}

/**
 * Полка витрины: ровно `want` плиток, сколько бы хозяин ни отметил
 * «не интересно».
 *
 * Меньше `want` отдаётся лишь когда выборка кончилась: у «лучшего» и
 * «в тренде» страниц тысячи, и четырнадцать отметок не пустят полку,
 * а доберут её следующей страницей того же отбора.
 */
export async function shelfFill(name: ShelfName, want: number): Promise<MediaBrief[]> {
  const stock = stockOf(name)

  let out = await visible(stock.raw)
  for (let attempt = 0; out.length < want && attempt < SHELF_TRIES; attempt++) {
    if (!(await grow(stock))) break
    out = await visible(stock.raw)
  }

  return out.slice(0, want)
}

/**
 * Справочник тэгов для меню отбора. Провал сбрасывает обещание: меню
 * без тэгов бесполезно, и второе открытие должно попробовать снова.
 */
export function tagChoices(): Promise<CatalogTag[]> {
  if (tagsRun !== null) return tagsRun

  tagsRun = fetchTags().catch((e: unknown) => {
    Logger('WARN', 'Рекомендации: справочник тэгов не доехал', e)
    tagsRun = null
    return []
  })

  return tagsRun
}

/**
 * Состояние ленты подбора: где остановились и кого уже отдавали.
 * Живёт у вызывающего, а не в ядре: лент бывает несколько, и чужой экран
 * не должен листать чужую.
 */
export interface FeedRun {
  pick: CatalogPick
  page: number
  /** Каталог кончился и остаток роздан: кнопка «Показать ещё» больше не нужна. */
  done: boolean
  /** Страницы сервера исчерпаны. Отдельно от `done`: остаток ещё может лежать. */
  over: boolean
  seen: Set<number>
  /** Набранное сверх порции: следующее нажатие начинает с него, а не с сети. */
  rest: MediaBrief[]
}

/** Новая лента под отбор. Страницы ещё не брали. */
export function newFeed(pick: CatalogPick): FeedRun {
  return { pick, page: 0, done: false, over: false, seen: new Set(), rest: [] }
}

/**
 * Следующая порция ленты: ровно `want` плиток, пока каталог не кончился.
 *
 * Ровно — это не придирка: порция подобрана под целое число рядов сетки,
 * и случайный хвост сверх неё оставлял нижний ряд наполовину пустым.
 * Лишнее не выбрасывается и не спрашивается вторично: оно ждёт в остатке
 * ленты, и следующее нажатие часто обходится вовсе без сети.
 *
 * Пустой ответ при `done === false` — не конец ленты, а неудачный заход:
 * кнопка остаётся, и следующее нажатие продолжит с той же страницы.
 */
export async function feedMore(run: FeedRun, want: number): Promise<MediaBrief[]> {
  // Остаток прежнего захода идёт вперед сети: он уже отобран и проверен.
  const out: MediaBrief[] = run.rest.splice(0, want)

  for (let attempt = 0; attempt < FEED_TRIES && !run.over && out.length < want; attempt++) {
    const page = run.page + 1

    let reply: BriefPage
    try {
      reply = await fetchFeed(run.pick, page)
    } catch (e) {
      // Отказ сети не закрывает ленту: страница не засчитана, берём её же потом.
      Logger('WARN', `Лента подбора: страница ${page} не доехала`, e)
      break
    }

    run.page = page
    if (!reply.hasNext) run.over = true

    for (const brief of await visible(reply.items)) {
      if (run.seen.has(brief.mediaId)) continue
      run.seen.add(brief.mediaId)

      // Сверх порции — в остаток. В виденные оно уже записано: иначе
      // следующая страница привезла бы то же вторым плитками.
      if (out.length < want) out.push(brief)
      else run.rest.push(brief)
    }
  }

  // Лента закрывается только когда кончился и каталог, и остаток.
  run.done = run.over && run.rest.length === 0
  return out
}
