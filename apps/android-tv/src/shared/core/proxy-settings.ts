// Настройка прокси со стороны разметки. Отдельно от core/proxy.ts: тот читает TauriBridge,
// импорт '@/bridge' оттуда замкнул бы круг. Разбор значений обязан совпадать с Rust.

import { Bridge, type ProxyStatus } from '@/bridge'

import {
  DEFAULT_PROXY,
  PROXY_KEYS,
  normalizeProxyKind,
  normalizeProxyPort,
  proxyUrl,
  type ProxyConfig,
} from './proxy'

/**
 * Что записано в настройках сейчас. Дефолты подставляются только при отсутствии ключа:
 * пустая строка — осознанный выбор, перебивать её нельзя (то же правило в proxy.rs).
 */
export async function readProxyConfig(): Promise<ProxyConfig> {
  const storage = Bridge.storage

  const [enabled, kind, host, port, login, password, bypass] = await Promise.all([
    storage.get(PROXY_KEYS.enabled, DEFAULT_PROXY.enabled),
    storage.get(PROXY_KEYS.kind, DEFAULT_PROXY.kind),
    storage.get(PROXY_KEYS.host, DEFAULT_PROXY.host),
    storage.get(PROXY_KEYS.port, DEFAULT_PROXY.port),
    storage.get(PROXY_KEYS.login, DEFAULT_PROXY.login),
    storage.get(PROXY_KEYS.password, DEFAULT_PROXY.password),
    storage.get(PROXY_KEYS.bypass, DEFAULT_PROXY.bypass),
  ])

  return {
    // Строго true, как и matches!(…, Bool(true)) в proxy.rs: «да» строкой
    // движок за включение не считает, и панель врать про это не должна.
    enabled: enabled === true,
    kind: normalizeProxyKind(kind),
    // Обрезка пробелов — как read_string() в Rust. Пароль не обрезается
    // нигде: пробел по краям в нём законен, а тихая правка дала бы отказ.
    host: String(host ?? '').trim(),
    port: normalizeProxyPort(port),
    login: String(login ?? '').trim(),
    password: String(password ?? ''),
    bypass: String(bypass ?? ''),
  }
}

/**
 * Записать одно поле и сразу вернуть управление. Не отклоняется, как и saveSetting: зовут
 * из обработчиков разметки, а отклонение всплыло бы глобальным unhandledrejection.
 */
export async function saveProxyField<K extends keyof ProxyConfig>(
  field: K,
  value: ProxyConfig[K],
): Promise<void> {
  try {
    await Bridge.storage.set(PROXY_KEYS[field], value)
  } catch (e) {
    console.error('[AniMori] Не удалось сохранить настройку прокси ' + PROXY_KEYS[field], e)
  }
}

/**
 * Нужен ли перезапуск, чтобы настройка дошла до окна: ключи запуска WebView2 читаются один раз.
 * Сравнивается адрес, а не исход: повторный заход с тем же адресом ничего не изменит.
 */
export function proxyRestartNeeded(
  applied: Pick<ProxyStatus, 'outcome' | 'server'>,
  config: ProxyConfig,
): boolean {
  const wanted = proxyUrl(config)

  // Настройка снята: перезапуск нужен, только если движок всё ещё с прокси.
  if (wanted === null) return applied.outcome === 'applied'

  return applied.server !== wanted
}
