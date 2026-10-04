// Система пользователя одной строкой: нужна строке «О программе», записи о запуске и шапке копии журнала.
// Имя узла браузера («Windows») отвечает человеку сразу, а слово «app» — нет.

/** Название системы по userAgent. */
export function systemName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Android/i.test(ua)) return 'Android'
  if (/Windows/i.test(ua)) return 'Windows'
  if (/Mac OS X/i.test(ua)) return 'macOS'
  if (/Linux/i.test(ua)) return 'Linux'
  return 'неизвестна'
}