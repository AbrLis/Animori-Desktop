// Поиск тайтлов по русскому слову у Shikimori: даёт номера MAL для выписки из AniList.
// AniList кириллицу не понимает, поэтому русское слово ищется только тут. Находки живут в памяти четверть часа.

import { LIFE_SEARCH } from '../core/cache-life'
import { Logger } from '../utils/logger'
import { fetchShiki } from './shikimori'

export const SHIKI_SEARCH_LIMIT = 20

const MEMORY_MAX = 30

interface ShikiSearchRow {
  id?: number
  name?: string | null
  russian?: string | null
}

/** Одна находка Шикимори: номер здесь — номер MyAnimeList, они совпадают. */
export interface ShikiFound {
  malId: number
  russian: string | null
  name: string | null
}

const memory = new Map<string, { at: number; found: ShikiFound[] }>()

/** Есть ли в слове кириллица: по этому признаку русское слово идёт в Шикимори, а латиница — в каталог AniList. */
export function hasCyrillic(word: string): boolean {
  return /[\u0400-\u04FF]/.test(word)
}

function textOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** Одно написание слова на все сравнения: регистр не важен, края обрезаются, пробелы сводятся к одному. */
function fold(word: string): string {
  return word.trim().toLowerCase().replace(/\s+/g, ' ')
}

function remember(key: string, found: ShikiFound[]): void {
  // Повторная запись переставляет слово в конец: вытесняется то, к чему давно не возвращались.
  memory.delete(key)
  memory.set(key, { at: Date.now(), found })

  while (memory.size > MEMORY_MAX) {
    const oldest = memory.keys().next()
    if (oldest.done) break

    memory.delete(oldest.value)
  }
}

/** Забывает найденное по словам: нужно ручной чистке склада. */
export function forgetShikiSearch(): void {
  memory.clear()
}

/**
 * Ищет тайтлы по слову у Шикимори, порядок находок сохраняется. Взрослое из выдачи не вырезается:
 * отбор по этому признаку — дело слоя показа, а повтор слова отвечает из памяти запуска.
 */
export async function searchShikimori(word: string): Promise<ShikiFound[]> {
  const asked = word.trim()
  if (asked === '') return []

  const key = fold(asked)
  const kept = memory.get(key)

  if (kept && Date.now() - kept.at < LIFE_SEARCH) {
    Logger('API', `Поиск у Шикимори «${asked}»: ответ из памяти, находок ${kept.found.length}`)

    // Наружу уходит копия списка: перестановки на стороне зовущего не должны портить память.
    return kept.found.slice()
  }

  // Раздел вписан словом: номер из чужого раздела увёл бы выписку не туда.
  const path =
    `/api/animes?search=${encodeURIComponent(asked)}` +
    `&limit=${SHIKI_SEARCH_LIMIT}&censored=false`

  const reply = await fetchShiki<ShikiSearchRow[]>(path)
  const rows = Array.isArray(reply.data) ? reply.data : []
  const found: ShikiFound[] = []

  for (const row of rows) {
    if (!row || typeof row.id !== 'number' || row.id <= 0) continue

    found.push({
      malId: row.id,
      russian: textOrNull(row.russian),
      name: textOrNull(row.name),
    })
  }

  remember(key, found)

  Logger('API', `Поиск у Шикимори «${asked}»: нашлось ${found.length}`)
  return found
}
