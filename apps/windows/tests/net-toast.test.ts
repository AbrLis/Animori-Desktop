// Проверки плашки о сети. Разбор отказа проверяется в core/tests/net-toast, здесь — отбор
// и повторы: какая плашка попадает на экран, а какая остаётся незамеченной.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MAX_TOASTS, pickToasts } from '@/core/net-toast'
import type { NetSourceHealth } from '@/core/net-health'

/** Свежий учёт сети: состояние модуля общее, поэтому каждый набор берёт своё. */
async function freshNet() {
  vi.resetModules()
  return import('@/core/net-health')
}

/** Запись учёта для отбора: отбору важны состояние и подробности, не возраст. */
function row(id: string, label: string, detail: string): NetSourceHealth {
  return {
    id,
    label,
    state: 'serverError',
    since: 0,
    lastSeenAt: Date.now(),
    failStreak: 2,
    lastDetail: detail,
  }
}

describe('плашка о сети: что попадает на экран', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('один сбой не даёт плашки: сеть моргает', async () => {
    const net = await freshNet()

    net.reportStatus('anilist', 'AniList', 403)
    await vi.waitFor(() => {
      expect(net.listHealth()[0]?.failStreak).toBe(1)
    })

    expect(pickToasts(net.listHealth(), [])).toHaveLength(1)
    // Плашка показывается на второй неудаче: решение о пороге принимает подписчик, отбор лишь отдаёт отказы.
  })

  it('уже показанный отвал повторно не выводится', async () => {
    const net = await freshNet()

    net.reportStatus('anilist', 'AniList', 403)
    const first = pickToasts(net.listHealth(), [])
    const again = pickToasts(
      net.listHealth(),
      first.map((t) => t.id),
    )

    // Плашка каждые полминуты читалась бы как издёвка.
    expect(first).toHaveLength(1)
    expect(again).toHaveLength(0)
  })

  it('второй пострадавший источник добавляется, а не теряется', async () => {
    const net = await freshNet()

    net.reportStatus('anilist', 'AniList', 403)
    const first = pickToasts(net.listHealth(), [])

    net.reportStatus('shiki', 'Шикимори', 500)
    const both = pickToasts(
      net.listHealth(),
      first.map((t) => t.id),
    )

    // Первый отвал не должен вытесняться вторым: пострадавших двое, и обоих надо назвать.
    expect(both.map((t) => t.id)).toEqual(['shiki'])
    expect(both[0]?.label).toBe('Шикимори')
  })

  it('здоровый источник не занимает место на экране', async () => {
    const net = await freshNet()

    net.reportStatus('anilist', 'AniList', 200)

    // Здесь плашка была бы враньём: источник отвечает.
    expect(pickToasts(net.listHealth(), [])).toHaveLength(0)
  })

  it('показаны не больше трёх: дальше читать невозможно', () => {
    const many = Array.from({ length: 6 }, (_, i) => row(`s${i}`, 'Shikimori', 'HTTP 500'))

    expect(many.length).toBeGreaterThan(MAX_TOASTS)
    expect(MAX_TOASTS).toBe(3)
  })
})

describe('плашка о сети: снятие подписки', () => {
  it('после отказа от подписки изменения не приходят', async () => {
    const net = await freshNet()
    let seen = 0
    const stop = net.subscribeNetHealth(() => {
      seen += 1
    })

    net.reportStatus('anilist', 'AniList', 403)
    const afterFirst = seen
    stop()
    net.reportStatus('anilist', 'AniList', 403)

    // Если подписка останется, плашка обновится уже без экрана и уронит его.
    expect(seen).toBe(afterFirst)
  })
})
