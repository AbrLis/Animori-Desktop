// Даты просмотров из журнала Shikimori: в закладках дат нет вовсе, журнал — единственный источник.
// Тип цели — из target.url: поля target_type в ответе нет. Страницы перекрываются на одну запись (шаг limit-1).

import { Logger } from '../utils/logger'
import { shikiUserGet } from './shikimori-user'

/** Записей за страницу. Сервер отдаёт на одну больше — см. шапку файла. */
const PAGE_SIZE = 100

/** Потолок страниц: шесть тысяч событий больше любого живого списка, а страж — от вечного журнала. */
const MAX_PAGES = 60

const PAGE_PAUSE_MS = 300

const RATE_RETRIES = 3

const RATE_PAUSE_MS = 2000

/** Подписи, которыми кончают тайтл целиком. Сравниваются по началу строки: «Просмотрено и оценено на <b>7</b>» — тоже завершение. */
const END_WORDS = ['просмотрено', 'прочитано', 'пересмотрено', 'перечитано']

/**
 * Основы глаголов, по которым событие считается просмотром. Существительных («эпизод»,
 * «глава») здесь нет нарочно: по ним за просмотр сходило бы «Сброшено число эпизодов».
 */
const WATCH_WORDS = [
  'смотр', // Смотрю, Просмотрено, Просмотрен 7-й эпизод
  'сматр',
  'прочит', // Прочитано, Прочитана 3-я глава
  'читаю',
]

export interface HistoryDates {
  /** Самое раннее событие-просмотр, мс; null — просмотров не было. */
  start: number | null
  /** Самое позднее событие-завершение, мс; null — не завершали. */
  end: number | null
}

export interface HistoryRead {
  /** Ключ — `anime:57334` или `manga:20`; даты есть только у тронутых целей. */
  dates: Map<string, HistoryDates>
  rows: number
  pages: number
  /** Обход упёрся в потолок: часть журнала осталась непрочитанной. */
  truncated: boolean
}

interface HistoryReply {
  id?: number
  created_at?: string
  description?: string
  target?: {
    id?: number
    url?: string | null
  } | null
}

/** Разметку из подписи долой: «оценено на <b>7</b>» иначе не сравнить. */
function plain(description: string): string {
  return description
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Что это было. Три исхода, а не два: подпись может не говорить о просмотре, и тогда запись
 * пропускается молча. «Просмотрено» без числа — тайтл закрыт, «Просмотрено 7 эпизодов» — серия.
 */
function kindOf(description: string): 'start' | 'end' | null {
  const text = plain(description)
  if (text === '') return null

  const named = text.includes('эпизод') || text.includes('глав')
  if (!named && END_WORDS.some((word) => text.startsWith(word))) return 'end'

  return WATCH_WORDS.some((word) => text.includes(word)) ? 'start' : null
}

/** Тип цели по адресу карточки: `target_type` в ответе нет, а адрес различает аниме и мангу однозначно. */
function kindOfTarget(url: unknown): 'anime' | 'manga' | null {
  if (typeof url !== 'string') return null
  if (url.startsWith('/animes/')) return 'anime'
  if (url.startsWith('/mangas/')) return 'manga'

  return null
}

/** Миллисекунды из даты сервера. Нечитаемая дата даёт 0, а не «сейчас». */
function stampOf(value: unknown): number {
  if (typeof value !== 'string' || value === '') return 0

  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Читает журнал изменений и собирает даты начала и конца просмотра: начало — самое раннее
 * событие-просмотр, конец — самое позднее завершение. Ошибка чтения переносом не считается.
 */
export async function fetchShikiHistoryDates(
  userId: number,
  onPage?: (page: number) => void,
): Promise<HistoryRead> {
  const bounds = new Map<string, { start: number; end: number }>()
  const seen = new Set<number>()

  let rows = 0
  let pages = 0
  let truncated = true

  for (let page = 1; page <= MAX_PAGES; page++) {
    let reply: Awaited<ReturnType<typeof shikiUserGet<HistoryReply[]>>> | null = null

    for (let attempt = 0; attempt <= RATE_RETRIES; attempt++) {
      reply = await shikiUserGet<HistoryReply[]>(
        `/api/users/${userId}/history?limit=${PAGE_SIZE}&page=${page}`,
      )

      if (reply.status !== 429) break

      // Повтор без счётчика зациклился бы навсегда: сервер вправе держать паузу сколько угодно.
      Logger('WARN', `Шикимори: журнал, страница ${page} — 429, попытка ${attempt + 1}`)
      await sleep(RATE_PAUSE_MS)
    }

    if (reply === null) break

    if (reply.status === 403 || reply.status === 401) {
      Logger('WARN', 'Шикимори: журнал изменений закрыт для анонимного чтения')
      break
    }

    // Отказ на любой странице значит «дальше не пойдём»: прочитанное остаётся, перенос продолжается.
    if (!reply.ok) {
      Logger('WARN', `Шикимори: журнал, страница ${page} — отказ ${reply.status}`)
      break
    }

    const chunk = reply.data
    if (!Array.isArray(chunk) || chunk.length === 0) {
      truncated = false
      break
    }

    let fresh = 0

    for (const row of chunk) {
      const id = typeof row.id === 'number' ? row.id : 0
      if (id !== 0) {
        if (seen.has(id)) continue
        seen.add(id)
      }

      fresh++
      rows++

      const target = row.target
      if (target === null || target === undefined) continue

      const kind = kindOfTarget(target.url)
      const malId = typeof target.id === 'number' ? target.id : 0
      if (kind === null || malId <= 0) continue

      const what = kindOf(row.description ?? '')
      if (what === null) continue

      const at = stampOf(row.created_at)
      if (at === 0) continue

      const key = `${kind}:${malId}`
      const bound = bounds.get(key)

      if (bound === undefined) {
        bounds.set(key, { start: what === 'start' ? at : 0, end: what === 'end' ? at : 0 })
        continue
      }

      if (what === 'start') bound.start = bound.start === 0 ? at : Math.min(bound.start, at)
      else bound.end = Math.max(bound.end, at)
    }

    pages = page

    // Страница целиком из уже виденного значит, что обход вернулся на круг из-за перекрытия.
    if (fresh === 0) {
      truncated = false
      break
    }

    // Неполная страница — последняя: лишний запрос за пустотой ни к чему.
    if (chunk.length < PAGE_SIZE) {
      truncated = false
      break
    }

    onPage?.(page)
    await sleep(PAGE_PAUSE_MS)
  }

  const dates = new Map<string, HistoryDates>()
  for (const [key, bound] of bounds) {
    dates.set(key, {
      start: bound.start === 0 ? null : bound.start,
      end: bound.end === 0 ? null : bound.end,
    })
  }

  Logger(
    'API',
    `Шикимори: журнал прочитан — записей ${rows}, страниц ${pages}, ` +
      `целей с датами ${dates.size}${truncated ? ' (обход упёрся в потолок)' : ''}`,
  )

  return { dates, rows, pages, truncated }
}
