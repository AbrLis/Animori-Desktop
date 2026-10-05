import { vi } from 'vitest'

import type * as RateLimit from '../../src/api/rate-limit'

/**
 * Мгновенный слот у всех ограничителей темпа — для проверок экранов.
 *
 * Зачем. Ограничитель держит промежуток между запросами: у AniList потолок 30 на окно
 * в минуту, то есть ровно 2000 мс. Проверка экрана делает несколько запросов подряд —
 * на втором и третьем она честно ждёт своё, и файл календаря стоил 36 секунд из 37
 * всего прогона.
 *
 * Почему не поддельные часы. `acquireSlot` — цикл `for(;;)`, который сверяется с
 * `Date.now()` и спит через `setTimeout`. На замороженных часах условие ожидания не
 * станет истинным никогда, и проверка не упадёт, а повиснет. Часы в этих проверках
 * намеренно настоящие (см. комментарии в home-calendar.test.ts).
 *
 * Почему не сброс состояния. Он лечит утечку между случаями, а задержки здесь
 * ВНУТРИ одного случая: сброс ничего не ускоряет.
 *
 * Что остаётся настоящим. Сам ограничитель подменяется не весь: `once()`, счётчики,
 * паузы, `RateLimitError` и все константы приходят из настоящего модуля. Меняется
 * ровно одна вещь — выдача слота, и она в проверках экрана не проверяется.
 * У ограничителя есть своя проверка: packages/core/tests/rate-limit.test.ts.
 */
export function useInstantPace(): void {
  vi.doMock('@/api/rate-limit', async (importOriginal) => {
    const real = await importOriginal<typeof RateLimit>()

    /** Тот же ограничитель, но слот выдаётся сразу: ждать в проверке экрана нечего. */
    const instant = (limiter: RateLimit.RateLimiter): RateLimit.RateLimiter => ({
      ...limiter,
      acquireSlot: () => Promise.resolve(),
    })

    return {
      ...real,
      shikiLimiter: instant(real.shikiLimiter),
      animeThemesLimiter: instant(real.animeThemesLimiter),
      anilistLimiter: instant(real.anilistLimiter),
      githubLimiter: instant(real.githubLimiter),
      anilibertyLimiter: instant(real.anilibertyLimiter),
      kodikLimiter: instant(real.kodikLimiter),
    }
  })
}
