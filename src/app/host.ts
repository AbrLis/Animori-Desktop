// Система пользователя одной строкой: строке «О программе», записи о запуске в журнале и шапке
// копии журнала она нужна одинаково, а разбирать userAgent в трёх местах — значит со временем
// разъедутся. Имя узла браузера («Windows») человеку отвечает на вопрос сразу, а слово «app» — нет.

/** Название системы по userAgent. */
export function systemName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Android/i.test(ua)) return 'Android'
  if (/Windows/i.test(ua)) return 'Windows'
  if (/Mac OS X/i.test(ua)) return 'macOS'
  if (/Linux/i.test(ua)) return 'Linux'
  return 'неизвестна'
}