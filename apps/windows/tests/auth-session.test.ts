import { beforeEach, describe, expect, it, vi } from 'vitest'

// Вызовы Rust подменяются: настоящий invoke в наборе некуда звать.
const invokeMock = vi.fn()
const listenMock = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))

const auth = await import('../src/app/auth/session')

beforeEach(() => {
  invokeMock.mockReset()
  listenMock.mockReset()
  Object.assign(window, { __TAURI_INTERNALS__: {} })
})

describe('состояние входа', () => {
  it('в браузере состояние не спрашивается', async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

    await auth.refreshAuth()

    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('на рабочем столе спрашивает состояние у Rust', async () => {
    invokeMock.mockResolvedValue({ authorized: true, expiresAt: 1700000000 })

    await auth.refreshAuth()

    expect(invokeMock).toHaveBeenCalledWith('animori_auth_status')
    expect(auth.authStatus.value.authorized).toBe(true)
  })

  it('начало входа возвращает срок ожидания, а не токен', async () => {
    invokeMock.mockResolvedValue({ waitSecs: 120 })

    const start = await auth.startLogin()

    expect(start.waitSecs).toBe(120)
    expect(invokeMock).toHaveBeenCalledWith('animori_auth_start')
    // В ответе токена быть не должно: выдаёт его Rust, разметка его не видит.
    expect(Object.keys(start)).toEqual(['waitSecs'])
  })

  it('вставленный токен запоминается как вход', async () => {
    invokeMock.mockResolvedValue({ authorized: true, expiresAt: null })

    await auth.submitToken('токен')

    expect(invokeMock).toHaveBeenCalledWith('animori_auth_submit', {
      token: 'токен',
      expiresIn: null,
    })
    expect(auth.authStatus.value.authorized).toBe(true)
  })

  it('выход снимает вход', async () => {
    invokeMock.mockResolvedValue({ authorized: false, expiresAt: null })

    await auth.logout()

    expect(invokeMock).toHaveBeenCalledWith('animori_auth_logout')
    expect(auth.authStatus.value.authorized).toBe(false)
  })

  it('событие из окна входа обновляет состояние', async () => {
    // Через массив, а не через переменную: одиночную TS сужает до null и ругается на вызов.
    type Payload = { payload: { authorized: boolean; expiresAt: number } }
    const handlers: Array<(event: Payload) => void> = []
    listenMock.mockImplementation((_name: string, fn: (event: Payload) => void) => {
      handlers.push(fn)
      return Promise.resolve(() => undefined)
    })

    await auth.watchAuth()
    handlers[0]?.({ payload: { authorized: true, expiresAt: 1700000000 } })

    expect(listenMock).toHaveBeenCalledWith('animori://auth-changed', expect.any(Function))
    expect(auth.authStatus.value.authorized).toBe(true)
  })

  it('в браузере подписка безопасна и не зовёт события', async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

    const stop = await auth.watchAuth()

    expect(listenMock).not.toHaveBeenCalled()
    expect(typeof stop).toBe('function')
  })
})
