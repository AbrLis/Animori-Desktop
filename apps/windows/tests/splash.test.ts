// Проверки круга надписей плашки главной: круг лежит в хранилище, поэтому спам перезагрузки страницы
// показывает реестр целиком, не повторяя надписей, а не начинает круг заново.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { type MockBridgeHandle } from '@core-tests/bridge'

type Mocks = typeof import('@core-tests/bridge-module')
type Splash = typeof import('../src/app/splash')

/** Ключ круга: проверки смотрят в тот же ключ, что и модуль. */
const STORE_KEY = 'am_splash_round'

/** Что лежит на диске: склад переживает перезагрузку, отсюда и переносится. */
const disk = new Map<string, unknown>()

let splash: Splash
let bridge: MockBridgeHandle

/** Круг, как он лежит в хранилище: номера колоды и номер последней взятой надписи. */
function stored(rest: Array<number | string>, last: unknown): void {
  disk.set(STORE_KEY, { rest, last })
}

/** Запуск приложения: модуль берётся заново, склад на месте, надпись заготавливается до показа. */
async function launch(): Promise<void> {
  vi.resetModules()

  const mocks: Mocks = await import('@core-tests/bridge-module')
  mocks.resetMockBridge()
  bridge = mocks.installMockBridge()
  for (const [key, value] of disk) await bridge.bridge.storage.set(key, value)

  splash = await import('../src/app/splash')
  await splash.initSplash()
}

/** Перезагрузка страницы: записанное остаётся на диске, и круг идёт дальше. */
async function reload(): Promise<void> {
  const written = bridge.calls.storageSet[bridge.calls.storageSet.length - 1]
  if (written !== undefined) disk.set(written.key, written.value)

  await launch()
}

/** Один показ: надпись с плашки, после чего страницу перезагружают. */
async function show(): Promise<string> {
  const line = splash.splashLine()
  await reload()
  return line
}

/** Полный круг показов: столько перезагрузок, сколько надписей в реестре. */
async function wholeRound(): Promise<string[]> {
  const seen: string[] = []
  for (let at = 0; at < splash.SPLASHES.length; at += 1) seen.push(await show())
  return seen
}

/** Надписи без порядка: круг сверяется с реестром по составу, а не по последовательности. */
function sorted(phrases: ReadonlyArray<string>): string[] {
  return [...phrases].sort()
}

beforeEach(async () => {
  disk.clear()
  await launch()
})

describe('круг надписей', () => {
  it('перезагрузка страницы продолжает круг: реестр без повторов', async () => {
    const seen = await wholeRound()

    expect(sorted(seen)).toEqual(sorted(splash.SPLASHES))
  })

  it('фраза одна на запуск: круг сдвигается раз за запуск, а не за каждый зов', async () => {
    const first = splash.splashLine()

    expect(splash.splashLine()).toBe(first)
    expect(splash.splashLine()).toBe(first)
  })

  it('внутри круга надпись не повторяется ни разу', async () => {
    const size = splash.SPLASHES.length
    const shown: string[] = []
    for (let at = 0; at < size * 3; at += 1) shown.push(await show())

    for (let from = 0; from < shown.length; from += size) {
      expect(new Set(shown.slice(from, from + size)).size).toBe(size)
    }
  })

  it('круг за кругом: реестр показывается заново, но в другом порядке', async () => {
    const first = await wholeRound()
    const second = await wholeRound()

    expect(sorted(second)).toEqual(sorted(first))
    // Совпадение целых кругов — событие из области невероятных; стык кругов проверяется точно.
    expect(second).not.toEqual(first)
    expect(second[0]).not.toBe(first[first.length - 1])
  })

  it('ход круга записан до показа: перезагрузка застаёт его сдвинутым', async () => {
    stored([3, 1, 2], 0)
    await launch()

    const line = splash.splashLine()
    const written = bridge.calls.storageSet[bridge.calls.storageSet.length - 1]?.value as {
      rest: number[]
      last: number
    }

    expect(written.last).toBe(splash.SPLASHES.indexOf(line))
    expect(written.rest).not.toContain(written.last)
  })

  it('круг читается из хранилища, а не тасуется заново', async () => {
    stored([3, 1, 2], 0)
    await launch()
    expect(splash.splashLine()).toBe(splash.SPLASHES[3])

    await reload()
    expect(splash.splashLine()).toBe(splash.SPLASHES[1])
  })

  it('круг из одних показанных начинает новый, не повторяя последнюю надпись', async () => {
    stored([], 0)
    await launch()

    expect(splash.splashLine()).not.toBe(splash.SPLASHES[0])
  })

  it('чужие номера отбрасываются', async () => {
    stored([1, 999, 2], -1)
    await launch()

    expect(splash.splashLine()).toBe(splash.SPLASHES[1])
  })

  it('повтор в колоде отменяет запись целиком: круг тасуется заново', async () => {
    stored([4, 4, 2], 0)
    await launch()

    expect(sorted(await wholeRound())).toEqual(sorted(splash.SPLASHES))
  })

  it('пустая и битая запись читается как «круга не было»', async () => {
    disk.set(STORE_KEY, { rest: 'нет', last: [1] })
    await launch()
    expect(splash.SPLASHES).toContain(splash.splashLine())

    disk.clear()
    await launch()
    expect(sorted(await wholeRound())).toEqual(sorted(splash.SPLASHES))
  })
})
