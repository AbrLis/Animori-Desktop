// Живой запрос через прокси: TCP-щуп в proxy.rs видит лишь приём соединения, а наружу прокси мог не пустить.
// В net-health исход не идёт: одна неудача попала бы в сводку дважды.

import { Bridge } from '@/bridge'

import { Logger } from '../utils/logger'
import { githubLimiter } from './rate-limit'

/** Файл выпуска на GitHub: адрес разрешён в capabilities, отдаётся без входа. */
const CHECK_URL =
  'https://raw.githubusercontent.com/foulnike/Animori-TV/main/README.md'

/** Потолок ожидания: проверка идёт по кнопке, и ждать дольше нечего. */
const CHECK_TIMEOUT_MS = 8000

/** Прошёл ли запрос: вид сбоя не нужен, о молчании прокси скажет щуп. */
export async function proxyLiveCheck(): Promise<boolean> {
  await githubLimiter.acquireSlot()

  try {
    const res = await Bridge.http.request({
      method: 'GET',
      url: CHECK_URL,
      credentials: 'omit',
      timeoutMs: CHECK_TIMEOUT_MS,
    })

    return res.ok
  } catch (e) {
// Отказ — исход проверки, а не поломка; в журнал пишем: молчаливый catch запрещён.
    Logger('WARN', 'Прокси: проверочный запрос не прошёл', e)
    return false
  }
}
