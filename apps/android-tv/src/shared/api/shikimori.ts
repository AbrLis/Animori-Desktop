// Клиент Shikimori: карточки и GraphQL, перебор зеркал одной дорогой (askMirrors).
// Куки не шлём: 'include' давал 400 от размера заголовка. Рабочий адрес переживает перезапуск.

import { Bridge } from '@/bridge'
import { SHIKI_DOMAINS } from '../core/constants'
import {
  describeState,
  getHealth,
  isTroubled,
  registerProbe,
  reportError,
  reportStatus,
} from '../core/net-health'
import { Logger } from '../utils/logger'
import { MAX_RATE_RETRIES, RateLimitError, shikiLimiter } from './rate-limit'

const RATE_PAUSE_MS = 5000
/** Таймаут одного зеркала: дольше ждать нет смысла, лучше уйти на следующее. */
const MIRROR_TIMEOUT_MS = 5000
/** Таймаут GraphQL: одна пачка отвечает за пятьдесят тайтлов сразу, и пяти секунд ей коротко. */
const GRAPHQL_TIMEOUT_MS = 8000
const MIRROR_KEY = 'SHIKI_MIRROR'
/** Чем спрашиваем зеркало «ты живо?»: одна карточка — самый дешёвый ответ, проходящий весь путь. */
const PROBE_PATH = '/api/animes/1'

/** Зеркало, ответившее данными последним: пробуется первым и дублируется в хранилище. */
let preferredDomain: string | null = null

/** Однократное чтение хранилища: первые запросы уходят пачкой и должны дождаться одного чтения. */
let preferredReady: Promise<void> | null = null

/** Имя источника для учёта доступности зеркала: net-health по замыслу адресов не знает. */
function netId(domain: string): string {
  return `shikimori:${domain}`
}

/** Читает рабочее зеркало из хранилища один раз за сеанс; адрес сверяется со списком сборки. */
function loadPreferred(): Promise<void> {
  if (preferredReady) return preferredReady

  preferredReady = (async () => {
    try {
      const stored = await Bridge.storage.get<unknown>(MIRROR_KEY, '')
      const domain = typeof stored === 'string' ? stored : ''
      if (domain && SHIKI_DOMAINS.includes(domain)) {
        preferredDomain = domain
        Logger('API', `Shikimori: прошлый запуск ходил через ${domain}`)
      }
    } catch (e) {
      Logger('ERROR', 'Ошибка чтения рабочего зеркала Shikimori', e)
    }
  })()

  return preferredReady
}

/** Пишет рабочее зеркало или стирает память (пустая строка); ошибка записи запрос не валит. */
async function rememberPreferred(domain: string): Promise<void> {
  try {
    await Bridge.storage.set(MIRROR_KEY, domain)
  } catch (e) {
    Logger('ERROR', 'Ошибка записи рабочего зеркала Shikimori', e)
  }
}

/** Порядок перебора: предпочтённый адрес в начале. Исключать отпавшие нельзя — тайтл, удалённый на одном зеркале, жив на другом. */
function mirrorOrder(): string[] {
  const preferred = preferredDomain
  if (!preferred || !SHIKI_DOMAINS.includes(preferred)) return [...SHIKI_DOMAINS]
  return [preferred, ...SHIKI_DOMAINS.filter((d) => d !== preferred)]
}

/** Причина, по которой Shikimori бесполезен, или null. Сводится по И: пока отвечает хотя бы одно зеркало, данные будут. */
export function shikimoriTrouble(): string | null {
  let detail: string | null = null

  for (const domain of SHIKI_DOMAINS) {
    const id = netId(domain)
    if (!isTroubled(id)) return null
    if (detail === null) {
      const state = getHealth(id)?.state
      if (state) detail = describeState(state)
    }
  }

  return detail
}

function mirrorUrl(domain: string, path: string): string {
  return 'https://' + domain + path
}

export function isShikimoriRateLimited(): boolean {
  return shikiLimiter.isPaused()
}

export function pauseShikimori(ms: number): void {
  shikiLimiter.pause(ms)
}

export interface ShikiResponse<T = unknown> {
  /** null означает «не найдено» либо полный сбой всех зеркал. */
  data: T | null
  domain: string | null
}

/** Что именно отправляем на зеркало: путь всегда без домена. */
interface MirrorRequest {
  method: 'GET' | 'POST'
  path: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  /** Приписка к строке журнала: у GraphQL путь один на все запросы. */
  note?: string
}

/** Конверт ответа GraphQL. Ошибки при наличии данных — частичный ответ, а не сбой. */
interface GraphqlReply<T> {
  data?: T | null
  errors?: unknown
}

/**
 * Общий обход зеркал: слот темпа, отчёт о доступности, трактовка кодов, повтор по 429.
 * `read` обязан бросить исключение на негодном ответе: иначе обход уходит на зеркало дальше.
 */
async function askMirrors<T>(
  req: MirrorRequest,
  read: (text: string) => T,
  attempt: number,
): Promise<ShikiResponse<T>> {
  const tail = req.note ? ` — ${req.note}` : ''
  Logger('API', `Запрос к Shikimori API: ${req.path}${tail}`)

  // Память читается до построения порядка: иначе первый запрос сеанса пошёл бы по стартовому списку.
  await loadPreferred()

  let lastNotFound: ShikiResponse<T> | null = null
  let mirrorFailures = 0

  for (const domain of mirrorOrder()) {
    const startedAt = Date.now()

    try {
      // Слот перед каждой отправкой: зеркала делят один бюджет, а не имеют по своему.
      await shikiLimiter.acquireSlot()

      const r = await Bridge.http.request({
        method: req.method,
        url: mirrorUrl(domain, req.path),
        headers: req.headers,
        body: req.body,
        timeoutMs: req.timeoutMs ?? MIRROR_TIMEOUT_MS,
        credentials: 'omit',
      })

      // Отчёт до разбора кодов: net-health игнорирует 429 и трактует 404 как «связь есть».
      reportStatus(netId(domain), `Shikimori (${domain})`, r.status, Date.now() - startedAt)

      if (r.status === 429) {
        // Пауза ставится всегда: она притормозит и поиск персон, и очередь перевода.
        shikiLimiter.pause(RATE_PAUSE_MS)

        if (attempt + 1 >= MAX_RATE_RETRIES) {
          Logger('ERROR', `Shikimori: лимит 429 не отпустил, запрос отменён: ${req.path}`, {
            domain,
            attempts: attempt + 1,
          })
          throw new RateLimitError('Shikimori', req.path)
        }

        Logger(
          'WARN',
          `Shikimori 429 (${domain}): пауза ${RATE_PAUSE_MS}мс, ` +
            `повтор ${attempt + 2}/${MAX_RATE_RETRIES} — ${req.path}`,
        )
        return await askMirrors<T>(req, read, attempt + 1)
      }

      // 404 — возможно удалён по РКН: пробуем следующее зеркало. Предпочтённым такое не становится.
      if (r.status === 404) {
        lastNotFound = { data: null, domain }
        continue
      }

      if (r.status !== 200) {
        throw new Error(`Shikimori HTTP ${r.status}`)
      }

      const data = read(r.text)

      // Отметка ставится после разбора тела: битое тело — беда ответа, а не адреса.
      if (preferredDomain !== domain) {
        preferredDomain = domain
        void rememberPreferred(domain)
        Logger('API', `Shikimori: рабочее зеркало — ${domain}`)
      }

      return { data, domain }
    } catch (e) {
      // Исчерпание повторов по 429 — не сбой зеркала: бюджет у зеркал общий.
      if (e instanceof RateLimitError) throw e

      mirrorFailures++

      // Отметка снимается сразу и с диска: иначе каждый следующий запуск начинал бы с мёртвого адреса.
      if (preferredDomain === domain) {
        preferredDomain = null
        void rememberPreferred('')
        Logger('WARN', `Shikimori: зеркало ${domain} больше не предпочтительное`)
      }

      // reportError учитывает только транспорт и таймаут; ответ со статусом учтён выше.
      reportError(netId(domain), `Shikimori (${domain})`, e, Date.now() - startedAt)
      Logger('WARN', `Shikimori: зеркало ${domain} не ответило по ${req.path}`, e)
    }
  }

  if (lastNotFound) {
    // Для вызывающего это штатный исход, но в журнале он должен быть виден: перевод не появится.
    Logger('WARN', `Shikimori: данных нет ни на одном зеркале (404): ${req.path}`)
    return lastNotFound
  }

  Logger('ERROR', `Все зеркала Shikimori недоступны для ${req.path}`, { mirrorFailures })
  throw new Error(`Все зеркала Shikimori недоступны для ${req.path}`)
}

/** GET к Shikimori REST: путь вида `/api/animes/123`, без домена. Перебор зеркал и повтор при 429. */
export async function fetchShiki<T = unknown>(
  path: string,
  attempt = 0,
): Promise<ShikiResponse<T>> {
  return await askMirrors<T>({ method: 'GET', path }, (text) => JSON.parse(text) as T, attempt)
}

/**
 * POST в GraphQL с тем же перебором зеркал и бюджетом темпа; `note` идёт в журнал, путь один.
 * GraphQL почти всегда отвечает 200, поэтому негодный ответ распознаётся по пустому `data`.
 */
export async function fetchShikiGraphql<T = unknown>(
  query: string,
  variables: Record<string, unknown>,
  note?: string,
): Promise<ShikiResponse<T>> {
  return await askMirrors<T>(
    {
      method: 'POST',
      path: '/api/graphql',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
      timeoutMs: GRAPHQL_TIMEOUT_MS,
      note,
    },
    (text) => {
      const reply = JSON.parse(text) as GraphqlReply<T>
      if (reply.data === undefined || reply.data === null) {
        throw new Error('Shikimori GraphQL: ответ без данных')
      }
      return reply.data
    },
    0,
  )
}

/** Проба зеркала мимо askMirrors намеренно: обход отвечает «где взять данные», проба — «что с адресом». */
async function probeMirror(domain: string): Promise<void> {
  const startedAt = Date.now()
  const label = `Shikimori (${domain})`

  try {
    await shikiLimiter.acquireSlot()

    const r = await Bridge.http.request({
      method: 'GET',
      url: mirrorUrl(domain, PROBE_PATH),
      timeoutMs: MIRROR_TIMEOUT_MS,
      credentials: 'omit',
    })

    reportStatus(netId(domain), label, r.status, Date.now() - startedAt)
  } catch (e) {
    // Отчёт — весь смысл пробы: наружу исключение не отдаём, иначе прогон напишет вторую строку про то же.
    reportError(netId(domain), label, e, Date.now() - startedAt)
  }
}

// Регистрация при загрузке модуля: экраны больше не звонят зеркалам сами и не держат список адресов.
for (const domain of SHIKI_DOMAINS) {
  registerProbe(netId(domain), `Shikimori (${domain})`, () => probeMirror(domain))
}
