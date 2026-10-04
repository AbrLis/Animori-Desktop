// Различение сетевых отказов в HTTP-слое (`api/shikimori-list`). Проверяется не «пришёл ли ответ»,
// а какой именно: для человека 404, 403, 429 и обрыв — четыре разные беды с разными словами.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SHIKI_DOMAINS } from '@/core/constants'
import { installMockBridge } from './mocks/bridge-module'

const HOST = SHIKI_DOMAINS[0] ?? 'shikimori.io'

/** Адрес поиска пользователя: подменённый ответ ищется по нему целиком. */
function userUrl(nick = 'ivan'): string {
  return `https://${HOST}/api/users/${nick}?is_nickname=1`
}

/** Порядок обязателен: resetModules обнуляет и заглушку, поэтому мост ставится после него,
 * из того же набора модулей, что и проверяемый код. */
async function freshApi() {
  vi.resetModules()
  const mocks = await import('./mocks/bridge-module')
  mocks.resetMockBridge()
  const mock = mocks.installMockBridge()
  const net = await import('@/core/net-health')
  const api = await import('@/api/shikimori-list')

  return { mock, net, ...api, installMockBridge: mocks.installMockBridge }
}

/** Ставит ответ на первом зеркале и запускает поиск. Текст отказа и есть различаемый исход. */
async function searchWith(setup: (mock: ReturnType<typeof installMockBridge>) => void) {
  const { mock, findShikiUser } = await freshApi()
  setup(mock)

  try {
    const user = await findShikiUser('ivan')
    return { user, message: '' }
  } catch (e) {
    return { user: null, message: e instanceof Error ? e.message : String(e) }
  }
}

describe('отказ Шикимори: разные коды — разные слова', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('404 — нет такого ника, виноват человек, а не сеть', async () => {
    const { message } = await searchWith((m) => m.setHttpResponse(userUrl(), { status: 404 }))

    // Ника в списке нет — это не поломка, и звать человека к VPN незачем.
    expect(message).toContain('нет пользователя')
    expect(message).toContain('ivan')
  })

  it('403 — профиль закрыт: перенос невозможен по существу', async () => {
    const { message } = await searchWith((m) => m.setHttpResponse(userUrl(), { status: 403 }))

    // Закрытый профиль — самая частая беда у анонимного доступа, и её надо называть прямо.
    expect(message).toContain('Профиль скрыт')
  })

  it('401 считается тем же закрытым профилем', async () => {
    const { message } = await searchWith((m) => m.setHttpResponse(userUrl(), { status: 401 }))

    expect(message).toContain('Профиль скрыт')
  })

  it('429 — сервер просит подождать, а не отказал', async () => {
    const { message } = await searchWith((m) => m.setHttpResponse(userUrl(), { status: 429 }))

    // Лимит — не беда: предложение подождать здесь единственно уместное.
    expect(message).toContain('подождать')
  })

  it('500 — отказ сервиса, о нём честно и сказано', async () => {
    const { message } = await searchWith((m) => m.setHttpResponse(userUrl(), { status: 500 }))

    expect(message).toContain('500')
  })

  it('200 без пользователя не выдаётся за успех', async () => {
    const { message } = await searchWith((m) => m.setHttpResponse(userUrl(), { id: 0 }))

    // Ответ без номера пользователя — не человек: принять его за найденного нельзя.
    expect(message).toContain('отказом')
  })

  it('битое тело не обрывает перенос молча', async () => {
    const { message } = await searchWith((m) =>
      m.setHttpResponse(userUrl(), { status: 200, text: '{это не json' }),
    )

    expect(message).not.toBe('')
  })
describe('отказ Шикимори: обрыв идёт по зеркалам, а не обрывает всё', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('первое зеркало недоступно, второе отвечает — поиск проходит', async () => {
    const { mock, findShikiUser } = await freshApi()

    const first = SHIKI_DOMAINS[0] ?? HOST
    const second = SHIKI_DOMAINS[1] ?? HOST
    mock.setHttpError(`https://${first}/api/users/ivan?is_nickname=1`, 'network')
    mock.setHttpResponse(
      `https://${second}/api/users/ivan?is_nickname=1`,
      { id: 7, nickname: 'ivan' },
    )

    const user = await findShikiUser('ivan')

    // Обрыв одного зеркала не беда: вторая попытка обязана найти пользователя.
    expect(user.id).toBe(7)
  })

  it('оборваны все зеркала — отказ, а не тишина', async () => {
    const { mock, findShikiUser } = await freshApi()
    for (const domain of SHIKI_DOMAINS) {
      mock.setHttpError(`https://${domain}/api/users/ivan?is_nickname=1`, 'network')
    }

    // Молча вернуть «нет пользователя» здесь вредно: человек решит, что нет у него ника.
    await expect(findShikiUser('ivan')).rejects.toThrow()
  })

  it('таймаут первого зеркала не мешает второму', async () => {
    const { mock, findShikiUser } = await freshApi()

    const first = SHIKI_DOMAINS[0] ?? HOST
    const second = SHIKI_DOMAINS[1] ?? HOST
    mock.setHttpError(`https://${first}/api/users/ivan?is_nickname=1`, 'timeout')
    mock.setHttpResponse(
      `https://${second}/api/users/ivan?is_nickname=1`,
      { id: 9, nickname: 'ivan' },
    )

    const user = await findShikiUser('ivan')

    expect(user.id).toBe(9)
  })
})

describe('отказ Шикимори: учёт сети видит исход', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('403 попадает в учёт как отказ впустить', async () => {
    const { mock, net, findShikiUser } = await freshApi()
    mock.setHttpResponse(userUrl(), { status: 403 })

    await findShikiUser('ivan').catch(() => undefined)

    // Без записи в учёт интерфейс не сможет объяснить человеку, что произошло.
    expect(net.getHealth(`shikimori:${HOST}`)?.state).toBe('forbidden')
  })

  it('обрыв попадает в учёт как недоступность сети', async () => {
    const { mock, net, findShikiUser } = await freshApi()
    for (const domain of SHIKI_DOMAINS) {
      mock.setHttpError(`https://${domain}/api/users/ivan?is_nickname=1`, 'network')
    }

    await findShikiUser('ivan').catch(() => undefined)

    // Состояния разные, потому советы разные: недоступность лечится VPN, отказ впустить — нет.
    expect(net.getHealth(`shikimori:${HOST}`)?.state).toBe('unreachable')
  })

  it('429 не портит учёт: это темп, а не беда', async () => {
    const { mock, net, findShikiUser } = await freshApi()
    mock.setHttpResponse(userUrl(), { status: 429 })

    await findShikiUser('ivan').catch(() => undefined)

    expect(net.getHealth(`shikimori:${HOST}`)).toBeUndefined()
  })
})
})