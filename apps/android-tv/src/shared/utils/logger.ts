// Ядро журнала: запись, кольцевой буфер, перехватчики ошибок. UI — через registerLogSink().
// ERROR вытесняется последним; настройки асинхронны, поэтому enableLogger не читается на уровне модуля.

import { settings } from '@/core/settings'

export type LogType = 'INFO' | 'WARN' | 'ERROR' | 'DB' | 'API'

export interface LogEntry {
  id: number
  time: string
  /** URL-контекст (window.location.pathname на момент записи). */
  path: string
  type: LogType | string
  message: string
  details: unknown
  stack: string
}

/** Ёмкость буфера в памяти (один на все виды записей). */
export const LOG_CAPACITY = 500

/** Сколько записей переживает переход между страницами (квота sessionStorage). */
const SESSION_KEEP = 200

const FLUSH_DELAY_MS = 1000

export let scriptLogs: LogEntry[] = []

let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushHooksInstalled = false

// Освобождает место под новую запись: вытесняет самую старую запись НЕ типа ERROR,
// а если ошибок больше нет — самую старую из них. Буфер не растёт ни при каких условиях.
function makeRoom(): void {
  while (scriptLogs.length >= LOG_CAPACITY) {
    const victim = scriptLogs.findIndex((x) => x.type !== 'ERROR')
    scriptLogs.splice(victim >= 0 ? victim : 0, 1)
  }
}

function flushSessionLogs(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  try {
    sessionStorage.setItem('animori_logs', JSON.stringify(scriptLogs.slice(-SESSION_KEEP)))
  } catch {
    /* квота исчерпана — игнор */
  }
}

// Планирует запись; повторные вызовы в пределах окна ничего не стоят. При уходе
// со страницы хвост дописывается принудительно — иначе теряются последние секунды лога.
function scheduleSessionFlush(): void {
  if (!flushHooksInstalled) {
    flushHooksInstalled = true
    window.addEventListener('pagehide', flushSessionLogs)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushSessionLogs()
    })
  }
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushSessionLogs()
  }, FLUSH_DELAY_MS)
}

// Вызывается после загрузки настроек и только при включённом логгере. sessionStorage
// идёт мимо моста: это память вкладки, в WebView Tauri работает штатно. Хвост обрезается по LOG_CAPACITY.
function restoreSessionLogs(): void {
  try {
    const savedLogs = sessionStorage.getItem('animori_logs')
    if (savedLogs) {
      const parsed = JSON.parse(savedLogs) as LogEntry[]
      scriptLogs = parsed.slice(-LOG_CAPACITY)
    }
  } catch (e) {
    // Logger может быть не готов — прямой console.warn.
    console.warn('[AniMori] Не удалось восстановить логи сессии', e)
  }
}

/** Подписчик показа: получает каждую новую запись, пока открыт (один на всех). */
let logSink: ((entry: LogEntry) => void) | null = null

export function registerLogSink(sink: ((entry: LogEntry) => void) | null): void {
  logSink = sink
}

/** Накопленные записи: читателю нужна и предыстория, не только поток. */
export function readLogs(): ReadonlyArray<LogEntry> {
  return scriptLogs
}

export function clearLogs(): void {
  scriptLogs = []

  try {
    sessionStorage.removeItem('animori_logs')
  } catch {
    /* памяти вкладки может не быть — записи и так уже забыты */
  }
}

export function Logger(type: LogType | string, message: string, details: unknown = null): void {
  if (
    (globalThis as { __ANIMORI_LOGGER_ENABLED__?: boolean }).__ANIMORI_LOGGER_ENABLED__ === false
  ) {
    return
  }
  if (!settings.enableLogger) return

  let parsedDetails = details
  if (details instanceof Error) {
    parsedDetails = { name: details.name, message: details.message, stack: details.stack }
  }

  const d = new Date()
  const time = `${d.toLocaleTimeString('ru-RU', { hour12: false })}.${String(
    d.getMilliseconds(),
  ).padStart(3, '0')}`
  const path = window.location.pathname
  const stackLines =
    type === 'ERROR' || type === 'WARN' ? (new Error().stack ?? '').split('\n') : []
  const stack = stackLines.length > 2 ? stackLines.slice(2).join('\n') : ''

  const entry: LogEntry = {
    id: Date.now() + Math.random(),
    time,
    path,
    type,
    message,
    details: parsedDetails,
    stack,
  }

  makeRoom()
  scriptLogs.push(entry)

  scheduleSessionFlush()

  if (logSink) logSink(entry)
  if (type === 'ERROR') console.error(`[AniMori ERROR] ${message}`, details || '')
  else if (type === 'WARN') console.warn(`[AniMori WARN] ${message}`, details || '')
}

// Ставятся из start() в app/main.ts сразу после чтения настроек: импорт модуля
// сайд-эффектов не имеет, а до настроек неизвестно, включён ли журнал. Здесь же — восстановление прошлой сессии.
export function installGlobalErrorHandlers(): void {
  if (!settings.enableLogger) return

  restoreSessionLogs()

  window.addEventListener('error', (e: ErrorEvent) => {
    Logger('ERROR', `Uncaught Error: ${e.message}`, {
      file: e.filename,
      line: e.lineno,
      col: e.colno,
      stack: e.error?.stack,
    })
  })

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    Logger(
      'ERROR',
      `Unhandled Promise Rejection: ${e.reason}`,
      typeof e.reason === 'object' ? e.reason : { reason: e.reason },
    )
  })
}

/** Вызывает fn, логируя ошибки в Logger('ERROR'); при silent ошибка не пробрасывается. */
export async function safeCall<T>(
  fn: () => T | Promise<T>,
  context: string,
  { silent = false }: { silent?: boolean } = {},
): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e)
    Logger('ERROR', `Ошибка в ${context}: ${msg}`, e)
    if (!silent) throw e
    return undefined
  }
}
