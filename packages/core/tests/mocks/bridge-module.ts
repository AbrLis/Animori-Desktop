import { createMockBridge, type MockBridgeHandle } from './bridge'

/** Наборы берут отсюда и `Bridge`, и тип заглушки: разводить их по двум адресам незачем,
 * а молчащий `undefined` вместо типа поймал бы только проверка типов — то есть после того,
 * как набор уже признан зелёным. */
export type { MockBridgeHandle } from './bridge'

/** Подменяет весь модуль `@/bridge`, поэтому обязан повторять его вывеску: код, который берёт
 * отсюда не только `Bridge`, получит `undefined` и упадёт на первом же `instanceof`. */
export { BridgeHttpError } from '../../src/bridge/IBridge'
export type { HttpErrorKind } from '../../src/bridge/IBridge'

export let currentMock: MockBridgeHandle | null = null

export function installMockBridge(options: { filesAvailable?: boolean } = {}): MockBridgeHandle {
  currentMock = createMockBridge(options)
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
