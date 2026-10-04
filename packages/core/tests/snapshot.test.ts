import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  emptySnapshot,
  ownSnapshot,
  readSnapshot,
  saveSnapshotNow,
  SNAPSHOT_VERSION,
} from '@/core/snapshot'
import type { UserSnapshot } from '@/core/snapshot'

import { installMockBridge, type MockBridgeHandle } from './mocks/bridge-module'

const KEY = 'AM_SNAPSHOT'
const FILE = 'animori-snapshot.json'

let mock: MockBridgeHandle

/** Снимок с одной целой записью: форма проверяется на читаемость, не содержание. */
function snapshotOf(entries: unknown[]): unknown {
  return { version: SNAPSHOT_VERSION, userId: 7, savedAt: 100, entries }
}

/** Запись минимальной формы: нормализация сама достроит остальные поля. */
function entryOf(mediaId: number): unknown {
  return { mediaId, status: 'watching', score10: 8, progress: 3 }
}

/** Кладёт снимок прямо в хранилище мимо API: так проверяется чтение, а не запись.
 *  Счётчик записей обнуляется: посев не должен попадать в проверку поведения. */
async function seedStorage(value: unknown): Promise<void> {
  await mock.bridge.storage.set(KEY, value)
  mock.calls.storageSet.length = 0
}

beforeEach(() => {
  mock = installMockBridge()
})

describe('чтение снимка', () => {
  it('целый снимок отдаёт записи как есть', async () => {
    await seedStorage(snapshotOf([entryOf(21)]))

    const snapshot = await readSnapshot()

    expect(snapshot.version).toBe(SNAPSHOT_VERSION)
    expect(snapshot.userId).toBe(7)
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0]?.mediaId).toBe(21)
  })

  it('пустой снимок остаётся пустым и не поднимается из файла', async () => {
    // Осознанно удалённый список нельзя возвращать дублем: человек его стёр.
    await seedStorage(snapshotOf([]))
    mock.setFile(FILE, JSON.stringify(snapshotOf([entryOf(99)])))

    const snapshot = await readSnapshot()

    expect(snapshot.entries).toHaveLength(0)
    expect(mock.calls.storageSet).toHaveLength(0)
  })

  it('снимок чужой версии поднимается из файла и возвращается в хранилище', async () => {
    await seedStorage({ version: SNAPSHOT_VERSION - 1, userId: 7, savedAt: 1, entries: [] })
    mock.setFile(FILE, JSON.stringify(snapshotOf([entryOf(21), entryOf(22)])))

    const snapshot = await readSnapshot()

    expect(snapshot.entries.map((e) => e.mediaId)).toEqual([21, 22])
    // Возврат в хранилище: иначе подъём повторился бы на каждом запуске.
    expect(mock.calls.storageSet).toHaveLength(1)
    expect(await readSnapshot()).toEqual(snapshot)
  })

  it('битые записи отбрасываются поштучно, а не всем снимком', async () => {
    await seedStorage(snapshotOf([entryOf(21), { status: 'x' }, null, entryOf(22)]))

    const snapshot = await readSnapshot()

    expect(snapshot.entries.map((e) => e.mediaId)).toEqual([21, 22])
  })

  it('нормализация чинит мусор в полях, а не роняет запись', async () => {
    await seedStorage(
      snapshotOf([{ mediaId: 21, startedAt: 'вчера', episodes: 0, seasonYear: null, notes: '' }]),
    )

    const entry = (await readSnapshot()).entries[0]

    expect(entry?.startedAt).toBeNull()
    expect(entry?.episodes).toBeNull()
    expect(entry?.seasonYear).toBeNull()
    expect(entry?.notes).toBeNull()
  })

  it('ни снимка, ни дубля — пустой список, а не отказ', async () => {
    const snapshot = await readSnapshot()

    expect(snapshot.entries).toHaveLength(0)
    expect(snapshot.version).toBe(SNAPSHOT_VERSION)
  })

  it('нечитаемый дубль не роняет чтение', async () => {
    mock.setFile(FILE, '{ это не json')

    const snapshot = await readSnapshot()

    expect(snapshot.entries).toHaveLength(0)
  })

  it('доступ к файлам выключен: чтение не падает', async () => {
    mock = installMockBridge({ filesAvailable: false })
    await seedStorage({ version: 1, entries: [] })
    mock.setFile(FILE, JSON.stringify(snapshotOf([entryOf(21)])))

    const snapshot = await readSnapshot()

    expect(snapshot.entries).toHaveLength(0)
  })
})

// Модуль помнит назначенного хозяина и второй раз его не берёт, поэтому источник
// назначается один раз на весь набор, а тесты меняют только содержимое.
let payload: UserSnapshot = emptySnapshot()

beforeAll(() => {
  ownSnapshot(() => payload)
})

describe('запись снимка', () => {
  it('запись без дубля не трогает файл', async () => {
    payload = { ...emptySnapshot(), entries: [entryOf(21) as never] }

    await saveSnapshotNow()

    expect(mock.calls.storageSet).toHaveLength(1)
    expect(mock.getFile(FILE)).toBeNull()
  })

  it('запись с дублем кладёт второй экземпляр в файл', async () => {
    payload = { ...emptySnapshot(), entries: [entryOf(31) as never] }

    await saveSnapshotNow({ backup: true })

    expect(mock.getFile(FILE)).not.toBeNull()
    expect(JSON.parse(mock.getFile(FILE) ?? '{}').entries[0].mediaId).toBe(31)
  })
})