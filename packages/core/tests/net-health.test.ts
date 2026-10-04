// Проверки учёта доступности (`core/net-health`). Именно этот модуль решает, увидит ли человек
// причину пустоты или саму пустоту, поэтому разбор кодов здесь — не украшение, а поведение.

import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Учёт живёт в состоянии модуля, поэтому берём свежую копию вместе с её классом ошибки:
 * после сброса модулей это другой класс, и `instanceof` внутри net-health не сойдётся. */
async function freshNetHealth() {
  vi.resetModules()
  const net = await import('@/core/net-health')
  const bridge = await import('./mocks/bridge-module')

  return { ...net, BridgeHttpError: bridge.BridgeHttpError }
}

describe('net-health: что считается отказом, а что ответом', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('403 от Cloudflare — отказ впустить, а не «нет данных»', async () => {
    const net = await freshNetHealth()

    net.reportStatus('anilist', 'AniList', 403)

    expect(net.getHealth('anilist')?.state).toBe('forbidden')
    expect(net.getHealth('anilist')?.lastDetail).toBe('HTTP 403')
  })

  it('451 — тот же отказ: доступ ограничен законом', async () => {
    const net = await freshNetHealth()

    net.reportStatus('anilist', 'AniList', 451)

    expect(net.getHealth('anilist')?.state).toBe('forbidden')
  })

  it('5xx — беда сервиса, не блокировка', async () => {
    const net = await freshNetHealth()

    net.reportStatus('anilist', 'AniList', 503)

    expect(net.getHealth('anilist')?.state).toBe('serverError')
  })

  it('404 — источник жив: отвечает, просто нет такого', async () => {
    const net = await freshNetHealth()

    net.reportStatus('anilist', 'AniList', 404)

    // Неверно было бы жаловаться на сеть там, где сервер честно сказал «нет».
    expect(net.getHealth('anilist')?.state).toBe('ok')
  })

  it('429 не считается ничьим отказом: это темп, а не беда', async () => {
    const net = await freshNetHealth()

    net.reportStatus('anilist', 'AniList', 429)

    expect(net.getHealth('anilist')).toBeUndefined()
  })

  it('401 тоже оставляют в покое', async () => {
    const net = await freshNetHealth()

    net.reportStatus('shiki', 'Шикимори', 401)

    expect(net.getHealth('shiki')).toBeUndefined()
  })
})

describe('net-health: отказ транспорта', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('обрыв сети — недоступность, её лечит VPN', async () => {
    const net = await freshNetHealth()

    net.reportError('anilist', 'AniList', new net.BridgeHttpError('network', 'https://x'))

    expect(net.getHealth('anilist')?.state).toBe('unreachable')
    expect(net.getHealth('anilist')?.lastDetail).toBe('network')
  })

  it('таймаут — тоже недоступность', async () => {
    const net = await freshNetHealth()

    net.reportError('anilist', 'AniList', new net.BridgeHttpError('timeout', 'https://x'))

    expect(net.getHealth('anilist')?.state).toBe('unreachable')
  })

  it('отмену запроса отказом не считаем: это наше решение, а не беда сети', async () => {
    const net = await freshNetHealth()

    net.reportError('anilist', 'AniList', new net.BridgeHttpError('abort', 'https://x'))

    // Иначе уход с экрана во время ответа писал бы человеку «сеть недоступна».
    expect(net.getHealth('anilist')).toBeUndefined()
  })

  it('чужая ошибка разбора состояния сети не трогает', async () => {
    const net = await freshNetHealth()

    net.reportError('anilist', 'AniList', new Error('JSON разобрался не так'))

    expect(net.getHealth('anilist')).toBeUndefined()
  })
})

describe('net-health: говорить с человеком только после второй неудачи', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('один сбой — тишина: сеть моргает', async () => {
    const net = await freshNetHealth()

    net.reportStatus('anilist', 'AniList', 500)

    expect(net.getHealth('anilist')?.failStreak).toBe(1)
    expect(net.isTroubled('anilist')).toBe(false)
  })

  it('два сбоя подряд — пора объяснять', async () => {
    const net = await freshNetHealth()

    net.reportStatus('anilist', 'AniList', 500)
    net.reportStatus('anilist', 'AniList', 500)

    expect(net.isTroubled('anilist')).toBe(true)
  })

  it('успех обнуляет счётчик неудач', async () => {
    const net = await freshNetHealth()

    net.reportStatus('anilist', 'AniList', 500)
    net.reportStatus('anilist', 'AniList', 200)

    expect(net.getHealth('anilist')?.failStreak).toBe(0)
    expect(net.getHealth('anilist')?.state).toBe('ok')
  })

  it('источник, о котором никто не отчитывался, не проблемный', async () => {
    const net = await freshNetHealth()

    expect(net.isTroubled('никого-нет')).toBe(false)
  })
})

describe('net-health: различение причин отвала', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('два недоступных источника — сеть, и это лечится VPN', async () => {
    const net = await freshNetHealth()

    // Обрыв сообщают дважды: один сбой кодек считает привычным, а не бедой.
    net.reportError('anilist', 'AniList', new net.BridgeHttpError('network', 'https://a'))
    net.reportError('anilist', 'AniList', new net.BridgeHttpError('network', 'https://a'))
    net.reportError('shiki', 'Шикимори', new net.BridgeHttpError('network', 'https://b'))
    net.reportError('shiki', 'Шикимори', new net.BridgeHttpError('network', 'https://b'))

    const outage = net.getOutage()
    expect(outage.active).toBe(true)
    expect(outage.reason).toBe('network')
    expect(outage.labels).toEqual(['AniList', 'Шикимори'])
  })

  it('один недоступный источник — всё равно сеть', async () => {
    const net = await freshNetHealth()

    net.reportError('anilist', 'AniList', new net.BridgeHttpError('network', 'https://a'))
    net.reportError('anilist', 'AniList', new net.BridgeHttpError('network', 'https://a'))

    expect(net.getOutage().reason).toBe('network')
  })

  it('только отказы впустить — блокировка', async () => {
    const net = await freshNetHealth()

    net.reportStatus('anilist', 'AniList', 403)
    net.reportStatus('anilist', 'AniList', 403)

    const outage = net.getOutage()
    expect(outage.active).toBe(true)
    expect(outage.reason).toBe('blocked')
  })

  it('пятисотки без других причин — беда сервиса', async () => {
    const net = await freshNetHealth()

    net.reportStatus('anilist', 'AniList', 500)
    net.reportStatus('anilist', 'AniList', 500)

    expect(net.getOutage().reason).toBe('service')
  })

  it('сеть побеждает блокировку: VPN полезнее при обоих исходах', async () => {
    const net = await freshNetHealth()

    net.reportStatus('anilist', 'AniList', 403)
    net.reportStatus('anilist', 'AniList', 403)
    net.reportError('shiki', 'Шикимори', new net.BridgeHttpError('network', 'https://b'))
    net.reportError('shiki', 'Шикимори', new net.BridgeHttpError('network', 'https://b'))

    expect(net.getOutage().reason).toBe('network')
  })

  it('сбой вне окна не считается нынешним', async () => {
    const net = await freshNetHealth()

    net.reportStatus('anilist', 'AniList', 500)
    net.reportStatus('anilist', 'AniList', 500)

    // Старая беда, к текущему моменту отношения не имеет.
    const later = Date.now() + net.OUTAGE_WINDOW_MS + 1000
    expect(net.getOutage(later).active).toBe(false)
    expect(net.looksLikeOutage(later)).toBe(false)
  })

  it('отказ впустить не выдаётся за недоступность: разные лекарства', async () => {
    const net = await freshNetHealth()

    net.reportStatus('anilist', 'AniList', 403)
    net.reportStatus('anilist', 'AniList', 403)

    // looksLikeOutage намеренно считает только unreachable.
    expect(net.looksLikeOutage()).toBe(false)
  })
})

describe('net-health: копия состояния и подписка', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('список отдаёт копии: правка извне не должна ломать учёт', async () => {
    const net = await freshNetHealth()

    net.reportStatus('anilist', 'AniList', 200)
    const rows = net.listHealth()
    rows[0].state = 'unreachable'

    expect(net.getHealth('anilist')?.state).toBe('ok')
  })

  it('подписчик видит изменения, а отказ от него не ломает остальных', async () => {
    const net = await freshNetHealth()

    let seen = 0
    let healthySeen = 0
    net.subscribeNetHealth(() => {
      throw new Error('этот подписчик сломан')
    })
    net.subscribeNetHealth((rows) => {
      seen += 1
      if (rows.some((r) => r.id === 'anilist' && r.state === 'ok')) healthySeen += 1
    })

    net.reportStatus('anilist', 'AniList', 200)

    // Падение одного подписчика не отменяет доставку второму.
    expect(seen).toBeGreaterThan(0)
    expect(healthySeen).toBe(1)
  })

  it('отказ от подписки действительно отписывает', async () => {
    const net = await freshNetHealth()

    let seen = 0
    const stop = net.subscribeNetHealth(() => {
      seen += 1
    })
    net.reportStatus('anilist', 'AniList', 200)
    const before = seen

    stop()
    net.reportStatus('anilist', 'AniList', 500)

    expect(seen).toBe(before)
  })
})

describe('net-health: ручная проверка источников', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('проба отчитывается через учёт, а не отдельным ответом', async () => {
    const net = await freshNetHealth()

    net.registerProbe('probe:a', 'Проба', async () => {
      net.reportStatus('probe:a', 'Проба', 200)
    })

    await net.runProbes()

    expect(net.getHealth('probe:a')?.state).toBe('ok')
  })

  it('упавшая проба не роняет остальные', async () => {
    const net = await freshNetHealth()

    net.registerProbe('probe:a', 'Первая', async () => {
      net.reportStatus('probe:a', 'Первая', 200)
    })
    net.registerProbe('probe:b', 'Вторая', async () => {
      throw new Error('проба сорвалась')
    })

    await net.runProbes()

    // Первая проба состоялась, сорвавшаяся — не отменяет её результат.
    expect(net.getHealth('probe:a')?.state).toBe('ok')
    expect(net.getHealth('probe:b')?.state).toBe('unknown')
  })

  it('частые нажатия не бьют по сервису: у второй проверки пауза', async () => {
    const net = await freshNetHealth()

    let asked = 0
    net.registerProbe('probe:a', 'Проба', async () => {
      asked += 1
      net.reportStatus('probe:a', 'Проба', 200)
    })

    await net.runProbes()
    await net.runProbes()

    // Человек жмёт кнопку несколько раз подряд — второй раз сервис не должен получать ещё запрос.
    expect(asked).toBe(1)
    expect(net.probeCooldownRemaining()).toBeGreaterThan(0)
  })

  it('источник появляется в таблице сразу, до первой проверки', async () => {
    const net = await freshNetHealth()

    net.registerProbe('probe:a', 'Проба', async () => {
      net.reportOk('probe:a', 'Проба')
    })

    // Пустое место в таблице хуже честного «не проверялся».
    expect(net.getHealth('probe:a')?.state).toBe('unknown')
  })

  it('снятие пробы убирает её из прогона', async () => {
    const net = await freshNetHealth()

    let asked = 0
    const stop = net.registerProbe('probe:a', 'Проба', async () => {
      asked += 1
    })

    stop()
    await net.runProbes()

    expect(asked).toBe(0)
  })
})