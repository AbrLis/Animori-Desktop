// Проверки сборки статистики просмотра (`app/screens/stats-count`): числа, доли и отбор показа.
// Модуль чистый, но считает по памяти коллекции — наполняем её записями снимка напрямую.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { MediaBrief } from '@/api/anilist-media'
import {
  arcDash,
  arcShift,
  buildStats,
  formatlessIds,
  formatNumber,
  pointsForBars,
  RING_TURN,
  sectorPath,
  sliceAngle,
  smoothAreaPath,
  smoothPath,
  splitLegend,
  watchTime,
} from '@/app/screens/stats-count'
import { dropEntry, putEntry } from '@/core/collection'
import { rememberBrief } from '@/core/media-looks'
import { settings } from '@/core/settings'
import type { SnapshotEntry } from '@/core/snapshot'

/** Запись снимка целиком: пропущенное поле ломает сборку. */
function entry(mediaId: number, over: Partial<SnapshotEntry> = {}): SnapshotEntry {
  return {
    mediaId,
    malId: mediaId,
    status: 'COMPLETED',
    score10: 0,
    progress: 0,
    repeat: 0,
    startedAt: null,
    completedAt: null,
    notes: null,
    updatedAt: 0,
    isAdult: false,
    romaji: null,
    english: null,
    ...over,
  }
}

/** Что наполнили: убирается после каждой проверки, иначе числа поехали бы между ними. */
const seeded: number[] = []

function seed(rows: SnapshotEntry[]): void {
  for (const row of rows) {
    putEntry(row)
    seeded.push(row.mediaId)
  }
}

/** Облик тайтла в кэш: формат и оценка сообщества приходят только отсюда. */
function brief(mediaId: number, over: Partial<MediaBrief> = {}): void {
  rememberBrief({
    mediaId,
    malId: mediaId,
    type: 'ANIME',
    format: null,
    status: 'FINISHED',
    episodes: null,
    chapters: null,
    seasonYear: null,
    averageScore: null,
    isAdult: false,
    romaji: null,
    english: null,
    native: null,
    cover: null,
    color: null,
    airingEpisode: null,
    airingAt: null,
    ownEntry: null,
    ...over,
  })
}

beforeEach(() => {
  // Тумблер взрослого читается в момент вопроса, поэтому его достаточно выставить в объекте настроек.
  settings.showAdult = false
  seeded.length = 0
})

afterEach(() => {
  for (const mediaId of seeded) dropEntry(mediaId)
})

describe('formatNumber', () => {
  it('ставит разряды через пробел', () => {
    expect(formatNumber(999)).toBe('999')
    expect(formatNumber(1000)).toBe('1 000')
    expect(formatNumber(1234567)).toBe('1 234 567')
  })

  it('округляет до целого и не теряет знак', () => {
    expect(formatNumber(1234.6)).toBe('1 235')
    expect(formatNumber(0)).toBe('0')
  })
})

describe('watchTime', () => {
  it('на пустом списке даёт ноль, а не NaN', () => {
    expect(watchTime(0)).toEqual({ hours: 0, days: 0 })
  })

  it('переводит серии в часы и дни по договорённости', () => {
    // 24 серии по 24 минуты — это 9,6 часа.
    expect(watchTime(24)).toEqual({ hours: 9.6, days: 0.4 })
    // Сотня серий — сорок часов, то есть без малого двое суток.
    expect(watchTime(100)).toEqual({ hours: 40, days: 1.7 })
  })
})

describe('buildStats', () => {
  it('на пустом списке отвечает нулями и пустыми графиками', () => {
    const stats = buildStats()

    expect(stats.titles).toBe(0)
    expect(stats.episodes).toBe(0)
    expect(stats.meanScore).toBe(0)
    expect(stats.statuses).toEqual([])
    expect(stats.years).toEqual([])
    expect(stats.formats).toEqual([])
    // Гистограмма оценок есть всегда: десять колонок с нулями, иначе график исчезал бы целиком.
    expect(stats.scores).toHaveLength(10)
    expect(stats.scores.every((bar) => bar.count === 0 && bar.share === 0)).toBe(true)
  })

  it('считает серии и оценки по видимым записям', () => {
    seed([
      entry(1, { progress: 12, score10: 8 }),
      entry(2, { progress: 8, score10: 6 }),
    ])

    const stats = buildStats()

    expect(stats.titles).toBe(2)
    expect(stats.episodes).toBe(20)
    expect(stats.hours).toBe(8)
    expect(stats.rated).toBe(2)
    expect(stats.meanScore).toBe(7)
    expect(stats.hidden).toBe(0)
  })

  it('прячет взрослое тем же тумблером, что и список, и называет, сколько спрятано', () => {
    seed([entry(1, { progress: 12 }), entry(2, { progress: 100, isAdult: true })])

    const hidden = buildStats()
    expect(hidden.titles).toBe(1)
    expect(hidden.episodes).toBe(12)
    expect(hidden.hidden).toBe(1)

    settings.showAdult = true
    const shown = buildStats()
    expect(shown.titles).toBe(2)
    expect(shown.episodes).toBe(112)
    expect(shown.hidden).toBe(0)
  })

  it('раскладывает закладки по порядку списка и считает доли кольца', () => {
    seed([entry(1), entry(2), entry(3, { status: 'CURRENT' }), entry(4, { status: null })])

    const stats = buildStats()

    expect(stats.statuses.map((slice) => slice.title)).toEqual([
      'Смотрю',
      'Просмотрено',
      'Без закладки',
    ])
    expect(stats.statuses.map((slice) => slice.count)).toEqual([1, 2, 1])
    // Смещение — начало доли: без него каждая дуга кольца начиналась бы сверху.
    expect(stats.statuses.map((slice) => slice.offset)).toEqual([0, 0.25, 0.75])
    expect(stats.statuses.reduce((sum, slice) => sum + slice.share, 0)).toBeCloseTo(1, 10)
    expect(stats.completed).toBe(2)
    expect(stats.running).toBe(1)
  })

  it('называет записи без формата: их и добирает экран', () => {
    seed([entry(1), entry(2, { isAdult: true }), entry(3)])
    brief(1, { format: 'TV' })
    // Взрослому формату не место в кольце: за него экран не спрашивает.
    settings.showAdult = false

    expect(formatlessIds()).toEqual([3])

    // С пришедшим форматом номер уходит из списка добычи: второй раз его не спросят.
    brief(3, { format: 'OVA' })
    expect(formatlessIds()).toEqual([])
  })

  it('раскладывает форматы по кольцу, а неизвестное уводит в конец', () => {
    seed([entry(1), entry(2), entry(3), entry(4)])
    brief(1, { format: 'TV' })
    brief(2, { format: 'TV' })
    brief(3, { format: 'MOVIE' })
    // Четвёртый без облика: формат по кэшу ему не выдумать.

    const stats = buildStats()

    expect(stats.formats.map((slice) => slice.key)).toEqual(['TV', 'MOVIE', 'UNKNOWN'])
    expect(stats.formats.map((slice) => slice.title)).toEqual(['ТВ', 'Фильм', 'Неизвестно'])
    expect(stats.formats.map((slice) => slice.count)).toEqual([2, 1, 1])
    // Смещения — начала долей: кольцо с них и рисуется.
    expect(stats.formats.map((slice) => slice.offset)).toEqual([0, 0.5, 0.75])
    expect(stats.formats.reduce((sum, slice) => sum + slice.share, 0)).toBeCloseTo(1, 10)
  })

  it('строит гистограмму оценок от самой высокой колонки', () => {
    seed([entry(1, { score10: 8 }), entry(2, { score10: 8 }), entry(3, { score10: 6 })])

    const stats = buildStats()
    const at = (score: number) => stats.scores.find((bar) => bar.score === score)

    expect(stats.scores).toHaveLength(10)
    expect(at(8)?.count).toBe(2)
    expect(at(8)?.share).toBe(1)
    expect(at(6)?.count).toBe(1)
    expect(at(6)?.share).toBe(0.5)
    // Ноль оценки колонкой не считается: «оценки нет» — это не «оценка ноль».
    expect(at(1)?.count).toBe(0)
  })

  it('группирует завершённые по годам, а высоту берёт по сериям', () => {
    seed([
      entry(1, { completedAt: '2024-05-01', progress: 10, score10: 8 }),
      entry(2, { completedAt: '2024-11-02', progress: 10, score10: 6 }),
      entry(3, { completedAt: '2025-01-09', progress: 30 }),
      entry(4, { completedAt: null, progress: 5 }),
    ])

    const stats = buildStats()
    const shares = stats.years.map((bar) => bar.share)

    // Запись без даты завершения в годы не попадает: год ей неизвестен.
    expect(stats.years.map((bar) => bar.year)).toEqual([2024, 2025])
    expect(stats.years.map((bar) => bar.titles)).toEqual([2, 1])
    expect(stats.years.map((bar) => bar.episodes)).toEqual([20, 30])
    expect(stats.years.map((bar) => bar.hours)).toEqual([8, 12])
    expect(stats.years[0]?.meanScore).toBe(7)
    expect(stats.years[1]?.meanScore).toBe(0)
    expect(shares[1]).toBe(1)
    expect(shares[0]).toBeCloseTo(20 / 30, 10)
  })
})

describe('spline generation', () => {
  it('на пустом списке точек или одной точке не строит путь', () => {
    expect(smoothPath([])).toBe('')
    expect(smoothPath([{ x: 10, y: 20 }])).toBe('')
    expect(smoothAreaPath([])).toBe('')
    expect(smoothAreaPath([{ x: 10, y: 20 }])).toBe('')
  })

  it('на двух и более точках строит кубическую кривую Безье', () => {
    const points = [
      { x: 100, y: 800 },
      { x: 300, y: 400 },
      { x: 500, y: 200 },
    ]
    const d = smoothPath(points)

    expect(d.startsWith('M 100.0 800.0 C ')).toBe(true)
    expect(d.includes('500.0 200.0')).toBe(true)

    const area = smoothAreaPath(points, 1000)
    expect(area.startsWith(d)).toBe(true)
    expect(area.endsWith('L 500.0 1000.0 L 100.0 1000.0 Z')).toBe(true)
  })

  it('рассчитывает координаты верхушек столбиков с учётом минимальной высоты', () => {
    const bars = [{ share: 0 }, { share: 0.5 }, { share: 1 }]
    const points = pointsForBars(bars)

    expect(points).toHaveLength(3)
    // 3 столбика: центры при x = ((i + 0.5) / 3) * 1000
    expect(points[0]?.x).toBeCloseTo((0.5 / 3) * 1000, 5)
    expect(points[1]?.x).toBeCloseTo((1.5 / 3) * 1000, 5)
    expect(points[2]?.x).toBeCloseTo((2.5 / 3) * 1000, 5)

    // При нуле — высота 0, y = 1000
    expect(points[0]?.y).toBe(1000)
    // При 50% — y = 1000 - 500 = 500
    expect(points[1]?.y).toBe(500)
    // При 100% — y = 1000 - 1000 = 0
    expect(points[2]?.y).toBe(0)
  })
})

describe('сектор кольца', () => {
  it('начинается сверху и замыкается по внутреннему радиусу', () => {
    const d = sectorPath(0, 0.25)

    // −90° — верх кольца: первый сектор начинается там, где его ждёт глаз.
    expect(d.startsWith('M 60.00 3.00')).toBe(true)
    // Две дуги — по внешнему радиусу и обратно по внутреннему — и замыкание.
    expect(d.match(/ A /g)).toHaveLength(2)
    expect(d.endsWith('Z')).toBe(true)
  })

  it('сектор шире половины круга рисуется большой дугой', () => {
    expect(sectorPath(0, 0.25)).toContain('A 57 57 0 0 1')
    expect(sectorPath(0, 0.75)).toContain('A 57 57 0 1 1')
  })

  it('смотрит туда же, куда повёрнута краска: подсказка встаёт на свою долю', () => {
    // Дуги повёрнуты на RING_TURN от начала координат окружности — в верх кольца.
    expect(RING_TURN).toBe('rotate(-90 60 60)')
    expect(sliceAngle(0)).toBe(-90)

    // Начало сектора лежит на луче sliceAngle: сдвиг слоя подсказок на четверть оборота
    // показывал бы подсказку одной доли над другой.
    const hit = /^M ([-\d.]+) ([-\d.]+)/.exec(sectorPath(0.25, 0.25))
    const x = Number(hit?.[1])
    const y = Number(hit?.[2])
    const angle = (Math.atan2(y - 60, x - 60) * 180) / Math.PI

    expect(angle).toBeCloseTo(sliceAngle(0.25), 6)
  })
})

describe('дуги кольца', () => {
  /** Окружность радиуса 44 — та же, что нарисована в разметке. */
  const ring = 2 * Math.PI * 44

  it('длину доли считает по радиусу самой окружности', () => {
    expect(arcDash(1)).toBe(`${ring.toFixed(2)} 0.00`)
    expect(arcDash(0.25)).toBe(`${(ring * 0.25).toFixed(2)} ${(ring * 0.75).toFixed(2)}`)
  })

  it('смещает долю по кольцу назад', () => {
    expect(arcShift(0)).toBe('0.00')
    expect(arcShift(0.25)).toBe(`${(-ring * 0.25).toFixed(2)}`)
  })
})

describe('легенда кольца', () => {
  const slices = [
    { title: 'Смотрю', count: 10, share: 0.5, offset: 0 },
    { title: 'Просмотрено', count: 6, share: 0.3, offset: 0.5 },
    { title: 'В планах', count: 2, share: 0.1, offset: 0.8 },
    { title: 'Брошено', count: 2, share: 0.1, offset: 0.9 },
  ]

  it('оставляет три крупнейших, а хвост собирает одной строкой', () => {
    const { head, tail } = splitLegend(slices)

    expect(head.map((slice) => slice.title)).toEqual(['Смотрю', 'Просмотрено', 'В планах'])
    expect(tail).toEqual({ parts: 1, count: 2, share: 0.1 })
  })

  it('у кольца из трёх секторов и меньше хвоста нет', () => {
    expect(splitLegend(slices.slice(0, 3)).tail).toBeNull()
  })

  it('пустое кольцо — пустая легенда', () => {
    expect(splitLegend([])).toEqual({ head: [], tail: null })
  })
})

