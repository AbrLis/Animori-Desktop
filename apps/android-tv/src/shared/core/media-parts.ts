// Записи каталога, отвечающие одному номеру MAL: AniList дробит часть на этапы, номер оставляя общим.
// orderParts задаёт порядок записей части (вышедшие впереди обещанных), pickEntry — какая запись её представляет.

/** Начало выпуска записи. Месяц и день бывают неизвестны. */
export interface PartDate {
  year: number | null
  month: number | null
  day: number | null
}

/** Запись каталога в том виде, в каком её видит порядок. */
export interface PartEntry {
  id: number
  status: string | null
  startDate: PartDate | null
}

/** Состояние выпуска, у которого ни одной серии ещё не вышло. */
const SOON = 'NOT_YET_RELEASED'

/** Начало выпуска числом для сравнения. Отсутствующие месяц и день считаются поздними, а
 * запись без даты вовсе — самой поздней: ей спешить некуда. */
export function startStamp(date: PartDate | null | undefined): number {
  const year = date?.year
  const month = date?.month
  const day = date?.day

  if (typeof year !== 'number' || year <= 0) return Number.MAX_SAFE_INTEGER

  return year * 10000 + (typeof month === 'number' ? month : 12) * 100 +
    (typeof day === 'number' ? day : 31)
}

/** Вышедшая запись впереди обещанной: из двух нужнее та, что открывается. */
function rank(entry: PartEntry): number {
  return entry.status === SOON ? 1 : 0
}

/** Порядок записей одной части: состояние выпуска, затем начало, затем номер записи. Номер
 * при равных датах нужен, иначе порядок зависел бы от порядка ответа службы. */
export function orderParts(a: PartEntry, b: PartEntry): number {
  return rank(a) - rank(b) || startStamp(a.startDate) - startStamp(b.startDate) || a.id - b.id
}

/** Запись, которой часть представлена на месте: своя (`mine`), иначе первая по порядку.
 * Пустой список — `null`: часть, которой нет в каталоге, представлять нечем. */
export function pickEntry<T extends PartEntry>(list: readonly T[], mine: number | null): T | null {
  if (list.length === 0) return null

  if (mine !== null) {
    const own = list.find((entry) => entry.id === mine)
    if (own) return own
  }

  return [...list].sort(orderParts)[0] as T
}
