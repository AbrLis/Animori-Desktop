// Русские названия и описания: память, датасет, склад, затем сеть. Отказы держатся отдельно
// (memory / names / noname): иначе пачечное «имени нет» глушит открытую карточку тайтла.

import { CACHE_TIME } from './constants'
import { lookupDatasetName } from './dataset-names'
import { dbGet, dbSet } from './db'
import { settings } from './settings'
import { fetchMalIds } from '../api/anilist-media'
import { fetchShikiNames, forgetShikiCards } from '../api/shikimori-media'
import { resolveTitle } from '../api/titles'
import { Logger } from '../utils/logger'
import type { MediaCacheRecord } from './types'

/** Префикс ключа на складе: цифра — версия формы записи. Срок хранения бессрочный, поэтому
 * смена формы требует нового префикса. */
const KEY_PREFIX = 'RU4_'

/** Префикс склада имён. Отдельная запись: имён читаются тысячи за раз, и датасет названий
 * ложится в свой файл и спрашивается раньше склада. */
const NAME_PREFIX = 'NAME1_'

/** Префикс отрицательных записей: «сеть спрашивали, русского имени нет». Без них каждый запуск
 * бил бы в источники за теми же тайтлами; появившееся имя приносит датасет. */
const NONAME_PREFIX = 'NONAME1_'

/** Готовая русская карточка тайтла. */
export interface RussianTitle {
  russian: string
  /** Описание с разметкой источника: разбирается при показе. */
  description: string | null
  url: string
  sourceName: string
  /** Оценка MAL из зеркала Шикимори, шкала 0..10. */
  score: number | null
  /** Распределение голосов Шикимори для их собственной средней. */
  rates: Array<{ name: string; value: number }> | null
}

/** Чем кончился вопрос о русской карточке. Три исхода, а не два: `null` приходит и при отказе
 * источника, и при сбое сети, а разница решает, можно ли показывать английский текст. */
export type RussianAskState =
  | 'ready'
  | 'none'
  | 'fail'

export interface RussianAsk {
  state: RussianAskState
  title: RussianTitle | null
}

/** Тайтл и его номер MAL: пачечным путям нужны оба сразу. */
interface TitlePair {
  mediaId: number
  malId: number
}

/** Знание этого запуска про карточки; `null` — «спрашивали сеть, перевода нет». Ответ датасета
 * сюда не попадает: иначе обход списка решал бы за карточку, открытую позже. */
const memory = new Map<number, RussianTitle | null>()

/** Русские названия, добытые попутно с находкой поиска. Держатся отдельно от карточек:
 * описания и ссылки тут нет, и выдавать голое имя за полную карточку нельзя. */
const names = new Map<number, string>()

/** Кому русского имени нет вовсе: переживает запуски. Смотрят сюда только пачечные пути. */
const noname = new Set<number>()

/** Чьи ключи уже искали на складе: промах склада не значит «перевода нет», сеть спросить ещё стоит. */
const asked = new Set<number>()

/** Чьи имена уже искали на складе имён. Склады разные — и отметки разные. */
const askedNames = new Set<number>()

/** Чьи отказы уже искали на складе: чтение пустоты тоже стоит обращения. */
const askedNoname = new Set<number>()

/** Незавершённые добычи: два виджета часто просят один тайтл в один миг. */
const pending = new Map<number, Promise<RussianAsk>>()

function cacheKey(mediaId: number): string {
  return `${KEY_PREFIX}${mediaId}`
}

function nameKey(mediaId: number): string {
  return `${NAME_PREFIX}${mediaId}`
}

function nonameKey(mediaId: number): string {
  return `${NONAME_PREFIX}${mediaId}`
}

/** Читает карточку со склада. Протухшая запись считается отсутствующей. */
async function readCache(mediaId: number): Promise<RussianTitle | null> {
  asked.add(mediaId)

  const record = await dbGet<MediaCacheRecord<RussianTitle>>('mediaCache', cacheKey(mediaId))
  if (!record || typeof record.ts !== 'number') return null
  if (Date.now() - record.ts > CACHE_TIME) return null

  const data = record.data
  return data && typeof data.russian === 'string' && data.russian ? data : null
}

/** Кладёт карточку на склад. Отсутствие перевода на склад карточек не пишется. */
async function writeCache(mediaId: number, data: RussianTitle): Promise<void> {
  await dbSet('mediaCache', { key: cacheKey(mediaId), data, ts: Date.now() })
}

/** Читает имя со склада имён. Протухшая запись считается отсутствующей. */
async function readNameCache(mediaId: number): Promise<string | null> {
  askedNames.add(mediaId)

  const record = await dbGet<MediaCacheRecord<string>>('mediaCache', nameKey(mediaId))
  if (!record || typeof record.ts !== 'number') return null
  if (Date.now() - record.ts > CACHE_TIME) return null

  return typeof record.data === 'string' && record.data !== '' ? record.data : null
}

/** Кладёт имя на склад имён. Пустое имя записью не считается. */
async function writeNameCache(mediaId: number, russian: string): Promise<void> {
  if (russian === '') return

  await dbSet('mediaCache', { key: nameKey(mediaId), data: russian, ts: Date.now() })
}

/** Спрашивали ли уже сеть об этом тайтле и получали ли отказ. Читается один раз за запуск. */
async function readNoname(mediaId: number): Promise<boolean> {
  if (noname.has(mediaId)) return true
  if (askedNoname.has(mediaId)) return false

  askedNoname.add(mediaId)

  const record = await dbGet<MediaCacheRecord<number>>('mediaCache', nonameKey(mediaId))
  if (!record || typeof record.ts !== 'number') return false
  if (Date.now() - record.ts > CACHE_TIME) return false

  noname.add(mediaId)
  return true
}

/** Запоминает отказ сети навсегда. Именно сети: ответ датасета сюда не пишется, иначе первая
 * же прокрутка навечно закрыла бы тайтлу путь в рантайм. */
async function writeNoname(mediaId: number): Promise<void> {
  noname.add(mediaId)
  askedNoname.add(mediaId)

  await dbSet('mediaCache', { key: nonameKey(mediaId), data: 1, ts: Date.now() })
}

/** Добывает карточку из сети по уже известному номеру MAL. */
async function fetchByMal(mediaId: number, malId: number): Promise<RussianTitle | null> {
  const resolved = await resolveTitle(malId)

  if (!resolved || !resolved.russian) {
    // Сеть спрошена и ответила отказом — вот это в память класть можно:
    // открытая карточка через секунду спросит тех же и услышит то же.
    memory.set(mediaId, null)

    // Следующему запуску знание пригодится: сетки за этим тайтлом больше
    // не пойдут, а открытая карточка по-прежнему попробует.
    await writeNoname(mediaId)
    return null
  }

  const card: RussianTitle = {
    russian: resolved.russian,
    description: resolved.description,
    url: resolved.url,
    sourceName: resolved.sourceName,
    score: resolved.score,
    rates: resolved.rates,
  }

  memory.set(mediaId, card)

  // Один ответ наполняет оба склада: имя понадобится сетке, описание —
  // открытой карточке, и спрашивать источник о том же дважды незачем.
  await Promise.all([writeCache(mediaId, card), writeNameCache(mediaId, card.russian)])
  return card
}

/** Полный путь для одного тайтла: склад, соответствие MAL, источники. */
async function loadOne(mediaId: number): Promise<RussianTitle | null> {
  const cached = await readCache(mediaId)
  if (cached) {
    memory.set(mediaId, cached)
    return cached
  }

  const malId = (await fetchMalIds([mediaId])).get(mediaId)
  if (!malId) {
    memory.set(mediaId, null)
    return null
  }

  return await fetchByMal(mediaId, malId)
}

/** Русская карточка тайтла с исходом вопроса. Повторные вызовы пока идёт добыча ждут тот же
 * ответ. Отрицательные записи здесь не спрашиваются: прошлый отказ сети — не повод оставить
 * карточку без описания. */
export async function getRussianTitle(mediaId: number): Promise<RussianAsk> {
  if (memory.has(mediaId)) {
    const title = memory.get(mediaId) ?? null
    // Запомненное знание всегда исход, а не ожидание: в память ложится либо карточка,
    // либо отказ источника.
    return { state: title === null ? 'none' : 'ready', title }
  }

  const inFlight = pending.get(mediaId)
  if (inFlight) return await inFlight

  const task = loadOne(mediaId)
    .then<RussianAsk>((title) => ({
      state: title === null ? 'none' : 'ready',
      title,
    }))
    .catch<RussianAsk>((e) => {
      // Сбой не запоминается: сеть вернётся — спросим снова. Наружу он уходит своим исходом,
      // а не пустотой: вызывающий должен отличить «сети нет» от «перевода нет».
      Logger('WARN', `Русское название: добыть не вышло (тайтл ${mediaId})`, e)
      return { state: 'fail', title: null }
    })

  pending.set(mediaId, task)

  try {
    return await task
  } finally {
    pending.delete(mediaId)
  }
}

/** Запоминает русское название, доставшееся даром вместе с чужим ответом: сети это не стоит ничего. */
export function rememberRussianName(mediaId: number, russian: string): void {
  const clean = russian.trim()
  if (clean === '') return

  names.set(mediaId, clean)
}

/** Поднимает в память имена, известные без сети: датасет, затем склады. Обратно в запись имя
 * не переносится — это делает prefetchRussianNames на видимом куске. */
export async function warmRussianNames(mediaIds: number[]): Promise<number> {
  let warmed = 0

  for (const mediaId of mediaIds) {
    if (memory.has(mediaId) || names.has(mediaId)) continue

    try {
      // Датасет первым: он полнее складов и читается из памяти запуска.
      const fromDataset = await lookupDatasetName(mediaId)
      if (fromDataset.kind === 'name') {
        names.set(mediaId, fromDataset.name)
        warmed++
        continue
      }
      if (fromDataset.kind === 'none') {
        // Память не трогаем: здесь решается вопрос поиска по кириллице, а не судьба
        // открытой карточки. Сети тут нет вовсе.
        noname.add(mediaId)
        continue
      }

      // Склады спрашиваются по одному разу за запуск: чтений тут тысячи.
      const stored = askedNames.has(mediaId) ? null : await readNameCache(mediaId)
      if (stored !== null) {
        names.set(mediaId, stored)
        warmed++
        continue
      }

      const cached = asked.has(mediaId) ? null : await readCache(mediaId)
      if (!cached) continue

      memory.set(mediaId, cached)
      warmed++
    } catch (e) {
      // Склад мог не открыться: без него поиск обеднеет, но работать обязан.
      Logger('WARN', `Русские имена: склад не ответил по тайтлу ${mediaId}`, e)
      return warmed
    }
  }

  if (warmed > 0) Logger('DB', `Русские имена: без сети поднято ${warmed}`)
  return warmed
}

/** Разрешён ли Шикимори настройками источников: пачками умеет только он. */
function shikimoriAllowed(): boolean {
  return settings.titlePrimary === 'shikimori' || settings.titleFallback === 'shikimori'
}

/** Имена пачками: один запрос на пятьдесят тайтлов; берётся только строка имени. Три исхода,
 * и путать их нельзя: «нет» — вечный отказ, а молчание не то же самое. */
async function namesInBulk(pairs: TitlePair[]): Promise<number> {
  const reply = await fetchShikiNames(pairs.map((pair) => pair.malId))
  let added = 0

  for (const pair of pairs) {
    try {
      const russian = reply.names.get(pair.malId)
      if (russian) {
        names.set(pair.mediaId, russian)
        await writeNameCache(pair.mediaId, russian)
        added++
        continue
      }

      if (reply.answered.has(pair.malId)) await writeNoname(pair.mediaId)
    } catch (e) {
      // Склад мог не открыться: имя всё равно уже в памяти запуска.
      Logger('WARN', `Русское имя: тайтл ${pair.mediaId} не лёг на склад`, e)
    }
  }

  return added
}

/** Путь по одному через все источники: пачками отвечает только Шикимори, anime365 берёт
 * по одному номеру за запрос. */
async function namesOneByOne(pairs: TitlePair[]): Promise<number> {
  let added = 0

  for (const pair of pairs) {
    try {
      if (await fetchByMal(pair.mediaId, pair.malId)) added++
    } catch (e) {
      // Один упавший тайтл не повод бросать остальной экран без названий.
      Logger('WARN', `Русское имя: тайтл ${pair.mediaId} пропущен`, e)
    }
  }

  return added
}

/** Готовит имена для видимого куска списка: датасет, склад имён, склад карточек. «Имени нет»
 * от датасета не приговор: он собран из трёх источников, спрошенных в разный день. */
export async function prefetchRussianNames(mediaIds: number[]): Promise<number> {
  const unknown: number[] = []
  let skipped = 0

  for (const mediaId of mediaIds) {
    if (memory.has(mediaId) || names.has(mediaId)) continue

    // Датасет — раньше складов: он свежее и полнее их обоих, а отвечает из памяти.
    const fromDataset = await lookupDatasetName(mediaId)
    if (fromDataset.kind === 'name') {
      names.set(mediaId, fromDataset.name)
      continue
    }

    // Склад спрашивается один раз за запуск: прокрутка возвращается к тем же строкам.
    const stored = askedNames.has(mediaId) ? null : await readNameCache(mediaId)
    if (stored !== null) {
      names.set(mediaId, stored)
      continue
    }

    const cached = asked.has(mediaId) ? null : await readCache(mediaId)
    if (cached) {
      memory.set(mediaId, cached)

      // Имя переносится в свою запись: следующий запуск возьмёт строку, не поднимая
      // описание с оценками и голосами.
      await writeNameCache(mediaId, cached.russian)
      continue
    }

    // Отрицательная запись спрашивается последней: имя могло приехать
    // на склад позже отказа — например, попутно с поиском.
    if (await readNoname(mediaId)) {
      skipped++
      continue
    }

    unknown.push(mediaId)
  }

  if (unknown.length === 0) {
    if (skipped > 0) Logger('DB', `Русские имена: ${skipped} без перевода, сеть не трогаем`)
    return 0
  }

  const malIds = await fetchMalIds(unknown)
  const pairs: TitlePair[] = []

  for (const mediaId of unknown) {
    const malId = malIds.get(mediaId)
    if (!malId) {
      // Номера MAL нет — спрашивать источники не по чему. Знание на склад,
      // но не в память: пачечный путь не решает за открытую карточку.
      await writeNoname(mediaId)
      continue
    }

    pairs.push({ mediaId, malId })
  }

  if (pairs.length === 0) {
    const noMal = unknown.length
    Logger('INFO', `Русские имена: соответствий MAL нет ни у одного из ${noMal}`)
    return 0
  }

  const added = shikimoriAllowed() ? await namesInBulk(pairs) : await namesOneByOne(pairs)

  const tail = skipped > 0 ? `, пропущено ${skipped}` : ''
  Logger('INFO', `Русские имена: добыто ${added} из ${unknown.length}${tail}`)
  return added
}

/** Русское название, известное прямо сейчас: из полной карточки или попутное. */
export function peekRussianName(mediaId: number): string | null {
  return memory.get(mediaId)?.russian ?? names.get(mediaId) ?? null
}

/** Забывает знание запуска. Склад не трогается: его чистят из настроек. */
export function forgetRussianTitles(): void {
  memory.clear()
  names.clear()
  noname.clear()
  asked.clear()
  askedNames.clear()
  askedNoname.clear()
  pending.clear()

  // Карточки Шикимори — тоже знание запуска. Без этой строки «забыть всё» оставляло бы
  // источник отвечать из памяти, в том числе прошлым отказом.
  forgetShikiCards()
}
