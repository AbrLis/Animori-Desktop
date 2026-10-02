/**
 * Геометрия «календарика» активности на главной. Всё, что можно посчитать, считается здесь и
 * подаётся разметке готовым: сетке нельзя доверять арифметику по кругу квадратов, а проверять
 * уровни на глаз невозможно — их четыре, и на глаз они неразличимы.
 *
 * Уровни строятся по рангам счётчиков, а не по круглым порогам вроде «до трёх — первый тон».
 * Круглый порог ломается на живых данных: человек, который смотрит по две серии в день, получил бы
 * ровный однотонный прямоугольник, и сетка перестала бы что-либо показывать. Ранги вместо
 * этого всегда дают разброс по года и остаются сравнимыми между собой.
 */

import {
  activityYear,
  dayTitle,
  type ActivityDay,
  type ActivityEvent,
  type ActivityKind,
} from '@/core/activity'
import { getPlural } from '@/utils/dom'

/** Уровень квадрата: 0 — тишина, 4 — самая плотная треть активных дней. */
export type ActivityLevel = 0 | 1 | 2 | 3 | 4

/** Один квадрат сетки. */
export interface ActivityCell {
  /** Начало местных суток. */
  day: number
  count: number
  level: ActivityLevel
  /** День позже сегодняшнего: его ещё не наступило. */
  future: boolean
  /** День соседнего года в краях сетки: не наш, в счёт не идёт и не открывается. */
  outside: boolean
  /** Сегодняшний: его обводим, иначе в плотной сетке его не найти. */
  today: boolean
  /** Номер месяца 0..11: по нему сетка рисует подписи месяцев. */
  month: number
  /** Подпись для подсказки и для невидимого текста кнопки. */
  title: string
  /** Номер квадрата в раскладке: семь идут вертикально, дальше — следующая колонка. */
  at: number
}

/** Месячная зона: колонка первого дня и слово над ней. */
export interface ActivityMonth {
  /** Номер колонки, в которой месяц начался. */
  at: number
  /** Три буквы: «сен». */
  label: string
}

/** Смещение внутри недели: 0 — понедельник, как и в самой сетке. */
export interface ActivityWeekday {
  at: number
  label: string
}

/**
 * Начало местных суток. Приводит «сегодня» к полуночи: сетка сравнивает дни между собой, и
 * «сегодня» с часами в 15:04 не совпало бы ни с одним квадратом — день в сетке тоже полночь.
 */
function dayStart(stamp: number): number {
  const date = new Date(stamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Месяцы тремя буквами, как их принято подписывать над узкой колонкой. */
const MONTH_SHORT = [
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
] as const

/** Дни недели под колонкой: все семь не поместились бы в ту же ширину, что и месяц. */
const WEEKDAYS: ReadonlyArray<{ at: number; label: string }> = [
  { at: 0, label: 'пн' },
  { at: 2, label: 'ср' },
  { at: 4, label: 'пт' },
]

/** Границы уровней: три квартиля активных счётчиков, от Quiet до громкого дня. */
export interface ActivityBands {
  /** С этого числа событий день считается первым тоном. */
  first: number
  second: number
  third: number
}

/**
 * Границы уровней: три порога по различным счётчикам активных дней.
 *
 * Пороги берутся по рангам *различных* значений, а не по квартилям всех дней подряд. Квартили
 * совпадают там, где счётчиков мало: человек, который смотрит по две серии, даёт счётчик 2 на
 * каждом дне, и второй и третий квартиль сходятся на двойке — уровень 3 становится
 * недостижимым, половина тона пропадает, и сетка читается вдвое беднее, чем она есть.
 * Различные значения заодно разводят пороги строго по возрастанию, иначе на двух-трёх разных
 * счётчиках тоны снова бы слиплись.
 */
export function activityBands(days: ReadonlyArray<ActivityDay>): ActivityBands {
  const distinct = [...new Set(days.map((day) => day.count).filter((count) => count > 0))].sort(
    (a, b) => a - b,
  )

  if (distinct.length === 0) return { first: 1, second: 1, third: 1 }

  // Одна величина — градиента нет вовсе, и делить нечего: год у такого человека либо ровный,
  // и тогда тон сетки задаёт не расклад, а сама величина. Ставим её на абсолютную лестницу
  // (одно событие, два-четыре, пять-девять, десять и больше), иначе один громкий день в тихом
  // году читался бы как обычный — а это единственное, что в том году случилось, и приглушать
  // его нельзя. Лестница покрывает все четыре тона: иначе первый тон был бы недостижим.
  if (distinct.length === 1) return { first: 2, second: 5, third: 10 }

  const rank = (part: number): number =>
    distinct[Math.min(distinct.length - 1, Math.floor(distinct.length * part))] ?? 1

  // Пороги обязаны идти строго вверх: иначе уровень между ними некуда положить.
  let first = rank(0.25)
  let second = rank(0.5)
  let third = rank(0.75)

  if (second <= first) second = first + 1
  if (third <= second) third = second + 1

  return { first, second, third }
}

/** Тон дня по границам: сравнения «не ниже», иначе самый частый счётчик уезжал бы на тон выше. */
export function activityLevel(count: number, bands: ActivityBands): ActivityLevel {
  if (count <= 0) return 0
  if (count >= bands.third) return 4
  if (count >= bands.second) return 3
  if (count >= bands.first) return 2
  return 1
}

/**
 * Раскладка года: неделя — это столбец, внутри семь дней сверху вниз, и сетка читается так же,
 * как календарь, только повёрнутый. Ничего не обрезаем: год приходит из журнала ровно такой длины,
 * какой получился — 52 или 53 колонки, — и обрезка по чужому числу недель отпилила бы декабрь.
 */
export function activityCells(today: number, days?: ReadonlyArray<ActivityDay>): ActivityCell[] {
  const now = dayStart(today)
  const source = days ?? activityYear(now)
  const bands = activityBands(source)

  return source.map((day, at) => {
    const date = new Date(day.day)
    return {
      day: day.day,
      count: day.count,
      level: activityLevel(day.count, bands),
      future: day.future,
      outside: day.outside,
      today: day.day === now,
      month: date.getMonth(),
      title: dayTitle(day.day),
      at,
    }
  })
}

/** Сколько недель-колонок в раскладке: у календарного года их 52 или 53. */
export function activityColumns(cells: ReadonlyArray<ActivityCell>): number {
  return Math.ceil(cells.length / 7)
}

/**
 * Зоны месяцев: колонка первого дня и подпись над ней.
 *
 * Подпись не ограничивается шириной зоны и не обрезается. Прежнее ограничение резало слова
 * пополам: узкому месяцу доставалось «се» вместо «сен», и подпись читалась как опечатка.
 * Наехать друг на друга подписи не могут и без ограничения: месяц занимает не меньше четырёх
 * колонок, а трёх букв в четырёх колонках встаёт с запасом даже при самой узкой сетке — колонка
 * не опускается ниже четырёх пикселей.
 *
 * Зона приходит к колонке, в которой месяц начался, а не к левому краю его дней: 1-е число стоит
 * обычно в середине недели, и колонка, где месяц начался, начинается ещё прошлым месяцем.
 */
export function activityMonths(cells: ReadonlyArray<ActivityCell>): ActivityMonth[] {
  const zones: ActivityMonth[] = []
  let seen = -1

  // Месяц ищем по всем дням подряд, а не по началу колонки: 1-е число стоит обычно в середине
  // недели, и колонка, в которой месяц начался, начинается ещё прошлым месяцем. По началу
  // колонки сентябрь не находился вовсе — зон выходило одиннадцать, а не двенадцать.
  for (let at = 0; at < cells.length; at += 1) {
    const cell = cells[at]
    if (cell === undefined || cell.outside) continue
    if (cell.month === seen) continue

    seen = cell.month
    zones.push({
      at: Math.floor(at / 7),
      label: MONTH_SHORT[cell.month] ?? '',
    })
  }

  return zones
}

/** Подписи дней недели: понедельник, среда, пятница — остальные строки подписать нечем. */
export function activityWeekdays(): ReadonlyArray<ActivityWeekday> {
  return WEEKDAYS
}

/**
 * Сколько дней года не пустых: подписью «пустых» клеток человек понимает, что приложение живо.
 * Чужие дни в краях сетки и ещё не наступившие в счёт не идут: иначе подпись спорила бы с глазом.
 */
export function activityTotals(cells: ReadonlyArray<ActivityCell>): { days: number; events: number } {
  let days = 0
  let events = 0

  for (const cell of cells) {
    if (cell.future || cell.outside || cell.count === 0) continue
    days += 1
    events += cell.count
  }

  return { days, events }
}

/** Куда можно переключить год: левое — назад, правое — вперёд. */
export interface ActivityYearStep {
  /** Есть ли активность в предыдущем году: без неё переключателя нет. */
  prev: boolean
  /** Есть ли активность в следующем году. */
  next: boolean
}

/**
 * Переключатели появляются только там, где есть что показывать. Год без единого дела переключать
 * незачем, а кнопка рядом с годом читалась бы как «там что-то есть». Крайние годы: 2026 — первый,
 * и в 2027-м сетка встаёт на него сама, назад уходят переключателем.
 */
export function activityYearStep(
  shown: number,
  years: ReadonlyArray<number>,
): ActivityYearStep {
  return {
    prev: years.includes(shown - 1),
    next: years.includes(shown + 1),
  }
}

/**
 * Номер клетки, на которую сетка встаёт прокруткой. Год в окно не вмещается почти всегда, и без
 * прокрутки человек видел бы пустой январь вместо того, за чем шёл: сегодняшнего дня. В прошлом
 * году сегодняшнего дня нет, и опорой становится последнее дело года — смотреть пустой декабрь
 * тоже незачем. Ноль — год пуст целиком, и стоит его начало.
 */
export function activityAnchor(
  cells: ReadonlyArray<ActivityCell>,
  currentYear: number,
  shownYear: number,
): number {
  if (shownYear === currentYear) {
    const now = cells.findIndex((cell) => cell.today)
    if (now >= 0) return now
  }

  for (let at = cells.length - 1; at >= 0; at -= 1) {
    const cell = cells[at]
    if (cell !== undefined && cell.count > 0 && !cell.outside) return at
  }

  return 0
}

/** Подпись событий словами: «3 действия», «1 действие», «11 действий». */
export function activityFacts(count: number): string {
  if (count <= 0) return 'без событий'
  return `${count} ${getPlural(count, ['действие', 'действия', 'действий'])}`
}

/** Одно дело дня: вид, серия, закладка, оценка, переход и час. */
export interface ActivityAct {
  /** Ключ для разметки: момент, вид и серия — точнее в одном блоке ничего не повторяется. */
  key: string
  kind: ActivityKind
  /** Номер серии просмотра или новое число серий прогресса; у прочих дел ноль. */
  parts: number
  /** Закладка, которую поставили: ключ AniList; null — не про закладку или запись без поля. */
  mark: string | null
  /** Оценка 0…10; null — не записана, ноль — оценку сняли. */
  score: number | null
  /**
   * С чего шло: прежний балл у оценки, прежнее число серий у прогресса; null — событие старее
   * поля, и переход показать нечем. С ним чипса и говорит главное: «7 → 8», а не просто «8».
   */
  from: number | null
  at: number
}

/** Тайтл дня и всё, что с ним в этот день делали. */
export interface ActivityGroup {
  mediaId: number
  /** Подпись из журнала: переживает перезаход; пусто — экран спросит кэши имён. */
  title: string
  /** Дела по часам: закладка, серия, оценка — как это было у человека. */
  acts: ActivityAct[]
  /** Час последнего дела: по нему блоки и стоят. */
  last: number
}

/**
 * Раскладывает дела дня по тайтлам: один тайтл — один блок. День человек вспоминает тайтлами,
 * а не часами: закладка, просмотр и оценка одного аниме — одна история, даже если между ними
 * успел подвернуться другой тайтл. Внутри блока дела идут по порядку совершения, а блоки стоят
 * свежими сверху: последнее дело дня — то, что помнится, и искать его внизу списка незачем.
 */
export function activityGroups(events: ReadonlyArray<ActivityEvent>): ActivityGroup[] {
  const byMedia = new Map<number, ActivityGroup>()
  const titledAt = new Map<number, number>()

  for (const event of events) {
    let group = byMedia.get(event.mediaId)

    if (group === undefined) {
      group = { mediaId: event.mediaId, title: '', acts: [], last: event.at }
      byMedia.set(event.mediaId, group)
    }

    // Подпись берётся у самого свежего дела с непустой: старое могло лечь до появления поля,
    // и его пустота не должна перебивать имя, добытое позже.
    const seen = titledAt.get(event.mediaId) ?? 0
    if (event.title !== '' && event.at >= seen) {
      group.title = event.title
      titledAt.set(event.mediaId, event.at)
    }

    group.acts.push({
      key: `${event.at}-${event.kind}-${event.episode}`,
      kind: event.kind,
      parts: event.episode,
      mark: event.mark ?? null,
      score: event.score ?? null,
      from: event.from ?? null,
      at: event.at,
    })

    if (event.at > group.last) group.last = event.at
  }

  for (const group of byMedia.values()) group.acts.sort((a, b) => a.at - b.at)

  return [...byMedia.values()].sort((a, b) => b.last - a.last)
}
