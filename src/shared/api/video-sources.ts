// Порядок здесь — порядок перебора на экране: сначала открытый API, потом цепочки.
// В метке доступности Aniliberty нет вопроса о наличии; у Kodik — presenceCost 'each'.

import { registerVideoSource } from '../core/video'
import { anilibertySource } from './aniliberty'
import { kodikSource } from './kodik'

/** Реестр общий на весь запуск, поэтому сборка идёт ровно один раз. */
let done = false

/** Повторный вызов ничего не стоит и ничего не ломает. */
export function setupVideoSources(): void {
  if (done) return

  registerVideoSource(anilibertySource)

  registerVideoSource({
    ...kodikSource,
    /** Вход только по номеру Шикимори: тайтл без номера службе не адресуем. */
    canAskPresence: (req) => req.shikimoriId !== null && req.shikimoriId > 0,
  })

  done = true
}
