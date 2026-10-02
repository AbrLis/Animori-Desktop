// Кадры и ролики тайтла: галерея Шикимори, иначе — кадры серий AniList как запас.
// В карточке Шикимори полных списков нет: они на /screenshots и /videos — одна тема, один срок.

import { isFresh, LIFE_SHOTS } from '../core/cache-life'
import { dbGet, dbSet } from '../core/db'
import type { MediaCacheRecord, MediaClip, MediaShots, MediaShot } from '../core/types'
import { Logger } from '../utils/logger'
import { anilistQuery } from './anilist'
import { fetchShiki } from './shikimori'

/**
 * Ключ записи на складе: номер AniList, а не MAL, как у соседей. MAL у части тайтлов
 * не разрешается, и запись для них пропала бы вовсе.
 */
const CACHE_PREFIX = 'SHOT1_'

/** Номер вида записи: поднимается при смене строения, срок у записи месяц, старое само не выветрится. */
const SHAPE = 1

/** Кадр в ответе Шикимори: путь относительный, домен даёт ответившее зеркало. */
interface ShotReply {
  original?: string | null
  preview?: string | null
}

/** Ролик в ответе Шикимори. Адреса приходят по http, встраиваемый — тоже. */
interface ClipReply {
  kind?: string | null
  name?: string | null
  url?: string | null
  player_url?: string | null
  image_url?: string | null
}

/** Ответ AniList о сериях: запасной источник кадров. */
interface EpisodesReply {
  Media?: { streamingEpisodes?: Array<{ thumbnail?: string | null } | null> | null } | null
}

const EPISODES_QUERY = `query ($id: Int!) {
  Media(id: $id) {
    streamingEpisodes {
      thumbnail
    }
  }
}`

/** Обходы за кадрами одного тайтла: второй вызов ждёт первый, а не идёт рядом. */
const pendingShots = new Map<number, Promise<MediaShots | null>>()

/** Шикимори отдаёт ссылки на ролики по http, а окно живёт на защищённом источнике: трейлер молча не откроется. */
function httpsOrNull(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url.trim() === '') return null
  return url.startsWith('http://') ? 'https://' + url.slice(7) : url
}

/** Строка или null: пустая строка равносильна отсутствию значения. */
function textOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** Абсолютный адрес: домен подставляется тот, что ответил, — зеркал два, и чужой домен не откроется. */
function shotUrl(domain: string | null, path: string | null | undefined): string | null {
  const clean = textOrNull(path)
  if (clean === null) return null

  // Абсолютный адрес источник вправе отдать и сам — тогда домен не нужен.
  if (clean.startsWith('http://') || clean.startsWith('https://')) return clean
  if (domain === null) return null

  return `https://${domain}${clean.startsWith('/') ? '' : '/'}${clean}`
}

/** Кадры из ответа Шикимори. Без домена ответа кадры не собираются вовсе. */
function readShots(reply: ShotReply[] | null, domain: string | null): MediaShot[] {
  if (!Array.isArray(reply) || domain === null) return []

  const shots: MediaShot[] = []
  for (const item of reply) {
    const original = shotUrl(domain, item?.original)
    if (original === null) continue

    // Уменьшенного может не быть: тогда в сетке стоит полный кадр.
    shots.push({ original, preview: shotUrl(domain, item?.preview) ?? original })
  }

  return shots
}

/** Ролики из ответа Шикимори. Без ссылки наружу ролик бесполезен и отброшен. */
function readClips(reply: ClipReply[] | null): MediaClip[] {
  if (!Array.isArray(reply)) return []

  const clips: MediaClip[] = []
  for (const item of reply) {
    const url = httpsOrNull(item?.url)
    if (url === null) continue

    clips.push({
      kind: textOrNull(item?.kind) ?? 'other',
      name: textOrNull(item?.name) ?? 'Ролик',
      url,
      embed: httpsOrNull(item?.player_url),
      thumb: httpsOrNull(item?.image_url),
    })
  }

  return clips
}

/**
 * Запасные кадры: серии AniList. Пустой список — не отказ, а ответ:
 * у «Евангелиона» сервер не знает ни одной серии.
 */
async function fetchEpisodeShots(mediaId: number): Promise<MediaShot[] | null> {
  try {
    const reply = await anilistQuery<EpisodesReply>(EPISODES_QUERY, { id: mediaId })
    const list = reply.data?.Media?.streamingEpisodes

    // Ни данных, ни пустого списка — отказ: пустоту запоминать нельзя.
    if (!Array.isArray(list)) return null

    const shots: MediaShot[] = []
    for (const item of list) {
      const url = textOrNull(item?.thumbnail)
      // Размер один, поэтому оба поля — тот же адрес: см. заметку у MediaShot.
      if (url !== null) shots.push({ original: url, preview: url })
    }

    return shots
  } catch (e) {
    Logger('WARN', `Кадры серий AniList для ${mediaId} не приехали`, e)
    return null
  }
}

/** Что удалось добыть у Шикимори, или null, если оба зеркала промолчали. */
async function fetchShikiShots(
  malId: number,
): Promise<{ shots: MediaShot[]; clips: MediaClip[] } | null> {
  const [shotsReply, clipsReply] = await Promise.all([
    fetchShiki<ShotReply[]>(`/api/animes/${malId}/screenshots`),
    fetchShiki<ClipReply[]>(`/api/animes/${malId}/videos`),
  ])

  // Оба ответа пусты — это отказ сети или зеркал, а не «кадров нет»: такую пустоту
  // класть на склад нельзя, она пролежала бы там месяц.
  if (shotsReply.data === null && clipsReply.data === null) return null

  return {
    shots: readShots(shotsReply.data, shotsReply.domain),
    clips: readClips(clipsReply.data),
  }
}

/**
 * Кадры и ролики тайтла. Никогда не отклоняется: сбой всплыл бы в mount() плитки.
 * `null` и пустые списки — разные ответы: первый «спросить не удалось», второй «показывать нечего».
 */
export async function fetchMediaShots(
  mediaId: number,
  malId: number | null,
): Promise<MediaShots | null> {
  if (mediaId <= 0) return null

  const pending = pendingShots.get(mediaId)
  if (pending) return pending

  const task = fetchMediaShotsAttempt(mediaId, malId)
  pendingShots.set(mediaId, task)
  try {
    return await task
  } finally {
    pendingShots.delete(mediaId)
  }
}

async function fetchMediaShotsAttempt(
  mediaId: number,
  malId: number | null,
): Promise<MediaShots | null> {
  const key = `${CACHE_PREFIX}${mediaId}#${SHAPE}`

  try {
    const stored = await dbGet<MediaCacheRecord<MediaShots>>('mediaCache', key)
    if (stored && isFresh(key, stored.ts, LIFE_SHOTS)) return stored.data
  } catch (e) {
    Logger('WARN', `Кадры ${mediaId}: склад не прочитался`, e)
  }

  let shots: MediaShot[] = []
  let clips: MediaClip[] = []
  let answered = false

  if (malId !== null && malId > 0) {
    const shiki = await fetchShikiShots(malId)
    if (shiki !== null) {
      answered = true
      shots = shiki.shots
      clips = shiki.clips
    }
  }

  // Запасной источник спрашивается только за пустой галереей: у тайтла с полусотней
  // кадров Шикимори кадры серий не нужны, а это отдельный запрос к AniList.
  if (shots.length === 0) {
    const fallback = await fetchEpisodeShots(mediaId)
    if (fallback !== null) {
      answered = true
      shots = fallback
    }
  }

  // Ни один источник не ответил — не запоминаем ничего.
  if (!answered) return null

  const data: MediaShots = { shots, clips }
  void dbSet('mediaCache', { key, data, ts: Date.now() })
  return data
}
