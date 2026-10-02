// Сроки хранения складских записей: одно место на всех, файл видно целиком. Разброс ±20 %
// считается от ключа, иначе запись то свежая, то просроченная. Бессрочное — LIFE_FOREVER.

export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

/** Бессрочно: запись верна, пока её не снесут вручную из настроек. */
export const LIFE_FOREVER = Number.POSITIVE_INFINITY

/** Завершённый тайтл: неделя — меняться там может только средняя оценка. */
export const LIFE_CARD_FINISHED = 7 * DAY_MS

/** Идущий тайтл: сутки — иначе карточка неделю обещает вчерашнюю серию. */
export const LIFE_CARD_AIRING = DAY_MS

/** Персонажи и авторы: состав снят с готового тайтла и уже не изменится. */
export const LIFE_PEOPLE = LIFE_FOREVER

/** Справочник тэгов каталога: около тысячи семисот строк, новые появляются раз в месяцы. */
export const LIFE_TAGS = 30 * DAY_MS

/** Жанры тайтла: заданы при выпуске и не правятся. */
export const LIFE_GENRES = LIFE_FOREVER

/** Полка «Сейчас выходит»: сезон меняется четыре раза в год, состав — реже суток. */
export const LIFE_SHELF_AIRING = 6 * HOUR_MS

/** Полка «В тренде»: единственная, где смысл в самой свежести. */
export const LIFE_SHELF_TRENDING = 2 * HOUR_MS

/** Полка «Лучшее»: список верхних оценок за сутки не сдвигается. */
export const LIFE_SHELF_TOP = DAY_MS

export const LIFE_SHELF_GENRE = DAY_MS

/** Советы «по мотивам»: голоса за связи набираются месяцами. */
export const LIFE_RECS = DAY_MS

/** Выдача поиска и ленты: четверть часа в памяти, на склад не ложится. */
export const LIFE_SEARCH = 15 * MINUTE_MS
export const LIFE_FEED = 15 * MINUTE_MS

/** Метка «да»: неделя — вход пропадает разве что вместе со службой. */
export const LIFE_PLAY_YES = 7 * DAY_MS

/** Метка «нет» у идущего: сутки — к следующей серии озвучка может появиться. */
export const LIFE_PLAY_NO_AIRING = DAY_MS

/** Метка «нет» у завершённого: две недели — иначе вся сетка старых тайтлов платит заново. */
export const LIFE_PLAY_NO_FINISHED = 14 * DAY_MS

/** Озвучки Kodik у идущего: сутки — адреса постоянны, меняется состав серий. */
export const LIFE_VOICES_AIRING = DAY_MS

/** То же у завершённого тайтла: неделя. Новых серий там уже не будет. */
export const LIFE_VOICES_FINISHED = 7 * DAY_MS

/** Соответствие «наш тайтл → релиз Aniliberty»: номер релиза за ним закреплён. */
export const LIFE_ALIB_MATCH = LIFE_FOREVER

/** Промах поиска Aniliberty: сутки. Релиз мог выйти вчера. */
export const LIFE_ALIB_MISS = DAY_MS

/** Отказ по человеку: неделя — к следующему выпуску датасета имя могло появиться. */
export const LIFE_PERSON_MISS = 7 * DAY_MS

/** Как часто спрашивать опись датасета: полсуток, запуск бывает и раз в месяц. Разброс по
 * ключу разносит проверки разных установок, а не сгоняет их в один час. */
export const LIFE_DATASET_CHECK = 12 * HOUR_MS

/** Кадры и ролики: месяц — набор кадров пополняется неделями, а запись весит полсотни адресов. */
export const LIFE_SHOTS = 30 * DAY_MS

/** Насколько срок гуляет в обе стороны. Двадцать процентов от самого срока. */
const SPREAD = 0.2

/** Множитель разброса для ключа: устойчивое число из диапазона 0,8…1,2. Свёртка простая
 * нарочно: это способ получить из строки одно число, а не хеш для сравнения. */
function spreadFactor(key: string): number {
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) % 100_000_007
  }

  const steps = Math.round(SPREAD * 200) + 1
  const shift = (hash % steps) / 100 - SPREAD
  return 1 + shift
}

/** Свежа ли складская запись; ключ участвует ради разброса. Запись из будущего считается
 * свежей: выбросить склад из-за переставленных часов — худший ответ. */
export function isFresh(key: string, ts: number | null | undefined, life: number): boolean {
  if (typeof ts !== 'number' || ts <= 0) return false
  if (!Number.isFinite(life)) return true

  const age = Date.now() - ts
  if (age < 0) return true

  return age < life * spreadFactor(key)
}

/** Свежа ли запись в памяти запуска. Разброса нет: залпа после истечения не будет. */
export function isFreshAt(at: number | null | undefined, life: number): boolean {
  if (typeof at !== 'number' || at <= 0) return false
  if (!Number.isFinite(life)) return true

  const age = Date.now() - at
  return age < 0 || age < life
}
