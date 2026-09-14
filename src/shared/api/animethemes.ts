// Клиент AnimeThemes.moe: опенинги и эндинги по MAL ID.
// Единственный API без ключа и без зеркал, зато с обязательным кэшем mediaCache.
// Пустой результат тоже кэшируется: иначе тайтлы без тем дёргали бы API каждый раз.
//
// Повторов после 429 здесь нет намеренно: ими распоряжается ограничитель темпа,
// а темы второстепенны — карточка без них откроется. Прежде тут жила рекурсия
// по attempt, но при MAX_RATE_RETRIES = 1 она была недостижима: условие выхода
// срабатывало на первом же проходе. Мᄅртвый код хуже отсутствующего: он обещает
// поведение, которого нет.
//
// Кроме метаданных спрашивается адрес звукового файла темы и ссылки на стриминги.
// Звук берётся именно аудиодорожкой (videos.audio), а не видеофайлом: карточке
// нужна песня, а видео тяжелее в несколько раз при том же звуке.

import { Bridge, type HttpResponse } from '@/bridge'
import { CACHE_TIME } from '../core/constants'
import { dbGet, dbSet } from '../core/db'
import { reportError, reportStatus } from '../core/net-health'
import { Logger } from '../utils/logger'
import type { MediaCacheRecord } from '../core/types'
import { animeThemesLimiter } from './rate-limit'

/** Базовый адрес собран конкатенацией: литерал схемы в шаблонной строке ломался при отправке. */
const API_BASE = 'https://api.animethemes.moe/anime'

/**
 * Имя источника для учёта доступности. Именно имя, а не адрес: net-health по замыслу
 * не знает ни одного хоста, иначе превратится в список заблокированного.
 */
export const NET_SOURCE_ANIMETHEMES = 'animethemes'
export const NET_LABEL_ANIMETHEMES = 'AnimeThemes'

/** Пауза ограничителю после 429. Джиттер разводит одновременные карточки. */
const RATE_PAUSE_MS = 1500
const REQUEST_TIMEOUT_MS = 10000

/**
 * Номер вида записи в кэше. Строение темы пополнилось звуком и ссылками,
 * а старые записи их не знают: под новый вид идёт свой ключ. Префикс
 * THEMES2_ при этом сохранён: по нему считает темы счётчик кэша в core/db.ts.
 */
const SHAPE = 3

const pendingThemes = new Map<number, Promise<MalThemes | null>>()

/** Ссылка на песню во внешней музыкальной службе. */
export interface ThemeLink {
  /** Ключ службы для разметки: spotify, apple, youtube, amazon. */
  site: string
  /** Подпись службы для подсказки. */
  label: string
  url: string
}

export interface ThemeItem {
  seq: string
  title: string
  artist: string
  /** Адрес звукового файла темы; null — у AnimeThemes его нет. */
  audio: string | null
  /** Стриминги песни; пустой список — ссылок не дали. */
  links: ThemeLink[]
}

export interface MalThemes {
  openings: ThemeItem[]
  endings: ThemeItem[]
}

/**
 * Службы, ссылки на которые имеют смысл в карточке. Среди resources песни
 * приезжают и каталоги вроде AniDB: слушать по ним нечего, и в строку они не идут.
 */
const MUSIC_SITES: ReadonlyArray<{ match: string; site: string; label: string }> = [
  { match: 'spotify', site: 'spotify', label: 'Spotify' },
  { match: 'apple music', site: 'apple', label: 'Apple Music' },
  { match: 'youtube music', site: 'youtube', label: 'YouTube Music' },
  { match: 'amazon music', site: 'amazon', label: 'Amazon Music' },
  { match: 'amazon', site: 'amazon', label: 'Amazon Music' },
  { match: 'youtube', site: 'youtube', label: 'YouTube' },
]

interface AnimeThemesResource {
  site?: string
  link?: string
}

interface AnimeThemesSong {
  title?: string
  artists?: Array<{ name?: string }>
  resources?: AnimeThemesResource[]
}

interface AnimeThemesAudio {
  link?: string
}

interface AnimeThemesVideo {
  audio?: AnimeThemesAudio
}

interface AnimeThemesThemeEntry {
  videos?: AnimeThemesVideo[]
}

interface AnimeThemesEntry {
  type?: string
  slug?: string
  song?: AnimeThemesSong
  animethemeentries?: AnimeThemesThemeEntry[]
}

interface AnimeThemesResponse {
  anime?: Array<{ animethemes?: AnimeThemesEntry[] }>
}

/**
 * Звук темы: первая найденная аудиодорожка. Записей у темы бывает несколько
 * (телевизионная версия, без титров, другая серия), но песня в них одна и та же:
 * выбор между ними карточке ничего не даёт.
 */
function pickAudio(entries: readonly AnimeThemesThemeEntry[]): string | null {
  for (const entry of entries) {
    for (const video of entry.videos ?? []) {
      const link = video.audio?.link
      if (typeof link === 'string' && link !== '') return link
    }
  }
  return null
}

/** Стриминги песни без повторов: одна служба — одна иконка в строке. */
function pickLinks(resources: readonly AnimeThemesResource[]): ThemeLink[] {
  const out: ThemeLink[] = []
  const seen = new Set<string>()

  for (const res of resources) {
    const url = res.link
    const name = (res.site ?? '').trim().toLowerCase()
    if (typeof url !== 'string' || url === '' || name === '') continue

    const known = MUSIC_SITES.find((s) => name.includes(s.match))
    if (!known || seen.has(known.site)) continue

    seen.add(known.site)
    out.push({ site: known.site, label: known.label, url })
  }

  return out
}

/** Разбирает ответ API в списки опенингов и эндингов. */
function formatThemes(themes: AnimeThemesEntry[]): MalThemes {
  const formattedData: MalThemes = { openings: [], endings: [] }

  themes.forEach((t) => {
    const song = t.song ?? {}
    const slug = t.slug ?? ''
    const title = song.title || slug
    const artist = (song.artists ?? [])
      .map((a) => a.name)
      .filter(Boolean)
      .join(', ')
    const seq = slug.replace(/[^0-9]/g, '') || '1'
    const item: ThemeItem = {
      seq,
      title,
      artist,
      audio: pickAudio(t.animethemeentries ?? []),
      links: pickLinks(song.resources ?? []),
    }

    if (t.type === 'OP') formattedData.openings.push(item)
    else if (t.type === 'ED') formattedData.endings.push(item)
  })

  // По номеру: API отдаёт темы в своём порядке, а в строке ждут OP1, OP2, OP3.
  const byNumber = (a: ThemeItem, b: ThemeItem): number => Number(a.seq) - Number(b.seq)
  formattedData.openings.sort(byNumber)
  formattedData.endings.sort(byNumber)

  return formattedData
}

/**
 * Грузит темы по MAL ID; кэш — mediaCache, ключ THEMES2_<malId>#<вид>.
 * Никогда не отклоняется: любая неудача — null, иначе сбой всплывёт в mount() виджета.
 * @param malId Идентификатор MyAnimeList или null, если его не удалось разрешить.
 */
export async function fetchMalThemes(malId: number | null): Promise<MalThemes | null> {
  if (!malId) return null

  const pending = pendingThemes.get(malId)
  if (pending) return pending

  const task = fetchMalThemesAttempt(malId)
  pendingThemes.set(malId, task)
  try {
    return await task
  } finally {
    pendingThemes.delete(malId)
  }
}

async function fetchMalThemesAttempt(malId: number): Promise<MalThemes | null> {
  const cacheKey = `THEMES2_${malId}#${SHAPE}`
  const cached = await dbGet<MediaCacheRecord<MalThemes>>('mediaCache', cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TIME) return cached.data

  Logger('API', `Запрос AnimeThemes.moe для MAL ID: ${malId}`)

  let res: HttpResponse
  // Замер идёт вместе с ожиданием слота: важно, сколько ждал виджет, а не сервер.
  const startedAt = Date.now()
  try {
    // Слот берём перед отправкой: для счётчика окна это такой же запрос, как все.
    await animeThemesLimiter.acquireSlot()

    res = await Bridge.http.request({
      method: 'GET',
      url:
        API_BASE +
        '?filter[has]=resources&filter[site]=MyAnimeList' +
        `&filter[external_id]=${malId}` +
        '&include=animethemes.song.artists,animethemes.song.resources' +
        ',animethemes.animethemeentries.videos.audio',
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
  } catch (e) {
    // Сюда приходит только транспортный сбой, таймаут или отмена.
    Logger('ERROR', 'AnimeThemes Network Error', e)
    reportError(NET_SOURCE_ANIMETHEMES, NET_LABEL_ANIMETHEMES, e, Date.now() - startedAt)
    return null
  }

  // Отчёт идёт до разбора статусов ниже: net-health сам игнорирует 429 и 401.
  reportStatus(NET_SOURCE_ANIMETHEMES, NET_LABEL_ANIMETHEMES, res.status, Date.now() - startedAt)

  // Код вне 2xx мост исключением не считает, поэтому статусы разбираем сами.
  if (res.status === 429) {
    // Пауза на ограничителе, а не sleep: она притормозит и соседние карточки в очереди.
    const waitMs = RATE_PAUSE_MS + Math.floor(Math.random() * 500)
    animeThemesLimiter.pause(waitMs)

    Logger('ERROR', `AnimeThemes: лимит 429, пауза ${waitMs}мс, темы не загружены (MAL ${malId})`)
    // Не кэшируем: это временный отказ, а не отсутствие тем.
    return null
  }

  if (res.status !== 200) {
    Logger('ERROR', `AnimeThemes Error HTTP ${res.status}`)
    return null
  }

  try {
    const data = JSON.parse(res.text) as AnimeThemesResponse
    const animeList = data.anime ?? []

    // Не найдено — кэшируем пустой результат.
    if (animeList.length === 0) {
      const emptyData: MalThemes = { openings: [], endings: [] }
      void dbSet('mediaCache', { key: cacheKey, data: emptyData, ts: Date.now() })
      return emptyData
    }

    const formattedData = formatThemes(animeList[0]?.animethemes ?? [])
    void dbSet('mediaCache', { key: cacheKey, data: formattedData, ts: Date.now() })
    return formattedData
  } catch (e) {
    Logger('ERROR', 'Ошибка парсинга AnimeThemes', e)
    return null
  }
}
