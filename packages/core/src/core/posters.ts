// Склад постеров: тело картинки, а не её адрес. Обложка в MediaLook — ссылка на CDN, и без сети сетка
// оставалась пустой. Модуль не знает про Vue, object URL отзывается при вытеснении, срок бессрочный.

import { Bridge } from '@/bridge'
import { Logger } from '../utils/logger'
import { dbClearStore, dbDelete, dbSet, openDB } from './db'
import type { PosterCacheRecord } from './types'

/**
 * Потолок склада. Список человека — сотни картинок по 60–120 КБ; запас оставлен на длинный список. Перешагнув его, модуль вытесняет самое старое невостребованное, а не отказывает в догрузке.
 */
const POSTER_BUDGET_BYTES = 256 * 1024 * 1024

/** Отказ от одной непомерно большой картинки: она одна съела бы весь потолок. */
const MAX_POSTER_BYTES = 3 * 1024 * 1024

/** Сколько постеров тянем одновременно. CDN держит и шире, но вежливость тут дешевле. */
const FETCH_CONCURRENCY = 4

/**
 * Сколько object URL держим в памяти запуска. Всё, что за этим числом, остаётся на диске нетронутым и поднимется, когда плитку откроют снова. Число большое: список человека обычно меньше.
 */
const URL_CACHE_LIMIT = 400

/**
 * Тип образа. С CDN приходит вместе с телом, и без него подпись в объекте URL WebView не поймёт, что это за картинка: постер остаётся картинкой и без этого, но задавать его честнее.
 */
const POSTER_MIME = 'image/jpeg'

/** Тайтл и его адрес на CDN: по нему качаем, если своего постера ещё нет. */
export interface CoverPair {
  mediaId: number
  url: string
}

/** Сколько постеров лежит на диске и сколько они занимают — для настроек. */
export interface PosterStats {
  count: number
  bytes: number
  /** Сколько адресов поднято в память этого запуска. */
  inMemory: number
}

/** Тайл с его адресом в памяти. Порядок карты — давность: первым уходит самый старый. */
const urls = new Map<number, string>()

/** Чьи постеры лежат на диске. Не равен urls: лежат все, в памяти — не все. */
const known = new Set<number>()

/** Подписчики на «появился постер»: слой экранов перерисовывает плитки по этому сигналу. */
const listeners = new Set<() => void>()

/** Незавершённая догрузка: два вызова на старте не качают одно и то же дважды. */
let warmInFlight: Promise<number> | null = null


/**
 * Локальный адрес постера или null, когда своего нет. Синхронно и без ожидания: разметка не умеет ждать, и постер должен появиться тем же кадром, что и плитка.
 */
export function localCover(mediaId: number): string | null {
  const url = urls.get(mediaId)
  if (url === undefined) return null

  // Касание двигает запись в хвост: вытесняется то, чего давно не открывали.
  urls.delete(mediaId)
  urls.set(mediaId, url)

  return url
}

/** Есть ли постер на диске — даже если его адрес сейчас вытеснен из памяти. */
export function hasLocalCover(mediaId: number): boolean {
  return known.has(mediaId)
}

/** Подписка на появление постеров; отписка — возвращённая функция. */
export function onCoversChanged(watcher: () => void): () => void {
  listeners.add(watcher)
  return () => {
    listeners.delete(watcher)
  }
}

function notify(): void {
  for (const watcher of listeners) {
    try {
      watcher()
    } catch (e) {
      Logger('WARN', 'Постер: подписчик сорвался', e)
    }
  }
}

/** Освобождает адреса, пока те не уместятся в памяти запуска. */
function evictUrls(): void {
  while (urls.size > URL_CACHE_LIMIT) {
    const oldest = urls.keys().next()
    if (oldest.done) return

    const url = urls.get(oldest.value)
    if (url !== undefined) URL.revokeObjectURL(url)
    urls.delete(oldest.value)
  }
}

/** Тело ответа в байты. base64 — единственный вид, в котором мост умеет передавать бинарное. */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  // Ответ моста — «data:...;base64,» либо голое тело; в обоих случаях нужен хвост после запятой.
  const clean = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64
  const binary = atob(clean)
  // Буфер выписывается явно: без этого тип остаётся «любой», а Blob требует обычный ArrayBuffer.
  const out = new Uint8Array(new ArrayBuffer(binary.length))

  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

/** Кладёт постер на диск и поднимает его адрес в память. */
async function remember(mediaId: number, bytes: Uint8Array<ArrayBuffer>): Promise<void> {
  const blob = new Blob([bytes], { type: POSTER_MIME })

  await dbSet('posterCache', { id: mediaId, blob, bytes: bytes.length, ts: Date.now() })

  const previous = urls.get(mediaId)
  if (previous !== undefined) URL.revokeObjectURL(previous)

  known.add(mediaId)
  urls.set(mediaId, URL.createObjectURL(blob))
  evictUrls()
}

/** Снимает с диска и из памяти; вытеснение и кнопка сброса идут через неё. */
async function dropPoster(mediaId: number): Promise<void> {
  const url = urls.get(mediaId)
  if (url !== undefined) {
    URL.revokeObjectURL(url)
    urls.delete(mediaId)
  }

  known.delete(mediaId)
  await dbDelete('posterCache', mediaId)
}

/** Все записи склада разом: чекнутый список, где отбор и подсчёт места нужны оба. */
async function readAll(): Promise<PosterCacheRecord[]> {
  const db = await openDB()
  if (!db) return []

  return await new Promise<PosterCacheRecord[]>((resolve) => {
    const req = db.transaction('posterCache', 'readonly').objectStore('posterCache').getAll()
    req.onsuccess = () => resolve((req.result as PosterCacheRecord[]) ?? [])
    req.onerror = () => resolve([])
  })
}


/**
 * Поднимает из памяти то, что уже лежит на диске. Курсор, а не getAll: список человека — сотни картинок, и тянуть их все в память разом ради показа незачем, вон и взят предел.
 */
export async function loadCoversFromStore(): Promise<number> {
  try {
    const db = await openDB()
    if (!db) return 0

    const records = await new Promise<PosterCacheRecord[]>((resolve) => {
      const picked: PosterCacheRecord[] = []
      const req = db.transaction('posterCache', 'readonly').objectStore('posterCache').openCursor()

      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) {
          resolve(picked)
          return
        }

        const value = cursor.value as PosterCacheRecord
        if (picked.length < URL_CACHE_LIMIT && value && typeof value.id === 'number' && value.blob) {
          picked.push(value)
        }

        cursor.continue()
      }
      req.onerror = () => resolve(picked)
    })

    let added = 0
    for (const record of records) {
      if (urls.has(record.id)) continue
      urls.set(record.id, URL.createObjectURL(record.blob))
      known.add(record.id)
      added++
    }

    if (added > 0) {
      evictUrls()
      Logger('INFO', `Постер: со склада поднято ${added}`)
      notify()
    }

    return added
  } catch (e) {
    Logger('WARN', 'Постер: склад не ответил', e)
    return 0
  }
}

/** Догружает недостающие. Повторный вызов ждёт текущий и начинает свой — так работает кнопка. */
export function prefetchCovers(pairs: readonly CoverPair[]): Promise<number> {
  return (async () => {
    if (warmInFlight) await warmInFlight

    const task = warmCovers(pairs)
    warmInFlight = task
    try {
      return await task
    } finally {
      if (warmInFlight === task) warmInFlight = null
    }
  })()
}

async function warmCovers(pairs: readonly CoverPair[]): Promise<number> {
  const wanted = pairs.filter((pair) => pair.url !== '' && !known.has(pair.mediaId))
  if (wanted.length === 0) return 0

  let added = 0
  let from = 0

  // Скользящее окно по FETCH_CONCURRENCY: очередь не растёт, а отказ одного адреса не роняет заход.
  const workers = Array.from(
    { length: Math.min(FETCH_CONCURRENCY, wanted.length) },
    async () => {
      while (from < wanted.length) {
        const pair = wanted[from]
        from += 1
        if (!pair) continue

        try {
          const res = await Bridge.http.requestBytes({ url: pair.url, method: 'GET' })
          if (res.status < 200 || res.status >= 300) continue

          const bytes = base64ToBytes(res.bytesBase64)
          // Отказ по размеру важнее ошибки: картинка уже в руках, а место кончиться может.
          if (bytes.length === 0 || bytes.length > MAX_POSTER_BYTES) continue

          await remember(pair.mediaId, bytes)
          added++
        } catch (e) {
          // Отказ одного постера не обрывает заход: этот адрес сетка отдаст и в следующий раз.
          Logger('WARN', `Постер: тайтл ${pair.mediaId} не скачан`, e)
        }
      }
    },
  )

  await Promise.all(workers)

  if (added > 0) {
    Logger('INFO', `Постер: догружено ${added} из ${wanted.length}`)
    notify()
  }

  await trimToBudget()
  return added
}

/**
 * Держит склад в потолке. Вытесняется самое старое из того, чего в памяти нет: открытую картинку отбирать нельзя, иначе плитка под человеком мигнёт буквой вместо обложки.
 */
async function trimToBudget(): Promise<number> {
  try {
    const records = await readAll()

    let total = 0
    for (const record of records) total += record.bytes
    if (total <= POSTER_BUDGET_BYTES) return 0

    const stale = records.filter((record) => !urls.has(record.id)).sort((a, b) => a.ts - b.ts)

    let dropped = 0
    for (const record of stale) {
      if (total <= POSTER_BUDGET_BYTES) break
      await dropPoster(record.id)
      total -= record.bytes
      dropped++
    }

    if (dropped > 0) Logger('INFO', `Постер: вытеснено ${dropped} записей`)
    return dropped
  } catch (e) {
    Logger('WARN', 'Постер: потолок места не проверен', e)
    return 0
  }
}

/** Счёт для настроек: сколько постеров на диске и сколько они занимают. */
export async function posterStats(): Promise<PosterStats> {
  try {
    const records = await readAll()

    let bytes = 0
    for (const record of records) bytes += record.bytes

    return { count: records.length, bytes, inMemory: urls.size }
  } catch (e) {
    Logger('WARN', 'Постер: счёт места не собран', e)
    return { count: 0, bytes: 0, inMemory: urls.size }
  }
}

/**
 * Забывает постеры этого запуска и стирает склад. Зовётся кнопкой сброса кэша: без отзыва адресов память держала бы то, чего на диске уже нет.
 */
export async function forgetCovers(): Promise<void> {
  for (const url of urls.values()) URL.revokeObjectURL(url)

  urls.clear()
  known.clear()

  await dbClearStore('posterCache')
  Logger('INFO', 'Постер: склад очищен')
}

/** Забывает знание запуска, склад не трогая: он нужен следующему запуску. */
export function forgetCoverMemory(): void {
  for (const url of urls.values()) URL.revokeObjectURL(url)

  urls.clear()
  known.clear()
  warmInFlight = null
}
