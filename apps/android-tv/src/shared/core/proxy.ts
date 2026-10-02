// Прокси для WebView2, только десктоп. Модуль чистый: его тянет и прикладной код, и мост.
// Ключи нельзя держать в core/settings.ts: вышел бы цикл. На ходу не применяется.

export type ProxyKind = 'http' | 'socks5'

export interface ProxyConfig {
  enabled: boolean
  kind: ProxyKind
  host: string
  port: number
  login: string
  /**
   * Хранится В ОТКРЫТОМ ВИДЕ в animori-settings.json: системное хранилище секретов —
   * ещё один плагин и путь отказа. Панель настроек обязана предупредить об этом.
   */
  password: string
  /** Адреса в обход прокси. Разделитель — запятая, точка с запятой или перевод строки. */
  bypass: string
}

/** Ключи хранилища. Единственное место, где они объявлены: их читают и мост, и панель. */
export const PROXY_KEYS = {
  enabled: 'set_proxy_on',
  kind: 'set_proxy_kind',
  host: 'set_proxy_host',
  port: 'set_proxy_port',
  login: 'set_proxy_login',
  password: 'set_proxy_pass',
  bypass: 'set_proxy_bypass',
} as const

/**
 * Значения на случай отсутствия ключа. Порт не подстраивается под тип сознательно:
 * настройка, меняющаяся от соседней, непредсказуема.
 */
export const DEFAULT_PROXY: ProxyConfig = {
  enabled: false,
  kind: 'http',
  host: '',
  port: 8080,
  login: '',
  password: '',
  bypass: 'localhost, 127.0.0.1',
}

/** Приводит прочитанное к известному типу: неизвестное значение — http, а не ошибка. */
export function normalizeProxyKind(value: unknown): ProxyKind {
  return value === 'socks5' ? 'socks5' : 'http'
}

/**
 * Порт как целое в допустимом диапазоне. Ноль означает «значения нет»: так мост
 * отличает непригодный ввод, не бросая исключения. Строка — это ввод из панели.
 */
export function normalizeProxyPort(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return 0
  return parsed
}

/** Пригодна ли настройка к применению. */
export function isProxyUsable(config: ProxyConfig): boolean {
  return config.enabled && config.host.trim().length > 0 && normalizeProxyPort(config.port) !== 0
}

/**
 * Адрес прокси без учётных данных: двоеточия и собаки в пароле ломают склейку user:pass@host.
 * Логин и пароль уходят через basicAuth в TauriBridge.
 */
export function proxyUrl(config: ProxyConfig): string | null {
  if (!isProxyUsable(config)) return null

  const scheme = config.kind === 'socks5' ? 'socks5' : 'http'
  return `${scheme}://${config.host.trim()}:${normalizeProxyPort(config.port)}`
}

export function proxyBypassList(config: ProxyConfig): string[] {
  return config.bypass
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}
