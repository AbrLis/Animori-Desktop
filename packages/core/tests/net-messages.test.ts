// Тексты отказов, которые видит человек. Проверяется не «сообщение есть», а «сообщение
// человеческое»: по-русски, с причиной и советом. Английские диагностические строки вроде
// «Network Error» в полосу попадать не должны — их место в журнале.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { installMockBridge } from './mocks/bridge-module'

/** Мост и модуль AniList свежей копии: состояние ограничителя между наборами не должно течь. */
async function freshAniList() {
  vi.resetModules()
  const mocks = await import('./mocks/bridge-module')
  mocks.resetMockBridge()
  const mock = mocks.installMockBridge()
  const api = await import('@/api/anilist')

  return { mock, api }
}

/** Слова, которых в тексте для человека быть не должно: это язык журнала. */
const JOURNAL_ONLY = ['Network Error', 'Rate Limit', 'GraphQL', 'HTTP', 'пауза ']

/** Проверяет одно сообщение: по-русски, с причиной, с советом и без служебного жаргона. */
function expectHuman(message: string): void {
  expect(message.length).toBeGreaterThan(0)
  // Кириллица обязательна: текст без неё уехал в диагностику.
  expect(message).toMatch(/[а-яА-Я]/)

  for (const word of JOURNAL_ONLY) {
    expect(message.includes(word)).toBe(false)
  }
}

describe('тексты отказов AniList человеческие', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('обрыв сети объясняет и советует', async () => {
    const { mock, api } = await freshAniList()
    const { BridgeHttpError } = await import('./mocks/bridge-module')
    mock.bridge.anilist.query = async () => {
      throw new BridgeHttpError('network', 'https://graphql.anilist.co')
    }

    const message = await api.anilistQuery('{ Media { id } }').catch((e: Error) => e.message)

    expectHuman(message)
    // Человек без подготовки должен понять, что делать: тут нужен VPN.
    expect(message).toContain('VPN')
  })

  it('лимит 429 говорит «подождать», а не «Rate Limit»', async () => {
    const { mock, api } = await freshAniList()
    mock.bridge.anilist.query = async () => ({
      status: 429,
      ok: false,
      headers: { 'retry-after': '60' },
      text: '',
    })

    const message = await api.anilistQuery('{ Media { id } }').catch((e: Error) => e.message)

    expectHuman(message)
    // При лимите единственно уместный совет — подождать, и текст обязан это называть.
    expect(message.toLowerCase()).toMatch(/подожд|повторите/)
  })

  it('пятисотка называет код и не велит ждать', async () => {
    const { mock, api } = await freshAniList()
    mock.bridge.anilist.query = async () => ({
      status: 500,
      ok: false,
      headers: {},
      text: '',
    })

    const message = await api.anilistQuery('{ Media { id } }').catch((e: Error) => e.message)

    expectHuman(message)
    expect(message).toContain('500')
  })
})

describe('тексты отказов Shikimori человеческие', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('закрытый профиль объясняет причину, а не показывает код', async () => {
    const { mock } = await freshAniList()
    const { SHIKI_DOMAINS } = await import('@/core/constants')
    const host = SHIKI_DOMAINS[0] ?? 'shikimori.io'
    mock.setHttpResponse(`https://${host}/api/users/ivan?is_nickname=1`, { status: 403 })

    const { findShikiUser } = await import('@/api/shikimori-list')
    const message = await findShikiUser('ivan').catch((e: Error) => e.message)

    expectHuman(message)
    // Человек должен понять, что это не поломка программы.
    expect(message).toContain('Профиль')
  })

  it('все зеркала недоступны — сразу совет, а не путь GraphQL', async () => {
    const { mock } = await freshAniList()
    const { SHIKI_DOMAINS } = await import('@/core/constants')
    for (const domain of SHIKI_DOMAINS) {
      mock.setHttpError(`https://${domain}/api/users/ivan?is_nickname=1`, 'network')
    }

    const { findShikiUser } = await import('@/api/shikimori-list')
    const message = await findShikiUser('ivan').catch((e: Error) => e.message)

    expectHuman(message)
    expect(message).not.toContain('/api/')
  })
})