// Одна карточка Шикимори на тайтл и имена пачками: стратегия поверх транспорта (shikimori.ts).
// Склада здесь нет: ключи и сроки решают вызывающие; здешняя память живёт запуск.

import { Logger } from '../utils/logger'
import { fetchShiki, fetchShikiGraphql } from './shikimori'
import type { ShikiMedia } from '../core/types'

export interface ShikiAnime {
  /** `null` — источник ответил, что такого тайтла не знает. */
  data: ShikiMedia | null
  domain: string | null
}

export interface ShikiNames {
  names: Map<number, string>
  /** Кто попал в ответ: без этого «перевода нет» не отличить от «пачка не доехала». */
  answered: Set<number>
}

/** Больше пятидесяти Shikimori не отдаёт: `limit` выше потолка он молча урезает. */
const NAMES_CHUNK = 50

/** `ids` — строка номеров через запятую, как и в запросе состава тайтла. */
const NAMES_QUERY =
  'query($ids: String!, $limit: Int!) { animes(ids: $ids, limit: $limit) { id russian name } }'

interface NamesReply {
  animes?: Array<{
    /** У GraphQL номер — строка (`ID!`), а не число, как в REST. */
    id?: string | number | null
    russian?: string | null
    name?: string | null
  } | null> | null
}

/** Карточки, о которых источник уже ответил в этом запуске, включая отказы. */
const cards = new Map<number, ShikiAnime>()

/** Незавершённые походы за карточкой: название и оценки просят её в один миг. */
const pending = new Map<number, Promise<ShikiAnime>>()

/** Строка или `null`. Пустая строка равносильна отсутствию значения. */
function textOrNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null

  const clean = value.trim()
  return clean === '' ? null : clean
}

/**
 * Карточка тайтла: один запрос на номер за запуск, одновременные просьбы ждут один ответ.
 * Отказ источника (`data: null`) запоминается, сбой сети — нет: при возврате сети спросим снова.
 */
export async function fetchShikiAnime(malId: number): Promise<ShikiAnime> {
  const known = cards.get(malId)
  if (known) return known

  const inFlight = pending.get(malId)
  if (inFlight) return await inFlight

  const task = fetchShiki<ShikiMedia>(`/api/animes/${malId}`).then((reply) => {
    const answer: ShikiAnime = { data: reply.data, domain: reply.domain }
    cards.set(malId, answer)
    return answer
  })

  pending.set(malId, task)

  try {
    return await task
  } finally {
    pending.delete(malId)
  }
}

/**
 * Русские имена сразу для многих тайтлов: сеткам и полкам нужна одна строка, а не карточка.
 * Пачка падает молча и по отдельности: упавшее зеркало не бросает остальные строки без названий.
 */
export async function fetchShikiNames(malIds: number[]): Promise<ShikiNames> {
  const names = new Map<number, string>()
  const answered = new Set<number>()

  const wanted = [...new Set(malIds.filter((id) => Number.isFinite(id) && id > 0))]
  if (wanted.length === 0) return { names, answered }

  let chunks = 0

  for (let at = 0; at < wanted.length; at += NAMES_CHUNK) {
    const slice = wanted.slice(at, at + NAMES_CHUNK)
    chunks++

    try {
      const reply = await fetchShikiGraphql<NamesReply>(
        NAMES_QUERY,
        { ids: slice.join(','), limit: slice.length },
        `имена: ${slice.length}`,
      )

      // Ответа нет вовсе — это не «имён не знаем», а неудача пачки.
      if (!reply.data) {
        Logger('WARN', `Имена Шикимори: пачка из ${slice.length} осталась без ответа`)
        continue
      }

      // Источник ответил про всю пачку сразу: кого нет в списке, того он не знает.
      slice.forEach((id) => answered.add(id))

      for (const row of reply.data.animes ?? []) {
        if (!row) continue

        const malId = Number(row.id)
        if (!Number.isFinite(malId) || malId <= 0) continue

        const russian = textOrNull(row.russian)
        if (russian) names.set(malId, russian)
      }
    } catch (e) {
      // Здесь же глушится исчерпание повторов по 429: остаток пачек уйдёт после паузы, шлюз держит её сам.
      Logger('WARN', `Имена Шикимори: пачка из ${slice.length} не доехала`, e)
    }
  }

  Logger(
    'INFO',
    `Имена Шикимори: спросили ${wanted.length} пачками ${chunks}, ` +
      `ответили про ${answered.size}, нашли ${names.size}`,
  )

  return { names, answered }
}

/** Забывает знание запуска о карточках: нужно после чистки склада из настроек. */
export function forgetShikiCards(): void {
  cards.clear()
  pending.clear()
}
