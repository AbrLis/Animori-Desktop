// Проверки плашки о сети. Разбор отказа проверяется в core/tests/net-toast, здесь — отбор:
// какая плашка попадает на экран, а какая остаётся незамеченной.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { pickToasts } from '@/core/net-toast'
import type { NetSourceHealth, NetState } from '@/core/net-health'

/** Свежий учёт сети: состояние модуля общее, поэтому каждый набор берёт своё. */
async function freshNet() {
  vi.resetModules()
  return import('@/core/net-health')
}

/** Запись учёта для отбора: важны состояние и подробности, не возраст. */
function row(id: string, state: NetState, detail?: string): NetSourceHealth {
  return {
    id,
    label: id.split(':')[0] ?? id,
    state,
    since: 0,
    lastSeenAt: Date.now(),
    failStreak: state === 'ok' ? 0 : 2,
    lastDetail: detail,
  }
}

/** Зеркало: идентификатор с доменом — так его и помечает api/shikimori.ts. */
function mirror(id: string, state: NetState, detail = 'timeout'): NetSourceHealth {
  return row(id, state, state === 'ok' ? 'HTTP 200' : detail)
}

describe('плашка о сети: что попадает на экран', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('отказ здорового источника не даёт плашки', () => {
    expect(pickToasts([row('anilist', 'ok', 'HTTP 200')], [])).toHaveLength(0)
  })

  it('уже показанный отвал повторно не выводится', () => {
    const rows = [row('anilist', 'forbidden', 'HTTP 403')]
    const first = pickToasts(rows, [])

    // Плашка каждые полминуты читалась бы как издёвка.
    expect(first).toHaveLength(1)
    expect(
      pickToasts(
        rows,
        first.map((t) => t.id),
      ),
    ).toHaveLength(0)
  })

  it('ушедшая с экрана плашка не возвращается', () => {
    const rows = [row('anilist', 'forbidden', 'HTTP 403')]
    const announced = pickToasts(rows, []).map((t) => t.id)

    // Память переживает исчезновение с экрана: иначе тост вернулся бы при следующем отчёте.
    expect(pickToasts(rows, announced)).toHaveLength(0)
  })

  it('второй пострадавший источник добавляется, а не теряется', () => {
    const first = pickToasts([row('anilist', 'forbidden', 'HTTP 403')], [])
    const both = pickToasts(
      [row('anilist', 'forbidden', 'HTTP 403'), row('themes', 'serverError', 'HTTP 503')],
      first.map((t) => t.id),
    )

    expect(both.map((t) => t.id)).toEqual(['themes'])
  })

  it('живой учёт без отказов не показывает ничего', async () => {
    const net = await freshNet()
    net.reportStatus('anilist', 'AniList', 200)

    expect(pickToasts(net.listHealth(), [])).toHaveLength(0)
  })
})

describe('плашка о сети: зеркала не шумят', () => {
  it('одно упавшее зеркало при живом втором молчит', () => {
    // Из жалобы: перевод пришёл с .io, запасной .rip отвалился — сообщать не о чем.
    const rows = [
      mirror('shikimori:shikimori.rip', 'unreachable', 'timeout'),
      mirror('shikimori:shikimori.io', 'ok'),
    ]

    expect(pickToasts(rows, [])).toHaveLength(0)
  })

  it('оба зеркала отпали — плашка появляется', () => {
    const rows = [
      mirror('shikimori:shikimori.io', 'unreachable', 'timeout'),
      mirror('shikimori:shikimori.rip', 'forbidden', 'HTTP 403'),
    ]

    expect(pickToasts(rows, [])).toHaveLength(1)
  })

  it('на группу зеркал выходит одна плашка', () => {
    const rows = [
      mirror('shikimori:shikimori.io', 'unreachable', 'timeout'),
      mirror('shikimori:shikimori.rip', 'unreachable', 'timeout'),
    ]

    // Две одинаковые плашки об одном отвале читались бы двумя рядами текста.
    expect(pickToasts(rows, [])).toHaveLength(1)
  })

  it('живое зеркало одного сервиса не оправдывает другой', () => {
    const rows = [
      mirror('shikimori:shikimori.io', 'ok'),
      mirror('anime365:smotret-anime.online', 'unreachable', 'timeout'),
    ]

    expect(pickToasts(rows, [])).toHaveLength(1)
  })

  it('ожившее зеркало снимает запрет на повтор', () => {
    const down = [
      mirror('shikimori:shikimori.io', 'unreachable', 'timeout'),
      mirror('shikimori:shikimori.rip', 'unreachable', 'timeout'),
    ]
    const announced = pickToasts(down, []).map((t) => t.id)

    const healed = [mirror('shikimori:shikimori.io', 'ok'), mirror('shikimori:shikimori.rip', 'ok')]
    const downAgain = [
      mirror('shikimori:shikimori.io', 'unreachable', 'timeout'),
      mirror('shikimori:shikimori.rip', 'forbidden', 'HTTP 403'),
    ]
    // Лечение снимает запрет, новая поломка после него — снова новость.
    pickToasts(healed, announced)

    expect(pickToasts(downAgain, [])).toHaveLength(1)
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
