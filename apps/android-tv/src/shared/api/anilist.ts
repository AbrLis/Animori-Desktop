// Клиент AniList GraphQL: пауза по лимиту, разбор ответов и отступ, переживающий перезапуск.
// Тормоз здесь, а не в очереди: только клиент видит все запросы к AniList сразу.

import { Bridge, BridgeHttpError, type HttpResponse } from '@/bridge'
import { reportError, reportStatus } from '../core/net-health'
import { Logger } from '../utils/logger'
import { anilistLimiter, MAX_RATE_RETRIES } from './rate-limit'

export const NET_SOURCE_ANILIST = 'anilist:graphql'
export const NET_LABEL_ANILIST = 'AniList API'

const DEFAULT_RETRY_MS = 5000

/** Первая пауза после отказа сервера и потолок роста: каждый следующий отказ удваивает её. */
const SERVER_FAIL_PAUSE_MS = 30000
const SERVER_FAIL_MAX_PAUSE_MS = 900000

/** Короткую паузу пережидаем внутри запроса; длинную нельзя — висящее обещание выглядит зависанием. */
const MAX_INLINE_WAIT_MS = 10000

/** Ключ хранилища для токена. Имя менять нельзя: прежние записи перестанут читаться. */
const TOKEN_KEY = 'AL_TOKEN'

/** Ключи хранилища для отступа: до какого времени молчим и глубина отступа. */
const PAUSE_KEY = 'AL_PAUSE_UNTIL'
const STREAK_KEY = 'AL_FAIL_STREAK'

let alRateLimitPause = 0

let serverFailStreak = 0

let alTokenCache = ''

/** Есть ли пропуск у самой оболочки: в десктопе токен лежит в Rust и разметке не виден. */
let shellSigned = false

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isAniListRateLimited(): boolean {
  return Date.now() < alRateLimitPause
}

export function anilistPauseRemaining(): number {
  return Math.max(0, alRateLimitPause - Date.now())
}

/** Число из хранилища: там может оказаться строка или мусор. */
function numberFrom(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value

  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }

  return 0
}

/** Пишет отступ в хранилище и никогда не отклоняется. Пара ключей пишется целиком: порознь они бессмысленны. */
function rememberBackOff(): void {
  void Bridge.storage.set(PAUSE_KEY, alRateLimitPause).catch((e: unknown) => {
    Logger('ERROR', 'Ошибка записи AL_PAUSE_UNTIL', e)
  })
  void Bridge.storage.set(STREAK_KEY, serverFailStreak).catch((e: unknown) => {
    Logger('ERROR', 'Ошибка записи AL_FAIL_STREAK', e)
  })
}

/** Отступ после запуска: пауза и глубина вместе. Остаток обрезается потолком — переведённые часы заперли бы программу. */
export async function restoreAniListPause(): Promise<void> {
  try {
    const [storedPause, storedStreak] = await Promise.all([
      Bridge.storage.get<unknown>(PAUSE_KEY, 0),
      Bridge.storage.get<unknown>(STREAK_KEY, 0),
    ])

    const until = numberFrom(storedPause)
    const remaining = until - Date.now()

    if (remaining <= 0) {
      if (until !== 0 || numberFrom(storedStreak) !== 0) {
        alRateLimitPause = 0
        serverFailStreak = 0
        rememberBackOff()
      }
      return
    }

    const capped = Math.min(remaining, SERVER_FAIL_MAX_PAUSE_MS)
    serverFailStreak = Math.max(0, Math.floor(numberFrom(storedStreak)))
    alRateLimitPause = Date.now() + capped
    anilistLimiter.pause(capped)

    Logger(
      'INFO',
      `AniList: отступ восстановлен, молчим ещё ${Math.round(capped / 1000)}с ` +
        `(отказов подряд до перезапуска: ${serverFailStreak})`,
    )
  } catch (e) {
    Logger('ERROR', 'Ошибка чтения отступа AniList', e)
  }
}

/** Ставит паузу вручную. Существующая более долгая пауза не укорачивается. */
export function pauseAniList(ms: number): void {
  alRateLimitPause = Math.max(alRateLimitPause, Date.now() + ms)
  anilistLimiter.pause(ms)
  rememberBackOff()
}

export interface GraphQLResponse<T = unknown> {
  data?: T
  errors?: unknown
}

/** Читает токен в память и восстанавливает отступ; зовётся один раз на старте. */
export async function loadAlToken(): Promise<void> {
  try {
    const stored = await Bridge.storage.get<unknown>(TOKEN_KEY, '')
    alTokenCache = typeof stored === 'string' ? stored : ''
  } catch (e) {
    Logger('ERROR', 'Ошибка чтения AL_TOKEN', e)
    alTokenCache = ''
  }

  await restoreAniListPause()
}

export function setAlToken(token: string): void {
  alTokenCache = token
  void Bridge.storage.set(TOKEN_KEY, token).catch((e: unknown) => {
    Logger('ERROR', 'Ошибка записи AL_TOKEN', e)
  })
}

export function getAlToken(): string | null {
  return alTokenCache || null
}

/** Пропуск есть ли у оболочки; сам токен сюда не передаётся: он в разметке появляться не должен. */
export function setShellSigned(value: boolean): void {
  if (shellSigned === value) return

  shellSigned = value
  Logger('INFO', `AniList: пропуск в оболочке ${value ? 'есть' : 'снят'}`)
}

/** Есть ли чем подписать запрос: пропуск оболочки или токен из настроек. */
export function canSignAniList(): boolean {
  return shellSigned || getAlToken() !== null
}

/** Значение заголовка в любом регистре: мост в Rust имена понижает. */
function header(headers: Record<string, string>, name: string): string {
  const direct = headers[name]
  if (direct !== undefined) return direct

  const found = Object.keys(headers).find((key) => key.toLowerCase() === name)
  return found ? (headers[found] ?? '') : ''
}

function headerNumber(headers: Record<string, string>, name: string): number {
  const raw = header(headers, name)
  return raw ? parseInt(raw, 10) : NaN
}

/** Заголовки, по которым разбирают отказ: 403 у AniList двусмыслен — это и выключенный API, и защита. */
const FAILURE_HEADERS: readonly string[] = [
  'cf-ray',
  'cf-mitigated',
  'cf-cache-status',
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'server',
]

/** Выписка пришедших заголовков отказа; отсутствующие не перечисляются. */
function failureDetails(headers: Record<string, string>): Record<string, string> {
  const details: Record<string, string> = {}

  for (const name of FAILURE_HEADERS) {
    const value = header(headers, name)
    if (value !== '') details[name] = value
  }

  return details
}

/**
 * Когда сбрасывается окно лимита, в мс Unix-времени: заголовок приходит и полным
 * временем в секундах, и остатком секунд — число меньше миллиарда и есть остаток.
 */
function readResetAt(headers: Record<string, string>): number {
  const reset = headerNumber(headers, 'x-ratelimit-reset')
  if (!Number.isFinite(reset) || reset <= 0) return NaN

  return reset > 1e9 ? reset * 1000 : Date.now() + reset * 1000
}

/** Темп ведётся по остатку, а не по потолку: остаток учитывает уже потраченное и тянется до сброса. */
function learnRateHeaders(headers: Record<string, string>): void {
  const limit = headerNumber(headers, 'x-ratelimit-limit')
  if (Number.isFinite(limit) && limit > 0) anilistLimiter.applyCeiling(limit)

  const remaining = headerNumber(headers, 'x-ratelimit-remaining')
  if (!Number.isFinite(remaining)) return

  const resetAt = readResetAt(headers)

  if (remaining > 0) {
    if (Number.isFinite(resetAt)) anilistLimiter.applyRemaining(remaining, resetAt)
    return
  }

  // Окно выбрано до конца: ждём сброса, не дожидаясь 429.
  const untilReset = Number.isFinite(resetAt) ? resetAt - Date.now() : NaN
  const wait = Number.isFinite(untilReset) && untilReset > 0 ? untilReset : DEFAULT_RETRY_MS
  anilistLimiter.pause(Math.min(wait + 500, 60000))
}

/** retry-after приходит и числом секунд, и датой по HTTP: разбирать надо оба вида. */
function readRetryAfter(headers: Record<string, string>): number {
  const raw = header(headers, 'retry-after').trim()
  if (raw === '') return DEFAULT_RETRY_MS

  // Number, а не parseInt: «120abc» — мусор, а не срок.
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000

  const until = Date.parse(raw)
  if (Number.isFinite(until)) {
    const wait = until - Date.now()
    // Срок прошёл, но не идём в тот же миг: часы у нас и у сервера расходятся.
    return wait > 0 ? wait : DEFAULT_RETRY_MS
  }

  return DEFAULT_RETRY_MS
}

/** Отказ сервера, после которого надо отступить. 403 включён: им AniList отвечал, когда выключал API. */
function isServerFailure(status: number): boolean {
  return status === 403 || status === 408 || status >= 500
}

/** Ставит растущую паузу после отказа сервера. В журнал идёт только вход в отступ: иначе отказы вытесняют всё. */
function backOffAfterServerFailure(status: number): number {
  const wasIdle = !isAniListRateLimited()

  serverFailStreak++
  const pause = Math.min(
    SERVER_FAIL_PAUSE_MS * Math.pow(2, serverFailStreak - 1),
    SERVER_FAIL_MAX_PAUSE_MS,
  )
  pauseAniList(pause)

  if (wasIdle) {
    Logger(
      'ERROR',
      `AniList отвечает ${status}: запросы приостановлены на ${Math.round(pause / 1000)}с ` +
        `(отказов подряд: ${serverFailStreak})`,
    )
  }

  return pause
}

/**
 * GraphQL-запрос с паузой после 429 и ограниченным числом повторов. Без пропуска
 * просьба понижается до публичной: работа без входа важнее полей, доступных только хозяину.
 */
export async function anilistQuery<T = unknown>(
  query: string,
  variables: Record<string, unknown>,
  useAuth = false,
  attempt = 0,
): Promise<GraphQLResponse<T>> {
  const remaining = anilistPauseRemaining()
  if (remaining > 0) {
    if (remaining > MAX_INLINE_WAIT_MS) {
      throw new Error(`AniList недоступен, повтор через ${Math.ceil(remaining / 1000)}с`)
    }
    await sleep(remaining + Math.floor(Math.random() * 500))
  }

  // Подписать нечем — мост отказывает целиком, поэтому просьба понижается до публичной.
  const signed = useAuth && canSignAniList()
  if (useAuth && !signed) {
    Logger('API', 'AniList: вход не выполнен, запрос идёт без подписи')
  }

  Logger('API', 'GraphQL запрос (AniList)', {
    query: query.substring(0, 100) + '...',
    variables,
    useAuth: signed,
  })

  await anilistLimiter.acquireSlot()

  const startTime = performance.now()
  const startedAt = Date.now()

  let res: HttpResponse
  try {
    // Адрес, заголовки и пропуск — забота моста: в десктопе запрос идёт из Rust.
    res = await Bridge.anilist.query(JSON.stringify({ query, variables }), signed)
  } catch (e) {
    // Отказ самого моста, а не сети: паузу ставить нельзя — она глушит и публичные запросы.
    if (!(e instanceof BridgeHttpError)) {
      Logger('ERROR', 'AniList: мост отклонил запрос', e)
      throw e instanceof Error ? e : new Error(String(e))
    }

    // Сеть упала — тот же отступ, иначе очередь крутит пачки вхолостую.
    reportError(NET_SOURCE_ANILIST, NET_LABEL_ANILIST, e, Date.now() - startedAt)
    backOffAfterServerFailure(0)
    Logger('ERROR', 'AniList Network Error', e)
    throw new Error('AniList Network Error')
  }

  reportStatus(NET_SOURCE_ANILIST, NET_LABEL_ANILIST, res.status, Date.now() - startedAt)

  learnRateHeaders(res.headers)

  if (res.status === 429) {
    const waitTime = readRetryAfter(res.headers)

    // Пауза через общий вход: он же кладёт её в хранилище, чтобы перезапуск не начинал с чистого листа.
    pauseAniList(waitTime + 500)

    anilistLimiter.reduceCeiling()

    // Пауза ставится даже при исчерпанных повторах: остальные вызовы не должны добивать сервер.
    if (attempt >= MAX_RATE_RETRIES) {
      Logger('ERROR', `AniList Rate Limit 429: повторы исчерпаны (${MAX_RATE_RETRIES})`, res)
      throw new Error('AniList Rate Limit: повторы исчерпаны')
    }

    // Срок длиннее порога — не высиживаем внутри вызова: пауза уже стоит.
    if (waitTime > MAX_INLINE_WAIT_MS) {
      const seconds = Math.ceil(waitTime / 1000)
      Logger('ERROR', `AniList Rate Limit 429: сервер назвал ${seconds}с — ждём вне запроса`, res)
      throw new Error(`AniList Rate Limit: повтор через ${seconds}с`)
    }

    Logger(
      'ERROR',
      `AniList Rate Limit 429! Ожидание ${waitTime}ms (повтор ${attempt + 1} из ${MAX_RATE_RETRIES})`,
      res,
    )
    await sleep(waitTime + 500 + Math.floor(Math.random() * 500))
    return anilistQuery<T>(query, variables, useAuth, attempt + 1)
  }

  if (res.status !== 200) {
    // Сервер лежит или закрылся — отступаем, а не пробуем снова через полсекунды.
    if (isServerFailure(res.status)) {
      // Выписка при каждом отказе: различия между ними и говорят, что происходит.
      Logger('ERROR', `AniList ${res.status}: заголовки отказа`, failureDetails(res.headers))

      const pause = backOffAfterServerFailure(res.status)
      throw new Error(`AniList недоступен (${res.status}), пауза ${Math.round(pause / 1000)}с`)
    }

    Logger('ERROR', `AniList API Error HTTP ${res.status}`, res.text)
    throw new Error(`Error ${res.status}`)
  }

  // Успех обнуляет серию отказов, и запись в хранилище обновляется тут же:
  // иначе завтрашний запуск отступил бы от вчерашней аварии.
  if (serverFailStreak > 0) {
    Logger('INFO', `AniList снова отвечает (отказов подряд было: ${serverFailStreak})`)
    serverFailStreak = 0
    rememberBackOff()
  }

  const timeTaken = Math.round(performance.now() - startTime)
  Logger('API', `[DONE] GraphQL запрос (AniList) выполнен за ${timeTaken}ms`)

  let payload: GraphQLResponse<T>
  try {
    payload = JSON.parse(res.text) as GraphQLResponse<T>
  } catch (e) {
    Logger('ERROR', 'AniList: не удалось разобрать ответ', e)
    throw new Error('AniList: некорректный ответ сервера')
  }

  if (payload.errors) {
    const message = JSON.stringify(payload.errors)
    Logger('ERROR', 'AniList GraphQL Error', payload.errors)
    throw new Error(`AniList GraphQL Error: ${message}`)
  }

  return payload
}
