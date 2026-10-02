// Проверки календарика активности (`shared/core/activity` и `app/screens/home-activity`).
// Считать дни и тона — работа, которая ломается тихо: сетка либо врёт числами, либо молчит.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  activityAnchor,
  activityBands,
  activityCells,
  activityColumns,
  activityFacts,
  activityGroups,
  activityLevel,
  activityMonths,
  activityTotals,
  activityWeekdays,
  activityYearStep,
} from '@/app/screens/home-activity'
import { dayTitle, type ActivityDay, type ActivityEvent } from '@/core/activity'

import type { MockBridgeHandle } from '@core-tests/bridge'

type Activity = typeof import('@/core/activity')

/** Среда 16 сентября 2026 — «сегодня» для большинства случаев. */
const TODAY = new Date(2026, 8, 16, 15, 4).getTime()

/** Год, который стоит на сетке. */
const YEAR = 2026

function dayStart(stamp: number): number {
  const date = new Date(stamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month, day, hour, minute).getTime()
}

function event(day: number, at0: number, over: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    day: dayStart(day),
    kind: 'watch',
    mediaId: 1,
    episode: 0,
    at: at0,
    title: '',
    ...over,
  }
}

/**
 * Все дни сетки календарного года: от понедельника недели с 1 января по воскресенье недели
 * с 31 декабря. Края намеренно вылезают за год — так их рисует журнал, и тест обязан знать
 * ту же раскладку, что и экран.
 */
function yearDays(year: number): number[] {
  const first = new Date(year, 0, 1)
  const last = new Date(year, 11, 31)
  const from = new Date(year, 0, 1 - ((first.getDay() + 6) % 7))
  const to = new Date(year, 11, 31 + 6 - ((last.getDay() + 6) % 7))
  const out: number[] = []

  for (let d = new Date(from); d <= to; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    out.push(d.getTime())
  }

  return out
}

/** Год с заданными счётчиками. Счётчик на каждый день сетки, чужие дни обнуляются. */
function yearWith(counts: ReadonlyArray<number>, year = YEAR): ActivityDay[] {
  const now = dayStart(TODAY)
  const first = new Date(year, 0, 1).getTime()
  const after = new Date(year + 1, 0, 1).getTime()

  return yearDays(year).map((day, at) => {
    const inside = day >= first && day < after
    const count = inside ? (counts[at] ?? 0) : 0
    const events: ActivityEvent[] = []

    for (let n = 0; n < count; n += 1) events.push(event(day, day + n * 1000))

    return { day, count, events, future: inside && day > now, outside: !inside }
  })
}

/** Пустой год сетки: 371 день руками не набирается. */
function blankYear(year = YEAR): ActivityDay[] {
  return yearWith([], year)
}


describe('календарик активности: границы года', () => {
  it('начинается слева с января и кончается справа декабрём', () => {
    const cells = activityCells(TODAY, blankYear())
    const first = cells.find((cell) => !cell.outside)
    const last = cells.filter((cell) => !cell.outside).pop()

    expect(new Date(first?.day ?? 0).getMonth()).toBe(0)
    expect(new Date(first?.day ?? 0).getDate()).toBe(1)
    expect(new Date(last?.day ?? 0).getMonth()).toBe(11)
    expect(new Date(last?.day ?? 0).getDate()).toBe(31)
  })

  it('держит в календарном году 365 дней, а не 53 недели', () => {
    const cells = activityCells(TODAY, blankYear())

    expect(cells.filter((cell) => !cell.outside)).toHaveLength(365)
    expect(activityColumns(cells)).toBe(53)
  })

  it('сетка соседнего года не наследует чужие края: у 2027-го своя первая колонка', () => {
    const cells = activityCells(TODAY, blankYear(2027))
    const first = cells[0]
    const last = cells[cells.length - 1]

    // Края сетки — только рядовые слоты: события в них никогда не лежат, а в следующий год
    // первым идёт уже декабрь 2026-го, а не декабрь 2025-го. Дни 2025-го в сетку 2027-го не попадают.
    expect(new Date(first?.day ?? 0).getFullYear()).toBe(2026)
    expect(new Date(last?.day ?? 0).getFullYear()).toBe(2028)
    expect(cells.some((cell) => new Date(cell.day).getFullYear() === 2025)).toBe(false)
  })

  it('помечает дни соседнего года в краях и не считает их', () => {
    const cells = activityCells(TODAY, blankYear())
    const outside = cells.filter((cell) => cell.outside)

    // 1 января 2026 — четверг, значит неделя начинается 29 декабря 2025; 31 декабря 2026 тоже
    // четверг, и её неделя кончается 3 января 2027. Три дня там и три тут.
    expect(outside).toHaveLength(6)
    for (const cell of outside) {
      expect(cell.future).toBe(false)
      expect(cell.count).toBe(0)
    }
  })

  it('ставит сегодняшний день ровно один раз и в свой год', () => {
    const cells = activityCells(TODAY, blankYear())

    expect(cells.filter((cell) => cell.today)).toHaveLength(1)
    expect(cells.find((cell) => cell.today)?.outside).toBe(false)
  })

  it('не режет декабрь обрезанием по чужому числу недель', () => {
    // Прежняя сетка резалась по 53 неделям, и в високосном году январь с декабрём в неё не влезали.
    const leap = activityCells(at(2024, 5, 15), blankYear(2024))
    const december = leap.filter((cell) => !cell.outside && new Date(cell.day).getMonth() === 11)

    expect(december).toHaveLength(31)
  })
})

describe('календарик активности: геометрия', () => {
  it('кладёт семь дней в колонку недели, а неделю — в колонку календаря', () => {
    const cells = activityCells(TODAY, blankYear())

    // Неделя начинается с понедельника, поэтому первый день сетки — понедельник.
    expect(new Date(cells[0]?.day ?? 0).getDay()).toBe(1)
    expect(cells).toHaveLength(activityColumns(cells) * 7)
  })

  it('рисует все дни года, включая пустые: тишина тоже часть года', () => {
    const days = blankYear()
    days[100]!.count = 3
    days[100]!.events = [event(days[100]!.day, days[100]!.day + 60_000)]

    expect(activityCells(TODAY, days)[100]?.level).toBeGreaterThan(0)
  })

  it('раздаёт тон ровному человеку, а не оставляет сетку пустой', () => {
    // Ровный человек по две серии в день: круглый порог по всем дням дал бы один ровный тон.
    // Чужие дни в краях сетки молчат, поэтому ровнота смотрится по дням года.
    const cells = activityCells(TODAY, yearWith(new Array(371).fill(2))).filter((cell) => !cell.outside)

    expect(new Set(cells.map((cell) => cell.level)).size).toBe(1)
    expect(cells[0]?.level).toBeGreaterThan(0)
  })

  it('тон при одной величине идёт от неё самой, а не от её ранга', () => {
    // Одна величина в году — градиента нет: тон обязан читаться как «много», иначе единственный
    // громкий день за год выглядел бы так же, как самый обычный.
    const loud = yearWith(new Array(371).fill(0))
    loud[200]!.count = 40
    expect(activityCells(TODAY, loud)[200]?.level).toBe(4)

    expect(activityCells(TODAY, yearWith(new Array(371).fill(2)))[200]?.level).toBe(2)
    expect(activityCells(TODAY, yearWith(new Array(371).fill(1)))[200]?.level).toBe(1)
  })

  it('пустой год не делится на ноль и остаётся читаемым', () => {
    const bands = activityBands([])

    expect(bands).toEqual({ first: 1, second: 1, third: 1 })
    expect(activityLevel(0, bands)).toBe(0)
    expect(activityLevel(1, bands)).toBe(4)
  })

  it('один громкий день среди тишины не красит всю сетку', () => {
    const counts = new Array(371).fill(0)
    counts[200] = 40
    const cells = activityCells(TODAY, yearWith(counts))

    expect(cells[200]?.level).toBe(4)
    expect(cells[199]?.level).toBe(0)
    expect(cells[201]?.level).toBe(0)
  })

describe('календарик активности: подписи', () => {
  it('ставит подпись в начало своего месяца и отмечает все границы', () => {
    const months = activityMonths(activityCells(TODAY, blankYear()))

    expect(months.length).toBe(12)
    // Первая зона — январь, хотя колонка с 1 января начинается 29 декабря 2025: подпись берётся
    // по первому дню года в колонке, а не по первому дню колонки.
    expect(months[0]?.label).toBe('янв')
    expect(months[months.length - 1]?.label).toBe('дек')

    // Границы идут подряд, без пропусков: пропустилась бы зона, и календарь поехал бы.
    for (let i = 1; i < months.length; i += 1) {
      expect(months[i]!.at).toBeGreaterThan(months[i - 1]!.at)
    }
  })

  it('подписывает все двенадцать месяцев целым словом', () => {
    // Подпись не ограничена шириной зоны: прежнее ограничение резало слово пополам, и узкому
    // месяцу доставалось «се» вместо «сен».
    const months = activityMonths(activityCells(TODAY, blankYear()))

    expect(months.map((month) => month.label)).toEqual([
      'янв',
      'фев',
      'мар',
      'апр',
      'май',
      'июн',
      'июл',
      'авг',
      'сен',
      'окт',
      'ноя',
      'дек',
    ])

    // Наехать друг на друга подписи не могут и без ограничения: месяц занимает не меньше четырёх
    // колонок, а трёх букв в четырёх колонках встаёт с запасом даже при самой узкой сетке.
    for (let i = 1; i < months.length; i += 1) {
      expect(months[i]!.at - months[i - 1]!.at).toBeGreaterThanOrEqual(4)
    }
  })

  it('ставит зону месяца в колонку его первого дня, а не в начало недели', () => {
    const cells = activityCells(TODAY, blankYear())
    const september = activityMonths(cells)[8]
    const at = september?.at ?? 0

    // 1 сентября 2026 — вторник, то есть вторая строка недели. Зона приходит к колонке, в которой
    // месяц начался, а первый день стоит в ней не сверху: подпись над началом недели встала бы
    // над чужими днями и врала бы на шесть клеток.
    expect(new Date(cells[at * 7]?.day ?? 0).getMonth()).toBe(7)
    expect(new Date(cells[at * 7 + 1]?.day ?? 0).getMonth()).toBe(8)
    expect(new Date(cells[at * 7 + 1]?.day ?? 0).getDate()).toBe(1)
  })

  it('находит первое число месяца в его зоне, какой бы строкой недели оно ни было', () => {
    const cells = activityCells(TODAY, blankYear())

    activityMonths(cells).forEach((month, index) => {
      const week = cells.slice(month.at * 7, month.at * 7 + 7)
      const first = week.find(
        (cell) => !cell.outside && cell.month === index && new Date(cell.day).getDate() === 1,
      )

      // Иначе подпись месяца висела бы над колонкой, где его первого дня нет вовсе.
      expect(first).toBeDefined()
    })
  })

  it('подписывает дни недели тремя строками', () => {
    expect(activityWeekdays().map((day) => day.at)).toEqual([0, 2, 4])
  })

  it('считает в итогах только дни года, которые уже были', () => {
    const days = blankYear()
    days[10]!.count = 2
    days[20]!.count = 5
    const tail = days.length - 1
    days[tail]!.count = 9

    const cells = activityCells(TODAY, days)

    // Край года — чужие дни, и хвост года — ещё не наступившие: ни то, ни другое в счёт не идёт.
    expect(cells[tail]?.outside).toBe(true)
    expect(activityTotals(cells)).toEqual({ days: 2, events: 7 })
  })

  it('склоняет число действий по-русски', () => {
    expect(activityFacts(0)).toBe('без событий')
    expect(activityFacts(1)).toBe('1 действие')
    expect(activityFacts(3)).toBe('3 действия')
    expect(activityFacts(11)).toBe('11 действий')
  })

  it('подписывает день словами: день недели, число и месяц', () => {
    expect(dayTitle(at(2026, 8, 16))).toBe('среда, 16 сентября')
  })
})

describe('календарик активности: блоки дня', () => {
  const DAY = at(2026, 8, 16, 0)

  it('складывает дела одного тайтла в один блок, а разные — в разные', () => {
    // Ликорис: закладка утром, серия днём, закладка «Просмотрено» и оценка вечером. Другой тайтл
    // вклинился между ними — и всё равно остаётся своим блоком.
    const groups = activityGroups([
      event(DAY, at(2026, 8, 16, 9), { mediaId: 7, kind: 'status', mark: 'CURRENT', title: 'Ликорис Рикоил' }),
      event(DAY, at(2026, 8, 16, 14), { mediaId: 9, kind: 'watch', episode: 2, title: 'Другой тайтл' }),
      event(DAY, at(2026, 8, 16, 20), { mediaId: 7, kind: 'watch', episode: 1 }),
      event(DAY, at(2026, 8, 16, 21), { mediaId: 7, kind: 'status', mark: 'COMPLETED' }),
      event(DAY, at(2026, 8, 16, 22), { mediaId: 7, kind: 'score', score: 8 }),
    ])

    expect(groups.map((group) => group.mediaId)).toEqual([7, 9])
    expect(groups[0]?.acts.map((act) => act.kind)).toEqual(['status', 'watch', 'status', 'score'])
    expect(groups[0]?.acts.map((act) => act.mark)).toEqual(['CURRENT', null, 'COMPLETED', null])
    expect(groups[0]?.acts[3]?.score).toBe(8)
  })

  it('ставит блоки свежими сверху, а дела внутри блока — по часам', () => {
    const groups = activityGroups([
      event(DAY, at(2026, 8, 16, 8), { mediaId: 3, kind: 'note', title: 'Ранний' }),
      event(DAY, at(2026, 8, 16, 23), { mediaId: 4, kind: 'add', title: 'Поздний' }),
      event(DAY, at(2026, 8, 16, 12), { mediaId: 3, kind: 'score', score: 7 }),
    ])

    expect(groups.map((group) => group.mediaId)).toEqual([4, 3])
    expect(groups[1]?.acts.map((act) => act.kind)).toEqual(['note', 'score'])
  })

  it('берёт подпись у самого свежего дела с непустой, а не у первого попавшегося', () => {
    // Старое дело легло до появления поля: пустота не должна перебивать имя, добытое позже.
    const groups = activityGroups([
      event(DAY, at(2026, 8, 16, 21), { mediaId: 5, title: 'Ликорис Рикоил' }),
      event(DAY, at(2026, 8, 16, 9), { mediaId: 5, title: '' }),
    ])

    expect(groups[0]?.title).toBe('Ликорис Рикоил')
  })

  it('не выдумывает дела пустому дню', () => {
    expect(activityGroups([])).toEqual([])
  })
})

describe('календарик активности: переключатели лет', () => {
  it('показывает стрелку только туда, где в году есть активность', () => {
    // 2026 — первый и крайний год: назад некуда, вперёд пусто.
    expect(activityYearStep(2026, [2026])).toEqual({ prev: false, next: false })

    // Наступил 2027: сетка встала на него сама, и назад ведёт 2026 со своими делами.
    expect(activityYearStep(2027, [2026, 2027])).toEqual({ prev: true, next: false })

    // Ушли назад сами: вперёд возвращает в 2027, где активность уже есть.
    expect(activityYearStep(2026, [2026, 2027])).toEqual({ prev: false, next: true })
  })

  it('через пустой год не переключает: за ним всё равно нечего смотреть', () => {
    // Активность есть в 2028-м, но из 2026-го на него не прыгнуть: 2027-й пуст, и сетка встала бы
    // на пустоту. Год на месте — значит, переключаются только соседние.
    expect(activityYearStep(2026, [2026, 2028])).toEqual({ prev: false, next: false })
  })
})

describe('календарик активности: опора прокрутки', () => {
  it('в нынешнем году встаёт на сегодняшний день, хоть бы и в пустом', () => {
    const cells = activityCells(TODAY, blankYear())
    const today = cells.findIndex((cell) => cell.today)

    // Год в окно не вмещается почти всегда: без прокрутки человек видел бы пустой январь.
    expect(today).toBeGreaterThan(0)
    expect(activityAnchor(cells, YEAR, YEAR)).toBe(today)
  })

  it('в прошлом году встаёт на последнее дело года, а не на его начало', () => {
    const counts: number[] = new Array(370).fill(0)
    counts[100] = 1
    counts[140] = 1

    const cells = activityCells(TODAY, yearWith(counts, YEAR - 1))

    // Сегодняшнего дня в прошлом году нет: опора — последнее дело, а не декабрь в пустоту.
    expect(activityAnchor(cells, YEAR, YEAR - 1)).toBe(140)
  })

  it('в пустом году встаёт на начало: прокручивать всё равно некуда', () => {
    const cells = activityCells(TODAY, blankYear(YEAR - 1))

    expect(activityAnchor(cells, YEAR, YEAR - 1)).toBe(0)
  })
})

describe('календарик активности: журнал', () => {
  let act: Activity
  let mock: MockBridgeHandle | null = null

  beforeEach(async () => {
    vi.resetModules()
    mock = null

    // Мост ставится в том же поколении реестра, что и проверяемый модуль: иначе `@/bridge`
    // внутри activity оказался бы другим экземпляром и писал бы мимо подмены.
    const mocks = await import('@core-tests/bridge-module')
    mock = mocks.installMockBridge()
    act = await import('@/core/activity')
    await act.whenActivityReady()
  })

  afterEach(() => {
    act.flushActivity()
  })

  it('раскладывает события по местным суткам, а не по часам в UTC', () => {
    // Полночь по местному времени: в UTC это предыдущие сутки, и сетка уехала бы на день назад.
    act.noteActivity('status', 11, 0, at(2026, 8, 16, 0, 30))
    act.noteActivity('status', 12, 0, at(2026, 8, 16, 23, 30))

    expect(act.activityOf(dayStart(at(2026, 8, 16)))).toHaveLength(2)
    expect(act.activityOf(dayStart(at(2026, 8, 17)))).toHaveLength(0)
  })

  it('читает сутки свежими сверху, как и положено списку действий за день', () => {
    act.noteActivity('watch', 21, 1, at(2026, 8, 16, 9))
    act.noteActivity('watch', 22, 1, at(2026, 8, 16, 20))

    expect(act.activityOf(dayStart(at(2026, 8, 16))).map((row) => row.mediaId)).toEqual([22, 21])
  })

  it('плеер в журнал больше не пишет: просмотр отмечает человек сам', async () => {
    const keep = await import('@/app/screens/player-keep')
    const what = { title: 'Ликорис Рикоил', cover: null, voiceLabel: 'Сабы' }
    const key = keep.spotKey(88, 'voice', 1)

    await keep.whenWatchReady()
    keep.rememberSpot(key, 600, 1440, what)
    keep.finishSpot(key, 1440, what)
    keep.flushWatchKeep()

    // История просмотра жива: что смотрели и где остановились, экран Истории показывает.
    expect(keep.peekHistory()).toHaveLength(1)

    // Календарь молчит. Плеер не отличает просмотр от перемотки, а его отметка стоила «Серия 1
    // просмотрена» после того, как человек лишь заглянул в середину.
    expect(act.activityOf(dayStart(Date.now()))).toHaveLength(0)
  })

  it('не пишет событие без тайтла: нулевой номер в журнале ничего не значит', () => {
    act.noteActivity('watch', 0, 1, at(2026, 8, 16, 21))

    expect(act.activityOf(dayStart(at(2026, 8, 16)))).toHaveLength(0)
  })

  it('кладёт в год только события своего года, прошлые и будущие не тащит', () => {
    act.noteActivity('watch', 51, 1, at(2025, 11, 30, 12))
    act.noteActivity('watch', 52, 1, at(2026, 0, 20, 12))
    act.noteActivity('watch', 53, 1, at(2027, 0, 5, 12))

    const year = act.activityYear(at(2026, 0, 20))

    expect(year.reduce((sum, day) => sum + day.count, 0)).toBe(1)
  })

  it('будит подписчика сразу, а сетка не должна спрашивать хранилище по кнопке', () => {
    let hits = 0
    const stop = act.watchActivity(() => {
      hits += 1
    })

    act.noteActivity('note', 61, 0, at(2026, 8, 16, 12))
    stop()
    act.noteActivity('note', 62, 0, at(2026, 8, 16, 13))

    expect(hits).toBe(1)
  })

  it('хранит подпись тайтла в самом событии: кэшу имён после перезахода верить нельзя', () => {
    act.noteActivity('score', 71, 0, at(2026, 8, 16, 12), { title: 'Ликорис Рикоил', score: 8 })

    const row = act.activityOf(dayStart(at(2026, 8, 16)))[0]

    expect(row?.title).toBe('Ликорис Рикоил')
    expect(row?.score).toBe(8)
  })

  it('берёт закладку и число серий у прогресса, а не выдумывает их', () => {
    act.noteActivity('status', 72, 0, at(2026, 8, 16, 12), { mark: 'COMPLETED' })
    act.noteActivity('progress', 72, 5, at(2026, 8, 16, 13))

    const rows = act.activityOf(dayStart(at(2026, 8, 16)))

    // Свежие сверху: первым идёт прогресс — он и несёт число серий.
    expect(rows[0]?.episode).toBe(5)
    expect(rows[0]?.mark).toBeUndefined()
    expect(rows[1]?.mark).toBe('COMPLETED')
  })

  it('дозаполняет подписи старых событий и не трогает уже подписанные', () => {
    act.noteActivity('watch', 81, 1, at(2026, 8, 16, 10))
    act.noteActivity('watch', 82, 1, at(2026, 8, 16, 11), { title: 'Уже с именем' })

    const named = act.fillActivityTitles((mediaId) => (mediaId === 81 ? 'Ликорис Рикоил' : ''))

    expect(named).toBe(1)

    const rows = act.activityOf(dayStart(at(2026, 8, 16)))
    expect(rows.find((row) => row.mediaId === 81)?.title).toBe('Ликорис Рикоил')
    expect(rows.find((row) => row.mediaId === 82)?.title).toBe('Уже с именем')

    // Второй заход искать нечего: подпись уже стоит, и чужое имя её не перебьёт.
    expect(act.fillActivityTitles(() => 'Другое')).toBe(0)
  })

  it('видит подпись после перезахода: она едет в журнале, а не в кэшах запуска', async () => {
    vi.resetModules()

    // Свежее поколение реестра с тем же хранилищем: так выглядит обычный перезапуск приложения.
    const fresh = await import('@core-tests/bridge-module')
    const handle = fresh.installMockBridge()
    await handle.bridge.storage.set('AM_ACTIVITY', [
      {
        day: dayStart(at(2026, 8, 16)),
        kind: 'score',
        mediaId: 91,
        episode: 0,
        at: at(2026, 8, 16, 12),
        title: 'Ликорис Рикоил',
        score: 8,
        from: 7,
      },
    ])

    const again = await import('@/core/activity')
    await again.whenActivityReady()

    const row = again.activityOf(dayStart(at(2026, 8, 16)))[0]

    expect(row?.title).toBe('Ликорис Рикоил')
    expect(row?.score).toBe(8)
    expect(row?.from).toBe(7)
  })

  it('берёт переход из правки записи: с чего на что шли оценка, прогресс и пересмотры', async () => {
    const collection = await import('@/core/collection')

    // Первая правка заводит запись — она считается добавлением, а не сменой закладки.
    collection.editEntry(74, 'status', 'CURRENT')
    collection.editEntry(74, 'score', 7)
    collection.editEntry(74, 'score', 8)
    collection.editEntry(74, 'progress', 5)
    collection.editEntry(74, 'repeat', 1)
    collection.editEntry(74, 'repeat', 2)

    const rows = act.activityOf(dayStart(Date.now()))

    expect(rows.find((row) => row.kind === 'add')?.mark).toBe('CURRENT')

    // Оценка: сначала поставлена (ноль — раньше её не было), потом изменена. Переход виден.
    const scores = rows
      .filter((row) => row.kind === 'score')
      .map((row) => `${row.from} → ${row.score}`)
      .sort()
    expect(scores).toEqual(['0 → 7', '7 → 8'])

    const steps = rows.filter((row) => row.kind === 'progress')
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ episode: 5, from: 0 })

    // Пересмотры — свой вид со своим счётчиком, а не прогресс без числа.
    const repeats = rows.filter((row) => row.kind === 'repeat')
    expect(repeats.map((row) => `${row.from} → ${row.episode}`).sort()).toEqual(['0 → 1', '1 → 2'])
  })

  it('дата окончания не плодит второй статус: закладку меняли один раз', async () => {
    const collection = await import('@/core/collection')

    // Тот же жест, что в шторке правки: «Просмотрено» кладёт дату рядом с собой. Дата — часть
    // закладки, и своей строки у неё нет, иначе рядом вставало «Статус изменён».
    collection.editEntry(75, 'status', 'COMPLETED')
    collection.editEntry(75, 'completedAt', '2026-09-16')
    collection.editEntry(75, 'startedAt', '2026-04-01')

    const rows = act.activityOf(dayStart(Date.now()))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('add')
  })

  it('убирает запись из списка целиком: и параметры, и след в журнале', async () => {
    const collection = await import('@/core/collection')
    const look = { romaji: 'Lycoris Recoil', english: null, isAdult: false }

    collection.editEntry(76, 'status', 'COMPLETED', look)
    collection.editEntry(76, 'score', 9)
    collection.editEntry(76, 'remove', null, look)

    // Записи нет — из неё уходят и список, и статистика: обе считают по коллекции.
    expect(collection.getEntry(76)).toBeUndefined()

    const rows = act.activityOf(dayStart(Date.now()))
    const drops = rows.filter((row) => row.kind === 'remove')

    // След в журнале остаётся с подписью: год за убранным тайтлом не должен пустеть.
    expect(drops).toHaveLength(1)
    expect(drops[0]?.title).toBe('Lycoris Recoil')
  })

  it('знает годы с активностью: переключателю не из чего вырасти, если года нет', () => {
    act.noteActivity('watch', 95, 1, at(2025, 11, 30, 12))
    act.noteActivity('watch', 96, 1, at(2026, 0, 20, 12))

    // 2026 — первый и крайний год журнала, и по нему одной строкой видно, что назад некуда.
    expect(act.activityYears()).toEqual([2025, 2026])
  })

  it('стирает журнал по кнопке из настроек и кладёт пустоту в хранилище не отложенно', async () => {
    act.noteActivity('watch', 91, 1, at(2026, 8, 16, 10))

    let hits = 0
    const stop = act.watchActivity(() => {
      hits += 1
    })

    act.clearActivity()
    stop()

    expect(act.activityOf(dayStart(at(2026, 8, 16)))).toHaveLength(0)

    // Сетка гаснет по подписчику: экран не должен ждать чтения, чтобы увидеть пустоту.
    expect(hits).toBe(1)

    // Пустота ложится сразу, а не отложенным сроком: уход с экрана настроек отложенную запись
    // не дождался бы, и история всплыла бы после перезапуска.
    await vi.waitFor(() => {
      const put = mock?.calls.storageSet.find((row) => row.key === 'AM_ACTIVITY')
      expect(put?.value).toEqual([])
    })
  })
})

})
