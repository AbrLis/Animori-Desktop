// Выгрузка списка в XML экспорта MyAnimeList: единственный формат, который принимают чужие
// сервисы. Формат ключуется номером MAL, а список живёт на AniList: записи без номера — поимённо.

import type { SnapshotEntry } from './snapshot'

/** Закладки AniList в слова MAL. Пересмотра у MAL нет: он идёт как «Watching», а число
 * пересмотров едет своим полем ниже. */
const STATUS_WORDS: Readonly<Record<string, string>> = {
  CURRENT: 'Watching',
  REPEATING: 'Watching',
  COMPLETED: 'Completed',
  PAUSED: 'On-Hold',
  DROPPED: 'Dropped',
  PLANNING: 'Plan to Watch',
}

/** Пустая дата формата: именно так MAL обозначает «даты нет». */
const NO_DATE = '0000-00-00'

/** Дата снимка всегда ГГГГ-ММ-ДД; всё остальное считается отсутствием. */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/

export interface MalXmlInput {
  entries: Iterable<SnapshotEntry>
  /** Имя в шапке выгрузки. Импортеры его не читают, но формат его ждёт. */
  userName?: string
}

/** Итог выгрузки: сама строка и честный счёт того, что не уехало. */
export interface MalXmlResult {
  xml: string
  /** Сколько записей легло в выгрузку. */
  exported: number
  /** Названия записей без номера MAL: формат их выразить не может, помогает перенос списка. */
  noMalId: string[]
  /** Записей без закладки: в списке их нет, выгружать нечего. */
  noStatus: number
}

/** Заворачивает вольный текст в CDATA. Закрывающая скобка внутри текста разрезается на два
 * блока: иначе комментарий со «]]>» рвёт весь файл и импортер отказывается от выгрузки. */
function cdata(value: string): string {
  return `<![CDATA[${value.split(']]>').join(']]]]><![CDATA[>')}]]>`
}

/** Закладка словом MAL. Незнакомая закладка считается отсутствием: придуманная замена
 * разложила бы список на чужом сервисе тихо. */
export function malStatus(status: string | null): string | null {
  if (status === null || status === '') return null
  return STATUS_WORDS[status] ?? null
}

export function malDate(value: string | null): string {
  if (value === null || !DATE_SHAPE.test(value)) return NO_DATE
  return value
}

/** Оценка целым баллом 0..10: у нас шкала с десятыми, у MAL целые — это ограничение формата. */
export function malScore(score10: number): number {
  if (!Number.isFinite(score10) || score10 <= 0) return 0
  return Math.min(10, Math.max(0, Math.round(score10)))
}

/** Название для выгрузки: сопоставление идёт по номеру, так что это для глаз. */
function titleOf(entry: SnapshotEntry): string {
  return entry.english ?? entry.romaji ?? `Anime #${entry.mediaId}`
}

// Зовёт только настольное приложение: на приставке выгрузки списка нет. Общее ядро такие
// места не выбрасывает — см. cloud.ts, saveCopy.
/** Собирает выгрузку. Порядок — по номеру MAL: две выгрузки одного списка должны совпадать
 * байт в байт. Поле series_episodes не пишется: чисел серий в снимке нет. */
export function buildMalXml(input: MalXmlInput): MalXmlResult {
  const rows: SnapshotEntry[] = []
  const noMalId: string[] = []
  let noStatus = 0

  for (const entry of input.entries) {
    if (malStatus(entry.status) === null) {
      noStatus++
      continue
    }

    if (typeof entry.malId !== 'number' || entry.malId <= 0) {
      noMalId.push(titleOf(entry))
      continue
    }

    rows.push(entry)
  }

  rows.sort((a, b) => (a.malId ?? 0) - (b.malId ?? 0))
  noMalId.sort((a, b) => a.localeCompare(b, 'ru'))

  const parts: string[] = []
  parts.push('<?xml version="1.0" encoding="UTF-8" ?>')
  parts.push('<myanimelist>')
  parts.push('  <myinfo>')
  parts.push('    <user_id>0</user_id>')
  parts.push(`    <user_name>${cdata(input.userName ?? 'AniMori')}</user_name>`)
  // Единица значит «аниме»; двойка — манга, её мы не ведём.
  parts.push('    <user_export_type>1</user_export_type>')
  parts.push(`    <user_total_anime>${rows.length}</user_total_anime>`)
  parts.push('  </myinfo>')

  for (const entry of rows) {
    const status = malStatus(entry.status)
    if (status === null) continue

    parts.push('  <anime>')
    parts.push(`    <series_animedb_id>${entry.malId ?? 0}</series_animedb_id>`)
    parts.push(`    <series_title>${cdata(titleOf(entry))}</series_title>`)
    parts.push(`    <my_watched_episodes>${Math.max(0, Math.round(entry.progress))}</my_watched_episodes>`)
    parts.push(`    <my_start_date>${malDate(entry.startedAt)}</my_start_date>`)
    parts.push(`    <my_finish_date>${malDate(entry.completedAt)}</my_finish_date>`)
    parts.push(`    <my_score>${malScore(entry.score10)}</my_score>`)
    parts.push(`    <my_status>${status}</my_status>`)
    parts.push(`    <my_times_watched>${Math.max(0, Math.round(entry.repeat))}</my_times_watched>`)
    parts.push(`    <my_comments>${cdata(entry.notes ?? '')}</my_comments>`)
    // Без этого поля импортёр MAL пропускает уже известные ему записи
    // вместо того, чтобы подновить их нашими числами.
    parts.push('    <update_on_import>1</update_on_import>')
    parts.push('  </anime>')
  }

  parts.push('</myanimelist>')

  return {
    xml: `${parts.join('\n')}\n`,
    exported: rows.length,
    noMalId,
    noStatus,
  }
}

/** Имя файла выгрузки с днём внутри: иначе в папке загрузок копятся одинаковые имена. */
export function malXmlFileName(now: Date = new Date()): string {
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value))
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  return `animori-anime-${day}.xml`
}
