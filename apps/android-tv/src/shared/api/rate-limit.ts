// Общий ограничитель темпа: один на источник (лимит считается по IP), выдаёт разрешение и держит паузу.
// once() склеивает одинаковые вопросы; темп — по остатку окна, а общий шлюз разводит старты в первые секунды.

/** Потолок повторов после 429: всё, что дольше одного, держит пауза, а не череда попыток. */
export const MAX_RATE_RETRIES = 1

/** Единый режим темпа: пять запросов в секунду и шестьдесят в минуту — ниже потолков Shikimori (5/сек, 90/мин). */
export const API_MIN_INTERVAL_MS = 300
export const API_WINDOW_MS = 60000
export const API_MAX_PER_WINDOW = 60

/** Начало и предохранитель для AniList: настоящий потолок придёт в заголовках; сейчас сервис отдаёт 30 вместо штатных 90. */
export const ANILIST_START_PER_WINDOW = 30
export const ANILIST_MAX_PER_WINDOW = 90

/** Ниже этого потолок не урезается: иначе серия 429 остановила бы работу вовсе. */
export const RATE_FLOOR_PER_WINDOW = 6

/** На сколько закрывается рост потолка после урезания: ответ во время техработ может назвать прежний потолок и тут же ответить 429. */
export const CEILING_RECOVERY_MS = 300000

/** Окно учёта общего залпа. Секунда — то, чем мерят частоту чужие лимиты. */
export const BURST_WINDOW_MS = 1000

/** Три на старте — замер: холодный запуск отправлял одиннадцать запросов в первую секунду. */
export const BURST_START_LIMIT = 3
export const BURST_LIMIT = 8

/** Сколько держится строгий стартовый режим. Считается от загрузки модуля. */
export const STARTUP_WINDOW_MS = 10000

/** Отказ по исчерпанию повторов на 429. Отдельный тип, чтобы перебор зеркал не проглотил его своим catch. */
export class RateLimitError extends Error {
  constructor(source: string, target: string) {
    super(`${source}: лимит запросов не отпустил, повторов было ${MAX_RATE_RETRIES} (${target})`)
    this.name = 'RateLimitError'
  }
}

/** Незавершённые вопросы по ключу. Приведение к типу делается в once(). */
const inFlight = new Map<string, Promise<unknown>>()

/** Ключ задаёт вызывающий — он один знает, что считать «тем же вопросом». Отказ склеивается с успехом. */
export function once<T>(key: string, task: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key)
  if (running !== undefined) return running as Promise<T>

  let started: Promise<T>
  try {
    started = task()
  } catch (e) {
    // Задача, упавшая до первого ожидания, ключ за собой не запирает.
    return Promise.reject(e)
  }

  const guarded: Promise<T> = started.finally(() => {
    // Сравнение обязательно: в карте мог оказаться уже другой, более свежий поход с тем же ключом.
    if (inFlight.get(key) === guarded) inFlight.delete(key)
  })

  inFlight.set(key, guarded)
  return guarded
}

export function inFlightCount(): number {
  return inFlight.size
}

/** Когда загрузился модуль: отсюда считается строгий стартовый режим залпа. */
const bootedAt = Date.now()

const burstSends: number[] = []

function burstLimit(now: number): number {
  return now - bootedAt < STARTUP_WINDOW_MS ? BURST_START_LIMIT : BURST_LIMIT
}

function trimBurst(now: number): void {
  while (burstSends.length > 0 && now - (burstSends[0] ?? 0) >= BURST_WINDOW_MS) {
    burstSends.shift()
  }
}

/** Сколько ждать, чтобы не превысить общий залп; ноль — можно идти. Десять миллисекунд — от дребезга на границе окна. */
function burstWait(now: number): number {
  trimBurst(now)

  if (burstSends.length < burstLimit(now)) return 0

  const oldest = burstSends[0] ?? now
  return Math.max(1, BURST_WINDOW_MS - (now - oldest) + 10)
}

function noteBurst(at: number): void {
  burstSends.push(at)
}

export function globalBurstCount(): number {
  const now = Date.now()
  trimBurst(now)
  return burstSends.length
}

export function inStartupWindow(): boolean {
  return Date.now() - bootedAt < STARTUP_WINDOW_MS
}

export interface RateLimiterOptions {
  name: string
  minIntervalMs: number
  windowMs: number
  maxPerWindow: number
  /** Предохранитель: выше этого не подниматься, что бы ни сказал сервер. */
  maxCeiling?: number
  /** Считать интервал от потолка, а не брать из minIntervalMs. */
  deriveInterval?: boolean
}

/** Снимок состояния одного источника: читатель бюджета на экране журнала (#/log). */
export interface RateLimiterStats {
  name: string
  inWindow: number
  ceiling: number
  remaining: number
  windowMs: number
  intervalMs: number
  pauseRemaining: number
  sentTotal: number
  lastSentAt: number
  /**
   * Промежуток по остатку окна из заголовков; ноль — сервер про остаток молчал.
   * В журнале по нему видна разница между нашим расчётом и чужим требованием.
   */
  pacedIntervalMs: number
}

export interface RateLimiter {
  readonly name: string
  acquireSlot: () => Promise<void>
  /** Паузы не сокращаются, только продлеваются. */
  pause: (ms: number) => void
  isPaused: () => boolean
  pauseRemaining: () => number
  /** Потолок из заголовков ответа: выше предохранителя обрезается, во время восстановления рост игнорируется. */
  applyCeiling: (limit: number) => void
  /** Остаток окна и время сброса (Unix-время в мс): растягивает оставшиеся запросы до конца окна. */
  applyRemaining: (remaining: number, resetAt: number) => void
  /** Урезает потолок вдвое после 429 и закрывает его рост на время восстановления. */
  reduceCeiling: () => void
  /** Снимок состояния, только чтение. */
  stats: () => RateLimiterStats
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Перечень созданных ограничителей в порядке появления: по нему строится сводка бюджета. */
const allLimiters: RateLimiter[] = []

/** Снимок по всем источникам сразу. Порядок — как создавались. */
export function collectRateStats(): RateLimiterStats[] {
  return allLimiters.map((limiter) => limiter.stats())
}

/** Создаёт независимый ограничитель темпа для одного источника. */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { name, minIntervalMs, windowMs, maxPerWindow, maxCeiling, deriveInterval } = options

  const hardMax = Math.max(maxPerWindow, maxCeiling ?? maxPerWindow)

  let ceiling = maxPerWindow
  let ceilingLockedUntil = 0
  let pausedUntil = 0
  let lastSentAt = 0
  let sentTotal = 0
  let pacedIntervalMs = 0
  let pacedUntil = 0
  const recentSends: number[] = []
  /** Очередь ожидающих: без шлюза два параллельных вызова займут один слот. Ответа не ждём. */
  let gate: Promise<void> = Promise.resolve()

  /** Промежуток от потолка: размазывает разрешённое число запросов по окну. */
  function derivedInterval(): number {
    if (!deriveInterval) return minIntervalMs
    return Math.max(minIntervalMs, Math.ceil(windowMs / Math.max(1, ceiling)))
  }

  /**
   * Из двух расчётов берётся более осторожный. Последний названный брать нельзя:
   * ответ с большим остатком разрешил бы идти почти без промежутка.
   */
  function currentInterval(): number {
    const base = derivedInterval()
    if (pacedIntervalMs > 0 && Date.now() < pacedUntil) return Math.max(base, pacedIntervalMs)
    return base
  }

  /**
   * Сколько отметок попадает в окно. Считается заново, а не длиной массива:
   * чистка идёт только при выдаче слота, и в тишине там остаётся вчерашний хвост.
   */
  function countInWindow(now: number): number {
    let count = 0
    for (const at of recentSends) {
      if (now - at < windowMs) count++
    }
    return count
  }

  async function acquireSlot(): Promise<void> {
    const previous = gate
    let release: () => void = () => undefined
    gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous

    try {
      for (;;) {
        const now = Date.now()

        while (recentSends.length > 0 && now - (recentSends[0] ?? 0) >= windowMs) {
          recentSends.shift()
        }

        const waits: number[] = []
        const interval = currentInterval()
        const sinceLast = now - lastSentAt
        if (sinceLast < interval) waits.push(interval - sinceLast)
        if (now < pausedUntil) waits.push(pausedUntil - now)
        if (recentSends.length >= ceiling) {
          waits.push(windowMs - (now - (recentSends[0] ?? now)) + 50)
        }

        // Общий залп: свой бюджет может быть свободен, а квартира — уже шумной.
        const burst = burstWait(now)
        if (burst > 0) waits.push(burst)

        if (waits.length === 0) {
          lastSentAt = Date.now()
          recentSends.push(lastSentAt)
          noteBurst(lastSentAt)
          sentTotal++
          return
        }

        await sleep(Math.max(...waits))
      }
    } finally {
      release()
    }
  }

  const limiter: RateLimiter = {
    name,
    acquireSlot,
    pause(ms: number): void {
      pausedUntil = Math.max(pausedUntil, Date.now() + ms)
    },
    isPaused(): boolean {
      return Date.now() < pausedUntil
    },
    pauseRemaining(): number {
      return Math.max(0, pausedUntil - Date.now())
    },
    applyCeiling(limit: number): void {
      if (!Number.isFinite(limit) || limit <= 0) return

      const next = Math.min(Math.floor(limit), hardMax)
      if (next === ceiling) return

      if (next > ceiling && Date.now() < ceilingLockedUntil) return

      ceiling = Math.max(RATE_FLOOR_PER_WINDOW, next)
    },
    applyRemaining(remaining: number, resetAt: number): void {
      if (!Number.isFinite(remaining) || !Number.isFinite(resetAt)) return

      const now = Date.now()
      const span = resetAt - now

      // Сброс назван в прошлом: окно уже новое, и старый расчёт про него врёт.
      if (span <= 0) {
        pacedIntervalMs = 0
        pacedUntil = 0
        return
      }

      // Остаток исчерпан — это не темп, а пауза: делить нельзя ни на нуль, ни на единицу.
      if (remaining <= 0) return

      // Далёкий сброс — признак разошедшихся часов: горизонт ограничен двумя окнами учёта.
      const horizon = Math.min(span, windowMs * 2)
      const paced = Math.ceil(horizon / remaining)

      pacedIntervalMs = Math.min(paced, windowMs)
      pacedUntil = now + horizon
    },
    reduceCeiling(): void {
      ceiling = Math.max(RATE_FLOOR_PER_WINDOW, Math.floor(ceiling / 2))
      ceilingLockedUntil = Date.now() + CEILING_RECOVERY_MS
    },
    stats(): RateLimiterStats {
      const now = Date.now()
      const inWindow = countInWindow(now)
      const paced = pacedIntervalMs > 0 && now < pacedUntil ? pacedIntervalMs : 0

      return {
        name,
        inWindow,
        ceiling,
        remaining: Math.max(0, ceiling - inWindow),
        windowMs,
        intervalMs: currentInterval(),
        pauseRemaining: Math.max(0, pausedUntil - now),
        sentTotal,
        lastSentAt,
        pacedIntervalMs: paced,
      }
    },
  }

  allLimiters.push(limiter)

  return limiter
}

/** Общий для shikimori.ts и shikimori-people.ts; shikimori-user.ts идёт мимо — там единичные запросы по кнопке. */
export const shikiLimiter = createRateLimiter({
  name: 'Shikimori',
  minIntervalMs: API_MIN_INTERVAL_MS,
  windowMs: API_WINDOW_MS,
  maxPerWindow: API_MAX_PER_WINDOW,
})

/** Режим тот же, что у Shikimori: источники стоят в одной цепочке резолва названий, иначе фоллбэк обгоняет основной. */
export const anime365Limiter = createRateLimiter({
  name: 'anime365',
  minIntervalMs: API_MIN_INTERVAL_MS,
  windowMs: API_WINDOW_MS,
  maxPerWindow: API_MAX_PER_WINDOW,
})

/** Бюджет отдельный от Shikimori: другой сервис со своим счётом по IP. */
export const animeThemesLimiter = createRateLimiter({
  name: 'AnimeThemes',
  minIntervalMs: API_MIN_INTERVAL_MS,
  windowMs: API_WINDOW_MS,
  maxPerWindow: API_MAX_PER_WINDOW,
})

/** Единственный ограничитель с плавающим потолком: только AniList их присылает. */
export const anilistLimiter = createRateLimiter({
  name: 'AniList',
  minIntervalMs: 100,
  windowMs: API_WINDOW_MS,
  maxPerWindow: ANILIST_START_PER_WINDOW,
  maxCeiling: ANILIST_MAX_PER_WINDOW,
  deriveInterval: true,
})

/** Опись и файлы датасета названий: до трёх запросов на запуск. Отдельный источник — ради инварианта: слот берёт каждый сетевой вызов. */
export const githubLimiter = createRateLimiter({
  name: 'GitHub',
  minIntervalMs: API_MIN_INTERVAL_MS,
  windowMs: API_WINDOW_MS,
  maxPerWindow: API_MAX_PER_WINDOW,
})

/** Aniliberty: открытый API без ключа и объявленного потолка; темп держится из вежливости, а не по документу. */
export const anilibertyLimiter = createRateLimiter({
  name: 'Aniliberty',
  minIntervalMs: API_MIN_INTERVAL_MS,
  windowMs: API_WINDOW_MS,
  maxPerWindow: API_MAX_PER_WINDOW,
})

/** Ключ общий на всех: одна серия стоит трёх запросов подряд — поиск, страница серии и /ftor. */
export const kodikLimiter = createRateLimiter({
  name: 'Kodik',
  minIntervalMs: API_MIN_INTERVAL_MS,
  windowMs: API_WINDOW_MS,
  maxPerWindow: API_MAX_PER_WINDOW,
})
