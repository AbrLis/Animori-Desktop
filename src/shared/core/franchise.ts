// Дерево франшизы: хронология частей с Шикимори одним запросом,
// маппинг номеров MAL в AniList одной пачкой, склад бессрочный.
// Перенос виджета скрипта: там та же хронология рисовалась на чужой
// странице; здесь переходы внутренние, а статусы берутся из своей
// памяти списка — авторизованный запрос ради них не нужен.
//
// Дерево у Шикимори смешанное: в хронологии аниме лежит и первоисточник
// манги. Показывать его негде: переход вёл бы на пустую карточку, так что
// такие узлы отбрасываются прямо по адресу (/mangas/, /ranobe/).
//
// Обратное тоже бывает: узлу MAL отвечают несколько записей AniList. Служба
// дробит часть франшизы на этапы и заводит каждому свою запись, а номер MAL
// оставляет общий. Прежде из них выбиралась одна — и выбор был случаен, а
// прочие записи пропадали из плитки вовсе. Теперь строк столько, сколько
// записей: у «Карманов лета. Фильм» их четыре, и все четыре видны.
// Порядок записей одной части — `orderParts` в `media-parts.ts`.

import { anilistQuery } from '../api/anilist'
import { fetchShiki } from '../api/shikimori'
import { dbGet, dbSet } from './db'
import { Logger } from '../utils/logger'
import { startStamp } from './media-parts'
import type { FranchiseCacheRecord } from './types'

/** Узел дерева франшизы с Шикимори: номер тут — номер MAL. */
interface FranchiseNode {
  id: number
  name: string
  url: string
  year: number | null
  /** Полная дата узла, unix-секунды: хронология сортируется по ней. */
  date?: number | null
  kind: string | null
}

/** Часть франшизы для полки: сопоставленная с каталогом AniList. */
export interface FranchiseWork {
  mediaId: number | null
  malId: number | null
  /**
   * Вид тайтла со стороны AniList. Остаток от времён манги: теперь здесь
   * всегда аниме, но поле оставлено строкой ради читателей склада
   * и старых записей, где манга ещё лежит.
   */
  type: string | null
  /** Имя части с Шикимори: русское и общее для всех записей этого узла. */
  name: string
  /** Название записи AniList. У раздробленной части только оно и различает строки. */
  title: string | null
  /**
   * Что различает записи одной части: остаток названия после общего начала
   * («1st STAGE», «Kushima Kamome-hen»). `null` — узел дал одну запись,
   * различать нечего.
   */
  stage: string | null
  year: number | null
  /** Полная дата части, unix-секунды. */
  date: number | null
  kind: string | null
  cover: string | null
  isAdult: boolean
}

interface FranchiseMapEntry {
  id: number
  idMal: number | null
  type: string | null
  isAdult: boolean
  coverImage: { medium: string | null } | null
  /** Состояние выпуска: по нему выбирается запись, когда их несколько. */
  status: string | null
  startDate: { year: number | null; month: number | null; day: number | null } | null
  /** Название записи: единственное, чем различаются этапы одной части. */
  title: { romaji: string | null } | null
}

const FRANCHISE_MAP_QUERY = `
query ($ids: [Int], $type: MediaType) {
  Page(page: 1, perPage: 50) {
    media(idMal_in: $ids, type: $type) {
      id
      idMal
      type
      isAdult
      status
      startDate { year month day }
      title { romaji }
      coverImage { medium }
    }
  }
}`

/** Знание этого запуска: дерево спрашивают карточка и полка одновременно. */
const memory = new Map<number, FranchiseWork[] | null>()

/**
 * Что различает записи одной части: остаток названия после общего начала.
 *
 * У «Стального шара» названия этапов — «…Steel Ball Run - 1st STAGE» и
 * «…Steel Ball Run - 2nd - 3rd STAGE», у «Карманов лета» — «Summer Pockets:
 * Kushima Kamome-hen» и три соседних. Общее начало у них одно и то же, и
 * в строке оно только мешает: различает именно хвост.
 *
 * Общее начало срезается, только если остаток начинается с разделителя.
 * У «Foo» и «Foobar» общее начало «Foo», но остаток «bar» ничего не
 * различает — такое название остаётся целым.
 */
function stageTail(title: string, others: readonly string[]): string | null {
  let common = title
  for (const other of others) {
    let i = 0
    while (i < common.length && i < other.length && common[i] === other[i]) i += 1
    common = common.slice(0, i)
  }

  const cut = common.replace(/[\s\-–—:·,.]+$/, '')
  if (cut.length === 0) return null

  const rest = title.slice(cut.length)
  if (!/^[\s\-–—:·,.]/.test(rest)) return null

  const tail = rest.replace(/^[\s\-–—:·,.]+/, '').trim()
  return tail === '' ? null : tail
}

/** Незавершённые добычи по номеру тайтла. */
const pending = new Map<number, Promise<FranchiseWork[] | null>>()

/** Адреса узлов, которых у нас больше нет: читать мангу приложение не умеет. */
const FOREIGN_PATHS = ['/mangas', '/ranobe']

/** Узел чужого вида: первоисточник в дереве аниме встречается часто. */
function isForeignNode(url: string): boolean {
  return FOREIGN_PATHS.some((path) => url.startsWith(path))
}

/**
 * Форма складской записи.
 *
 * 2 — выбор записи каталога перестал зависеть от порядка ответа службы.
 * 3 — в строке появились название записи и её отличительный хвост, а на один
 * узел Шикимори строк стало столько, сколько записей в каталоге. Склад
 * у франшизы бессрочный, а правила сборки меняются: без метки записи прежней
 * формы пережили бы правку, и потеря записей осталась бы у каждого, кто уже
 * открывал эту карточку.
 */
const FRANCHISE_SHAPE = 3

/** Читает дерево со склада. Записи старой формы — без метки, без постеров,
 *  без полной даты, без названия записи, с частями без сопоставления или
 *  с мангой внутри — считаются промахом. Проверяется каждая часть, а не
 *  первая: иначе старый склад с клипом или с мангой в середине выживал,
 *  а склад у нас бессрочный. */
async function readCache(mediaId: number): Promise<FranchiseWork[] | null> {
  const record = await dbGet<FranchiseCacheRecord>('franchiseCache', mediaId)
  if (record?.shape !== FRANCHISE_SHAPE) return null

  const data = record.data
  if (!Array.isArray(data) || data.length === 0) return null

  for (const work of data as Array<Partial<FranchiseWork> | undefined>) {
    if (!work || typeof work.name !== 'string') return null
    if (!('cover' in work) || !('date' in work)) return null
    if (!('title' in work) || !('stage' in work)) return null
    if (work.mediaId === undefined || work.mediaId === null) return null
    if (work.type === 'MANGA') return null
  }

  return data as FranchiseWork[]
}

/** Кладёт дерево на склад. Отсутствие дерева на склад не пишется. */
async function writeCache(mediaId: number, works: FranchiseWork[]): Promise<void> {
  await dbSet('franchiseCache', {
    id: mediaId,
    data: works,
    ts: Date.now(),
    shape: FRANCHISE_SHAPE,
  })
}

/**
 * Добывает и собирает дерево: Шикимори по номеру MAL, затем маппинг.
 *
 * Запрос сопоставления теперь один: пространство номеров MAL у аниме
 * и манги раздельное, а манга больше не ищется вовсе.
 */
async function load(mediaId: number, malId: number): Promise<FranchiseWork[] | null> {
  const reply = await fetchShiki<{ nodes?: FranchiseNode[] }>(`/api/animes/${malId}/franchise`)

  const nodes = Array.isArray(reply.data?.nodes) ? reply.data.nodes : []
  if (nodes.length === 0) {
    memory.set(mediaId, null)
    return null
  }

  // Манга и ранобэ из дерева убираются сразу: их незачем искать в каталоге.
  const own = nodes.filter((node) => !isForeignNode(node.url ?? ''))

  const malIds = [
    ...new Set(own.flatMap((n) => (typeof n.id === 'number' && n.id > 0 ? [n.id] : []))),
  ]

  // Одному номеру MAL служба иногда отвечает несколькими записями: часть
  // франшизы раздроблена на этапы, а номер у них общий. Отсюда список, а не
  // одна запись. Прежде здесь стоял Map «номер → запись», и побеждала та,
  // что пришла последней: порядок ответа службы решал, какая часть попадёт
  // в плитку, а остальные пропадали из неё вовсе.
  const mapped = new Map<number, FranchiseMapEntry[]>()
  if (malIds.length > 0) {
    const answer = await anilistQuery<{ Page?: { media?: FranchiseMapEntry[] } }>(
      FRANCHISE_MAP_QUERY,
      { ids: malIds, type: 'ANIME' },
    )

    for (const entry of answer?.data?.Page?.media ?? []) {
      if (typeof entry.idMal !== 'number') continue

      const list = mapped.get(entry.idMal)
      if (list) list.push(entry)
      else mapped.set(entry.idMal, [entry])
    }
  }

  const rows: Array<{ work: FranchiseWork; stamp: number }> = []

  for (const node of own) {
    if (typeof node.id !== 'number' || node.id <= 0) continue

    const list = mapped.get(node.id)
    // Части только на Шикимори выкидываются: это клипы и реклама,
    // которых в каталоге AniList нет нарочно.
    if (list === undefined) continue

    // Порядок записей одной части берётся у начала выпуска, а не у порядка
    // ответа службы: хронология и есть хронология.
    const sorted = [...list].sort(
      (a, b) => startStamp(a.startDate) - startStamp(b.startDate) || a.id - b.id,
    )

    // Хвост, различающий этапы, нужен только раздробленной части: у одиночной
    // записи различать нечего, и полное название ей ни к чему.
    const split = sorted.length > 1
    const titles = sorted
      .map((entry) => entry.title?.romaji ?? '')
      .filter((title) => title !== '')

    for (const entry of sorted) {
      const title = entry.title?.romaji ?? null
      const nodeYear = typeof node.year === 'number' ? node.year : null
      const entryYear = entry.startDate?.year

      rows.push({
        work: {
          mediaId: entry.id,
          malId: node.id,
          type: entry.type,
          name: node.name,
          title,
          stage: split && title !== null ? stageTail(title, titles) : null,
          // Год записи точнее года узла: у раздробленной части этапы
          // расходятся по годам, а узел Шикимори у них один.
          year: typeof entryYear === 'number' && entryYear > 0 ? entryYear : nodeYear,
          date: typeof node.date === 'number' && node.date > 0 ? node.date : null,
          kind: node.kind ?? null,
          cover: entry.coverImage?.medium ?? null,
          isAdult: entry.isAdult === true,
        },
        stamp: startStamp(entry.startDate),
      })
    }
  }

  if (rows.length <= 1) {
    // Одна часть — это не франшиза, а сам тайтл: полке делать нечего.
    memory.set(mediaId, null)
    return null
  }

  // Хронология по полной дате узла, а внутри узла — по началу выпуска записи:
  // сезоны одного года иначе ехали, а этапы одной части и подавно.
  rows.sort(
    (a, b) =>
      (a.work.date ?? Number.MAX_SAFE_INTEGER) - (b.work.date ?? Number.MAX_SAFE_INTEGER) ||
      a.stamp - b.stamp,
  )

  const works = rows.map((row) => row.work)

  memory.set(mediaId, works)
  await writeCache(mediaId, works)
  return works
}

/**
 * Хронология франшизы тайтла или `null`, когда дерева нет.
 * Ошибки глушатся: отсутствие полки — не поломка карточки.
 */
export async function fetchFranchise(
  mediaId: number,
  malId: number | null,
): Promise<FranchiseWork[] | null> {
  if (malId === null) return null
  if (memory.has(mediaId)) return memory.get(mediaId) ?? null

  const inFlight = pending.get(mediaId)
  if (inFlight) return await inFlight

  const task = (async () => {
    const cached = await readCache(mediaId)
    if (cached !== null) {
      memory.set(mediaId, cached)
      return cached
    }

    return await load(mediaId, malId)
  })().catch((e) => {
    Logger('WARN', `Франшиза: дерево тайтла ${mediaId} не добылось`, e)
    return null
  })

  pending.set(mediaId, task)

  try {
    return await task
  } finally {
    pending.delete(mediaId)
  }
}
