// Общий слой источников видео: наружу — озвучки, эпизоды, дорожки и срок ссылок.
// Сети здесь нет: резолверы живут в api/ и сами складываются в реестр (зависимости идут api → core).

import { Logger } from '../utils/logger'

/** Имя источника: ключ реестра, подпись в журнале и значение в настройках. */
export type VideoSourceId = 'aniliberty' | 'kodik'

export interface VideoTrack {
  /** Высота кадра: 480, 720, 1080. И ключ выбора, и подпись кнопки. */
  height: number
  /** Адрес манифеста HLS. */
  url: string
}

/** Отрезок, который человек вправе пропустить одним нажатием. */
export interface VideoSkip {
  startSec: number
  stopSec: number
}

export interface VideoEpisode {
  /** Номер эпизода у источника. Нумерация чужая: бывают дубли и пропуски. */
  number: number
  title?: string
  durationSec?: number
  /** Заставка и титры, если источник их знает. Кнопку пропуска рисует экран. */
  opening?: VideoSkip
  ending?: VideoSkip
}

/** Озвучка: у Aniliberty она одна, у Kodik их пять и больше. */
export interface VideoVoice {
  /** Ключ источника, а не наш: он же уедет обратно в listEpisodes и resolve. */
  id: string
  label: string
  /** Сколько серий озвучено. Ноль читается как «источник не сказал». */
  episodes: number
}

export interface VideoStream {
  source: VideoSourceId
  /** Дорожки по убыванию высоты кадра. Пустым список не бывает. */
  tracks: VideoTrack[]
  /** С какой дорожки начинать. Всегда одна из tracks. */
  preferred: VideoTrack
  /** Когда адреса протухают; null — источник срока не сообщает. */
  expiresAt: number | null
}

/** Что известно о тайтле до обращения к источнику: у Kodik вход по номеру Шикимори, у Aniliberty — по названиям. */
export interface VideoRequest {
  anilistId: number
  malId: number | null
  shikimoriId: number | null
  /** Названия по убыванию пригодности для поиска: романдзи, английское, русское. */
  titles: string[]
  year?: number
  episodesTotal?: number
}

/**
 * Ответ о наличии: ключа нет — источник не высказался. Это «не знаю», а не «нет».
 */
export type PresenceMap = Map<number, boolean>

/**
 * Цена вопроса о наличии: 'batch' — один запрос на пачку, 'each' — по запросу на тайтл.
 * Метка доступности спрашивает дешёвых разом, дорогих — по одному.
 */
export type PresenceCost = 'batch' | 'each'

/** Три шага раздельны: ссылки берутся в последний момент и в кэш не кладутся — у Kodik они живут часы. */
export interface VideoSource {
  readonly id: VideoSourceId
  readonly label: string
  /** Пустой список означает честное «этого тайтла у источника нет». */
  listVoices(req: VideoRequest): Promise<VideoVoice[]>
  listEpisodes(req: VideoRequest, voiceId: string): Promise<VideoEpisode[]>
  /** null — эпизода нет или цепочка не прошла. Причину в журнал пишет резолвер. */
  resolve(req: VideoRequest, voiceId: string, episode: number): Promise<VideoStream | null>

  /**
   * Дешёвый ответ про пачку: есть ли вход к тайтлу. Отличие от listVoices принципиальное: тот тянет подробности одного тайтла.
   * Не объявлен — спросят listVoices по одному; объявлен — обязан быть объявлен presenceCost.
   */
  askPresence?(reqs: readonly VideoRequest[]): Promise<PresenceMap>
  readonly presenceCost?: PresenceCost

  /**
   * Можно ли задать вопрос об этом тайтле: метка «нет видео» ставится, только когда высказались все, кого спросить было можно.
   * Не объявлен — считается, что можно.
   */
  canAskPresence?(req: VideoRequest): boolean
}

const sources = new Map<VideoSourceId, VideoSource>()

/** Кладёт источник в реестр. Повтор — не отказ, а замена с записью в журнал. */
export function registerVideoSource(source: VideoSource): void {
  if (sources.has(source.id)) {
    Logger('WARN', `Источник видео ${source.id} зарегистрирован повторно, беру последний`)
  }
  sources.set(source.id, source)
}

/** Все источники в порядке добавления: он же порядок перебора при отказе. */
export function listVideoSources(): VideoSource[] {
  return [...sources.values()]
}

export function getVideoSource(id: VideoSourceId): VideoSource | null {
  return sources.get(id) ?? null
}

/** Только для проверок: реестр общий на весь запуск и сам себя не чистит. */
export function forgetVideoSources(): void {
  sources.clear()
}

/** Запас перед сроком: минута на цепочку и минута на первый буфер. */
export const STREAM_MARGIN_MS = 120000

/** Годится ли поток к запуску: промах — чёрный экран на первой секунде вместо внятного отказа. */
export function isStreamFresh(stream: VideoStream, now = Date.now()): boolean {
  if (stream.expiresAt === null) return true
  return stream.expiresAt - now > STREAM_MARGIN_MS
}

/** Дорожка нужной высоты или ближайшая снизу, а если таких нет — самая мелкая. */
export function pickTrack(tracks: VideoTrack[], height: number): VideoTrack | null {
  const sorted = [...tracks].sort((a, b) => b.height - a.height)
  const fits = sorted.find((t) => t.height <= height)
  return fits ?? sorted.at(-1) ?? null
}
