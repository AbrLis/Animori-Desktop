/**
 * Активность человека по дням — «календарик» в духе вклада на гитхабе, только вместо коммитов
 * его дела в приложении. Живёт отдельно от снимка списка: снимок хранит состояние записей, где
 * `updatedAt` — одно поле на тайтл и перезаписывается при каждой правке, а календарю нужна
 * каждая перемена и её день. Поэтому здесь append-only журнал: событие дописывается и больше
 * не меняется, а лишнее вытесняется по сроку.
 *
 * Чего журнал не знает: прошлого. Он пишется с момента появления, старые дни не восстанавливаются
 * из снимка — иначе в сетке были бы выдуманные события, которых не было. Первый год у всех
 * начинается пустым, и это честнее правдоподобной картинки.
 *
 * Подпись тайтла хранится в самом событии. Кэши имён живут запуском, и после перезахода вместо
 * имени в чипсах стояло бы «Без названия»; записанная подпись такой беды не знает — она
 * едет в журнале и переживает и перезаход, и отсутствие сети. Кто именно знает имя, решает
 * вызывающий: журналу не разглядеть ни датасет, ни Шикимори, а импорт оттуда дал бы кольцо.
 */

import { Bridge } from '@/bridge'
import { Logger } from '../utils/logger'
import { serialWrite } from './store-chain'

/** Ключ хранилища моста. Приставка AM_ занята только нашими записями. */
const ACTIVITY_KEY = 'AM_ACTIVITY'

/** Задержка записи: правки статуса идут пачками, писать на каждую — дороже отрисовки. */
const WRITE_DELAY_MS = 1500

/** Сколько событий держим. Год активного человека — около двух тысяч, потолок с запасом. */
const EVENT_LIMIT = 6000


/** Что человек сделал. Порядок объявления — от частого к редкому, им же считается подпись дня. */
export type ActivityKind =
  /**
   * Просмотр серии. Вид остался на чтение: события этого вида лежат в журналах прежних сборок,
   * а новая их не пишет — в календарь идёт только то, что человек отметил сам.
   */
  | 'watch'
  /** Сменил статус: «смотрю», «завершено», «бросил». */
  | 'status'
  /** Двинул прогресс по тайтлу. */
  | 'progress'
  /** Поставил или снял оценку. */
  | 'score'
  /** Написал или стёр заметку. */
  | 'note'
  /** Поменял счётчик пересмотров. */
  | 'repeat'
  /** Добавил тайтл в список. */
  | 'add'
  /** Убрал тайтл из списка. */
  | 'remove'

/** Одно действие. Запись append-only: при повторе добавляется новая, а эта не меняется. */
export interface ActivityEvent {
  /** Местные сутки действия, начало дня в миллисекундах. По нему и раскладывается сетка. */
  day: number
  kind: ActivityKind
  mediaId: number
  /** Номер серии у просмотра, новое число серий у прогресса; у прочих дел ноль. */
  episode: number
  /** Точный момент: миллисекунды, по ним порядок внутри дня. */
  at: number
  /**
   * Подпись тайтла на момент дела — та самая, что переживает перезаход. Пустая строка значит
   * «записано до появления поля или имя ещё не доехало»: такую подпись ищет fillActivityTitles.
   */
  title: string
  /** Закладка, которую поставили: ключ AniList; нет — не про закладку или запись без поля. */
  mark?: string
  /** Оценка 0…10; ноль — сняли. Нет — событие записано до появления поля. */
  score?: number
  /**
   * С чего шло: у оценки — прежний балл, у прогресса — прежнее число серий; ноль — до правки
   * этого не было. Без прежнего числа чипса не покажет переход, а он и есть главное в оценке.
   * Нет — событие записано до появления поля.
   */
  from?: number
}

/**
 * Что вызывающий знает про дело сверх его вида. Пустое поле значит «нечего добавить»: подпись
 * и закладку дозаполнит экран, а неверное значение соврало бы в чипсе.
 */
export interface ActivityNote {
  /** Подпись тайтла на момент дела: плеер берёт её из шапки кадра, правка записи — из записи. */
  title?: string
  /** Закладка, которую поставили: ключ AniList. */
  mark?: string
  /** Оценка 0…10; ноль — сняли. */
  score?: number
  /** С чего шло: прежняя оценка или прежнее число серий; ноль — этого раньше не было. */
  from?: number
}

/** Денная сводка: то, из чего рисуется квадрат и раскрывается его детализация. */
export interface ActivityDay {
  /** Начало местных суток. */
  day: number
  /** Сколько событий выпало на день. */
  count: number
  /** Сами события, свежие сверху. */
  events: ActivityEvent[]
  /** День позже сегодняшнего: его ещё не наступило, и кликать его нельзя. */
  future: boolean
  /** День соседнего года, попавший в первую или последнюю колонку: не наш, в счёт не идёт. */
  outside: boolean
}

const KINDS: ReadonlyArray<ActivityKind> = [
  'watch',
  'status',
  'progress',
  'score',
  'note',
  'repeat',
  'add',
  'remove',
]

/** Дни недели словами: индекс — как у `getDay()`, с нуля и с воскресенья. */
const WEEK_FULL = [
  'воскресенье',
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
] as const

/** Месяцы в родительном падеже: «12 сентября», а не «12 сентябрь». */
const MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
] as const

/** Значения журнала этого запуска. */
const events: ActivityEvent[] = []

/** Слушатели перемены: сетка на главной перерисовывается по ним, а не опрашивает хранилище. */
const watchers = new Set<() => void>()

let writeTimer = 0
let reading: Promise<void> | null = null

/** Начало местных суток. По нему дни и различаются, и он же уходит в хранилище. */
function dayStart(stamp: number): number {
  const date = new Date(stamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Сдвиг на дни через `setDate`: в сутках не всегда ровно 86 400 000 мс. */
function addDays(stamp: number, days: number): number {
  const date = new Date(stamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime()
}

/**
 * Начало недели: понедельник. `getDay()` даёт 0 для воскресенья, и без сдвига неделя
 * начиналась бы с воскресенья, а у нас недели начинаются с понедельника.
 */
function weekStart(stamp: number): number {
  const date = new Date(stamp)
  return addDays(dayStart(stamp), -((date.getDay() + 6) % 7))
}

/** Подпись дня словами: сначала день недели, потом число и месяц. */
export function dayTitle(stamp: number): string {
  const date = new Date(stamp)
  const week = WEEK_FULL[date.getDay()] ?? ''
  return `${week}, ${date.getDate()} ${MONTHS[date.getMonth()] ?? ''}`
}

/**
 * Годы, в которых есть хоть одно событие. По ним календарик знает, куда можно переключиться:
 * пустой год переключателем не показывается — лишняя кнопка вводила бы в заблуждение, будто
 * там что-то есть. Считается по журналу целиком, он и без того короткий.
 */
export function activityYears(): number[] {
  const years = new Set<number>()

  for (const event of events) years.add(new Date(event.at).getFullYear())

  return [...years].sort((a, b) => a - b)
}

function readKind(raw: unknown): ActivityKind | null {
  return typeof raw === 'string' && (KINDS as ReadonlyArray<string>).includes(raw)
    ? (raw as ActivityKind)
    : null
}

/** Разбор хранилища: чужой или битый ключ читается как пустота, а не роняет запуск. */
function readEvents(raw: unknown): ActivityEvent[] {
  const out: ActivityEvent[] = []
  if (typeof raw !== 'object' || raw === null) return out

  const list = Array.isArray(raw) ? raw : (raw as { events?: unknown }).events
  if (!Array.isArray(list)) return out

  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue

    const row = item as Record<string, unknown>
    const at = typeof row.at === 'number' ? row.at : 0
    const day = typeof row.day === 'number' ? row.day : 0
    const mediaId = typeof row.mediaId === 'number' ? row.mediaId : 0
    const kind = readKind(row.kind)

    if (kind === null || at <= 0 || day <= 0 || mediaId <= 0) continue

    out.push({
      day,
      kind,
      mediaId,
      episode: typeof row.episode === 'number' ? row.episode : 0,
      at,
      // Чужая строка в title читалась бы как подпись тайтла, а на деле это мусор в складе.
      title: typeof row.title === 'string' ? row.title : '',
      mark: typeof row.mark === 'string' && row.mark !== '' ? row.mark : undefined,
      score: typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : undefined,
      from: typeof row.from === 'number' && Number.isFinite(row.from) ? row.from : undefined,
    })
  }

  out.sort((a, b) => a.at - b.at)
  return out
}

async function read(): Promise<void> {
  const raw = await Bridge.storage.get<unknown>(ACTIVITY_KEY, null)
  const parsed = readEvents(raw)

  events.length = 0
  events.push(...parsed)
  Logger('DB', `Активность прочитана: событий ${events.length}`)
}

async function write(): Promise<void> {
  return serialWrite(async () => {
    try {
      await Bridge.storage.set(ACTIVITY_KEY, events)
      Logger('DB', `Активность записана: событий ${events.length}`)
    } catch (e) {
      Logger('ERROR', 'Активность: ошибка записи', e)
    }
  })
}

/** Откладывает запись. Повторный зов срок не продлевает — иначе день правок писался бы вечно. */
function schedule(): void {
  if (writeTimer !== 0) return

  writeTimer = window.setTimeout(() => {
    writeTimer = 0
    void write()
  }, WRITE_DELAY_MS)
}

/** Вытесняет самые давние события: журнал не должен расти без предела. */
function trim(): void {
  if (events.length <= EVENT_LIMIT) return
  events.splice(0, events.length - EVENT_LIMIT)
}

function touched(): void {
  for (const watcher of watchers) watcher()
}

/**
 * Записать действие. Молчаливые выходы: событие — это витрина, и его потеря не должна ломать
 * правку записи.
 */
export function noteActivity(
  kind: ActivityKind,
  mediaId: number,
  episode = 0,
  at = Date.now(),
  note: ActivityNote = {},
): void {
  if (mediaId <= 0) return

  events.push({
    day: dayStart(at),
    kind,
    mediaId,
    episode: episode > 0 ? Math.floor(episode) : 0,
    at,
    title: note.title ?? '',
    mark: note.mark === undefined || note.mark === '' ? undefined : note.mark,
    score: note.score,
    from: note.from,
  })

  trim()
  schedule()
  touched()
}

/**
 * Дозаполняет подписи событий, записанных до появления поля или в миг, когда имя ещё не доехало.
 * Подпись ищет вызывающий: журналу не разглядеть ни датасет, ни Шикимори, а импорт оттуда дал бы
 * кольцо модулей. Найденное ложится в журнал и остаётся там — второй раз имя искать не придётся.
 * Возвращает, скольким событиям подпись досталась.
 */
export function fillActivityTitles(lookup: (mediaId: number) => string): number {
  let named = 0

  for (const event of events) {
    if (event.title !== '') continue

    const title = lookup(event.mediaId)
    if (title === '') continue

    event.title = title
    named += 1
  }

  if (named > 0) {
    schedule()
    touched()
  }

  return named
}

/** События одного дня, свежие сверху. */
export function activityOf(day: number): ActivityEvent[] {
  return events.filter((event) => event.day === day).sort((a, b) => b.at - a.at)
}

/**
 * Сетка года: 53 недели по 7 дней, понедельник первым. Возвращает и пустые дни — квадрат без
 * события тоже должен нарисоваться, иначе в сетке были бы дыры там, где тишина, а не пустота.
 * Дни после сегодняшнего получают `future`, чтобы их нельзя было принять за забытую неделю.
 */
/**
 * Год по календарю: от 1 января до 31 декабря, а не скользящие 53 недели назад от сегодня.
 * Скользящий год кончался вчерашним днём, из-за чего правая половина сетки была пустой и календарь
 * нельзя было прочитать как календарь. Теперь год стоит на месте: слева январь, справа декабрь,
 * и человек видит не «последние 53 недели», а свой нынешний год целиком.
 *
 * Края недели вылезают за год — колонка с 1 января начинается в декабре прошлого, а колонка
 * с 31 декабря кончается в январе следующего. Такие дни помечены `outside`: они рисуются пустыми
 * слотами, чтобы края не выглядели обрезанными, но ни в счёт, ни в клики не идут.
 */
export function activityYear(today: number, year?: number): ActivityDay[] {
  const now = dayStart(today)
  const at = year ?? new Date(now).getFullYear()

  // Границы года: полночь первого января и полночь первого января следующего.
  const first = new Date(at, 0, 1).getTime()
  const after = new Date(at + 1, 0, 1).getTime()

  // Края сетки — понедельники недель, в которые попали 1 января и 31 декабря.
  const from = weekStart(first)
  const to = addDays(weekStart(after - 1), 6)

  const buckets = new Map<number, ActivityEvent[]>()

  for (const event of events) {
    if (event.day < first || event.day >= after) continue

    const bucket = buckets.get(event.day)
    if (bucket === undefined) buckets.set(event.day, [event])
    else bucket.push(event)
  }

  const out: ActivityDay[] = []

  for (let stamp = from; stamp <= to; stamp = addDays(stamp, 1)) {
    const inside = stamp >= first && stamp < after
    const day = inside ? (buckets.get(stamp) ?? []) : []

    out.push({
      day: stamp,
      count: day.length,
      events: day,
      future: inside && stamp > now,
      outside: !inside,
    })
  }

  return out
}

/** Подписаться на перемены журнала. Возвращает отписку — экраны переживают перезапуск. */
export function watchActivity(watcher: () => void): () => void {
  watchers.add(watcher)
  return () => watchers.delete(watcher)
}

/** Готовность журнала: до первого чтения сетка честно покажет пустоту. */
export function whenActivityReady(): Promise<void> {
  reading ??= read().catch((e) => {
    Logger('WARN', 'Активность: не прочиталась', e)
  })

  return reading
}

/** Записать немедленно: уход с экрана отложенной записи не дождётся. */
export function flushActivity(): void {
  if (writeTimer !== 0) {
    window.clearTimeout(writeTimer)
    writeTimer = 0
  }

  void write()
}

/**
 * Стереть журнал целиком — кнопка «Стереть историю» в настройках. Квадраты года гаснут у всех
 * сразу: подписчики получают перемену, а не ждут чтения. Писать приходится немедленно, а не
 * отложенно: уход с экрана настроек отложенную запись не дождался бы, и история всплыла бы
 * после перезапуска.
 */
export function clearActivity(): void {
  events.length = 0
  flushActivity()
  touched()
}
