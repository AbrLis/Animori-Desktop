// Единая точка отбора 18+: экраны спрашивают здесь, а не читают ключ настроек сами. Отбор на
// слое показа: свой список не исключение. У строк отбора метки нет: тэги бьются разделом.

import { settings } from './settings'

/** Жанры, которых не бывает при выключенном 18+. Имена серверные: перевод случается позже. */
const ADULT_GENRES: ReadonlySet<string> = new Set(['Hentai'])

/** Разделы справочника тэгов, закрытые целиком. */
const ADULT_TAG_GROUPS: ReadonlySet<string> = new Set(['Sexual Content'])

/** Тэги вне закрытых разделов, которым в меню отбора тоже не место. */
const ADULT_TAG_NAMES: ReadonlySet<string> = new Set([
  'Hentai',
  'Nudity',
  'Prostitution',
])

/** Показывать ли взрослое прямо сейчас: тумблер настроек меняет ответ без перезапуска окна. */
export function adultShown(): boolean {
  return settings.showAdult === true
}

/** Пускать ли аниме в показ. Неизвестный признак считается безопасным: из двух ошибок хуже
 * спрятать половину каталога из-за пустого поля. */
export function adultAllowed(isAdult: boolean | null | undefined): boolean {
  if (isAdult !== true) return true
  return adultShown()
}

/** Пускать ли жанр в меню отбора. Спрашивается именем сервера, а не подписью: подпись переводимая. */
export function genreAllowed(genre: string): boolean {
  if (!ADULT_GENRES.has(genre)) return true
  return adultShown()
}

/** Пускать ли тэг в меню отбора. Метка сервера — лишь первая из трёх проверок. */
export function tagAllowed(tag: {
  name: string
  category?: string | null
  adult?: boolean | null
}): boolean {
  const blocked =
    tag.adult === true ||
    ADULT_TAG_NAMES.has(tag.name) ||
    (typeof tag.category === 'string' && ADULT_TAG_GROUPS.has(tag.category))

  if (!blocked) return true
  return adultShown()
}

/** Отсеивает запрещённое из готовой выдачи; признак берётся снаружи, у каждого вида под своим
 * именем. Возвращает тот же массив, когда прятать нечего. */
export function keepAllowed<T>(
  items: readonly T[],
  isAdultOf: (item: T) => boolean | null | undefined,
): readonly T[] {
  if (adultShown()) return items
  return items.filter((item) => isAdultOf(item) !== true)
}

/** Сколько находок пришлось спрятать: молча съеденные строки выглядят потерей. */
export function hiddenCount<T>(
  items: readonly T[],
  isAdultOf: (item: T) => boolean | null | undefined,
): number {
  if (adultShown()) return 0

  let hidden = 0
  for (const item of items) {
    if (isAdultOf(item) === true) hidden += 1
  }
  return hidden
}

/** Возраст, с которого показ разрешён: то же число, что стоит на метке 18+ у сервера. */
export const ADULT_AGE = 18

/** Сколько полных лет на дату; `null` — дата не годится. Разница годов пропустила бы
 * семнадцатилетнего. Время передаётся доводом: проверка обязана быть повторяемой в тесте. */
export function ageAt(birth: string | null | undefined, now: Date = new Date()): number | null {
  if (typeof birth !== 'string') return null

  const hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birth)
  if (hit === null) return null

  const year = Number(hit[1])
  const month = Number(hit[2])
  const day = Number(hit[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null

  let age = now.getFullYear() - year
  const before =
    now.getMonth() + 1 < month || (now.getMonth() + 1 === month && now.getDate() < day)
  if (before) age -= 1

  return age < 0 ? null : age
}

/** Прошла ли проверка возраста. Негодная дата ответом «да» не считается: ошибка пускала бы
 * вперёд, а не назад. */
export function adultByBirth(birth: string | null | undefined, now: Date = new Date()): boolean {
  const age = ageAt(birth, now)
  return age !== null && age >= ADULT_AGE
}
