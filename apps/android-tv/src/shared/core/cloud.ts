// Распорядитель облачной копии: формат — cloud-file.ts, сеть — yandex-disk.ts, список — collection.ts.
// Облако — хранилище, а не второй хозяин: пишет и читает только по действию человека. Чужую правку не затираем молча.

import {
  checkAccess as diskCheck,
  DISK_APP_ROOT,
  downloadPublic,
  downloadText as diskDownload,
  publicInfo,
  shareFile,
  statFile as diskStat,
  unshareFile,
  uploadText as diskUpload,
} from '../api/yandex-disk'
import { Logger } from '../utils/logger'
import { buildCloudFile, CLOUD_DIR, CLOUD_FILE, parseCloudFile, type CloudFile } from './cloud-file'
import {
  currentUserId,
  dropEntry,
  eachEntry,
  entryCount,
  getEntry,
  initCollection,
  putEntry,
  type PullMode,
} from './collection'
import { saveSetting, settings, type CloudPlace } from './settings'
import { saveSnapshotNow, SNAPSHOT_VERSION } from './snapshot'

/** Путь файла копии для API Диска: приставка app: и есть папка приложения. */
const FILE_PATH = `${DISK_APP_ROOT}/${CLOUD_FILE}`

// Где копия лежит с точки зрения человека. Имя папки Диск берёт из названия приложения
// в OAuth, а не из наших констант: совпадение с CLOUD_DIR — договорённость.
export const CLOUD_PATH = `Приложения/${CLOUD_DIR}/${CLOUD_FILE}`

// Исход облачного действия: та же форма, что у клиента Диска — человеку нужна
// фраза на экран, а не исключение в журнале.
export type CloudDone<T> = { ok: true; value: T } | { ok: false; problem: string }

/** Чем кончилось сохранение копии. */
export interface CloudSaved {
  bytes: number
  count: number
  savedAt: number
}

// Что лежит в облаке вместо нашей копии. Нужно для вопроса человеку: судьбу чужой
// записи он не должен решать вслепую.
export interface CloudStranger {
  bytes: number
  /** Время правки со стороны облака (ISO 8601) или null. */
  modified: string | null
}

// Исход сохранения. Отдельный тип от CloudDone: у отказа есть третье состояние —
// не ошибка, а вопрос. Незнакомая копия в облаке значит, что решать теперь человеку.
export type CloudSaveDone =
  | { ok: true; value: CloudSaved }
  | { ok: false; problem: string; stranger?: CloudStranger }

/** Что лежит в облаке сейчас; отсутствие копии — нормальный ответ. */
export interface CloudInfo {
  there: boolean
  bytes: number
  /** Время правки файла со стороны облака (ISO 8601) или null. */
  modified: string | null
  /** Публичная ссылка на копию или null, если не опубликована. */
  share: string | null
}

/** Что видно по ссылке до приложения копии к списку. */
export interface CloudLink {
  /** Проверенный ключ публикации: его и передавать в pullByLink. */
  key: string
  bytes: number
  /** Время правки файла (ISO 8601) или null. */
  modified: string | null
}

/** Счёт приложенной копии; раздельный, как у переноса с сервера. */
interface CloudCounts {
  total: number
  added: number
  updated: number
  kept: number
  onlyHere: number
}

/** Итог восстановления с числами и паспортом самой копии. */
export interface CloudApplied extends CloudCounts {
  mode: PullMode
  /** Сколько записей в копии оказалось битыми и отброшено. */
  dropped: number
  from: { device: string; savedAt: number; userId: number | null }
}

// Итог приложения вместе с двумя числами самого файла. Внутреннее: числа нужны
// pullCopy, чтобы обновить отметку о своей копии.
interface AppliedCopy {
  applied: CloudApplied
  savedAt: number
  count: number
}

// Какой пропуск брать сейчас, или отказ словами. Синхронно: пропуск Диска вставляют
// руками, и живёт он месяцами — продлевать его не нужно и нечем.
function pass(): CloudDone<string> {
  if (settings.cloudPlace === 'yandex') {
    const token = settings.cloudToken.trim()
    if (token === '') return { ok: false, problem: 'Пропуск Яндекс Диска не введён' }

    return { ok: true, value: token }
  }

  if (settings.cloudPlace === 'google') {
    return {
      ok: false,
      problem:
        'Google Диск из программы убран: выберите Яндекс Диск в настройках. ' +
        'Файл копии в Google Диске остался на месте — он просто больше не обновляется.',
    }
  }

  return { ok: false, problem: 'Облако не выбрано: укажите место в настройках' }
}

// Есть ли чем ходить в облако. Ответ мгновенный и сети не касается: годен ли пропуск,
// знает только облако (checkChosenPlace()).
export function cloudReady(): boolean {
  return settings.cloudPlace === 'yandex' && settings.cloudToken.trim() !== ''
}

// Проверяет вставленный пропуск, не сохраняя его. Лучше сказать «не годится» сразу,
// чем молча запомнить строку и отказать потом.
export async function checkPlace(token: string): Promise<CloudDone<true>> {
  const done = await diskCheck(token)
  if (!done.ok) return done

  return { ok: true, value: true }
}

/** Проверяет выбранное место целиком: и пропуск, и доступ к папке. */
export async function checkChosenPlace(): Promise<CloudDone<true>> {
  const token = pass()
  if (!token.ok) return token

  const done = await diskCheck(token.value)
  if (!done.ok) return { ok: false, problem: done.problem }

  return { ok: true, value: true }
}

// Меняет место копии. Прежнему месту принадлежало и то, и другое: метка знакомой копии
// и числа последней копии (панель иначе обещала бы «812 записей, сохранено вчера»).
export async function choosePlace(place: CloudPlace): Promise<void> {
  if (settings.cloudPlace === place) return

  await saveSetting('cloudPlace', 'am_cloud_place', place)
  await saveSetting('cloudSeenModified', 'am_cloud_seen_modified', '')
  await saveSetting('cloudSavedAt', 'am_cloud_saved_at', 0)
  await saveSetting('cloudSavedCount', 'am_cloud_saved_count', 0)

  Logger('DB', `Облако: место копии теперь ${place}`)
}

/** Где копия лежит с точки зрения человека — для выбранного места. */
export function cloudPathText(): string {
  return settings.cloudPlace === 'yandex' ? CLOUD_PATH : ''
}

// Запоминает время правки файла, каким его назвало облако, — и после своей записи, и
// после чтения. Неудача пишет пустоту, а не прежнее значение: пустота значит «не знаем».
async function rememberSeen(token: string): Promise<void> {
  const seen = await diskStat(token, FILE_PATH)
  const mark = seen.ok && seen.value !== null ? (seen.value.modified ?? '') : ''
  await saveSetting('cloudSeenModified', 'am_cloud_seen_modified', mark)
}

// Зовёт только настольное приложение: на приставке отправки копии нет, а ядро общее.
// Такое место не выбрасывают: продукт, который функцию сейчас не зовёт, не вправе менять
// общий код — этим он разводит копии и теряет перенос правок.
// Собирает список и кладёт копию в облако, замещая прежнюю. `device` — метка устройства
// для человека («Windows», «ТВ»). `force` снимает вопрос о незнакомой копии.
export async function saveCopy(device: string, force = false): Promise<CloudSaveDone> {
  const token = pass()
  if (!token.ok) return token

  // Список обязан быть поднят: иначе в облако уедет пустота вместо списка на диске.
  await initCollection()

  let built
  try {
    built = buildCloudFile({
      entries: Array.from(eachEntry()),
      listVersion: SNAPSHOT_VERSION,
      userId: currentUserId(),
      device,
    })
  } catch (e) {
    Logger('WARN', 'Облако: копия не собралась', e)
    return {
      ok: false,
      problem: e instanceof Error ? e.message : 'Копию списка не удалось собрать',
    }
  }

  // Сторож перед записью: один дешёвый запрос перед заливкой в сотни килобайт.
  if (!force) {
    const there = await diskStat(token.value, FILE_PATH)
    if (!there.ok) return there

    const found = there.value
    if (found !== null && (found.modified ?? '') !== settings.cloudSeenModified) {
      return {
        ok: false,
        problem:
          'В облаке лежит копия, которую писали не мы: ' +
          'запись поверх стёрла бы её безвозвратно.',
        stranger: { bytes: found.bytes, modified: found.modified },
      }
    }
  }

  const sent = await diskUpload(token.value, FILE_PATH, built.text)
  if (!sent.ok) return sent

  // Отметка о копии пишется ПОСЛЕ успеха: обещание копии, которой нет, хуже её
  // отсутствия — на первое человек полагается.
  await saveSetting('cloudSavedAt', 'am_cloud_saved_at', built.file.savedAt)
  await saveSetting('cloudSavedCount', 'am_cloud_saved_count', built.file.count)
  await rememberSeen(token.value)

  Logger('DB', `Облако: копия сохранена, записей ${built.file.count}, байт ${built.bytes}`)

  return {
    ok: true,
    value: { bytes: built.bytes, count: built.file.count, savedAt: built.file.savedAt },
  }
}

// Спрашивает облако, что там лежит. Заодно отдаёт публичную ссылку, если копия опубликована.
export async function copyInfo(): Promise<CloudDone<CloudInfo>> {
  const token = pass()
  if (!token.ok) return token

  const found = await diskStat(token.value, FILE_PATH)
  if (!found.ok) return found

  if (found.value === null) {
    return { ok: true, value: { there: false, bytes: 0, modified: null, share: null } }
  }

  return {
    ok: true,
    value: {
      there: true,
      bytes: found.value.bytes,
      modified: found.value.modified,
      share: found.value.share,
    },
  }
}

// Публикует копию и возвращает короткую ссылку. Единственное место, где список
// становится доступен кому-то ещё, и зовётся оно только кнопкой.
export async function shareCopy(): Promise<CloudDone<string>> {
  const token = pass()
  if (!token.ok) return token

  return shareFile(token.value, FILE_PATH)
}

/** Закрывает ссылку; сам файл копии остаётся на месте и в работе. */
export async function unshareCopy(): Promise<CloudDone<true>> {
  const token = pass()
  if (!token.ok) return token

  const done = await unshareFile(token.value, FILE_PATH)
  if (!done.ok) return done

  return { ok: true, value: true }
}

// Что лежит по чужой ссылке. Пропуска не требует — на этом держится холодный старт. Размер
// и время показать обязательно: замена списка вслепую по строке с пульта — способ его потерять.
export async function linkInfo(link: string): Promise<CloudDone<CloudLink>> {
  const found = await publicInfo(link)
  if (!found.ok) return found

  return {
    ok: true,
    value: {
      key: found.value.key,
      bytes: found.value.file.bytes,
      modified: found.value.file.modified,
    },
  }
}

// Сливает копию с памятью по времени правки. При равных метках остаётся местная запись:
// копия — слепок нашего же списка, равная метка значит ту же правку, а не спор.
function mergeFromCopy(file: CloudFile): CloudCounts {
  let added = 0
  let updated = 0
  let kept = 0
  const seen = new Set<number>()

  for (const fresh of file.entries) {
    seen.add(fresh.mediaId)
    const mine = getEntry(fresh.mediaId)

    if (!mine) {
      putEntry(fresh)
      added++
      continue
    }

    if (mine.updatedAt >= fresh.updatedAt) {
      // Спор о полях местная запись выиграла, но пустоты дополнить можно:
      // без номера MAL запись потом нечем выгрузить в XML.
      const filled = { ...mine }
      let touched = false
      if (filled.malId === null && fresh.malId !== null) {
        filled.malId = fresh.malId
        touched = true
      }
      if (filled.romaji === null && fresh.romaji !== null) {
        filled.romaji = fresh.romaji
        touched = true
      }
      if (filled.english === null && fresh.english !== null) {
        filled.english = fresh.english
        touched = true
      }
      if (touched) putEntry(filled)

      kept++
      continue
    }

    putEntry(fresh)
    updated++
  }

  let onlyHere = 0
  for (const entry of eachEntry()) if (!seen.has(entry.mediaId)) onlyHere++

  return { total: entryCount(), added, updated, kept, onlyHere }
}

// Замещает память копией целиком. Нужен при переносе чужого списка, где слияние дало бы
// кашу из двух жизней.
function replaceFromCopy(file: CloudFile): CloudCounts {
  // Номера собираются заранее: dropEntry правит ту же карту, по которой идёт обход.
  const gone = Array.from(eachEntry(), (entry) => entry.mediaId)
  for (const mediaId of gone) dropEntry(mediaId)
  for (const entry of file.entries) putEntry(entry)

  return {
    total: entryCount(),
    added: entryCount(),
    updated: 0,
    kept: 0,
    onlyHere: 0,
  }
}

// Прикладывает прочитанную копию к списку: один порядок для обоих путей. Чужая копия не
// сливается: метки времени двух людей ничего друг о друге не знают.
async function applyText(text: string, mode: PullMode): Promise<CloudDone<AppliedCopy>> {
  const read = parseCloudFile(text, SNAPSHOT_VERSION)
  if (!read.ok) return { ok: false, problem: read.problem }

  const file = read.file
  const mine = currentUserId()

  if (mode === 'merge' && mine !== null && file.userId !== null && file.userId !== mine) {
    return {
      ok: false,
      problem:
        `Копия снята с другого счёта AniList (${file.userId}, здесь ${mine}): ` +
        'сливать два разных списка нельзя. Замена целиком возможна.',
    }
  }

  if (mode === 'replace' && file.count === 0 && entryCount() > 0) {
    return {
      ok: false,
      problem:
        'В копии нет ни одной записи: замена стёрла бы весь список. ' +
        'Сохраните копию заново или очистите список явно, если именно этого хотите.',
    }
  }

  const counts = mode === 'replace' ? replaceFromCopy(file) : mergeFromCopy(file)
  await saveSnapshotNow({ backup: true })

  Logger(
    'DB',
    `Облако: копия приложена (${mode}): всего ${counts.total}, ` +
      `новых ${counts.added}, обновлено ${counts.updated}, ` +
      `оставлено своих ${counts.kept}, только здесь ${counts.onlyHere}, ` +
      `отброшено битых ${read.dropped}`,
  )

  return {
    ok: true,
    value: {
      applied: {
        ...counts,
        mode,
        dropped: read.dropped,
        from: { device: file.device, savedAt: file.savedAt, userId: file.userId },
      },
      savedAt: file.savedAt,
      count: file.count,
    },
  }
}

/** Забирает свою копию из облака по пропуску и прикладывает к списку. */
export async function pullCopy(mode: PullMode): Promise<CloudDone<CloudApplied>> {
  const token = pass()
  if (!token.ok) return token

  await initCollection()

  const got = await diskDownload(token.value, FILE_PATH)
  if (!got.ok) return got

  const done = await applyText(got.value, mode)
  if (!done.ok) return done

  // Копия, которую только что прочли, с этого момента знакомая: сохранение поверх неё
  // спрашивать не должно.
  await saveSetting('cloudSavedAt', 'am_cloud_saved_at', done.value.savedAt)
  await saveSetting('cloudSavedCount', 'am_cloud_saved_count', done.value.count)
  await rememberSeen(token.value)

  return { ok: true, value: done.value.applied }
}

// Забирает список по короткой ссылке: ни пропуска, ни выбранного места не требует.
// Отметки о своей копии не трогаются: у читателя своей копии в облаке нет.
export async function pullByLink(key: string, mode: PullMode): Promise<CloudDone<CloudApplied>> {
  await initCollection()

  const got = await downloadPublic(key)
  if (!got.ok) return got

  const done = await applyText(got.value, mode)
  if (!done.ok) return done

  Logger('DB', 'Облако: список приложен из копии по ссылке')

  return { ok: true, value: done.value.applied }
}
