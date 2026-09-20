// Клиент AnimeThemes.moe: опенинги и эндинги по MAL ID.
//
// Спрашиваем GraphQL (graphql.animethemes.moe), а не прежний JSON:API
// (api.animethemes.moe): тот помечен устаревшим прямо в документации сервиса —
// «The JSON:API is deprecated and it will be removed». Сроков там не назвали,
// но отключат его молча: виджет музыки просто опустеет, без ошибки и без записи
// в журнале. Темы — единственное, что приходит с этого сервиса, и модуль один,
// поэтому переезд сделан заранее.
//
// Запрос идёт POST с телом {"query", "variables"}: GraphQL иначе не умеет.
// Ответ приходит с кодом 200 и тогда, когда запрос отвергнут, — причина лежит
// в поле errors. Проверять один статус нельзя: отказ выглядел бы как «тем нет»,
// и пустой ответ осел бы в кэше на CACHE_TIME.
//
// Три ловушки новой схемы, найденные при сверке со старым API:
//
// 1. Исполнители. Было готовое поле song.artists, стало performances, и на
//    группу с участниками приходит по строке на каждого: у «Kessoku Band»
//    их четыре. Без свёртывания по имени в карточке стояло бы «Kessoku Band,
//    Kessoku Band, Kessoku Band, Kessoku Band». Свёртываем, порядок храним.
//
// 2. Номер темы. Поле sequence выглядит прямее слага, но врёт: у Hibike!
//    Euphonium опенинг имеет slug OP1 и sequence null. Источник номера — слаг,
//    как было и в JSON:API.
//
// 3. Площадки ссылок. Теперь это перечисление (SPOTIFY, YOUTUBE_MUSIC,
//    APPLE_MUSIC, AMAZON_MUSIC, YOUTUBE), а не строка со свободным написанием.
//    Сопоставление стало точным, и таблица ниже — исчерпывающая: неизвестную
//    площадку пропускаем, а не угадываем по куску слова.
//
// 4. Версии заставки. У одной заставки бывает несколько записей: дубляж,
//    выпуск для другого региона, версия без титров. У них свой слаг с
//    суффиксом (OP1-EN, OP1-EN4Kids) при том же номере и той же песне,
//    и без разбора они встают в список двумя строками. У One Piece так
//    задваиваются двенадцать опенингов и двенадцать эндингов.
//
// Кроме метаданных спрашивается адрес звукового файла темы и ссылки на стриминги.
// Звук берётся именно аудиодорожкой (videos.audio), а не видеофайлом: карточке
// нужна песня, а видео тяжелее в несколько раз при том же звуке.
//
// Полных версий сервис не отдаёт и отдавать не будет: в хранилище попадает
// только то, что звучало в самом аниме, — дорожка, вынутая из видео заставки.
// На вопрос «где взять полную» у них один ответ: ссылка на внешнюю службу,
// и она приезжает тем же полем resources.
//
// Побочно чинится строка ссылок. Прежний адрес JSON:API не отдавал
// song.resources вовсе, когда тайтл искался по внешнему ресурсу: поле приходило
// пустым у всех двенадцати проверенных тайтлов, у которых ссылки на самом деле
// есть. Поэтому в карточке их и не было — не потому, что службы молчат.
// GraphQL отдаёт их тем же запросом, так что строка ссылок у песен появится.
// Это не новая возможность, а починка старой: людям покажется иначе.

import { Bridge, type HttpResponse } from '@/bridge'
import { CACHE_TIME } from '../core/constants'
import { dbGet, dbSet } from '../core/db'
import { reportError, reportStatus } from '../core/net-health'
import { Logger } from '../utils/logger'
import type { MediaCacheRecord } from '../core/types'
import { animeThemesLimiter } from './rate-limit'

/**
 * Адрес запроса. Собран конкатенацией, как и прежний: литерал схемы
 * в шаблонной строке ломался при отправке.
 */
const API_URL = 'https://graphql.animethemes.moe/'

/**
 * Тело запроса. Переменная одна: сервис принимает список идентификаторов,
 * но нам всегда нужен один тайтл, и подстановка через переменную избавляет
 * от склейки строк с чужой строкой внутри.
 *
 * site: MAL — площадка, по которой ищем. Имя перечисления, не подпись:
 * в JSON:API та же площадка звалась MyAnimeList.
 */
const THEMES_QUERY = `query Themes($malId: [Int!]) {
  findAnimeByExternalSite(site: MAL, id: $malId) {
    animethemes {
      type
      slug
      song {
        title { romaji }
        performances { artist { name { main } } }
        resources { nodes { site link } }
      }
      animethemeentries {
        videos { nodes { audio { link } } }
      }
    }
  }
}`

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
 * Номер вида записи в кэше. Поднимается, когда прежняя запись перестаёт
 * годиться: кэш тем вечный (CACHE_TIME — бесконечность), и старое содержимое
 * само не выветрится никогда.
 *
 * Строение темы при переезде на GraphQL не изменилось — те же поля и те же
 * значения, — поэтому ключ тогда оставлен прежним: поднимать номер значило бы
 * выбросить весь накопленный кэш тем и заново собрать его под рейт-лимитом
 * ради ничего.
 *
 * Поднимать при смене строения записи ИЛИ при правке её содержимого. Номер
 * темы считался неверно (слаг OP1-EN4Kids давал 14), а дубляжи заставок не
 * отсеивались, — в кэше лежат списки с повторами, и без подъёма номера они
 * останутся в нём навсегда.
 */
const SHAPE = 4

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
 * Службы, ссылки на которые имеют смысл в карточке. Слева — имя перечисления
 * из ответа, справа — ключ и подпись для разметки. Среди ресурсов песни
 * приезжают и каталоги вроде ANIDB: слушать по ним нечего, и в строку они не идут.
 *
 * Порядок значим: YouTube Music и YouTube дают один ключ разметки, и первая
 * найденная площадка занимает его. Музыкальная служба стоит выше обычной —
 * она и полезнее, а прежний разбор подстрокой приходил к тому же.
 */
const MUSIC_SITES: ReadonlyArray<{ key: string; site: string; label: string }> = [
  { key: 'SPOTIFY', site: 'spotify', label: 'Spotify' },
  { key: 'APPLE_MUSIC', site: 'apple', label: 'Apple Music' },
  { key: 'YOUTUBE_MUSIC', site: 'youtube', label: 'YouTube Music' },
  { key: 'AMAZON_MUSIC', site: 'amazon', label: 'Amazon Music' },
  { key: 'YOUTUBE', site: 'youtube', label: 'YouTube' },
]

interface AnimeThemesResource {
  site?: string
  link?: string
}

interface AnimeThemesName {
  main?: string
}

interface AnimeThemesPerformance {
  artist?: { name?: AnimeThemesName }
}

interface AnimeThemesSong {
  title?: { romaji?: string }
  performances?: AnimeThemesPerformance[]
  resources?: { nodes?: AnimeThemesResource[] }
}

interface AnimeThemesVideo {
  audio?: { link?: string }
}

interface AnimeThemesThemeEntry {
  videos?: { nodes?: AnimeThemesVideo[] }
}

interface AnimeThemesEntry {
  type?: string
  slug?: string
  song?: AnimeThemesSong
  animethemeentries?: AnimeThemesThemeEntry[]
}

interface AnimeThemesAnime {
  animethemes?: AnimeThemesEntry[]
}

interface AnimeThemesResponse {
  data?: { findAnimeByExternalSite?: AnimeThemesAnime[] }
  /** Отказ приходит с кодом 200: разбирать его обязательно. */
  errors?: Array<{ message?: string }>
}

/**
 * Звук темы: первая найденная аудиодорожка. Записей у темы бывает несколько
 * (телевизионная версия, без титров, другая серия), но песня в них одна и та же:
 * выбор между ними карточке ничего не даёт.
 */
function pickAudio(entries: readonly AnimeThemesThemeEntry[]): string | null {
  for (const entry of entries) {
    for (const video of entry.videos?.nodes ?? []) {
      const link = video.audio?.link
      if (typeof link === 'string' && link !== '') return link
    }
  }
  return null
}

/**
 * Исполнители песни строкой. Свёртываем по имени: на группу с участниками
 * сервис присылает по строке на каждого участника, и без свёртывания имя
 * группы повторилось бы столько раз, сколько в ней человек.
 */
function pickArtists(song: AnimeThemesSong): string {
  const names: string[] = []
  const seen = new Set<string>()

  for (const perf of song.performances ?? []) {
    const name = perf.artist?.name?.main
    if (typeof name !== 'string' || name === '' || seen.has(name)) continue

    seen.add(name)
    names.push(name)
  }

  return names.join(', ')
}

/** Стриминги песни без повторов: одна служба — одна иконка в строке. */
function pickLinks(resources: readonly AnimeThemesResource[]): ThemeLink[] {
  const out: ThemeLink[] = []
  const seen = new Set<string>()

  for (const res of resources) {
    const url = res.link
    const key = (res.site ?? '').trim().toUpperCase()
    if (typeof url !== 'string' || url === '' || key === '') continue

    const known = MUSIC_SITES.find((s) => s.key === key)
    if (!known || seen.has(known.site)) continue

    seen.add(known.site)
    out.push({ site: known.site, label: known.label, url })
  }

  return out
}

/**
 * Номер темы из слага: первая группа цифр.
 *
 * Склеивать все цифры подряд нельзя. У версий заставки слаг с суффиксом,
 * и OP1-EN4Kids давал бы 14 — тема вставала бы на место настоящей
 * четырнадцатой заставки, а своей терялась. Суффикс после номера — признак
 * версии, к номеру он не относится.
 *
 * Цифр в слагe может не быть вовсе (у Hibike! Euphonium опенинг имеет слаг
 * просто OP): тогда это первая заставка.
 */
function seqOf(slug: string): string {
  return slug.match(/\d+/)?.[0] ?? '1'
}

/**
 * Убирает песни, пришедшие дважды.
 *
 * Одна заставка приходит двумя записями, когда у неё есть версия. Номер из
 * слага выходит один и тот же, название песни тоже, и в списке она вставала
 * двумя строками подряд: OP1 «We Are!» и OP1-EN «We Are!», ED1 «memories» и
 * ED1-EN «memories». У One Piece таких пар двенадцать в каждую сторону.
 *
 * Сверяем по названию, а не по номеру: у слага без цифр номер совпадает
 * с первой заставкой, а песня там другая, и отсеять её по номеру значило бы
 * потерять её вовсе. Исполнитель в свёртку не входит: у версии на другом
 * языке он может быть указан иначе, а песня от этого не меняется.
 *
 * Из повторов остаётся первая по порядку: сервис кладёт саму заставку
 * раньше её переложений.
 */
function dropTwins(items: readonly ThemeItem[]): ThemeItem[] {
  const seen = new Set<string>()
  const out: ThemeItem[] = []

  for (const item of items) {
    const mark = item.title.trim().toLowerCase()
    if (seen.has(mark)) continue

    seen.add(mark)
    out.push(item)
  }

  return out
}

/** Разбирает ответ API в списки опенингов и эндингов. */
function formatThemes(themes: AnimeThemesEntry[]): MalThemes {
  const formattedData: MalThemes = { openings: [], endings: [] }

  themes.forEach((t) => {
    const song = t.song ?? {}
    const slug = t.slug ?? ''
    const title = song.title?.romaji || slug
    const seq = seqOf(slug)
    const item: ThemeItem = {
      seq,
      title,
      artist: pickArtists(song),
      audio: pickAudio(t.animethemeentries ?? []),
      links: pickLinks(song.resources?.nodes ?? []),
    }

    if (t.type === 'OP') formattedData.openings.push(item)
    else if (t.type === 'ED') formattedData.endings.push(item)
  })

  // По номеру: API отдаёт темы в своём порядке, а в строке ждут OP1, OP2, OP3.
  // Повторы отсеиваются после сортировки: из двух записей одной песни первой
  // должна остаться та, что стоит раньше в списке, а порядок он и задаёт.
  const byNumber = (a: ThemeItem, b: ThemeItem): number => Number(a.seq) - Number(b.seq)
  formattedData.openings.sort(byNumber)
  formattedData.endings.sort(byNumber)

  return {
    openings: dropTwins(formattedData.openings),
    endings: dropTwins(formattedData.endings),
  }
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
      method: 'POST',
      url: API_URL,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: THEMES_QUERY, variables: { malId: [malId] } }),
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
    const parsed = JSON.parse(res.text) as AnimeThemesResponse

    // Отказ GraphQL приходит с кодом 200, и это не «тем нет»: кэшировать нельзя.
    if (parsed.errors && parsed.errors.length > 0) {
      const reason = parsed.errors[0]?.message ?? 'без пояснения'
      Logger('ERROR', `AnimeThemes: запрос отвергнут — ${reason} (MAL ${malId})`)
      return null
    }

    const animeList = parsed.data?.findAnimeByExternalSite ?? []

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
    Logger('ERROR', 'Ошибка разбора ответа AnimeThemes', e)
    return null
  }
}
