// Сборка статистики просмотра: арифметика над памятью коллекции и кэшем обликов, ни одного запроса в сеть. Разметка ничего не считает: числа приходят готовыми, с долями и геометрией колец.

import { eachEntry, entryCount } from '@/core/collection'
import {
  averageScore,
  countByStatus,
  matchesEntry,
  totalProgress,
  type EntryFilter,
} from '@/core/collection-view'
import { peekLook, type MediaLook } from '@/core/media-looks'
import type { SnapshotEntry } from '@/core/snapshot'

import { formatWord, statusList, statusWord } from '../labels'

/**
 * Отбор показа — тот же, что у строк списка и счётчиков «Моё»: взрослое прячет тумблер, а не этот экран. Свой счёт у статистики разошёлся бы с соседней вкладкой на глазах, и причину никто бы не нашёл.
 */
const VIEW: EntryFilter = { hideAdult: true }

/** Сколько лет рисуется столбиками: без потолка. Ряд уезжает за край по горизонтали, и список
 *  с пятнадцатью годами никого не лишает — обрезанный ряд молчал бы об отброшенных годах. */

/** Ключ формата, которого нет ни в памяти списка, ни в складе обликов: аниме ещё не добрано. */
const FORMAT_UNKNOWN = 'UNKNOWN'

/**
 * Доля круговой диаграммы: оба кольца — по статусам и по форматам — читают одну форму. count посчитан, доли и смещение — для рисования.
 */
export interface PieSlice {
  /** Ключ закладки, формата или UNKNOWN; им же красится доля. */
  key: string
  title: string
  count: number
  /** Доля от всех записей, 0..1. */
  share: number
  /** Начало доли, 0..1: без смещения каждая дуга начиналась бы сверху и кольцо читалось бы одной. */
  offset: number
}

/** Столбик одной оценки: высота берётся от самой высокой колонки. */
export interface ScoreBar {
  score: number
  count: number
  share: number
}

/** Счётчик месяца: те же числа, что у года, только месячным шагом. */
interface Accum {
  titles: number
  episodes: number
  minutes: number
  sum: number
  rated: number
}

function blankAccum(): Accum {
  return { titles: 0, episodes: 0, minutes: 0, sum: 0, rated: 0 }
}

function addAccum(into: Accum, from: Accum): void {
  into.titles += from.titles
  into.episodes += from.episodes
  into.minutes += from.minutes
  into.sum += from.sum
  into.rated += from.rated
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** Столбик одного месяца внутри года. */
export interface MonthBar {
  /** Номер месяца, 1..12. */
  month: number
  titles: number
  episodes: number
  hours: number
  meanScore: number
}

/** Столбик одного года: аниме, серии, часы и средняя оценка за год. */
export interface YearBar {
  year: number
  titles: number
  episodes: number
  hours: number
  meanScore: number
  share: number
  /** Завершения по месяцам года, по возрастанию месяца; пустых месяцев в списке нет. */
  months: MonthBar[]
}

/**
 * Столбик года выпуска: что просмотрено из аниме, вышедших в этом году. Считаются записи с просмотром, а не весь список: «просмотрено аниме 2015 года» про то, что человек досмотрел.
 */
export interface ReleaseBar {
  year: number
  titles: number
  episodes: number
  hours: number
  meanScore: number
  share: number
}

/** Всё, что экран показывает: он ничего не досчитывает. */
export interface StatsSummary {
  /** Записей в списке после отбора показа. */
  titles: number
  /** Из них просмотренных: начата хоть одна серия. Держит вторую вкладку кольца по видам. */
  titlesWatched: number
  /** Сколько записей спрятал тумблер 18+: молчаливое расхождение со списком читается потерей данных. */
  hidden: number
  /** Записей с оценкой. */
  rated: number
  /** Средняя своя оценка по выставленным; ноль — оценок нет вовсе. */
  meanScore: number
  /** Просмотрено серий. */
  episodes: number
  hours: number
  /**
   * Просмотрено серий у аниме без известной длины: они не входят в часы, и без этого числа недобор выглядел бы полным счётом. Пользователь сам решит, устраивает ли его «меньше, чем правда».
   */
  episodesNoLength: number
  /** Эквивалент в днях — по сумме минут; серии без известной длины в сумму не входят. */
  days: number
  completed: number
  running: number
  statuses: PieSlice[]
  formats: PieSlice[]
  /** То же кольцо, но по просмотренному: у каждой вкладки свой знаменатель. */
  formatsWatched: PieSlice[]
  scores: ScoreBar[]
  years: YearBar[]
  /**
   * Просмотрено по году выпуска аниме. Ось другая, чем у `years`: там «когда досмотрели», здесь «когда вышло» — сортировка кота одна, а год разный.
   */
  releases: ReleaseBar[]
  /** Просмотрено серий у аниме без известного года выпуска: в гистограмму они не попадают. */
  episodesNoYear: number
}

/** Пустая сводка: её же показывает экран, пока снимок поднимается с диска. */
export function emptyStats(): StatsSummary {
  return {
    titles: 0,
    titlesWatched: 0,
    hidden: 0,
    rated: 0,
    meanScore: 0,
    episodes: 0,
    hours: 0,
    episodesNoLength: 0,
    days: 0,
    completed: 0,
    running: 0,
    statuses: [],
    formats: [],
    formatsWatched: [],
    scores: [],
    years: [],
    releases: [],
    episodesNoYear: 0,
  }
}

/** Часы и дни по сумме просмотренных минут: округление до десятых — третий знак всё равно не читается. */
export function watchTime(minutes: number): { hours: number; days: number } {
  const hours = minutes / 60
  return { hours: Math.round(hours * 10) / 10, days: Math.round((hours / 24) * 10) / 10 }
}

/**
 * Длина серии записи в минутах; без известной длины — ноль. Недобор честнее выдумки: часы из придуманных
 * минут нельзя назвать подсчётом. Длина живёт в записи списка и в складе обликов; у фильма — на единицу.
 */
export function episodeMinutes(entry: SnapshotEntry, look?: MediaLook | null): number {
  const known = entry.duration ?? look?.duration ?? null
  return known !== null && known > 0 ? known : 0
}

/** Число с разрядами: «12 345». Разряды ставим сами, чтобы формат не зависел от локали движка. */
export function formatNumber(value: number): string {
  const whole = Math.round(value)
  const sign = whole < 0 ? '−' : ''
  const digits = String(Math.abs(whole))
  let out = ''

  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ' '
    out += digits[i]
  }

  return sign + out
}

/** Доля каждой позиции от целого; пустой список — пустой ответ, а не деление на ноль. */
function sharesOf(counts: number[], total: number): number[] {
  if (total <= 0) return counts.map(() => 0)
  return counts.map((count) => count / total)
}

/** Высоты столбиков от самой высокой колонки: у пустого графика все нули, а не NaN. */
export function heightsOf(counts: number[]): number[] {
  const top = Math.max(1, ...counts)
  return counts.map((count) => count / top)
}

/** Центр кольца в поле 120×120: общий у краски и у сектора под курсором. */
const RING_CENTER = 60

/** Радиус дуг кольца — тот же, что у окружностей разметки: по нему считается длина обводки. */
const ARC_RADIUS = 44

/** Угол начала первой доли: −90° — верх кольца; ноль градусов у окружности SVG — правая точка. */
const RING_START = -90

/** Длина дуги целой доли: доля превращается в дугу умножением на неё. */
const RING_LENGTH = 2 * Math.PI * ARC_RADIUS

/**
 * Поворот слоя дуг: окружность SVG начинается справа, а доли кольца — сверху. Поворот стоит здесь, а не на всём полотне: повёрнутое целиком, оно уводит слой подсказок на четверть оборота от краски.
 */
export const RING_TURN = `rotate(${RING_START} ${RING_CENTER} ${RING_CENTER})`

/** Начало доли в градусах: тем же углом повёрнуты дуги, поэтому сектор и краска не разъезжаются. */
export function sliceAngle(offset: number): number {
  return RING_START + offset * 360
}

/** Дуга в пикселях кольца: длина доли, остальное — пустота на её месте. */
export function arcDash(share: number): string {
  const length = share * RING_LENGTH
  return `${length.toFixed(2)} ${(RING_LENGTH - length).toFixed(2)}`
}

/** Смещение дуги: отрицательное — по часовой стрелке от верхней точки кольца. */
export function arcShift(offset: number): string {
  return (-offset * RING_LENGTH).toFixed(2)
}

/** Радиусы сектора под курсором: полоса шире видимой дуги, иначе в неё не попасть. */
const HIT_INNER = 30
const HIT_OUTER = 57

/**
 * Путь сектора кольца: углы идут от sliceAngle, поэтому первый сектор начинается сверху — там же, где краска.
 * Именно сектор, а не дуга-обводка: у круга с обводкой габариты — вся окружность, и подпись встала бы в центр.
 */
export function sectorPath(offset: number, share: number): string {
  const start = (sliceAngle(offset) * Math.PI) / 180
  const end = (sliceAngle(offset + share) * Math.PI) / 180
  const large = share * 360 > 180 ? 1 : 0

  const cx = RING_CENTER
  const cy = RING_CENTER
  const n = (value: number): string => value.toFixed(2)

  const outStartX = cx + HIT_OUTER * Math.cos(start)
  const outStartY = cy + HIT_OUTER * Math.sin(start)
  const outEndX = cx + HIT_OUTER * Math.cos(end)
  const outEndY = cy + HIT_OUTER * Math.sin(end)
  const inEndX = cx + HIT_INNER * Math.cos(end)
  const inEndY = cy + HIT_INNER * Math.sin(end)
  const inStartX = cx + HIT_INNER * Math.cos(start)
  const inStartY = cy + HIT_INNER * Math.sin(start)

  return (
    `M ${n(outStartX)} ${n(outStartY)} ` +
    `A ${HIT_OUTER} ${HIT_OUTER} 0 ${large} 1 ${n(outEndX)} ${n(outEndY)} ` +
    `L ${n(inEndX)} ${n(inEndY)} ` +
    `A ${HIT_INNER} ${HIT_INNER} 0 ${large} 0 ${n(inStartX)} ${n(inStartY)} Z`
  )
}

/** Хвост легенды: секторы кольца, что не вошли в три крупнейших. */
export interface LegendTail {
  /** Сколько секторов ушло в хвост. */
  parts: number
  count: number
  share: number
}

export interface LegendSplit<T> {
  head: T[]
  tail: LegendTail | null
}

/**
 * Легенда кольца: крупнейшие сектора по убыванию и хвост одной строкой из остальных. Порог задаёт экран:
 * на широком окне все доли, в компактной раскладке — умолчание в три сектора, где полная легенда занимала полкарточки.
 */
export function splitLegend<T extends { count: number; share: number }>(
  slices: readonly T[],
  limit = 3,
): LegendSplit<T> {
  // Порядок кольца задают закладки, порядок легенды — размер: три крупнейших сектора по убыванию.
  const ordered = [...slices].sort((a, b) => b.count - a.count)
  const head = ordered.slice(0, limit)
  const rest = ordered.slice(limit)
  if (rest.length === 0) return { head: [...head], tail: null }

  let count = 0
  let share = 0
  for (const slice of rest) {
    count += slice.count
    share += slice.share
  }

  return { head: [...head], tail: { parts: rest.length, count, share } }
}

/**
 * Кольцо по видам: крупные сверху, а незнакомый вид уходит в конец отдельной долей. Вид лежит в памяти списка и на складе обликов, а у части аниме его нет вовсе.
 */
function formatSlices(counts: ReadonlyMap<string, number>, total: number): PieSlice[] {
  const keys = [...counts.keys()].sort((a, b) => {
    if (a === FORMAT_UNKNOWN) return 1
    if (b === FORMAT_UNKNOWN) return -1
    const byCount = (counts.get(b) ?? 0) - (counts.get(a) ?? 0)
    return byCount !== 0 ? byCount : a < b ? -1 : 1
  })
  const totals = keys.map((key) => counts.get(key) ?? 0)
  const shares = sharesOf(totals, total)

  let offset = 0
  return keys.map((key, at) => {
    const slice: PieSlice = {
      key,
      title: key === FORMAT_UNKNOWN ? 'Неизвестно' : (formatWord(key) ?? key),
      count: totals[at] ?? 0,
      share: shares[at] ?? 0,
      offset,
    }
    offset += slice.share
    return slice
  })
}

/** Год и месяц из даты снимка ГГГГ-ММ-ДД; всё прочее, включая пустоту, — «даты нет». */
function dateParts(date: string | null): { year: number; month: number } | null {
  if (typeof date !== 'string') return null

  const hit = /^(\d{4})-(\d{2})-\d{2}$/.exec(date)
  if (hit === null) return null

  const year = Number(hit[1])
  if (year < 1900 || year > 2200) return null

  const month = Number(hit[2])
  if (month < 1 || month > 12) return null

  return { year, month }
}

/**
 * Собирает сводку по памяти коллекции. Один перебор: считать по разу на метрику значило бы пройти список десяток раз ради чисел, которые всё равно читаются вместе.
 */
export function buildStats(): StatsSummary {
  const summary = emptyStats()

  /** Гистограмма оценок по возрастанию: индекс — оценка минус один. */
  const scoreCounts = new Array<number>(10).fill(0)
  const yearMonths = new Map<number, Map<number, Accum>>()
  const yearReleases = new Map<number, Accum>()
  const formatCounts = new Map<string, number>()
  const watchedFormatCounts = new Map<string, number>()
  let watchedMinutes = 0

  for (const entry of eachEntry()) {
    if (!matchesEntry(entry, VIEW)) continue

    summary.titles += 1

    // Облик читается один раз на запись: он несёт и вид, и длину серии, которой в записи может не быть.
    const look = peekLook(entry.mediaId)

    // Своя длина у каждой серии; без неё серия в часы не идёт — недобор вместо выдумки.
    const perEpisode = episodeMinutes(entry, look)
    const minutes = entry.progress * perEpisode
    watchedMinutes += minutes
    // Считаем именно серии, а не записи: одно аниме без длины недооценивает счёт сразу на десятки.
    if (perEpisode === 0 && entry.progress > 0) summary.episodesNoLength += entry.progress

    const format = entry.format ?? look?.format ?? ''
    const formatKey = format === '' ? FORMAT_UNKNOWN : format
    formatCounts.set(formatKey, (formatCounts.get(formatKey) ?? 0) + 1)

    // Просмотренное для второй вкладки кольца: начал хоть одну серию — уже смотрел. Тот же признак, что у метрики «Просмотрено аниме», иначе два ряда на экране считались бы по-разному.
    if (entry.progress > 0) {
      summary.titlesWatched += 1
      watchedFormatCounts.set(formatKey, (watchedFormatCounts.get(formatKey) ?? 0) + 1)
    }

    if (entry.score10 > 0) {
      summary.rated += 1

      // Дробная оценка идёт в ближайший целый столбик, а не вниз: при шаге в пол-балла отбрасывание вниз
      // сдвинуло бы весь ряд ниже правды, и столбик 9 не содержал бы вовсе девяток с половиной.
      const at = Math.min(10, Math.round(entry.score10)) - 1
      if (at >= 0) scoreCounts[at] = (scoreCounts[at] ?? 0) + 1
    }

    const when = dateParts(entry.completedAt)
    if (when !== null) {
      // Год собирается из месяцев, а не наоборот: месячная разбивка нужна для раскрытия года, а лишние числа в снимке разошлись бы с суммой года на единицу.
      let months = yearMonths.get(when.year)
      if (months === undefined) {
        months = new Map<number, Accum>()
        yearMonths.set(when.year, months)
      }

      let bucket = months.get(when.month)
      if (bucket === undefined) {
        bucket = blankAccum()
        months.set(when.month, bucket)
      }

      bucket.titles += 1
      bucket.episodes += entry.progress
      bucket.minutes += minutes

      if (entry.score10 > 0) {
        bucket.sum += entry.score10
        bucket.rated += 1
      }
    }

    // Год выпуска — ось второй гистограммы. Берём из записи, а из склада только как запасной: год приезжает со списком, и облик, собранный до этого поля, мог его не знать.
    const released = entry.seasonYear ?? look?.seasonYear ?? null
    if (entry.progress > 0) {
      if (released !== null && released > 1900 && released <= 2200) {
        let bucket = yearReleases.get(released)
        if (bucket === undefined) {
          bucket = blankAccum()
          yearReleases.set(released, bucket)
        }

        bucket.titles += 1
        bucket.episodes += entry.progress
        bucket.minutes += minutes

        if (entry.score10 > 0) {
          bucket.sum += entry.score10
          bucket.rated += 1
        }
      } else {
        // Года выпуска нет — в гистограмму такая запись не попадёт, и молчать об этом нельзя.
        summary.episodesNoYear += entry.progress
      }
    }
  }

  // Суммы по сериям берём у отборов ядра: своя арифметика рядом с чужой разошлась бы на фильтрах.
  summary.episodes = totalProgress(VIEW)
  summary.meanScore = averageScore(VIEW)
  summary.hidden = Math.max(0, entryCount() - summary.titles)

  const time = watchTime(watchedMinutes)
  summary.hours = time.hours
  summary.days = time.days

  const byStatus = countByStatus(VIEW)
  summary.completed = byStatus.get('COMPLETED') ?? 0
  summary.running = (byStatus.get('CURRENT') ?? 0) + (byStatus.get('REPEATING') ?? 0)

  // Порядок закладок тот же, что в списках; всё, чего нет в словаре, уходит в конец одной долей.
  const keys = [...statusList().map((item) => item.key), 'UNKNOWN']
  const counts = keys.map((key) => byStatus.get(key) ?? 0)
  const shares = sharesOf(counts, summary.titles)

  let offset = 0
  summary.statuses = keys
    .map((key, at) => {
      const slice: PieSlice = {
        key,
        title: key === 'UNKNOWN' ? 'Без закладки' : (statusWord(key) ?? key),
        count: counts[at] ?? 0,
        share: shares[at] ?? 0,
        offset,
      }
      offset += slice.share
      return slice
    })
    .filter((slice) => slice.count > 0)

  // Форматы строим дважды: по просмотренному и по всему списку. Доли у каждого свои — от своего знаменателя, иначе «Неизвестно» одной вкладки испортило бы другой.
  summary.formatsWatched = formatSlices(watchedFormatCounts, summary.titlesWatched)
  summary.formats = formatSlices(formatCounts, summary.titles)

  const scoreShares = heightsOf(scoreCounts)
  summary.scores = scoreCounts.map((count, at) => ({
    score: at + 1,
    count,
    share: scoreShares[at] ?? 0,
  }))

  // Года просмотра: все, что есть. Потолок здесь означал бы тихую потерю данных, а ряд и так уезжает за край по горизонтали, когда лет много.
  const years = [...yearMonths.keys()].sort((a, b) => a - b)
  const yearTotals = years.map((year) => {
    const total = blankAccum()
    for (const bucket of yearMonths.get(year)?.values() ?? []) addAccum(total, bucket)
    return total
  })
  const yearShares = heightsOf(yearTotals.map((total) => total.episodes))
  summary.years = years.map((year, at) => {
    const total = yearTotals[at] ?? blankAccum()
    const months = [...(yearMonths.get(year) ?? new Map<number, Accum>())]
      .sort((a, b) => a[0] - b[0])
      .map(([month, bucket]) => ({
        month,
        titles: bucket.titles,
        episodes: bucket.episodes,
        hours: round1(bucket.minutes / 60),
        meanScore: bucket.rated > 0 ? round2(bucket.sum / bucket.rated) : 0,
      }))

    return {
      year,
      titles: total.titles,
      episodes: total.episodes,
      hours: round1(total.minutes / 60),
      meanScore: total.rated > 0 ? round2(total.sum / total.rated) : 0,
      share: yearShares[at] ?? 0,
      months,
    }
  })

  // Годы выпуска: только те, где что-то смотрели, и с потолком — иначе столбики стали бы в ниточку.
  const releasedYears = [...yearReleases.keys()].sort((a, b) => a - b)
  const releaseShare = heightsOf(releasedYears.map((year) => yearReleases.get(year)?.episodes ?? 0))
  summary.releases = releasedYears.map((year, at) => {
    const bucket = yearReleases.get(year) ?? blankAccum()

    return {
      year,
      titles: bucket.titles,
      episodes: bucket.episodes,
      hours: round1(bucket.minutes / 60),
      meanScore: bucket.rated > 0 ? round2(bucket.sum / bucket.rated) : 0,
      share: releaseShare[at] ?? 0,
    }
  })

  return summary
}

/**
 * Номера записей показа, которым не хватает вида, длины серии или года выпуска: их добирает экран со сводкой,
 * и все поля приезжают одним обликом. Отбор показа один на всю сводку — свой попадал бы записи вне кольца и чисел.
 */
export function looklessIds(): number[] {
  const ids: number[] = []

  for (const entry of eachEntry()) {
    if (!matchesEntry(entry, VIEW)) continue

    // И вид, и длина живут в двух местах: память списка (приехала с ним) и добранный склад обликов.
    const look = peekLook(entry.mediaId)
    const blindFormat = entry.format == null && look?.format == null
    const blindDuration = (entry.duration ?? look?.duration) == null
    const blindYear = entry.seasonYear == null && look?.seasonYear == null
    if (!blindFormat && !blindDuration && !blindYear) continue

    ids.push(entry.mediaId)
  }

  return ids
}
