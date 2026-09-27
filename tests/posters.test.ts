import { beforeEach, describe, expect, it } from 'vitest'

import type { MediaBrief } from '@/api/anilist-media'
import { forgetLooks, peekLook, rememberBrief } from '@/core/media-looks'
import { forgetCoverMemory, hasLocalCover, localCover, prefetchCovers } from '@/core/posters'

import { installMockBridge, type MockBridgeHandle } from './mocks/bridge-module'

/** Картинка из трёх байт: важна длина, а не содержание. */
function pixels(size = 3): Uint8Array {
  return new Uint8Array(size).fill(7)
}

const COVER_URL = 'https://cdn.anili.st/cover/21.jpg'

/** Краткий облик для проверки шва: подменой адреса занимается сам склад постеров. */
function briefOf(mediaId: number, cover: string): MediaBrief {
  return { mediaId, cover } as MediaBrief
}

let mock: MockBridgeHandle

// Память постеров и обликов живёт в самих модулях, поэтому каждый случай начинается с их сброса.
// Сброс при этом склад не трогает: он и должен пережить смену теста.
beforeEach(() => {
  mock = installMockBridge()
  forgetCoverMemory()
  forgetLooks()
})

describe('склад постеров', () => {
  it('скачанный постер отдаёт локальный адрес вместо ссылки на CDN', async () => {
    mock.setHttpBytes(COVER_URL, pixels())

    const added = await prefetchCovers([{ mediaId: 21, url: COVER_URL }])

    expect(added).toBe(1)

    const cover = localCover(21)
    expect(cover).not.toBeNull()
    expect(cover).not.toBe(COVER_URL)
    expect(hasLocalCover(21)).toBe(true)
  })

  it('свой постер второй раз не качается', async () => {
    mock.setHttpBytes(COVER_URL, pixels())

    await prefetchCovers([{ mediaId: 21, url: COVER_URL }])
    const again = await prefetchCovers([{ mediaId: 21, url: COVER_URL }])

    expect(again).toBe(0)
    expect(mock.calls.httpBytes).toHaveLength(1)
  })

  it('пустое тело постером не считается', async () => {
    // Адреса в мосте нет — тот вернёт пустые байты, и это должно остаться «нет постера».
    const added = await prefetchCovers([{ mediaId: 21, url: COVER_URL }])

    expect(added).toBe(0)
    expect(localCover(21)).toBeNull()
    expect(hasLocalCover(21)).toBe(false)
  })

  it('один отказ не обрывает догрузку остальных', async () => {
    mock.setHttpBytes('https://cdn.anili.st/cover/1.jpg', pixels())
    // Второго адреса в мосте нет — он вернёт пустое тело, как отказ.

    const added = await prefetchCovers([
      { mediaId: 1, url: 'https://cdn.anili.st/cover/1.jpg' },
      { mediaId: 2, url: 'https://cdn.anili.st/cover/2.jpg' },
    ])

    expect(added).toBe(1)
    expect(hasLocalCover(1)).toBe(true)
    expect(hasLocalCover(2)).toBe(false)
  })

  it('пустой список не трогает сеть', async () => {
    expect(await prefetchCovers([])).toBe(0)
    expect(mock.calls.httpBytes).toHaveLength(0)
  })

  it('сброс памяти отпускает адреса запуска', async () => {
    mock.setHttpBytes(COVER_URL, pixels())
    await prefetchCovers([{ mediaId: 21, url: COVER_URL }])

    forgetCoverMemory()

    expect(localCover(21)).toBeNull()
    expect(hasLocalCover(21)).toBe(false)
  })
})

describe('шов в облике', () => {
  it('peekLook отдаёт локальный адрес, когда постер лежит', async () => {
    mock.setHttpBytes(COVER_URL, pixels())
    await prefetchCovers([{ mediaId: 21, url: COVER_URL }])

    rememberBrief(briefOf(21, COVER_URL))

    const cover = peekLook(21)?.cover
    expect(cover).toBe(localCover(21))
    expect(cover).not.toBe(COVER_URL)
  })

  it('без постера облик отдаёт ссылку на CDN как ни в чём не бывало', () => {
    rememberBrief(briefOf(21, COVER_URL))

    expect(peekLook(21)?.cover).toBe(COVER_URL)
  })

  it('тайтла, которого нет, облик по-прежнему не выдумывает', () => {
    expect(peekLook(999)).toBeNull()
  })
})
