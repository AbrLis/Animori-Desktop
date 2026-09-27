// Сборка статистики просмотра: арифметика над памятью коллекции и кэшем обликов, ни одного запроса в сеть.
// Разметка ничего не считает (граница .vue/.ts): числа приходят готовыми, вместе с долями для графиков
// и геометрией колец — подсказка доли обязана вставать на ту же дугу, что и краска, иначе она называется не тем.

import { eachEntry, entryCount } from '@/core/collection'
import {
  averageScore,
  countByStatus,
  matchesEntry,
  totalProgress,
  type EntryFilter,
} from '@/core/collection-view'
import { peekLook } from '@/core/media-looks'

import { formatWord, statusList, statusWord } from '../labels'

/**
 * Отбор показа — тот же, что у строк списка и счётчиков «Моё»: взрослое прячет тумблер, а не этот экран.
 * Свой счёт у статистики разошёлся бы с соседней вкладкой на глазах, и причину никто бы не нашёл.
 */
const VIEW: EntryFilter = { hideAdult: true }

/**
 * Минут на серию для перевода в дни. Длительности серии в наших данных нет: списки живут выписками
 * AniList, а `duration` там не приходит — спрашивать её значило бы по запросу на каждый тайтл.
 * Поэтому дни — договорённость, и экран обязан назвать её вслух, а не выдавать за подсчёт.
 */
export const MINUTES_PER_EPISODE = 24

/** Сколько лет рисуется столбиками: хвост истории в десяток лет и так редок. */
const YEARS_LIMIT = 10

/** Ключ формата, которого нет в кэше обликов: тайтл ещё не открывали. */
const FORMAT_UNKNOWN = 'UNKNOWN'

/**
 * Доля круговой диаграммы: оба кольца — по статусам и по форматам — читают одну форму.
 * count посчитан, доли и смещение — для рисования.
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

/** Столбик одного года: тайтлы, серии, часы и средняя оценка за год. */
export interface YearBar {
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
  /** Сколько записей спрятал тумблер 18+: молчаливое расхождение со списком читается потерей данных. */
  hidden: number
  /** Записей с оценкой. */
  rated: number
  /** Средняя своя оценка по выставленным; ноль — оценок нет вовсе. */
  meanScore: number
  /** Просмотрено серий. */
  episodes: number
  hours: number
  /** Эквивалент в днях — по MINUTES_PER_EPISODE. */
  days: number
  completed: number
  running: number
  statuses: PieSlice[]
  formats: PieSlice[]
  scores: ScoreBar[]
  years: YearBar[]
}

/** Пустая сводка: её же показывает экран, пока снимок поднимается с диска. */
export function emptyStats(): StatsSummary {
  return {
    titles: 0,
    hidden: 0,
    rated: 0,
    meanScore: 0,
    episodes: 0,
    hours: 0,
    days: 0,
    completed: 0,
    running: 0,
    statuses: [],
    formats: [],
    scores: [],
    years: [],
  }
}

/** Часы и дни по числу серий: округление до десятых — третий знак всё равно не читается. */
export function watchTime(episodes: number): { hours: number; days: number } {
  const hours = (episodes * MINUTES_PER_EPISODE) / 60
  return { hours: Math.round(hours * 10) / 10, days: Math.round((hours / 24) * 10) / 10 }
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

/** Точка графика в относительной системе координат 0..1000 для построения SVG-кривой. */
export interface SplinePoint {
  x: number
  y: number
}

/**
 * Координаты верхушек столбиков для SVG-графика поверх гистограммы.
 * X центрируется по ширине каждого столбика, Y совпадает с верхним краем заливки.
 */
export function pointsForBars(bars: readonly { share: number }[]): SplinePoint[] {
  const n = bars.length
  if (n === 0) return []

  return bars.map((b, i) => {
    const x = ((i + 0.5) / n) * 1000
    const fillPercent = b.share <= 0 ? 0 : Math.max(4, b.share * 100)
    const y = 1000 - fillPercent * 10
    return { x, y }
  })
}

/**
 * Строит плавную кривую Безье (Catmull-Rom -> Cubic Bezier) по верхушкам столбиков.
 * На двух и более точках выдаёт готовую команду пути M ... C ...
 */
export function smoothPath(points: readonly SplinePoint[]): string {
  if (points.length < 2) return ''

  const start = points[0]
  if (!start) return ''

  let d = `M ${start.x.toFixed(1)} ${start.y.toFixed(1)}`

  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i === 0 ? 0 : i - 1] ?? start
    const p1 = points[i] ?? start
    const p2 = points[i + 1] ?? p1
    const p3 = points[i + 2 < points.length ? i + 2 : i + 1] ?? p2

    const k = 0.2

    const cp1x = p1.x + (p2.x - p0.x) * k
    const cp1y = Math.max(0, Math.min(1000, p1.y + (p2.y - p0.y) * k))

    const cp2x = p2.x - (p3.x - p1.x) * k
    const cp2y = Math.max(0, Math.min(1000, p2.y - (p3.y - p1.y) * k))

    d += ` C ${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`
  }

  return d
}

/** Замыкает кривую ко дну (bottomY), формируя замкнутый контур для градиентной подложки. */
export function smoothAreaPath(points: readonly SplinePoint[], bottomY = 1000): string {
  if (points.length < 2) return ''
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return ''

  const lineD = smoothPath(points)
  return `${lineD} L ${last.x.toFixed(1)} ${bottomY.toFixed(1)} L ${first.x.toFixed(1)} ${bottomY.toFixed(1)} Z`
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
 * Поворот слоя дуг: окружность SVG начинается справа, а доли кольца — сверху. Поворот стоит здесь,
 * а не на всём полотне: повёрнутое целиком, оно уводит слой подсказок на четверть оборота от краски.
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
 * Путь сектора кольца: углы идут от sliceAngle, поэтому первый сектор начинается сверху — там же,
 * где краска. Именно сектор, а не дуга-обводка: у круга с обводкой габариты — вся окружность, и подпись
 * встала бы в центр кольца вместо места, где стоит курсор.
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

/** Легенда кольца: три крупнейших сектора и хвост одной строкой — полная занимала полкарточки. */
export function splitLegend<T extends { count: number; share: number }>(
  slices: readonly T[],
  limit = 3,
): LegendSplit<T> {
  const head = slices.slice(0, limit)
  const rest = slices.slice(limit)
  if (rest.length === 0) return { head: [...head], tail: null }

  let count = 0
  let share = 0
  for (const slice of rest) {
    count += slice.count
    share += slice.share
  }

  return { head: [...head], tail: { parts: rest.length, count, share } }
}

/** Год из даты снимка ГГГГ-ММ-ДД; всё прочее, включая пустоту, — «года нет». */
function yearOf(date: string | null): number | null {
  if (typeof date !== 'string') return null

  const hit = /^(\d{4})-\d{2}-\d{2}$/.exec(date)
  if (hit === null) return null

  const year = Number(hit[1])
  return year >= 1900 && year <= 2200 ? year : null
}

/**
 * Собирает сводку по памяти коллекции. Один перебор: считать по разу на метрику значило бы
 * пройти список десяток раз ради чисел, которые всё равно читаются вместе.
 */
export function buildStats(): StatsSummary {
  const summary = emptyStats()

  /** Гистограмма оценок по возрастанию: индекс — оценка минус один. */
  const scoreCounts = new Array<number>(10).fill(0)
  const yearTitles = new Map<number, number>()
  const yearEpisodes = new Map<number, number>()
  const yearScores = new Map<number, { sum: number; rated: number }>()
  const formatCounts = new Map<string, number>()

  for (const entry of eachEntry()) {
    if (!matchesEntry(entry, VIEW)) continue

    summary.titles += 1

    // Облик читается один раз на запись: формат живёт в том же кэше, что обложка и части.
    const look = peekLook(entry.mediaId)
    const format = look?.format ?? ''
    const formatKey = format === '' ? FORMAT_UNKNOWN : format
    formatCounts.set(formatKey, (formatCounts.get(formatKey) ?? 0) + 1)

    if (entry.score10 > 0) {
      summary.rated += 1
      const at = Math.min(10, Math.floor(entry.score10)) - 1
      if (at >= 0) scoreCounts[at] = (scoreCounts[at] ?? 0) + 1
    }

    const year = yearOf(entry.completedAt)
    if (year !== null) {
      yearTitles.set(year, (yearTitles.get(year) ?? 0) + 1)
      yearEpisodes.set(year, (yearEpisodes.get(year) ?? 0) + entry.progress)

      if (entry.score10 > 0) {
        const acc = yearScores.get(year) ?? { sum: 0, rated: 0 }
        acc.sum += entry.score10
        acc.rated += 1
        yearScores.set(year, acc)
      }
    }
  }

  // Суммы по сериям берём у отборов ядра: своя арифметика рядом с чужой разошлась бы на фильтрах.
  summary.episodes = totalProgress(VIEW)
  summary.meanScore = averageScore(VIEW)
  summary.hidden = Math.max(0, entryCount() - summary.titles)

  const time = watchTime(summary.episodes)
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

  // Форматы: облик лежит в кэше и есть не у каждого тайтла — незнакомое уходит в конец отдельной долей.
  const formatKeys = [...formatCounts.keys()].sort((a, b) => {
    if (a === FORMAT_UNKNOWN) return 1
    if (b === FORMAT_UNKNOWN) return -1
    const byCount = (formatCounts.get(b) ?? 0) - (formatCounts.get(a) ?? 0)
    return byCount !== 0 ? byCount : a < b ? -1 : 1
  })
  const formatTotals = formatKeys.map((key) => formatCounts.get(key) ?? 0)
  const formatShares = sharesOf(formatTotals, summary.titles)

  let formatOffset = 0
  summary.formats = formatKeys.map((key, at) => {
    const slice: PieSlice = {
      key,
      title: key === FORMAT_UNKNOWN ? 'Неизвестно' : (formatWord(key) ?? key),
      count: formatTotals[at] ?? 0,
      share: formatShares[at] ?? 0,
      offset: formatOffset,
    }
    formatOffset += slice.share
    return slice
  })

  const scoreShares = heightsOf(scoreCounts)
  summary.scores = scoreCounts.map((count, at) => ({
    score: at + 1,
    count,
    share: scoreShares[at] ?? 0,
  }))

  const years = [...yearTitles.keys()].sort((a, b) => a - b).slice(-YEARS_LIMIT)
  const episodeCounts = years.map((year) => yearEpisodes.get(year) ?? 0)
  const yearShares = heightsOf(episodeCounts)
  summary.years = years.map((year, at) => {
    const titles = yearTitles.get(year) ?? 0
    const episodes = episodeCounts[at] ?? 0
    const hours = Math.round(((episodes * MINUTES_PER_EPISODE) / 60) * 10) / 10
    const scoreAcc = yearScores.get(year)
    const meanScore =
      scoreAcc && scoreAcc.rated > 0 ? Math.round((scoreAcc.sum / scoreAcc.rated) * 100) / 100 : 0

    return {
      year,
      titles,
      episodes,
      hours,
      meanScore,
      share: yearShares[at] ?? 0,
    }
  })

  return summary
}

/**
 * Номера записей показа, чей формат ещё не пришёл. Сеть — забота экрана, а отбор показа один на всю
 * сводку: со своим отбором сюда попадали бы записи, которых нет ни в кольце, ни в числах.
 */
export function formatlessIds(): number[] {
  const ids: number[] = []

  for (const entry of eachEntry()) {
    if (!matchesEntry(entry, VIEW)) continue
    if (peekLook(entry.mediaId)?.format != null) continue
    ids.push(entry.mediaId)
  }

  return ids
}
