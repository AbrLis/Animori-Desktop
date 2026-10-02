// Список пользователя Шикимори: чтение по нику, без входа, вид записи как у anilist-list.ts.
// Входа нет сознательно: открытый профиль отдают любому. Номера переводим через MAL пачками по пятьдесят.

import { Logger } from '../utils/logger'
import type { RawListEntry } from './anilist-list'
import { fetchBriefsByMal } from './anilist-lookup'
import { fetchShikiHistoryDates } from './shikimori-history'
import { hiddenProfileMessage, shikiUserGet } from './shikimori-user'

/** Записей за страницу: тысяча укладывается в таймаут транспорта и покрывает почти любой живой список. */
const PAGE_SIZE = 1000

/** Потолок страниц: двадцать тысяч записей больше любого реального списка, а страж — от бесконечного обхода. */
const MAX_PAGES = 20

/** Сколько названий потерянных записей называть вслух. Дальше — только число. */
const LOST_NAMES = 8

export interface ShikiUser {
  id: number
  /** Ник в том виде, в каком его пишет сам Сайт, а не как набрал человек. */
  nick: string
}

export interface ShikiImport {
  user: ShikiUser
  entries: RawListEntry[]
  read: number
  matched: number
  lost: number
  lostTitles: string[]
  dated: number
}

/** Словарь, а не цепочка if: незнакомая закладка должна дать null, а не превратиться в «смотрю». */
const STATUS_MAP: Readonly<Record<string, string>> = {
  planned: 'PLANNING',
  watching: 'CURRENT',
  rewatching: 'REPEATING',
  completed: 'COMPLETED',
  on_hold: 'PAUSED',
  dropped: 'DROPPED',
}

interface UserReply {
  id?: number
  nickname?: string
}

interface RateReply {
  status?: string | null
  score?: number | null
  episodes?: number | null
  rewatches?: number | null
  text?: string | null
  created_at?: string | null
  updated_at?: string | null
  anime?: {
    id?: number
    name?: string | null
    russian?: string | null
  } | null
}

/** Целое неотрицательное или ноль: чужие пустоты не должны стать NaN. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** Строка или null: пустой комментарий равносилен отсутствию. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** Время правки в мс. Нечитаемая дата даёт ноль, а не сегодня: по метке слияние решает спор с местной правкой. */
function when(value: unknown): number {
  if (typeof value !== 'string' || value === '') return 0

  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

/** Ник без лишнего; ссылку целиком тоже принимаем — человек скорее скопирует адрес профиля. */
export function cleanNick(raw: string): string {
  const cut = raw.trim().replace(/\/+$/, '')
  if (cut === '') return ''

  const tail = cut.slice(cut.lastIndexOf('/') + 1)
  return tail.startsWith('@') ? tail.slice(1) : tail
}

/** Пользователь по нику: списки сервер отдаёт только по номеру, а ник меняется. Отказы разведены по кодам. */
export async function findShikiUser(nick: string): Promise<ShikiUser> {
  const wanted = cleanNick(nick)
  if (wanted === '') throw new Error('Ник не введён.')

  const path = `/api/users/${encodeURIComponent(wanted)}?is_nickname=1`
  const reply = await shikiUserGet<UserReply>(path)

  if (reply.status === 404) {
    throw new Error(`На Шикимори нет пользователя «${wanted}». Проверьте ник.`)
  }

  if (reply.status === 403 || reply.status === 401) {
    throw new Error(hiddenProfileMessage())
  }

  if (reply.status === 429) {
    throw new Error('Шикимори просит подождать: слишком много запросов. Повторите через минуту.')
  }

  const id = count(reply.data?.id)
  if (!reply.ok || id === 0) {
    throw new Error(`Шикимори ответил отказом (${reply.status}). Попробуйте позже.`)
  }

  return { id, nick: text(reply.data?.nickname) ?? wanted }
}

/** Все закладки аниме постранично. Пустая страница и 404 значат одно: страниц больше нет. */
async function readRates(userId: number): Promise<RateReply[]> {
  const all: RateReply[] = []

  for (let page = 1; page <= MAX_PAGES; page++) {
    const path = `/api/users/${userId}/anime_rates?limit=${PAGE_SIZE}&page=${page}`
    const reply = await shikiUserGet<RateReply[]>(path)

    if (reply.status === 403 || reply.status === 401) throw new Error(hiddenProfileMessage())

    if (reply.status === 429) {
      throw new Error(
        'Шикимори просит подождать: слишком много запросов. Повторите через минуту.',
      )
    }

    if (reply.status === 404) break

    if (!reply.ok) {
      // Неполный список человек примет за полный: отказ на любой странице — отказ переноса.
      throw new Error(`Шикимори ответил отказом (${reply.status}) на странице ${page}.`)
    }

    const chunk = reply.data
    if (!Array.isArray(chunk) || chunk.length === 0) break

    all.push(...chunk)
    Logger('API', `Шикимори: страница ${page}, записей ${chunk.length}`)

    // Неполная страница — последняя: лишний запрос за пустотой ни к чему.
    if (chunk.length < PAGE_SIZE) break
  }

  return all
}

/** Номер MAL из ответа: у Шикимори номер тайтла совпадает с номером MAL по устройству базы. */
function malIdOf(rate: RateReply): number {
  return count(rate.anime?.id)
}

function nameOf(rate: RateReply): string {
  return text(rate.anime?.russian) ?? text(rate.anime?.name) ?? `#${malIdOf(rate)}`
}

/** День события в виде ГГГГ-ММ-ДД. Считается по местным суткам: через toISOString() дата уехала бы в UTC. */
function dayOf(ms: number): string {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Читает список и переводит его в общий вид записи; в память ничего не кладёт. Дат в
 * закладках нет: они приезжают из журнала изменений, и время создания подставлять нельзя.
 */
export async function importShikiList(nick: string): Promise<ShikiImport> {
  const user = await findShikiUser(nick)
  const rates = await readRates(user.id)

  Logger('API', `Шикимори: список ${user.nick} прочитан, записей ${rates.length}`)

  // Журнал читается после списка, а не вровень: это второй поток запросов к тому же серверу.
  const history = await fetchShikiHistoryDates(user.id)

  // Страницы могут зайти внахлёст, если список правят во время обхода.
  const byMal = new Map<number, RateReply>()
  for (const rate of rates) {
    const malId = malIdOf(rate)
    if (malId === 0) continue

    const known = byMal.get(malId)
    if (!known || when(known.updated_at) <= when(rate.updated_at)) byMal.set(malId, rate)
  }

  const wanted = Array.from(byMal.keys())
  const briefs = wanted.length === 0 ? [] : await fetchBriefsByMal(wanted)

  const found = new Map<number, (typeof briefs)[number]>()
  for (const brief of briefs) if (brief.malId !== null) found.set(brief.malId, brief)

  const entries: RawListEntry[] = []
  const lostTitles: string[] = []
  let lost = 0
  let dated = 0

  for (const [malId, rate] of byMal) {
    const brief = found.get(malId)
    if (!brief) {
      // Тайтла нет у AniList либо связь с MAL там не записана. Молчать нельзя: разницу в числах видно.
      lost++
      if (lostTitles.length < LOST_NAMES) lostTitles.push(nameOf(rate))
      continue
    }

    const status = text(rate.status)
    const mapped = status === null ? null : (STATUS_MAP[status] ?? null)
    if (status !== null && mapped === null) {
      Logger('WARN', `Шикимори: незнакомая закладка «${status}» у ${nameOf(rate)}`)
    }

    // Время правки обязательно: по нему слияние решает, чья запись свежее.
    // Молчание сервера и о правке, и о создании = самая старая запись.
    const edited = when(rate.updated_at) || when(rate.created_at)

    // Даты из журнала. Пустое место остаётся пустым: у запланированного просмотров не было.
    const seen = history.dates.get(`anime:${malId}`)
    const startedAt = seen?.start == null ? null : dayOf(seen.start)
    const completedAt = seen?.end == null ? null : dayOf(seen.end)
    if (startedAt !== null || completedAt !== null) dated++

    entries.push({
      mediaId: brief.mediaId,
      malId,
      status: mapped,
      score: count(rate.score),
      progress: count(rate.episodes),
      repeat: count(rate.rewatches),
      startedAt,
      completedAt,
      notes: text(rate.text),
      updatedAt: edited,
      isAdult: brief.isAdult,
      romaji: brief.romaji,
      english: brief.english,
    })
  }

  Logger(
    'API',
    `Шикимори: привязано ${entries.length} из ${byMal.size}, без пары ${lost}, ` +
      `с датами ${dated}`,
  )

  return {
    user,
    entries,
    read: rates.length,
    matched: entries.length,
    lost,
    lostTitles,
    dated,
  }
}
