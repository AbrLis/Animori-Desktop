// Проверки журнала отладки: флаг записи, неубивающая сериализация подробностей и хвост, который обязан пережить перезагрузку. Модуль намеренно без импортов, поэтому проверяется сам по себе.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Logger = typeof import('@/utils/logger')

/** Свежее поколение модуля с включённым журналом: состояние общее и между проверками не делится. */
async function freshLogger(): Promise<Logger> {
  vi.resetModules()
  const log = await import('@/utils/logger')
  log.setLogEnabled(true)
  return log
}

/** Уход со страницы дописывает хвост принудительно: так проверяется путь через хранилище. */
function leavePage(): void {
  window.dispatchEvent(new Event('pagehide'))
}

beforeEach(() => {
  sessionStorage.clear()
})

afterEach(() => {
  // Таймер записи переживает проверку, и висящий таймер vitest считает зависшим: снимаем уходом.
  leavePage()
})

describe('журнал отладки: флаг записи', () => {
  it('выключенный флаг молчит, включённый пишет', async () => {
    const log = await freshLogger()

    log.setLogEnabled(false)
    log.Logger('INFO', 'этого быть не должно')
    expect(log.readLogs()).toHaveLength(0)

    // Переключение работает на ходу, без перезапуска: так его и крутит тумблер в настройках.
    log.setLogEnabled(true)
    log.Logger('INFO', 'а это уже да')
    expect(log.readLogs()).toHaveLength(1)
  })
})

describe('журнал отладки: запись', () => {
  it('носит момент и маршрут: строка сама говорит, откуда пришла', async () => {
    const log = await freshLogger()

    log.Logger('ERROR', 'проверка записи')

    const entry = log.readLogs()[0]
    expect(typeof entry?.at).toBe('number')
    expect(typeof entry?.route).toBe('string')
    expect(entry?.time).toMatch(/^\d\d:\d\d:\d\d\.\d{3}$/)
  })

  it('ст��к берёт у ошибки и предупреждения, а у обычной записи — нет', async () => {
    const log = await freshLogger()

    log.Logger('ERROR', 'ошибка')
    log.Logger('WARN', 'предупреждение')
    log.Logger('INFO', 'обычная')

    const rows = log.readLogs()
    expect(rows[0]?.stack).not.toBe('')
    expect(rows[1]?.stack).not.toBe('')
    expect(rows[2]?.stack).toBe('')
  })

  it('подробности приводит к строке: цикл не должен ронять ни запись, ни хвост', async () => {
    const log = await freshLogger()

    // Такой объект роняет JSON.stringify всего хвоста разом — а прежде это молча выключало переживание перезагрузки до конца сеанса.
    const looped: Record<string, unknown> = { name: 'кольцо' }
    looped.self = looped

    expect(() => log.Logger('ERROR', 'с кольцом в подробностях', looped)).not.toThrow()
    expect(log.readLogs()).toHaveLength(1)

    leavePage()
    const saved = sessionStorage.getItem('animori_logs')
    expect(saved).not.toBeNull()
    expect(JSON.parse(saved ?? '{}')).toMatchObject({ v: 2 })
  })
})

describe('журнал отладки: хвост между перезагрузками', () => {
  it('записи переживают перезапуск окна', async () => {
    const log = await freshLogger()
    log.installGlobalErrorHandlers()

    log.Logger('WARN', 'до перезагрузки')
    leavePage()

    const again = await freshLogger()
    again.installGlobalErrorHandlers()

    expect(again.readLogs().map((entry) => entry.message)).toEqual(['до перезагрузки'])
  })

  it('хвост прежней формы уходит молча: разбирать его нечем', async () => {
    // Старая форма лежала голым массивом записей с полем path — без момента времени и маршрута.
    sessionStorage.setItem('animori_logs', JSON.stringify([{ id: 1, message: 'из прошлой сборки' }]))

    const log = await freshLogger()
    log.installGlobalErrorHandlers()

    expect(log.readLogs()).toHaveLength(0)
    expect(sessionStorage.getItem('animori_logs')).toBeNull()
  })

  it('выключенный журнал прошлый хвост не поднимает: человек увидел бы чужой журнал', async () => {
    const log = await freshLogger()
    log.setLogEnabled(false)

    log.Logger('INFO', 'не пишется')
    leavePage()
    log.setLogEnabled(true)

    const again = await freshLogger()
    again.setLogEnabled(false)
    again.installGlobalErrorHandlers()

    expect(again.readLogs()).toHaveLength(0)
  })
})