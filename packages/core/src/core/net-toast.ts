// Тексты тостов о сети: сухие строки для человека. Код, причина, совет — в этом порядке,
// потому что читают именно так: что случилось, почему, что делать. Логика живёт здесь,
// а не в компоненте: одинаково нужна обеим платформам, и её можно проверить.

import type { NetSourceHealth } from './net-health'

/** Готовая строка тоста: всё, что нужно показать, и ничего лишнего. */
export interface NetToast {
  /** Идентификатор источника — по нему тост узнаётся и не дублируется. */
  id: string
  /** Название источника для человека: «AniList», «Шикимори (shikimori.rip)». */
  label: string
  /** Что именно отказало: код ответа или вид сбоя. */
  code: string
  /** Почему отказало, одной строкой. */
  cause: string
  /** Что делать человеку. Пусто быть не может: без совета тост бесполезен. */
  advice: string
}

/** Что отказало: сетевой сбой или код ответа. Разбор идёт по строке из учёта. */
type ToastKey = 'network' | 'timeout' | '403' | '451' | 'http'

/** Причина и совет по тому, что отказало. Порядок полей — порядок чтения. */
const TEXT: Record<ToastKey, { cause: string; advice: string }> = {
  network: { cause: 'нет связи', advice: 'проверьте интернет или включите VPN' },
  timeout: { cause: 'не ответил вовремя', advice: 'повторите позже или включите VPN' },
  403: { cause: 'отказал в доступе', advice: 'включите VPN: сервис не пускает' },
  451: { cause: 'доступ ограничен', advice: 'регион закрыт: нужен VPN' },
  http: { cause: 'ошибка на стороне сервиса', advice: 'попробуйте позже' },
}

/** Ключ и код по строке из учёта: «HTTP 503» даёт общий совет и сам код «HTTP 503», а не «HTTP http»:
 * терять показываемый код нельзя, по нему ищут причину. */
function read(detail: string): { key: ToastKey; code: string } {
  const status = /^HTTP (\d+)$/.exec(detail)?.[1]
  if (status === '403' || status === '451') return { key: status, code: `HTTP ${status}` }
  if (detail === 'network' || detail === 'timeout') return { key: detail, code: detail }
  return { key: 'http', code: status ? `HTTP ${status}` : 'HTTP' }
}

/** Строка тоста для источника. `null` — показывать нечего: здоров он или отказал один раз. */
export function toastFor(record: NetSourceHealth): NetToast | null {
  if (record.state === 'ok' || record.state === 'unknown') return null

  const { key, code } = read(record.lastDetail ?? '')
  const text = TEXT[key]

  return { id: record.id, label: record.label, code, cause: text.cause, advice: text.advice }
}

/** Тост одной строкой: источник, код, причина, совет. Разделитель — точка, как в журнале. */
export function toastLine(toast: NetToast): string {
  return `${toast.label}: ${toast.code} — ${toast.cause}. ${toast.advice}.`
}

/** Сколько плашек держим на экране: больше трёх читать уже невозможно. */
export const MAX_TOASTS = 3

/** Плашки из снимка учёта: только те, чего ещё не показывали. Повтор отвала плашкой не идёт —
 * иначе экран мигал бы каждые полминуты. */
export function pickToasts(rows: readonly NetSourceHealth[], shown: readonly string[]): NetToast[] {
  return rows.map(toastFor).filter((t): t is NetToast => t !== null && !shown.includes(t.id))
}
