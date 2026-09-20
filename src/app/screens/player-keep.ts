// Что просмотр помнит между запусками: где остановились, что выбрали
// и что смотрели.
//
// Почему не поле в core/settings: настройку человек ставит руками и ждёт
// от неё постоянства, а метка просмотра пишется сама всю серию. В общем
// ключе одна неудачная запись уносила бы заодно и настройки.
//
// Почему одна запись на всё, а не ключ на серию: у хранилища каждое
// обращение идёт через мост, и полсотни ключей одного тайтла вылились бы
// в полсотни вызовов на один открытый плеер.
//
// Что сюда не попадает: громкость и скорость. Их меняют под одну серию
// и под одну комнату, и вернувшаяся через неделю двойная скорость читается
// поломкой, а не заботой.
//
// ИСТОРИЯ — НЕ МЕТКИ
//
// Метка отвечает на один вопрос: с какой секунды продолжать. Она живёт
// на каждую озвучку отдельно и умирает, когда серия досмотрена: возвращать
// человека на титры незачем. Истории нужен другой ответ — что смотрели,
// когда и сколько, — и потому она лежит отдельным списком, со своим
// потолком и своей жизнью.
//
// Ключ истории склеен из аниме и серии, без озвучки: человек смотрит серию,
// а не дорожку, и три озвучки одной серии стояли бы в списке тремя строками
// об одном и том же. Свежая запись затирает давнюю — вместе с озвучкой,
// по которой эту серию продолжат.
//
// Заголовок и обложка едут вместе с записью нарочно: экран истории обязан
// рисоваться до всякой сети, а к моменту просмотра и имя тайтла, и постер
// плееру уже известны.
//
// Номера аниме и серии в запись не передаются, а разбираются из ключа.
// Так запись истории всегда говорит о той серии, за которую её позвали:
// метку пишут и тогда, когда выбор на экране уже уехал дальше, — при смене
// озвучки и при уходе с экрана.
import { Bridge } from '@/bridge'
import { Logger } from '@/utils/logger'

/** Ключ хранилища. Всё просмотренное лежит в нём одним объектом. */
const STORE_KEY = 'am_watch_marks'

/** Сколько ждать перед записью: серия идёт долго, спешить некуда. */
const WRITE_DELAY_MS = 4000

/** Сколько серий помним. Дальше вытесняются самые давние. */
const MARK_LIMIT = 600

/**
 * Сколько записей истории помним. Потолок выше, чем у меток, и это не
 * противоречие: запись истории склеена по аниме и серии, поэтому их заведомо
 * меньше, а жальче их больше — метку восстанавливают просмотром, историю
 * восстанавливать нечем.
 */
const HISTORY_LIMIT = 500

/** Сколько тайтлов помнят выбор озвучки и серии. */
const PICK_LIMIT = 200

/** Меньше этого за просмотр не считаем: заставка — не место остановки. */
const MIN_SEC = 15

/**
 * Хвост серии считается досмотренным. Без этого отступа «продолжить» возвращало
 * бы на титры той же серии вместо следующей.
 */
const TAIL_SEC = 90

/** Что помним про одну серию. */
export interface WatchMark {
  /** Секунда остановки. */
  at: number
  /** Длина серии по самому кадру; 0 — источник её так и не назвал. */
  full: number
  /** Когда записали: по этому полю вытесняются давние метки. */
  when: number
}

/** Что человек выбрал у тайтла в прошлый раз. */
export interface WatchPick {
  voiceKey: string
  episode: number
  height: number
  when: number
}

/** Из чего состоит ключ места остановки. */
export interface SpotParts {
  mediaId: number
  voiceKey: string
  episode: number
}

/**
 * Что записать в историю рядом с меткой. Номеров здесь нет: они берутся
 * из самого ключа, а снимок нужен только тот, которого в ключе не бывает.
 */
export interface WatchWhat {
  /** Заголовок тайтла на момент просмотра. */
  title: string
  /** Обложка на момент просмотра; null — карточка её не дала. */
  cover: string | null
  /** Подпись озвучки: «AniLiberty», «Субтитры». */
  voiceLabel: string
}

/** Строка истории: одна серия одного тайтла. */
export interface WatchRow {
  mediaId: number
  /** Озвучка последнего просмотра: по ней серия и продолжится. */
  voiceKey: string
  episode: number
  /** Секунда остановки. */
  at: number
  /** Длина серии; 0 — источник её так и не назвал. */
  full: number
  title: string
  cover: string | null
  voiceLabel: string
  /** Когда эту серию открыли впервые. */
  first: number
  /** Когда смотрели в последний раз: по этому полю идёт порядок. */
  when: number
}

interface Keep {
  marks: Record<string, WatchMark>
  picks: Record<string, WatchPick>
  history: Record<string, WatchRow>
}

const keep: Keep = { marks: {}, picks: {}, history: {} }

/** Чтение одно на весь запуск: второй плеер берёт уже прочитанное. */
let reading: Promise<void> | null = null

let writeTimer = 0

function readMarks(raw: unknown): Record<string, WatchMark> {
  const out: Record<string, WatchMark> = {}
  if (typeof raw !== 'object' || raw === null) return out

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue

    const row = value as Record<string, unknown>
    const at = typeof row.at === 'number' ? row.at : -1
    if (at < 0) continue

    out[key] = {
      at,
      full: typeof row.full === 'number' ? row.full : 0,
      when: typeof row.when === 'number' ? row.when : 0,
    }
  }

  return out
}

function readPicks(raw: unknown): Record<string, WatchPick> {
  const out: Record<string, WatchPick> = {}
  if (typeof raw !== 'object' || raw === null) return out

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue

    const row = value as Record<string, unknown>
    const voiceKey = typeof row.voiceKey === 'string' ? row.voiceKey : ''
    if (voiceKey === '') continue

    out[key] = {
      voiceKey,
      episode: typeof row.episode === 'number' ? row.episode : 0,
      height: typeof row.height === 'number' ? row.height : 0,
      when: typeof row.when === 'number' ? row.when : 0,
    }
  }

  return out
}

/**
 * История читается терпимо: запись без номера аниме или без номера серии
 * никуда не ведёт, и держать её в списке незачем. Так же переживается
 * и склад, писавшийся до появления истории: поля history в нём просто нет.
 */
function readHistory(raw: unknown): Record<string, WatchRow> {
  const out: Record<string, WatchRow> = {}
  if (typeof raw !== 'object' || raw === null) return out

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue

    const row = value as Record<string, unknown>
    const mediaId = typeof row.mediaId === 'number' ? row.mediaId : 0
    const episode = typeof row.episode === 'number' ? row.episode : 0
    if (mediaId <= 0 || episode <= 0) continue

    out[key] = {
      mediaId,
      voiceKey: typeof row.voiceKey === 'string' ? row.voiceKey : '',
      episode,
      at: typeof row.at === 'number' ? row.at : 0,
      full: typeof row.full === 'number' ? row.full : 0,
      title: typeof row.title === 'string' ? row.title : '',
      cover: typeof row.cover === 'string' ? row.cover : null,
      voiceLabel: typeof row.voiceLabel === 'string' ? row.voiceLabel : '',
      first: typeof row.first === 'number' ? row.first : 0,
      when: typeof row.when === 'number' ? row.when : 0,
    }
  }

  return out
}

async function read(): Promise<void> {
  try {
    const raw = await Bridge.storage.get<unknown>(STORE_KEY, null)
    if (typeof raw !== 'object' || raw === null) return

    const box = raw as Record<string, unknown>
    Object.assign(keep.marks, readMarks(box.marks))
    Object.assign(keep.picks, readPicks(box.picks))
    Object.assign(keep.history, readHistory(box.history))
  } catch (e) {
    // Без меток плеер работает, просто начинает серию с нуля.
    Logger('WARN', 'Просмотр: метки не прочитались', e)
  }
}

/**
 * Готовность меток. Ждать её обязан тот, кто собирается читать: само чтение
 * синхронное, но до первого ответа хранилища оно честно вернёт пустоту.
 */
export function whenWatchReady(): Promise<void> {
  reading ??= read()
  return reading
}

async function write(): Promise<void> {
  try {
    await Bridge.storage.set(STORE_KEY, {
      marks: keep.marks,
      picks: keep.picks,
      history: keep.history,
    })
  } catch (e) {
    Logger('WARN', 'Просмотр: метки не записались', e)
  }
}

/** Откладывает запись. Повторный зов срок не продлевает: иначе идущая серия
 * откладывала бы её вечно и на диск не попало бы ничего. */
function schedule(): void {
  if (writeTimer !== 0) return

  writeTimer = window.setTimeout(() => {
    writeTimer = 0
    void write()
  }, WRITE_DELAY_MS)
}

/** Записать немедля: уход с экрана отложенной записи не дождётся. */
export function flushWatchKeep(): void {
  if (writeTimer !== 0) {
    window.clearTimeout(writeTimer)
    writeTimer = 0
  }

  void write()
}

/** Вытесняет давние записи: список не должен расти вечно. */
function trim(rows: Record<string, { when: number }>, limit: number): void {
  const keys = Object.keys(rows)
  if (keys.length <= limit) return

  const old = keys
    .sort((a, b) => (rows[b]?.when ?? 0) - (rows[a]?.when ?? 0))
    .slice(limit)

  for (const key of old) delete rows[key]
}

/** Ключ места остановки: у каждой озвучки свой тайминг и свои врезки. */
export function spotKey(mediaId: number, voiceKey: string, episode: number): string {
  return `${mediaId}|${voiceKey}|${episode}`
}

/**
 * Разбирает ключ обратно на части. Резать по обоим разделителям сразу нельзя:
 * ключ озвучки разделителя содержать не должен, но проверять это здесь поздно
 * и незачем — номер аниме берётся до первого разделителя, номер серии после
 * последнего, а вся середина целиком уходит озвучке.
 */
export function splitSpot(key: string): SpotParts | null {
  const head = key.indexOf('|')
  const tail = key.lastIndexOf('|')
  if (head <= 0 || tail <= head) return null

  const mediaId = Number(key.slice(0, head))
  const episode = Number(key.slice(tail + 1))
  if (!Number.isInteger(mediaId) || !Number.isInteger(episode)) return null

  return { mediaId, voiceKey: key.slice(head + 1, tail), episode }
}

/** Секунда, с которой продолжать. Ноль — смотреть с начала. */
export function peekSpot(key: string): number {
  const mark = keep.marks[key]
  if (mark === undefined) return 0
  if (mark.full > 0 && mark.at >= mark.full - TAIL_SEC) return 0

  return mark.at
}

/** Доля просмотренного от 0 до 1. Без известной длины доли нет. */
export function peekShare(key: string): number {
  const mark = keep.marks[key]
  if (mark === undefined || mark.full <= 0) return 0

  return Math.min(1, Math.max(0, mark.at / mark.full))
}

/** Ключ истории: аниме и серия. Озвучка в него не входит — см. шапку файла. */
function historyKey(mediaId: number, episode: number): string {
  return `${mediaId}|${episode}`
}

/**
 * Кладёт просмотр в историю. Заголовок, обложка и подпись озвучки пустотой
 * не затираются: память о том, что смотрели, дороже свежести снимка —
 * а пустое имя приходит как раз тогда, когда карточка ещё не доехала.
 */
function noteWatch(parts: SpotParts, at: number, full: number, what: WatchWhat): void {
  // Нулевой номер серии — это «ещё не выбрано», а не серия: такая запись
  // никуда не ведёт, и в списке ей делать нечего.
  if (parts.mediaId <= 0 || parts.episode <= 0) return

  const key = historyKey(parts.mediaId, parts.episode)
  const seen = keep.history[key]
  const now = Date.now()

  keep.history[key] = {
    mediaId: parts.mediaId,
    voiceKey: parts.voiceKey,
    episode: parts.episode,
    at,
    full,
    title: what.title !== '' ? what.title : (seen?.title ?? ''),
    cover: what.cover ?? seen?.cover ?? null,
    voiceLabel: what.voiceLabel !== '' ? what.voiceLabel : (seen?.voiceLabel ?? ''),
    first: seen?.first ?? now,
    when: now,
  }

  trim(keep.history, HISTORY_LIMIT)
  schedule()
}

/** Запоминает место остановки. Первые секунды не считаются за просмотр. */
export function rememberSpot(key: string, seconds: number, full: number, what?: WatchWhat): void {
  if (key === '') return

  if (seconds < MIN_SEC) {
    forgetSpot(key)
    return
  }

  const at = Math.floor(seconds)
  const length = full > 0 ? Math.floor(full) : 0

  keep.marks[key] = { at, full: length, when: Date.now() }
  trim(keep.marks, MARK_LIMIT)

  // В историю попадает ровно то же, что и в метку: заставка и десятисекундный
  // заход просмотром не считаются, и в списке им делать нечего.
  if (what !== undefined) {
    const parts = splitSpot(key)
    if (parts !== null) noteWatch(parts, at, length, what)
  }

  schedule()
}

/**
 * Серия досмотрена до конца. Место остановки больше не нужно — возвращать
 * человека на титры незачем, — а в истории эта серия должна стоять целой,
 * а не оборванной на предпоследней секунде.
 *
 * Длина сюда приходит от кадра: у неизвестной и запись выйдет без числа,
 * потому что выдуманный итог хуже отсутствующего.
 */
export function finishSpot(key: string, full: number, what?: WatchWhat): void {
  if (key === '') return

  if (what !== undefined) {
    const parts = splitSpot(key)
    if (parts !== null) {
      const length = full > 0 ? Math.floor(full) : 0
      noteWatch(parts, length, length, what)
    }
  }

  forgetSpot(key)
}

export function forgetSpot(key: string): void {
  if (keep.marks[key] === undefined) return

  delete keep.marks[key]
  schedule()
}

/** Что смотрели у этого тайтла в прошлый раз. */
export function peekPick(mediaId: number): WatchPick | null {
  return keep.picks[String(mediaId)] ?? null
}

export function rememberPick(
  mediaId: number,
  voiceKey: string,
  episode: number,
  height: number,
): void {
  if (mediaId === 0 || voiceKey === '') return

  keep.picks[String(mediaId)] = { voiceKey, episode, height, when: Date.now() }
  trim(keep.picks, PICK_LIMIT)
  schedule()
}

/**
 * Всё, что смотрели, свежее вперёд. Отдаётся копией списка: порядок на экране
 * правит сам экран, а память остаётся за этим модулем.
 */
export function peekHistory(): WatchRow[] {
  return Object.values(keep.history).sort((a, b) => b.when - a.when)
}

/** Забыть одну серию. Соседние записи того же тайтла остаются на месте. */
export function forgetWatch(mediaId: number, episode: number): void {
  const key = historyKey(mediaId, episode)
  if (keep.history[key] === undefined) return

  delete keep.history[key]
  schedule()
}

/**
 * Забыть всё, что смотрели.
 *
 * Метки продолжения уходят вместе с историей: очистка, после которой на диске
 * остались бы сведения о том, где человек остановился, — не очистка,
 * а перестановка. А вот выбор озвучки и серии остаётся: это не след
 * просмотра, а настройка тайтла, и по ней плеер открывается там, где его
 * оставили.
 */
export function wipeWatch(): void {
  keep.history = {}
  keep.marks = {}
  schedule()
}

/**
 * Делает запись истории нынешним выбором тайтла. «Продолжить» — это не
 * переход на серию, а возврат к ней: плеер открывается по последнему выбору,
 * и без этой записи он открыл бы другую серию или другую озвучку.
 *
 * Качество переносится только вместе с озвучкой: у другой дорожки свои высоты,
 * и чужой выбор ей может не подойти. Нулевая высота означает «по умолчанию».
 */
export function resumeWatch(row: WatchRow): void {
  const seen = peekPick(row.mediaId)
  const height = seen !== null && seen.voiceKey === row.voiceKey ? seen.height : 0

  rememberPick(row.mediaId, row.voiceKey, row.episode, height)
}
