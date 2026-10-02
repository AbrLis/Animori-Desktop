// Датасет названий: слепок выпуска animori-data на диске, читается без сети. Обновление
// повторяет updater.rs; между проверками — LIFE_DATASET_CHECK и If-None-Match.

import { Bridge } from '@/bridge'
import {
  fetchDatasetIndex,
  fetchDatasetPayload,
  type DatasetFileRef,
  type DatasetIndex,
  type DatasetMapPayload,
  type DatasetTitlesPayload,
} from '../api/dataset'
import { Logger } from '../utils/logger'
import { isFresh, LIFE_DATASET_CHECK } from './cache-life'
import { getEntry } from './collection'

/** Имя файла в приватном каталоге; разрешённые имена живут в src-tauri/src/files.rs. */
const DATASET_FILE = 'animori-dataset.json'

/** Имена файлов выпуска выбираются точно: под маску подходят соседние. */
const FILE_TITLES = 'titles-anime.json.gz'
const FILE_MAP = 'map-mal-anilist.json.gz'

// Ключи в хранилище окна. Не в core/settings.ts сознательно: это служебная память
// модуля, а не выбор человека, и в панели настроек ей нечего делать.
const CHECKED_AT_KEY = 'am_dataset_checked_at'
const ETAG_KEY = 'am_dataset_etag'

/** Слепок одного выпуска на диске: имена и карта, записанные одной операцией. */
interface DatasetFile {
  v: number
  builtAt: string
  sourceTag: string
  license: string
  titles: DatasetTitlesPayload['titles']
  pairs: DatasetMapPayload['pairs']
}

/** Имена по номеру MAL; пустая строка — «перевода нет», а не пропуск. */
let titlesByMal: Map<number, string> | null = null

/** Обратная карта: номер AniList → номер MAL. */
let byAnilist: Map<number, number> | null = null

/** Дата сборки установленного выпуска: по ней решается, новее ли опись. */
let installedBuiltAt = ''

/** Подъём с диска — один раз: второй вызов ждёт первый. */
let loading: Promise<boolean> | null = null

/** Идущее обновление: вторая проверка в том же запуске не нужна. */
let updating: Promise<void> | null = null

/** Разбор файла в память; битый или чужой файл равен отсутствию. */
function parseDataset(raw: string): boolean {
  let data: DatasetFile
  try {
    data = JSON.parse(raw) as DatasetFile
  } catch (e) {
    Logger('WARN', 'Датасет: файл на диске не читается как JSON', e)
    return false
  }

  if (data.v !== 1) {
    Logger('WARN', `Датасет: не та версия файла (${data.v})`)
    return false
  }
  if (!Array.isArray(data.titles) || !Array.isArray(data.pairs)) {
    Logger('WARN', 'Датасет: в файле нет массивов имен или пар')
    return false
  }

  const titles = new Map<number, string>()
  for (const row of data.titles) {
    if (!row || typeof row.id !== 'number') continue
    titles.set(row.id, typeof row.russian === 'string' ? row.russian : '')
  }

  const reverse = new Map<number, number>()
  for (const pair of data.pairs) {
    if (!Array.isArray(pair)) continue
    const [mal, anilist] = pair
    if (typeof mal === 'number' && typeof anilist === 'number') reverse.set(anilist, mal)
  }

  titlesByMal = titles
  byAnilist = reverse
  installedBuiltAt = typeof data.builtAt === 'string' ? data.builtAt : ''
  return true
}

// Поднимает датасет с диска. Зовётся на старте и из первого запроса имени: обещание
// общее, цена чтения одна на всех. Отсутствие файла — штатный исход первого запуска.
export function initDatasetNames(): Promise<boolean> {
  if (loading) return loading

  loading = (async () => {
    if (!Bridge.files.available) return false

    const raw = await Bridge.files.read(DATASET_FILE)
    if (raw === null) return false

    const parsed = parseDataset(raw)
    if (!parsed) {
      Logger('WARN', `Датасет: файл на диске не разобран (${raw.length} байт), работаем без него`)
      return false
    }

    Logger('DB', `Датасет поднят: имён ${titlesByMal?.size ?? 0}, пар ${byAnilist?.size ?? 0}`)
    return true
  })()

  return loading
}

/** Что ответил датасет на вопрос об имени тайтла. */
export type DatasetAnswer =
  | { kind: 'name'; name: string }
  /** Выпуск знает тайтл, но русского имени нет: сеть не спрашивается. */
  | { kind: 'none' }
  /** Тайтла в выпуске нет: дальше склад и сеть. */
  | { kind: 'unknown' }

// Русское имя из датасета по номеру AniList. Номер MAL берётся из своей записи списка
// (его дал сам AniList), а иначе — из обратной карты выпуска.
export async function lookupDatasetName(mediaId: number): Promise<DatasetAnswer> {
  const ok = await initDatasetNames()
  if (!ok || !titlesByMal) return { kind: 'unknown' }

  const malId = getEntry(mediaId)?.malId ?? byAnilist?.get(mediaId) ?? null
  if (malId === null) return { kind: 'unknown' }

  const russian = titlesByMal.get(malId)
  if (russian === undefined) return { kind: 'unknown' }
  return russian === '' ? { kind: 'none' } : { kind: 'name', name: russian }
}

// Номер MAL по номеру AniList из выпуска, без сети. Своя запись списка идёт первой (номер
// дал AniList, он точнее слепка), карта выпуска — вторая. Пустота значит «пары нет в выпуске».
export function datasetMalId(mediaId: number): number | null {
  const own = getEntry(mediaId)?.malId
  if (typeof own === 'number' && own > 0) return own

  return byAnilist?.get(mediaId) ?? null
}

/** Состояние датасета для карточки «О программе»: снимок без сети. */
export interface DatasetStatus {
  loaded: boolean
  builtAt: string | null
  names: number
  pairs: number
}

// Что поднято в память этим запуском. Обновление, приехавшее фоном, сюда не попадает
// сознательно: оно работает со следующего запуска.
export function datasetStatus(): DatasetStatus {
  const loaded = titlesByMal !== null

  return {
    loaded,
    builtAt: loaded ? installedBuiltAt : null,
    names: titlesByMal?.size ?? 0,
    pairs: byAnilist?.size ?? 0,
  }
}

/** Строка описи по точному имени файла: маска ловит соседей, как в сборщике. */
function findFile(index: DatasetIndex, name: string): DatasetFileRef | null {
  return index.files.find((file) => file.name === name) ?? null
}

/** Годны ли распакованные файлы: числа и дата сборки обязаны сойтись с описью. */
function payloadOk(
  index: DatasetIndex,
  titles: DatasetTitlesPayload,
  map: DatasetMapPayload,
): boolean {
  return (
    Array.isArray(titles.titles) &&
    Array.isArray(map.pairs) &&
    titles.count === titles.titles.length &&
    map.count === map.pairs.length &&
    titles.builtAt === index.builtAt &&
    map.builtAt === index.builtAt
  )
}

/** Сброс состояния для изолированных тестов запуска. */
export function resetDatasetNames(): void {
  titlesByMal = null
  byAnilist = null
  installedBuiltAt = ''
  loading = null
  updating = null
}

// Пора ли спрашивать опись. Разброс считается от даты установленной сборки: берём её
// в ключ, чтобы у разных установок проверки не сошлись в один час после публикации.
function dueForCheck(checkedAt: number): boolean {
  return !isFresh(`dataset:${installedBuiltAt}`, checkedAt, LIFE_DATASET_CHECK)
}

// Фоновая сверка с последним выпуском: новее — оба файла качаются и заменяют слепок целиком.
// `force` проверяет несмотря на порог, по кнопке. Новый выпуск работает со следующего запуска.
export function updateDatasetNamesInBackground(force = false): Promise<void> | undefined {
  if (!Bridge.files.available || updating) return undefined

  updating = (async () => {
    // Сначала диск: сравнивать даты есть с чем только после подъёма.
    await initDatasetNames()

    const [checkedAt, knownEtag] = await Promise.all([
      Bridge.storage.get<number>(CHECKED_AT_KEY, 0),
      Bridge.storage.get<string>(ETAG_KEY, ''),
    ])

    if (!force && !dueForCheck(checkedAt)) {
      Logger('DB', 'Датасет: проверка выпуска ещё не к сроку')
      return
    }

    // Ручная проверка идёт без отпечатка: иначе кнопка не помогла бы там, где
    // отпечаток и содержимое диска разошлись.
    const answer = await fetchDatasetIndex(force ? null : knownEtag || null)

    // Ни отказ сети, ни сорванная запись час проверки не сдвигают: иначе одна
    // неудача на старте отодвинула бы попытку на полсуток.
    if (answer.kind === 'fail') return

    if (answer.kind === 'same') {
      await Bridge.storage.set(CHECKED_AT_KEY, Date.now())
      return
    }

    const { index, etag } = answer

    if (installedBuiltAt !== '' && index.builtAt <= installedBuiltAt) {
      await Bridge.storage.set(CHECKED_AT_KEY, Date.now())
      Logger('DB', `Датасет актуален: сборка ${installedBuiltAt}`)
      return
    }

    const titlesRef = findFile(index, FILE_TITLES)
    const mapRef = findFile(index, FILE_MAP)
    if (!titlesRef || !mapRef) {
      Logger('WARN', 'Датасет: в описи нет нужных файлов')
      return
    }

    const titles = (await fetchDatasetPayload(titlesRef)) as DatasetTitlesPayload | null
    const map = (await fetchDatasetPayload(mapRef)) as DatasetMapPayload | null
    if (!titles || !map) return

    if (!payloadOk(index, titles, map)) {
      Logger('WARN', 'Датасет: содержимое не сошлось с описью, выпуск отклонён')
      return
    }

    const file: DatasetFile = {
      v: 1,
      builtAt: index.builtAt,
      sourceTag: index.sourceTag,
      license: index.license,
      titles: titles.titles,
      pairs: map.pairs,
    }

    const ok = await Bridge.files.write(DATASET_FILE, JSON.stringify(file))
    if (!ok) {
      Logger('WARN', 'Датасет: новый выпуск не записался на диск')
      return
    }

    // Отпечаток запоминается только после записи: он значит «на диске ровно
    // этот выпуск». Сохранённый раньше, он заставил бы клиент после сбоя вечно
    // получать 304 и не пробовать до следующего выпуска.
    if (etag !== '') await Bridge.storage.set(ETAG_KEY, etag)
    await Bridge.storage.set(CHECKED_AT_KEY, Date.now())

    loading = null
    await initDatasetNames()
    Logger('DB', `Датасет обновлён до сборки ${index.builtAt}: имён ${titles.count}`)
  })()

  updating
    .catch((e) => {
      Logger('WARN', 'Датасет: фоновое обновление не удалось', e)
    })
    .finally(() => {
      updating = null
    })
  return updating
}
