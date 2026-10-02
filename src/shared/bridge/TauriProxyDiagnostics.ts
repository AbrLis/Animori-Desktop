// Реализация IProxyDiagnostics для десктопа, вынесена из TauriBridge ради размера.
// Инвариант 1 цел: файл внутри src/shared/bridge, импортирует его только TauriBridge.

import { invoke } from '@tauri-apps/api/core'

import type { IProxyDiagnostics, ProxyOutcome, ProxyProbe, ProxyStatus } from './IBridge'

/** Что отдаёт Rust (camelCase). Поля reachable в ответе нет: это outcome === 'applied'. */
type RawProxyProbe = {
  outcome: ProxyOutcome
  server: string
  hasCredentials: boolean
  latencyMs: number
}

export const tauriProxyDiagnostics: IProxyDiagnostics = {
/** Исход применения прокси и состояние авторизации. Сетевой работы нет, вызов дешёвый. */
  async status(): Promise<ProxyStatus> {
    return await invoke<ProxyStatus>('animori_proxy_status')
  },

/** Живая проверка адреса: до двух секунд, поэтому только по кнопке. */
  async probe(): Promise<ProxyProbe> {
    const raw = await invoke<RawProxyProbe>('animori_proxy_probe')

    return {
      outcome: raw.outcome,
      server: raw.server,
      reachable: raw.outcome === 'applied',
      latencyMs: raw.latencyMs,
    }
  },
}
