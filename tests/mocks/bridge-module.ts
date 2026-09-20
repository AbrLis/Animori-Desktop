import { createMockBridge, type MockBridgeHandle } from './bridge'

/**
 * Подменяет весь модуль `@/bridge`, поэтому обязан повторять его вывеску:
 * код, который берёт отсюда не только `Bridge`, получит `undefined` и упадёт
 * на первом же `instanceof`. Так и было с `BridgeHttpError`: `api/anilist`
 * различает по нему отказ транспорта и отказ самого моста, а в проверках
 * любая сетевая ошибка превращалась в `TypeError: Right-hand side of
 * 'instanceof' is not an object` — то есть проверялся не тот путь.
 *
 * Класс берётся настоящий: сравнение по нему идёт в рабочем коде.
 */
export { BridgeHttpError } from '../../src/shared/bridge/IBridge'

export let currentMock: MockBridgeHandle | null = null

export function installMockBridge(): MockBridgeHandle {
  currentMock = createMockBridge()
  return currentMock
}

function forward(key: PropertyKey): unknown {
  if (currentMock === null) throw new Error('mock bridge не установлен')
  return currentMock.bridge[key as keyof typeof currentMock.bridge]
}

export const Bridge = new Proxy({} as any, {
  get(_target, key) {
    return forward(key)
  },
  set() {
    return false
  },
})

export function resetMockBridge(): void {
  currentMock = null
}
