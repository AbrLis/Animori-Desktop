// Дерево франшизы: хронология с Шикимори одним запросом, номера MAL → AniList одной пачкой, склад бессрочный.
// Манга отбрасывается по адресу (/mangas/, /ranobe/): переход вёл бы на пустую карточку.

import { anilistQuery } from '../api/anilist'
import { fetchShiki } from '../api/shikimori'
import { dbGet, dbSet } from './db'
import { Logger } from '../utils/logger'
import { startStamp } from './media-parts'
import type { FranchiseCacheRecord } from './types'

/** Узел дерева с Шикимори: номер тут — номер MAL. */
interface FranchiseNode {
  id: number
  name: string
  url: string
  year: number | null
  /** Полная дата узла, unix-секунды; по ней сортируется хронология. */
  date?: number | null
  kind: string | null
}

/** Часть франшизы для полки, сопоставленная с каталогом AniList. */
export interface FranchiseWork {
  mediaId: number | null
  malId: number | null
  /** Вид тайтла со стороны AniList; строка ради читателей склада и старых записей. */
  type: string | null
  /** Имя части с Шикимори: русское, общее для всех записей узла. */
  name: string
  /** Название записи AniList: у раздробленной части только оно и различает строки. */
  title: string | null
  /** Что различает записи одной части: хвост названия после общего начала («1st STAGE»).
   * null — узел дал одну запись, различать нечего. */
  stage: string | null
  year: number | null
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
  coverImage: { large?: string | null; medium?: string | null } | null
  /** Состояние выпуска: по нему выбирается запись, когда их несколько. */
  status: string | null
  startDate: { year: number | null; month: number | null; day: number | null } | null
  /** Название записи: им различаются этапы одной части. */
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
      coverImage { large medium }
    }
  }
}`

/** Знание этого запуска: дерево спрашивают карточка и полка одновременно. */
const memory = new Map<number, FranchiseWork[] | null>()

// Что различает записи одной части: хвост названия после общего начала. Общее начало срезается,
// только если остаток начинается с разделителя: у «Foo» и «Foobar» хвост «bar» не различает.
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

const pending = new Map<number, Promise<FranchiseWork[] | null>>()

/** Адреса узлов манги: читать мангу приложение не умеет. */
const FOREIGN_PATHS = ['/mangas', '/ranobe']

/** Узел чужого вида: первоисточник в дереве аниме встречается часто. */
function isForeignNode(url: string): boolean {
  return FOREIGN_PATHS.some((path) => url.startsWith(path))
}

// Версия формы складской записи: правила сборки меняются, а склад бессрочный —
// без метки записи прежней формы пережили бы правку.
// 3 → 4: обложка части стала `large` вместо `medium`. Без смены метки прежние записи
// (обложки в 220×330) считались бы валидными, и полка осталась бы мыльной на весь срок
// жизни склада — как раз то, на что жаловались: шапка брала `large` и была резкой,
// а франшиза продолжала читать свой старый кэш с диска.
const FRANCHISE_SHAPE = 4

/** Читает дерево со склада. Записи старой формы считаются промахом, и проверяется
 *  каждая часть, а не первая: иначе старый склад с мангой в середине выживал бы. */
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

/** Кладёт дерево на склад; отсутствие дерева не пишется. */
async function writeCache(mediaId: number, works: FranchiseWork[]): Promise<void> {
  await dbSet('franchiseCache', {
    id: mediaId,
    data: works,
    ts: Date.now(),
    shape: FRANCHISE_SHAPE,
  })
}

// Добывает и собирает дерево: Шикимори по номеру MAL, затем маппинг.
async function load(mediaId: number, malId: number): Promise<FranchiseWork[] | null> {
  const reply = await fetchShiki<{ nodes?: FranchiseNode[] }>(`/api/animes/${malId}/franchise`)

  const nodes = Array.isArray(reply.data?.nodes) ? reply.data.nodes : []
  if (nodes.length === 0) {
    memory.set(mediaId, null)
    return null
  }

  // Мангу и ранобэ убираем сразу: их незачем искать в каталоге.
  const own = nodes.filter((node) => !isForeignNode(node.url ?? ''))

  const malIds = [
    ...new Set(own.flatMap((n) => (typeof n.id === 'number' && n.id > 0 ? [n.id] : []))),
  ]

  // Одному номеру MAL служба иногда отвечает несколькими записями: часть раздроблена
  // на этапы, а номер общий. Отсюда список, а не одна запись.
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
    // Части только на Шикимори — клипы и реклама, в каталоге AniList их нет нарочно.
    if (list === undefined) continue

    // Порядок записей одной части — по началу выпуска, а не по порядку ответа службы.
    const sorted = [...list].sort(
      (a, b) => startStamp(a.startDate) - startStamp(b.startDate) || a.id - b.id,
    )

    // Хвост нужен только раздробленной части: у одиночной различать нечего.
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
          // Год записи точнее года узла: этапы одной части расходятся по годам.
          year: typeof entryYear === 'number' && entryYear > 0 ? entryYear : nodeYear,
          date: typeof node.date === 'number' && node.date > 0 ? node.date : null,
          kind: node.kind ?? null,
          // Обложка — `large`, как и везде в приложении (anilist-catalog, anilist-lookup). Одного
          // `medium` (~220×330) не хватало: плитка полки на телевизоре — это сотни пикселей по
          // стороне, и картинка растягивалась вдвое-втрое, читаясь мылом. `medium` остаётся запасным.
          cover: entry.coverImage?.large ?? entry.coverImage?.medium ?? null,
          isAdult: entry.isAdult === true,
        },
        stamp: startStamp(entry.startDate),
      })
    }
  }

  if (rows.length <= 1) {
    // Одна часть — не франшиза, а сам тайтл: полке делать нечего.
    memory.set(mediaId, null)
    return null
  }

  // Хронология по полной дате узла, внутри узла — по началу выпуска записи.
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

/** Хронология франшизы или null; ошибки глушатся — отсутствие полки не поломка. */
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
