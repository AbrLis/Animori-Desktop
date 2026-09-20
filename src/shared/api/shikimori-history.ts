// Даты просмотров из журнала изменений Shikimori.
//
// В закладках (`/api/users/:id/anime_rates`) дат нет вовсе — ни начала, ни
// конца, и это проверено и по REST, и по GraphQL. Единственное место, где
// время просмотра вообще существует, — журнал изменений
// `/api/users/:id/history`.
//
// ЖУРНАЛ — НЕ СПИСОК ПРОСМОТРОВ
//
// В нём лежат все правки подряд: «Добавлено в список», «Запланировано»,
// «Оценено на 7», «Изменена оценка», «Отложено», «Удалено из списка». На
// живом профиле просмотрами оказались 40 записей из 101. Что именно случилось,
// сказано только в подписи — русским текстом с разметкой, — и разбор подписи
// здесь неизбежен. Договор хрупкий, поэтому слова вынесены в константы ниже
// и разобраны по случаям в комментариях.
//
// ПОЛЯ target_type В ОТВЕТЕ НЕТ
//
// Проверено 09.2026 на 404 записях двух профилей, в том числе с фильтром
// `?target_type=Anime`: в записи только `id`, `created_at`, `description`
// и `target`. Тип цели приходится брать из `target.url` — `/animes/…` против
// `/mangas/…`. В скриптовой версии разбор начинался именно с `target_type`
// и потому не работал никогда: до подписей дело не доходило, функция
// возвращала пустую карту, и даты в записи приезжали только запасным путём.
//
// СТРАНИЦЫ ПЕРЕКРЫВАЮТСЯ
//
// Шаг обхода равен `limit - 1`: при `limit=100` страница отдаёт 101 запись,
// и последняя запись страницы — первая запись следующей. Складывать страницы
// подряд нельзя, поэтому виденное считается по `id`. Глубокие страницы
// отвечают `200` и пустым массивом, а не 404.

import { Logger } from '../utils/logger'
import { shikiUserGet } from './shikimori-user'

/** Записей за страницу. Сервер отдаёт на одну больше — см. шапку файла. */
const PAGE_SIZE = 100

/**
 * Потолок страниц. Шесть тысяч событий больше любого живого списка, а страж
 * нужен от другого: без него журнал, который сервер вздумает отдавать вечно,
 * повесит перенос насмерть.
 */
const MAX_PAGES = 60

/** Пауза между страницами: журнал читается потоком, а не по кнопке. */
const PAGE_PAUSE_MS = 300

/** Сколько раз переждать 429 на одной странице, прежде чем сдаться. */
const RATE_RETRIES = 3

/** Пауза при 429: сервер сам просит подождать. */
const RATE_PAUSE_MS = 2000

/**
 * Подписи, которыми кончают тайтл целиком. Сравниваются по началу строки,
 * а не на равенство: «Просмотрено и оценено на <b>7</b>» — тоже завершение,
 * а на равенстве оно уезжало в начало просмотра.
 */
const END_WORDS = ['просмотрено', 'прочитано', 'пересмотрено', 'перечитано']

/**
 * Основы глаголов, по которым событие считается просмотром: смотреть,
 * пересматривать, читать. Список шире, чем нужно сегодня, нарочно: подписи
 * сервер составляет сам и меняет их без спроса.
 *
 * Существительных здесь нет нарочно, хотя «эпизод» и «глава» стоят в подписи
 * у половины событий. По ним за просмотр сходило бы «Сброшено число эпизодов»:
 * счётчик серий сбросили, а запись получила бы дату начала. Живой журнал
 * (1458 записей, 26 образцов подписей) на существительных давал ровно один
 * промах, и это был он.
 */
const WATCH_WORDS = [
  'смотр', // Смотрю, Просмотрено, Просмотрен 7-й эпизод
  'сматр', // Пересматриваю
  'прочит', // Прочитано, Прочитана 3-я глава
  'читаю', // Читаю
]

/** Дата просмотра одной цели. */
export interface HistoryDates {
  /** Самое раннее событие-просмотр, миллисекунды. null — просмотров не было. */
  start: number | null
  /** Самое позднее событие-завершение, миллисекунды. null — не завершали. */
  end: number | null
}

/** Итог чтения журнала: карта дат и то, чем обход кончился. */
export interface HistoryRead {
  /** Ключ — `anime:57334` или `manga:20`. Даты есть только у тронутых целей. */
  dates: Map<string, HistoryDates>
  /** Сколько записей журнала разобрано. */
  rows: number
  /** Сколько страниц прочитано. */
  pages: number
  /** Обход упёрся в потолок: часть журнала осталась непрочитанной. */
  truncated: boolean
}

/** Запись журнала в том виде, в каком её отдаёт сервер. */
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
 * Что это было. Три исхода, а не два: подпись может не говорить о просмотре
 * вовсе, и тогда запись пропускается молча — это оценка, закладка или снятие.
 *
 * Завершение отличается от просмотра серии по упоминанию серии: «Просмотрено»
 * без числа — тайтл закрыт целиком, «Просмотрено 7 эпизодов» — серия седьмая
 * и никакого завершения. Одного начала строки для этого мало.
 */
function kindOf(description: string): 'start' | 'end' | null {
  const text = plain(description)
  if (text === '') return null

  const named = text.includes('эпизод') || text.includes('глав')
  if (!named && END_WORDS.some((word) => text.startsWith(word))) return 'end'

  return WATCH_WORDS.some((word) => text.includes(word)) ? 'start' : null
}

/**
 * Тип цели по адресу карточки. `target_type` в ответе нет (см. шапку файла),
 * а адрес есть всегда и различает аниме и мангу однозначно.
 */
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

/** Пауза. Отдельной функцией: её зовут из двух мест и по разным поводам. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Читает журнал изменений и собирает из него даты начала и конца просмотра.
 *
 * Начало — самое РАННЕЕ событие-просмотр, конец — самое ПОЗДНЕЕ событие
 * завершения. Так «смотрю» через год после первой серии не сдвинет начало,
 * а пересмотр не перепишет конец задним числом.
 *
 * Ошибка чтения журнала переносом не считается: даты — добавка к списку,
 * а не сам список. Неудача возвращает то, что успели прочитать, и попадает
 * в журнал окна.
 *
 * @param userId Номер пользователя: ник меняется, номер нет.
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

      // Повтор без счётчика зациклился бы навсегда: сервер вправе держать
      // паузу сколько угодно, а перенос обязан кончиться.
      Logger('WARN', `Шикимори: журнал, страница ${page} — 429, попытка ${attempt + 1}`)
      await sleep(RATE_PAUSE_MS)
    }

    if (reply === null) break

    if (reply.status === 403 || reply.status === 401) {
      Logger('WARN', 'Шикимори: журнал изменений закрыт для анонимного чтения')
      break
    }

    // Отказ на любой странице значит «дальше не пойдём», а не «даты не нужны»:
    // прочитанное остаётся, перенос продолжается.
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

    // Страница целиком из уже виденного значит, что обход вернулся на круг:
    // перекрытие делает последнюю запись страницы первой записью следующей.
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
