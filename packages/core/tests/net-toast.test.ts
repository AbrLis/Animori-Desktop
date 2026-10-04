// Тексты тостов о сети (`core/net-toast`). Проверяется форма и обязательность совета:
// тост без подсказки хуже молчания — человек читает и не понимает, что делать.

import { describe, expect, it } from 'vitest'

import { toastFor, toastLine } from '@/core/net-toast'
import type { NetSourceHealth, NetState } from '@/core/net-health'

/** Запись учёта с заданным исходом: состояние и строка подробностей приходят из api/*. */
function record(state: NetState, lastDetail?: string, id = 'anilist'): NetSourceHealth {
  return {
    id,
    label: 'AniList',
    state,
    since: 0,
    lastSeenAt: Date.now(),
    failStreak: state === 'unknown' ? 0 : 2,
    lastDetail,
    lastStatus: lastDetail?.startsWith('HTTP ') ? Number(lastDetail.slice(5)) : undefined,
  }
}

describe('тост сети: в нём есть код, причина и совет', () => {
  it('403: код ответа, причина и VPN в совете', () => {
    const toast = toastFor(record('forbidden', 'HTTP 403'))

    expect(toast?.code).toBe('HTTP 403')
    expect(toast?.cause).toBe('отказал в доступе')
    expect(toast?.advice).toContain('VPN')
  })

  it('451 — регион закрыт, а не поломка', () => {
    const toast = toastFor(record('forbidden', 'HTTP 451'))

    expect(toast?.code).toBe('HTTP 451')
    expect(toast?.advice).toContain('регион')
  })

  it('обрыв: код остаётся соразмерным виду сбоя', () => {
    const toast = toastFor(record('unreachable', 'network'))

    // «HTTP network» звучал бы как ошибка чтения: сеть не отдала ни кода, ни тела.
    expect(toast?.code).toBe('network')
    expect(toast?.cause).toBe('нет связи')
  })

  it('таймаут советует и подождать, и VPN', () => {
    const toast = toastFor(record('unreachable', 'timeout'))

    expect(toast?.code).toBe('timeout')
    expect(toast?.advice).toContain('позже')
    expect(toast?.advice).toContain('VPN')
  })

  it('пятисотка — дело сервиса, VPN тут ни при чём', () => {
    const toast = toastFor(record('serverError', 'HTTP 503'))

    expect(toast?.code).toBe('HTTP 503')
    // Совет про VPN здесь вводил бы в заблуждение: с сервисом VPN ничего не сделает.
    expect(toast?.advice).not.toContain('VPN')
  })

  it('незнакомый код не ломает тост, а даёт общий совет', () => {
    const toast = toastFor(record('serverError', 'HTTP 418'))

    expect(toast?.advice).toBe('попробуйте позже')
  })

  it('у здорового источника тоста нет', () => {
    expect(toastFor(record('ok', 'HTTP 200'))).toBeNull()
  })

  it('непроверенный источник не вызывает тревоги', () => {
    // Пока источник не спросили, он не беда: молчание здесь уместнее плашки.
    expect(toastFor(record('unknown'))).toBeNull()
  })
})

describe('тост сети: совет обязателен', () => {
  const cases: Array<[string, NetState, string | undefined]> = [
    ['403', 'forbidden', 'HTTP 403'],
    ['451', 'forbidden', 'HTTP 451'],
    ['обрыв', 'unreachable', 'network'],
    ['таймаут', 'unreachable', 'timeout'],
    ['500', 'serverError', 'HTTP 500'],
    ['без подробностей', 'serverError', undefined],
  ]

  for (const [name, state, detail] of cases) {
    it(`${name}: причина и совет не пустые`, () => {
      const toast = toastFor(record(state, detail))

      expect(toast?.cause.length).toBeGreaterThan(0)
      expect(toast?.advice.length).toBeGreaterThan(0)
    })
  }
})

describe('тост сети: строка целиком', () => {
  it('читается как отчёт: кто, что, почему, что делать', () => {
    const toast = toastFor(record('forbidden', 'HTTP 403'))
    const line = toastLine(toast!)

    expect(line).toContain('AniList')
    expect(line).toContain('HTTP 403')
    expect(line).toContain('отказал в доступе')
    expect(line).toContain('VPN')
  })

  it('строка не длиннее двух строк на экране', () => {
    const line = toastLine(toastFor(record('unreachable', 'timeout'))!)

    // Плашка на весь экран из-за одной фразы читалась бы как авария.
    expect(line.length).toBeLessThanOrEqual(110)
  })

  it('каждый источник узнаётся по своему идентификатору', () => {
    const a = toastFor(record('unreachable', 'network', 'anilist'))
    const b = toastFor(record('unreachable', 'network', 'shiki'))

    expect(a?.id).not.toBe(b?.id)
  })
})