// Хозяин коллекции: единственный источник правды о списке, на диск — снимком из snapshot.ts.
// Перенос по умолчанию сливает, а не замещает.

import { fetchUserList, fetchViewer, type RawListEntry } from '../api/anilist-list'
import { importShikiList } from '../api/shikimori-list'
import { Logger } from '../utils/logger'
import {
  emptySnapshot,
  markSnapshotDirty,
  ownSnapshot,
  readSnapshot,
  saveSnapshotNow,
  SNAPSHOT_VERSION,
  type SnapshotEntry,
  type UserSnapshot,
} from './snapshot'

/** Что правится в записи. Список закрыт перечислением: правка незнакомого вида молча не
 * сделала бы ничего, а такую ошибку лучше поймать сборкой. */
export type EditKind =
  | 'status'
  | 'score'
  | 'progress'
  | 'repeat'
  | 'startedAt'
  | 'completedAt'
  | 'notes'
  | 'remove'

/** Облик тайтла, который запись о себе знать не может: экран передаёт его с правкой, иначе
 * запись, добавленная до переноса, навсегда осталась бы «Тайтл #id». */
export type EntryLook = {
  romaji: string | null
  english: string | null
  isAdult: boolean
}

/** Как переносить список с сервера. merge — слияние с памятью по времени правки; replace
 * обязателен при смене счёта: сливать чужой список со своим нельзя. */
export type PullMode = 'merge' | 'replace'

/** Итог переноса. Числа раздельные: «перенесено N» не отвечает на вопрос — не потерялось ли
 * что-то из набранного здесь. */
export interface PullResult {
  /** Каким способом перенос в итоге прошёл. Смена счёта его меняет сама. */
  mode: PullMode
  total: number
  added: number
  /** Ответ сервера оказался свежее нашего и заменил запись. */
  updated: number
  /** Наша правка оказалась свежее ответа и осталась на месте. */
  kept: number
  /** Записей, которых на сервере нет вовсе: добавленные здесь. */
  onlyHere: number
}

/** Итог переноса с Шикимори: добавлено, сколько записей было у источника и сколько нашли
 * пару у AniList, — иначе разница читалась бы как поломка программы. */
export interface ShikiPullResult extends PullResult {
  /** Ник в том виде, в каком его пишет сам Шикимори. */
  nick: string
  /** Сколько закладок отдал Шикимори. */
  read: number
  /** Сколько из них привязалось к номерам AniList и доехало до памяти. */
  matched: number
  /** Сколько осталось без пары. */
  lost: number
  /** Названия потерянного, несколько штук для разговора с человеком. */
  lostTitles: string[]
  /** Сколько записей получило хоть одну дату просмотра. Даты берутся из журнала изменений
   * Шикимори — в закладках их нет; ноль здесь не поломка: у запланированного и не было. */
  dated: number
}

/** Записи по номеру тайтла. Словарь, а не массив: поиск идёт по номеру на каждой правке. */
const entries = new Map<number, SnapshotEntry>()

/** Чей список сейчас в памяти; null — список местный, отвязанный от счёта. */
let ownerUserId: number | null = null

/** Поднят ли снимок с диска. Повторный подъём затёр бы свежие правки. */
let loaded = false

/** Общее ожидание первого подъёма: экраны не получают временно пустую карту. */
let initInFlight: Promise<number> | null = null

/** Идущий перенос: второй вызов ждёт первый, а не шлёт свой запрос. */
let refreshInFlight: Promise<PullResult> | null = null

/** Идущий перенос с Шикимори. Страж свой, а не общий с refreshInFlight: итоги разные, и отдать
 * нажавшему чужой итог значило бы соврать в числах. */
let shikiInFlight: Promise<ShikiPullResult> | null = null

/** Собирает снимок из памяти. Синхронно: хранилище ждёт готовый слепок. */
function collectSnapshot(): UserSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    userId: ownerUserId,
    savedAt: Date.now(),
    entries: Array.from(entries.values()),
  }
}

/** Запись списка из ответа сервера в форме снимка. */
function fromServer(raw: RawListEntry): SnapshotEntry {
  return {
    mediaId: raw.mediaId,
    malId: raw.malId,
    status: raw.status,
    score10: raw.score,
    progress: raw.progress,
    repeat: raw.repeat,
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
    notes: raw.notes,
    updatedAt: raw.updatedAt,
    isAdult: raw.isAdult,
    romaji: raw.romaji,
    english: raw.english,
  }
}

/** Пустая запись для правки тайтла, которого на сервере ещё нет. Поля перечислены явно,
 * чтобы новое поле ломало сборку. */
function blankEntry(mediaId: number, when: number, look?: EntryLook): SnapshotEntry {
  return {
    mediaId,
    malId: null,
    status: null,
    score10: 0,
    progress: 0,
    repeat: 0,
    startedAt: null,
    completedAt: null,
    notes: null,
    updatedAt: when,
    isAdult: look?.isAdult ?? false,
    romaji: look?.romaji ?? null,
    english: look?.english ?? null,
  }
}

/** Поднимает снимок с диска; вызывается на старте до сети, чтобы список был виден сразу.
 * Идемпотентна, поэтому её вправе звать любое действие. */
export async function initCollection(): Promise<number> {
  if (loaded) return entries.size
  if (initInFlight) return initInFlight

  initInFlight = (async () => {
    const snapshot = await readSnapshot()
    entries.clear()
    ownerUserId = snapshot.userId
    for (const entry of snapshot.entries) entries.set(entry.mediaId, entry)

    ownSnapshot(collectSnapshot)
    loaded = true
    Logger('DB', `Коллекция поднята из снимка: записей ${entries.size}`)

    return entries.size
  })()

  try {
    return await initInFlight
  } finally {
    initInFlight = null
  }
}

/** Сливает ответ сервера с памятью по времени правки; при равных метках побеждает сервер, иначе
 * лишняя «своя» победа скрыла бы правку с сайта. Записей, которых в ответе нет, не трогаем. */
function mergeFromServer(raw: RawListEntry[]): PullResult {
  let added = 0
  let updated = 0
  let kept = 0
  const seen = new Set<number>()

  for (const item of raw) {
    seen.add(item.mediaId)
    const fresh = fromServer(item)
    const mine = entries.get(item.mediaId)

    if (!mine) {
      entries.set(item.mediaId, fresh)
      added++
      continue
    }

    if (mine.updatedAt > fresh.updatedAt) {
      // Спор о полях правка выиграла, но пустоты дополнить можно. Свою дату, поставленную
      // руками, не затираем: заполняем только пустое место.
      if (mine.malId === null) mine.malId = fresh.malId
      if (mine.romaji === null) mine.romaji = fresh.romaji
      if (mine.english === null) mine.english = fresh.english
      if (mine.startedAt === null) mine.startedAt = fresh.startedAt
      if (mine.completedAt === null) mine.completedAt = fresh.completedAt
      kept++
      continue
    }

    entries.set(item.mediaId, fresh)
    updated++
  }

  let onlyHere = 0
  for (const mediaId of entries.keys()) if (!seen.has(mediaId)) onlyHere++

  return { mode: 'merge', total: entries.size, added, updated, kept, onlyHere }
}

/** Замещает память ответом сервера целиком. */
function replaceFromServer(raw: RawListEntry[]): PullResult {
  entries.clear()
  for (const item of raw) entries.set(item.mediaId, fromServer(item))

  return {
    mode: 'replace',
    total: entries.size,
    added: entries.size,
    updated: 0,
    kept: 0,
    onlyHere: 0,
  }
}

// Зовёт только настольное приложение: на приставке переноса с AniList нет. Общее ядро
// такие места не выбрасывает — см. cloud.ts, saveCopy.
/** Переносит список с сервера в память, по умолчанию слиянием. Без входа переносить
 * неоткуда, и это отказ, а не тихий ноль. */
export async function refreshFromServer(mode: PullMode = 'merge'): Promise<PullResult> {
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    // Снимок под собой обязателен до переноса: иначе запись снимка ниже окажется
    // молчаливым ничегонеделанием без хозяина.
    await initCollection()

    const viewer = await fetchViewer()
    if (!viewer) {
      throw new Error('Вход в AniList не выполнен: переносить список неоткуда')
    }

    // Сначала ответ, и только потом память: отказ сети иначе оставит пустой список.
    const raw = await fetchUserList(viewer.id)

    // Чужой список сливать с нашим нельзя: метки времени двух людей ничего друг о друге
    // не значат. Смена счёта всегда замещает.
    let use = mode
    if (ownerUserId !== null && ownerUserId !== viewer.id) {
      use = 'replace'
      Logger('WARN', `Коллекция: вход сменился (${ownerUserId} → ${viewer.id}), память замещена`)
    }

    ownerUserId = viewer.id

    const done = use === 'replace' ? replaceFromServer(raw) : mergeFromServer(raw)

    // Перенос бывает редко и двигает список целиком, так что дубль в файл
    // здесь уместен.
    await saveSnapshotNow({ backup: true })
    Logger(
      'DB',
      `Коллекция перенесена с сервера (${done.mode}): всего ${done.total}, ` +
        `новых ${done.added}, обновлено ${done.updated}, ` +
        `оставлено своих ${done.kept}, только здесь ${done.onlyHere}`,
    )

    return done
  })()

  try {
    return await refreshInFlight
  } finally {
    refreshInFlight = null
  }
}

/** Переносит список с Шикимори по нику: правила те же. Хозяин списка не меняется — хозяин
 * счёт AniList, иначе следующий перенос счёл бы список чужим. Ник или ссылка. */
export async function pullFromShikimori(
  nick: string,
  mode: PullMode = 'merge',
): Promise<ShikiPullResult> {
  if (shikiInFlight) return shikiInFlight

  shikiInFlight = (async () => {
    await initCollection()

    // Сначала весь ответ целиком, и только потом память: список читается в несколько
    // заходов, и обрыв на полпути оставил бы половину чужого списка.
    const got = await importShikiList(nick)

    const done =
      mode === 'replace' ? replaceFromServer(got.entries) : mergeFromServer(got.entries)

    await saveSnapshotNow({ backup: true })
    Logger(
      'DB',
      `Коллекция перенесена с Шикимори (${done.mode}, ${got.user.nick}): ` +
        `всего ${done.total}, новых ${done.added}, обновлено ${done.updated}, ` +
        `оставлено своих ${done.kept}, без пары ${got.lost}, с датами ${got.dated}`,
    )

    return {
      ...done,
      nick: got.user.nick,
      read: got.read,
      matched: got.matched,
      lost: got.lost,
      lostTitles: got.lostTitles,
      dated: got.dated,
    }
  })()

  try {
    return await shikiInFlight
  } finally {
    shikiInFlight = null
  }
}

/** Запись по номеру тайтла или undefined. Копия не делается сознательно. */
export function getEntry(mediaId: number): SnapshotEntry | undefined {
  return entries.get(mediaId)
}

/** Сколько записей в памяти. Нужно экранам и инспектору настроек. */
export function entryCount(): number {
  return entries.size
}

/** Чей список сейчас в памяти. null значит «местный». */
export function currentUserId(): number | null {
  return ownerUserId
}

/** Перебор записей без копии массива: над ним строятся отборы, сортировки и выгрузка. */
export function eachEntry(): IterableIterator<SnapshotEntry> {
  return entries.values()
}

/** Меняет запись в памяти и планирует запись снимка. На сервер правки не уезжают. */
export function putEntry(entry: SnapshotEntry): void {
  entries.set(entry.mediaId, entry)
  markSnapshotDirty()
}

/** Убирает запись из памяти. Отсутствие записи ошибкой не считается. */
export function dropEntry(mediaId: number): void {
  if (!entries.delete(mediaId)) return
  markSnapshotDirty()
}

/** Единственная точка правки записи: синхронно, входа и сети не требует. Пустая строка
 * значит «стереть». `look` даёт имя новой записи и заполняет пустоты известной. */
export function editEntry(
  mediaId: number,
  kind: EditKind,
  value: string | number | null,
  look?: EntryLook,
): void {
  if (!Number.isFinite(mediaId) || mediaId <= 0) return

  if (kind === 'remove') {
    dropEntry(mediaId)
    return
  }

  const known = entries.get(mediaId)
  const entry: SnapshotEntry = known ? { ...known } : blankEntry(mediaId, Date.now(), look)

  if (known && look) {
    if (entry.romaji === null) entry.romaji = look.romaji
    if (entry.english === null) entry.english = look.english
  }

  if (kind === 'status' && typeof value === 'string') entry.status = value
  if (kind === 'score' && typeof value === 'number') entry.score10 = value
  if (kind === 'progress' && typeof value === 'number') entry.progress = value
  if (kind === 'repeat' && typeof value === 'number') entry.repeat = value
  if (kind === 'startedAt' && typeof value === 'string') {
    entry.startedAt = value === '' ? null : value
  }
  if (kind === 'completedAt' && typeof value === 'string') {
    entry.completedAt = value === '' ? null : value
  }
  if (kind === 'notes' && typeof value === 'string') {
    entry.notes = value === '' ? null : value
  }

  // Метка правки — наши часы. По ней слияние решает спор с ответом сервера, поэтому
  // ставится даже когда значение не изменилось.
  entry.updatedAt = Date.now()
  putEntry(entry)
}

/** Отвязывает список от счёта AniList, оставляя записи. Выход из счёта и удаление списка —
 * разные желания: список ведётся и без входа. Снимок поднимается первым делом. */
export async function unlinkCollection(): Promise<number> {
  await initCollection()

  ownerUserId = null
  await saveSnapshotNow({ backup: true })

  Logger('DB', `Коллекция отвязана от счёта: записей ${entries.size}`)

  return entries.size
}

/** Забывает список целиком: удаление данных по прямой просьбе хозяина, а не выход из счёта
 * (для него unlinkCollection). Снимок поднимается первым делом. */
export async function forgetCollection(): Promise<void> {
  await initCollection()

  entries.clear()
  ownerUserId = null
  await saveSnapshotNow({ backup: true })
  Logger('DB', 'Коллекция забыта: снимок очищен')
}

/** Пустой снимок для проверок и первого запуска без входа. */
export function blankSnapshot(): UserSnapshot {
  return emptySnapshot()
}
