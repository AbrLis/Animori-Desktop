// Проверки подписки на правки памяти (`core/collection`, watchCollection):
// по ней сводка экрана считается заново сама, без ручного «обновить».

import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Запись снимка целиком: пропущенное поле ломает сборку. */
function entry(mediaId: number) {
  return {
    mediaId,
    malId: mediaId,
    status: 'COMPLETED',
    score10: 0,
    progress: 0,
    repeat: 0,
    startedAt: null as string | null,
    completedAt: null as string | null,
    notes: null,
    updatedAt: 0,
    isAdult: false,
    romaji: null,
    english: null,
  }
}

async function setup() {
  vi.resetModules()

  const bridge = await import('./mocks/bridge-module')
  bridge.resetMockBridge()
  bridge.installMockBridge()

  return await import('@/core/collection')
}

beforeEach(() => {
  vi.resetModules()
})

describe('подписка на правки коллекции', () => {
  it('зовёт подписчика на каждую правку записи', async () => {
    const collection = await setup()
    await collection.initCollection()

    let calls = 0
    collection.watchCollection(() => {
      calls += 1
    })

    collection.putEntry(entry(1) as never)
    collection.dropEntry(1)

    expect(calls).toBe(2)
  })

  it('умолкает со снятием подписки: экран ушёл — звать некого', async () => {
    const collection = await setup()
    await collection.initCollection()

    let calls = 0
    const stop = collection.watchCollection(() => {
      calls += 1
    })

    stop()
    collection.putEntry(entry(2) as never)

    expect(calls).toBe(0)
  })

  it('падение подписчика не отменяет ни правку, ни остальных подписчиков', async () => {
    const collection = await setup()
    await collection.initCollection()

    let survived = 0
    collection.watchCollection(() => {
      throw new Error('сводка упала')
    })
    collection.watchCollection(() => {
      survived += 1
    })

    expect(() => collection.putEntry(entry(3) as never)).not.toThrow()
    expect(survived).toBe(1)
    expect(collection.getEntry(3)?.mediaId).toBe(3)
  })
})
