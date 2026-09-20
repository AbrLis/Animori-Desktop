// Настройка прокси со стороны разметки: чтение, запись и один вопрос —
// нужен ли перезапуск, чтобы записанное дошло до движка окна.
//
// Отдельным модулем от core/proxy.ts, а не дописанным в него: тот держится
// чистым нарочно, потому что его читает TauriBridge, и импорт '@/bridge'
// оттуда замкнул бы круг. Здесь хранилище нужно, поэтому файл свой.
//
// Разбор значений обязан совпадать с Rust: ключи читают три места — proxy.rs
// (канал окна), anilist.rs (запросы к AniList) и этот модуль, — и разойдись
// они в мелочи, человек видел бы в панели одно, а трафик шёл бы по другому.

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
 * Что записано в настройках сейчас. Значения по умолчанию подставляются
 * только при отсутствии ключа: пустая строка в файле — осознанный выбор
 * человека, и перебивать её дефолтом нельзя (то же правило в proxy.rs).
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
 * Записать одно поле и сразу вернуть управление. Не отклоняется по той же
 * причине, что saveSetting в core/settings.ts: зовут из обработчиков разметки,
 * где дождаться результата негде, а отклонение всплыло бы глобальным
 * unhandledrejection. Отказ записи остаётся в журнале окна.
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
 * Нужен ли перезапуск, чтобы записанная настройка дошла до окна.
 *
 * Ключи запуска WebView2 читаются один раз, при создании первого окна, поэтому
 * перезапуск требуется ровно тогда, когда адрес у движка не тот, что записан.
 * Сравнивается адрес, а не исход: если движок уже пробовал этот же адрес
 * и не достучался, второй заход не изменит ничего — об этом говорит строка
 * состояния, и кнопка «перезапустить» здесь была бы враньём.
 *
 * Адрес у движка пуст при исходах off и invalid: там окно идёт напрямую.
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
