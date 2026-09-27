<script setup lang="ts">
// Вкладка «Статистика»: сводка по своему списку и графики. Числа считает stats-count.ts по памяти
// коллекции — ни запроса, ни ожидания; форматы приезжают из кэша обликов, и их добор экран ведёт сам,
// чтобы человек не пролистывал ради кольца весь список.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { initCollection, watchCollection } from '@/core/collection'
import { hydrateLooks, lookKnown, warmLooks } from '@/core/media-looks'

import EmptyMark from '../components/EmptyMark.vue'

import {
  arcDash,
  arcShift,
  buildStats,
  emptyStats,
  formatlessIds,
  formatNumber,
  MINUTES_PER_EPISODE,
  pointsForBars,
  RING_TURN,
  sectorPath,
  smoothAreaPath,
  smoothPath,
  splitLegend,
  type StatsSummary,
} from './stats-count'

/** Сколько плиток-заглушек показать, пока снимок поднимается с диска: столько же, сколько настоящих. */
const HOLD_TILES = 5

/** Сколько тайтлов спрашиваем у сети за раз: столько же везёт одна страница обликов. */
const FORMAT_CHUNK = 50

/** Вкладки метрики гистограммы «Год просмотра». */
type YearMetric = 'titles' | 'hours' | 'score'

interface YearTabChoice {
  key: YearMetric
  title: string
}

const YEAR_TABS: YearTabChoice[] = [
  { key: 'titles', title: 'Просмотрено тайтлов' },
  { key: 'hours', title: 'Просмотрено часов' },
  { key: 'score', title: 'Средняя оценка' },
]

/** Идёт ли подъём снимка. До него чисел нет вовсе, и показывать нули значило бы врать. */
const busy = ref(true)

const stats = ref<StatsSummary>(emptyStats())

/** Какую метрику рисует гистограмма года: выбор живёт только на время экрана. */
const yearMetric = ref<YearMetric>('titles')

/** Цвет дуги и точки легенды: закладка называет класс, а цвета живут в теме. */
function sliceClass(key: string): string {
  return `am-stats__arc--${key.toLowerCase()}`
}

/** Высота столбика: ноль остаётся нулём, остальное не тоньше четырёх процентов — иначе колонки не видно. */
function barHeight(share: number): string {
  return share <= 0 ? '0%' : `${Math.max(4, share * 100)}%`
}

/** Проценты для легенды: целые — дробные спорили бы с числами рядом. */
function percent(share: number): string {
  return `${Math.round(share * 100)}%`
}

/** Оценка одним знаком: «7,5» читается, «7.500000000001» — нет. */
function scoreText(value: number): string {
  return value > 0 ? value.toFixed(1).replace('.', ',') : '—'
}

/** Дни одним знаком с запятой: тот же вид, что у прочих дробных чисел экрана. */
function decimalText(value: number): string {
  return value.toFixed(1).replace('.', ',')
}

/** Подсказка сектора и строки легенды: кто это и сколько. Без названия кольцо не читается. */
function sliceTip(slice: { title: string; count: number; share: number }): string {
  return `${slice.title}: ${formatNumber(slice.count)} · ${percent(slice.share)}`
}

/** Легенды колец: три крупнейших сектора и хвост одной строкой. */
const statusLegend = computed(() => splitLegend(stats.value.statuses))
const formatLegend = computed(() => splitLegend(stats.value.formats))

/** Корень экрана: по его ширине считаются столбцы плиток. */
const root = ref<HTMLElement | null>(null)

/** Ширина плитки, с которой она ещё переносится; то же число лежит в minmax у CSS ниже. */
const TILE_BASIS = 196

/** Сколько плиток в ряду: столько, чтобы последний ряд встал ровно, без пустой клетки. */
const tileCols = ref(3)

/** Смотритель за шириной окна: без него расчёт столбцов сделался бы одноразовым. */
let tilesObserver: ResizeObserver | null = null

/**
 * Столбцы плиток: сначала сколько влезает, потом ряды делятся поровну —
 * и в каждом ряду клетки делят всю ширину, пустых мест не остаётся ни при какой ширине окна.
 */
function restyleTiles(): void {
  const box = root.value
  if (box === null) return

  const list = box.querySelector<HTMLElement>('.am-stats__tiles')
  if (list === null) return

  const count = list.children.length
  if (count === 0) return

  const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0
  const fit = Math.max(1, Math.floor((list.clientWidth + gap) / (TILE_BASIS + gap)))
  const rows = Math.ceil(count / fit)
  tileCols.value = Math.max(1, Math.ceil(count / rows))
}

/** Сколько записей ещё без формата: столько же показывает доля «Неизвестно» в кольце. */
const formatsLeft = computed(() => {
  const unknown = stats.value.formats.find((slice) => slice.key === 'UNKNOWN')
  return unknown?.count ?? 0
})

/** Сколько тайтлов попало в кольцо форматов: формат приходит из кэша обликов и остаётся у человека. */
const formatsKnown = computed(() => stats.value.titles - formatsLeft.value)

/** Идёт ли добор форматов: пока он идёт, кольцо достраивается само. */
const formatsBusy = ref(false)

/** Номер добора: правка списка начинает свой, уход с экрана отменяет идущий. */
let formatRun = 0

/** Идущий добор и просьба повторить: правки списка сыплются подряд, второй проход сразу не нужен. */
let formatsTask: Promise<void> | null = null
let formatsAgain = false

/**
 * Добор форматов: сперва склад — он лежит у человека и не стоит ни одного запроса, — потом сеть
 * пачками. Без склада первое открытие вкладки шло бы в сеть за каждым тайтлом списка; без сети
 * кольцо показывает то, что уже знает, и не пропадает.
 */
function fillFormats(): void {
  if (formatsTask !== null) {
    formatsAgain = true
    return
  }

  const run = (formatRun += 1)
  const task = runFormats(run)

  formatsTask = task
  void task.finally(() => {
    if (formatsTask !== task) return

    formatsTask = null
    formatsBusy.value = false

    if (!formatsAgain) return
    formatsAgain = false
    fillFormats()
  })
}

async function runFormats(run: number): Promise<void> {
  try {
    const wanted = formatlessIds()
    if (wanted.length === 0) return

    formatsBusy.value = true

    await hydrateLooks(wanted)
    if (run !== formatRun) return

    stats.value = buildStats()

    const rest = formatlessIds()
    for (let from = 0; from < rest.length; from += FORMAT_CHUNK) {
      if (run !== formatRun) return

      const chunk = rest.slice(from, from + FORMAT_CHUNK)
      await warmLooks(chunk)
      if (run !== formatRun) return

      stats.value = buildStats()

      // Ни один номер пачки не стал известен — ответа не было: спрашивать остальное незачем.
      if (!chunk.some((mediaId) => lookKnown(mediaId))) break
    }
  } catch (e) {
    // Отказ разметку не роняет: кольцо покажет то, что уже собрано.
    console.error('AniMori: форматы не добрались', e)
  }
}

/** Сколько серий в среднем приходится на тайтл; пустой список — ноль, а не деление на ноль. */
const perTitle = computed(() => {
  const source = stats.value
  return source.titles > 0 ? source.episodes / source.titles : 0
})

/** Данные колонок для гистограммы оценок (1–10). */
const scoreChartBars = computed(() => {
  return stats.value.scores.map((bar) => ({
    key: bar.score,
    label: String(bar.score),
    valueText: bar.count > 0 ? formatNumber(bar.count) : '',
    share: bar.share,
    hint: `Оценка ${bar.score}: записей ${formatNumber(bar.count)}`,
  }))
})

/** Плавный график поверх столбиков оценок. */
const scoreSpline = computed(() => {
  if (stats.value.rated === 0) return { line: '', area: '' }
  const points = pointsForBars(scoreChartBars.value)
  return {
    line: smoothPath(points),
    area: smoothAreaPath(points, 1000),
  }
})

/** Данные колонок для гистограммы «Год просмотра» в зависимости от выбранной вкладки. */
const yearChartBars = computed(() => {
  const list = stats.value.years
  if (list.length === 0) return []

  if (yearMetric.value === 'titles') {
    const top = Math.max(1, ...list.map((b) => b.titles))
    return list.map((b) => ({
      key: b.year,
      label: String(b.year),
      valueText: b.titles > 0 ? formatNumber(b.titles) : '',
      share: b.titles / top,
      hint: `${b.year}: тайтлов ${formatNumber(b.titles)}, серий ${formatNumber(b.episodes)}`,
    }))
  }

  if (yearMetric.value === 'hours') {
    const top = Math.max(1, ...list.map((b) => b.hours))
    return list.map((b) => ({
      key: b.year,
      label: String(b.year),
      valueText:
        b.hours > 0 ? (b.hours < 10 ? `${decimalText(b.hours)} ч` : `${formatNumber(b.hours)} ч`) : '',
      share: b.hours / top,
      hint: `${b.year}: ≈ ${decimalText(b.hours)} ч (серий: ${formatNumber(b.episodes)})`,
    }))
  }

  // 'score'
  return list.map((b) => ({
    key: b.year,
    label: String(b.year),
    valueText: b.meanScore > 0 ? scoreText(b.meanScore) : '—',
    share: b.meanScore > 0 ? b.meanScore / 10 : 0,
    hint: `${b.year}: средняя оценка ${b.meanScore > 0 ? scoreText(b.meanScore) : 'нет'} (${formatNumber(b.titles)} тайтл.)`,
  }))
})

/** Плавный график поверх столбиков по годам. */
const yearSpline = computed(() => {
  const bars = yearChartBars.value
  if (bars.length < 2) return { line: '', area: '' }
  const points = pointsForBars(bars)
  return {
    line: smoothPath(points),
    area: smoothAreaPath(points, 1000),
  }
})

/** Пояснение под гистограммой года в зависимости от активной вкладки. */
const yearNote = computed(() => {
  if (yearMetric.value === 'titles') {
    return 'Столбик — число завершённых тайтлов за календарный год; серии в подсказке.'
  }
  if (yearMetric.value === 'hours') {
    return `Столбик — часы просмотра за год из расчёта ${MINUTES_PER_EPISODE} мин на серию.`
  }
  return 'Столбик — средняя выставленная оценка по завершённым тайтлам за год (шкала 1–10).'
})

/** Отказ подписки на правки списка: зовётся при уходе с экрана. */
let stopWatching: (() => void) | null = null

onMounted(async () => {
  // Столбцы считаются сразу и пересчитываются на каждую смену ширины окна.
  restyleTiles()
  if (typeof ResizeObserver !== 'undefined' && root.value !== null) {
    tilesObserver = new ResizeObserver(restyleTiles)
    tilesObserver.observe(root.value)
  }

  // Список поднимается здесь же: без ожидания сводка была бы нулевой.
  // Ошибка подъёма окно не роняет — сводка останется пустой, а причина уйдёт в журнал.
  try {
    await initCollection()
  } catch (e: unknown) {
    console.error('AniMori: статистика не дождалась списка', e)
  }

  stats.value = buildStats()
  busy.value = false

  // Добор форматов идёт своим ходом: числа и оба кольца уже на экране.
  fillFormats()

  // Правка списка меняет сводку сама: числа, доли и годы считаются из памяти в тот же миг.
  stopWatching = watchCollection(() => {
    stats.value = buildStats()
    fillFormats()
  })
})

onBeforeUnmount(() => {
  tilesObserver?.disconnect()
  tilesObserver = null

  stopWatching?.()
  stopWatching = null

  // Идущий добор форматов отпускаем: экран закрыт, отвечать уже некому.
  formatRun += 1
  formatsAgain = false
})
</script>


<template>
  <section ref="root" class="am-page">
    <div class="am-stats__top">
      <h2 class="am-h2">Статистика</h2>
      <span v-if="!busy" class="am-stats__num">{{ formatNumber(stats.titles) }}</span>
      <span class="am-bar__gap" />
      <span class="am-meta">Числа считаются на месте по своему списку; форматы — из кэша обликов</span>
    </div>

    <ul v-if="busy" class="am-stats__tiles">
      <li v-for="n in HOLD_TILES" :key="n" class="am-stats__tile">
        <span class="am-skeleton" />
      </li>
    </ul>

    <div v-else-if="stats.titles === 0" class="am-empty">
      <span class="am-empty__mark"><EmptyMark name="chart" /></span>
      <span>Здесь будет статистика по вашему списку.</span>
      <span>Числа берутся из «Моё»: как только там появятся записи, они приедут сюда.</span>
    </div>

    <template v-else>
      <ul
        class="am-stats__tiles"
        :style="{ gridTemplateColumns: `repeat(${tileCols}, minmax(0, 1fr))` }"
      >
        <li class="am-stats__tile">
          <span class="am-stats__value">{{ formatNumber(stats.titles) }}</span>
          <span class="am-stats__name">Тайтлов в списке</span>
          <span class="am-stats__sub">
            завершено {{ formatNumber(stats.completed) }}, смотрю {{ formatNumber(stats.running) }}
          </span>
        </li>

        <li class="am-stats__tile">
          <span class="am-stats__value">{{ formatNumber(stats.episodes) }}</span>
          <span class="am-stats__name">Серий просмотрено</span>
          <span class="am-stats__sub">{{ decimalText(perTitle) }} серий на тайтл</span>
        </li>

        <li class="am-stats__tile">
          <span class="am-stats__value">{{ decimalText(stats.days) }}</span>
          <span class="am-stats__name">Дней за просмотром</span>
          <span class="am-stats__sub">≈ {{ formatNumber(stats.hours) }} ч экранного времени</span>
        </li>

        <li class="am-stats__tile">
          <span class="am-stats__value">{{ scoreText(stats.meanScore) }}</span>
          <span class="am-stats__name">Средняя оценка</span>
          <span class="am-stats__sub">по {{ formatNumber(stats.rated) }} записям с оценкой</span>
        </li>

        <li class="am-stats__tile">
          <span class="am-stats__value">{{ formatNumber(stats.titles - stats.rated) }}</span>
          <span class="am-stats__name">Без оценки</span>
          <span class="am-stats__sub">оценено {{ formatNumber(stats.rated) }}</span>
        </li>
      </ul>

      <div class="am-stats__grid">
        <section class="am-panel am-stats__card">
          <h3 class="am-h3">Распределение по статусам</h3>

          <div class="am-stats__ring-wrap">
            <svg class="am-stats__ring" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
              <circle class="am-stats__ring-bg" cx="60" cy="60" r="44" />
              <path
                v-for="slice in stats.statuses"
                :key="`hit-${slice.key}`"
                class="am-stats__hit"
                :d="sectorPath(slice.offset, slice.share)"
                v-tip="sliceTip(slice)"
              />
              <!-- Доли повёрнуты к верху кольца здесь, а не поворотом всего полотна:
                   иначе сектор под курсором уезжает от краски на четверть оборота. -->
              <g :transform="RING_TURN">
                <circle
                  v-for="slice in stats.statuses"
                  :key="slice.key"
                  class="am-stats__arc"
                  :class="sliceClass(slice.key)"
                  cx="60"
                  cy="60"
                  r="44"
                  :stroke-dasharray="arcDash(slice.share)"
                  :stroke-dashoffset="arcShift(slice.offset)"
                />
              </g>
            </svg>

            <span class="am-stats__ring-num">
              <span class="am-stats__ring-value">{{ formatNumber(stats.titles) }}</span>
              <span class="am-stats__ring-name">тайтлов</span>
            </span>
          </div>

          <ul class="am-stats__legend">
            <li
              v-for="slice in statusLegend.head"
              :key="slice.key"
              v-tip="sliceTip(slice)"
              class="am-stats__legend-row"
            >
              <span class="am-stats__dot" :class="sliceClass(slice.key)" aria-hidden="true" />
              <span class="am-stats__legend-name">{{ slice.title }}</span>
              <span class="am-stats__legend-num">{{ formatNumber(slice.count) }}</span>
              <span class="am-stats__legend-share">{{ percent(slice.share) }}</span>
            </li>
          </ul>

          <p v-if="statusLegend.tail" class="am-stats__note am-stats__note--tail">
            Ещё {{ statusLegend.tail.parts }} · {{ formatNumber(statusLegend.tail.count) }} ·
            {{ percent(statusLegend.tail.share) }}
          </p>
        </section>

        <section class="am-panel am-stats__card">
          <h3 class="am-h3">Распределение по форматам</h3>

          <div class="am-stats__ring-wrap">
            <svg class="am-stats__ring" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
              <circle class="am-stats__ring-bg" cx="60" cy="60" r="44" />
              <path
                v-for="slice in stats.formats"
                :key="`hit-${slice.key}`"
                class="am-stats__hit"
                :d="sectorPath(slice.offset, slice.share)"
                v-tip="sliceTip(slice)"
              />
              <g :transform="RING_TURN">
                <circle
                  v-for="slice in stats.formats"
                  :key="slice.key"
                  class="am-stats__arc"
                  :class="sliceClass(slice.key)"
                  cx="60"
                  cy="60"
                  r="44"
                  :stroke-dasharray="arcDash(slice.share)"
                  :stroke-dashoffset="arcShift(slice.offset)"
                />
              </g>
            </svg>

            <span class="am-stats__ring-num">
              <span class="am-stats__ring-value">{{ formatNumber(formatsKnown) }}</span>
              <span class="am-stats__ring-name">с форматом</span>
            </span>
          </div>

          <ul class="am-stats__legend">
            <li
              v-for="slice in formatLegend.head"
              :key="slice.key"
              v-tip="sliceTip(slice)"
              class="am-stats__legend-row"
            >
              <span class="am-stats__dot" :class="sliceClass(slice.key)" aria-hidden="true" />
              <span class="am-stats__legend-name">{{ slice.title }}</span>
              <span class="am-stats__legend-num">{{ formatNumber(slice.count) }}</span>
              <span class="am-stats__legend-share">{{ percent(slice.share) }}</span>
            </li>
          </ul>

          <p v-if="formatLegend.tail" class="am-stats__note am-stats__note--tail">
            Ещё {{ formatLegend.tail.parts }} · {{ formatNumber(formatLegend.tail.count) }} ·
            {{ percent(formatLegend.tail.share) }}
          </p>

          <p v-if="formatsBusy" class="am-stats__note">
            Добираю форматы из кэша: осталось {{ formatNumber(formatsLeft) }} — кольцо достроится само
          </p>

          <p v-else-if="formatsLeft > 0" class="am-stats__note">
            {{ formatNumber(formatsLeft) }} записей пока без формата: он берётся из кэша обликов
          </p>
        </section>
      </div>

      <section class="am-panel am-stats__card am-stats__card--wide">
        <h3 class="am-h3">Свои оценки</h3>

        <div class="am-stats__plot am-stats__plot--wide">
          <div class="am-stats__plot-row am-stats__plot-nums">
            <span v-for="bar in scoreChartBars" :key="bar.key" class="am-stats__plot-num">
              {{ bar.valueText }}
            </span>
          </div>

          <div class="am-stats__plot-tracks">
            <svg
              v-if="scoreSpline.line"
              class="am-stats__spline"
              viewBox="0 0 1000 1000"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <defs>
                <linearGradient id="am-stats-score-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" class="am-stats__grad-top" />
                  <stop offset="100%" class="am-stats__grad-end" />
                </linearGradient>
              </defs>
              <path v-if="scoreSpline.area" :d="scoreSpline.area" fill="url(#am-stats-score-grad)" />
              <path :d="scoreSpline.line" class="am-stats__spline-line" />
            </svg>

            <ol class="am-stats__plot-cols">
              <li
                v-for="bar in scoreChartBars"
                :key="bar.key"
                v-tip="bar.hint"
                class="am-stats__plot-col"
              >
                <span class="am-stats__bar-track">
                  <span class="am-stats__bar-fill" :style="{ height: barHeight(bar.share) }">
                    <span v-if="bar.share > 0" class="am-stats__bar-node" />
                  </span>
                </span>
              </li>
            </ol>
          </div>

          <div class="am-stats__plot-row am-stats__plot-keys">
            <span v-for="bar in scoreChartBars" :key="bar.key" class="am-stats__plot-key">
              {{ bar.label }}
            </span>
          </div>
        </div>
      </section>

      <section v-if="stats.years.length > 0" class="am-panel am-stats__card am-stats__card--wide">
        <div class="am-bar am-stats__head">
          <h3 class="am-h3">Год просмотра</h3>
          <span class="am-bar__gap" />
          <div class="am-seg" role="group" aria-label="Метрика по годам">
            <button
              v-for="tab in YEAR_TABS"
              :key="tab.key"
              class="am-seg__btn"
              :class="{ 'am-seg__btn--on': yearMetric === tab.key }"
              type="button"
              :aria-pressed="yearMetric === tab.key"
              @click="yearMetric = tab.key"
            >
              {{ tab.title }}
            </button>
          </div>
        </div>

        <div class="am-stats__plot am-stats__plot--wide">
          <div class="am-stats__plot-row am-stats__plot-nums">
            <span v-for="bar in yearChartBars" :key="bar.key" class="am-stats__plot-num">
              {{ bar.valueText }}
            </span>
          </div>

          <div class="am-stats__plot-tracks">
            <svg
              v-if="yearSpline.line"
              class="am-stats__spline"
              viewBox="0 0 1000 1000"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <defs>
                <linearGradient id="am-stats-year-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" class="am-stats__grad-top" />
                  <stop offset="100%" class="am-stats__grad-end" />
                </linearGradient>
              </defs>
              <path v-if="yearSpline.area" :d="yearSpline.area" fill="url(#am-stats-year-grad)" />
              <path :d="yearSpline.line" class="am-stats__spline-line" />
            </svg>

            <ol class="am-stats__plot-cols">
              <li
                v-for="bar in yearChartBars"
                :key="bar.key"
                v-tip="bar.hint"
                class="am-stats__plot-col"
              >
                <span class="am-stats__bar-track">
                  <span class="am-stats__bar-fill" :style="{ height: barHeight(bar.share) }">
                    <span v-if="bar.share > 0" class="am-stats__bar-node" />
                  </span>
                </span>
              </li>
            </ol>
          </div>

          <div class="am-stats__plot-row am-stats__plot-keys">
            <span v-for="bar in yearChartBars" :key="bar.key" class="am-stats__plot-key">
              {{ bar.label }}
            </span>
          </div>
        </div>

        <p class="am-stats__note">{{ yearNote }}</p>
      </section>

      <p class="am-stats__note">
        Дни и часы — оценка: одна серия считается за {{ MINUTES_PER_EPISODE }} минуты. Длительности
        серий в списке нет, поэтому числа с «≈».
      </p>

      <p v-if="stats.hidden > 0" class="am-stats__note">
        Скрыто тумблером 18+: {{ formatNumber(stats.hidden) }}. С ним числа пересчитаются.
      </p>
    </template>
  </section>
</template>

<style scoped>
/* Полоса над сводкой — то же стекло, что у отбора в списках и истории: вкладка стоит с ними в одном меню. */
.am-stats__top {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  padding: 10px 14px;
  background: var(--am-glass);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-xl);
  box-shadow: inset 0 1px 0 var(--am-edge);
  backdrop-filter: blur(var(--am-blur)) saturate(1.4);
}

.am-stats__num {
  font-size: 12px;
  color: var(--am-faint);
  font-variant-numeric: tabular-nums;
}

/* Плитки без стекла и размытия: их тут десяток, а blur в каждой считался бы кадром.
    auto-fit ниже — запас на первый кадр и скелет; рабочие столбцы ставит разметка (tileCols),
    деля ряды поровну, чтобы пустых клеток не было ни при какой ширине окна. */
.am-stats__tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(196px, 1fr));
  gap: var(--am-gap);
  margin: 0;
  padding: 0;
  list-style: none;
}

.am-stats__tile {
  display: flex;
  flex-direction: column;
  gap: 3px;
  align-items: center;
  min-height: 104px;
  padding: 14px 16px;
  /* Надписи по центру: у числа и подписи разная ширина, и слева от них пустовало. */
  text-align: center;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-l);
}

/* Заглушки подъёма снимка занимают плитку целиком: иначе экран дёрнулся бы на первом числе. */
.am-stats__tile .am-skeleton {
  height: 100%;
  min-height: 76px;
}

.am-stats__value {
  font-size: clamp(26px, 2.4vw, 34px);
  font-weight: 680;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.am-stats__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--am-dim);
}

.am-stats__sub {
  margin-top: auto;
  font-size: 12px;
  color: var(--am-faint);
}

/* Два кольца рядом: карточек ровно две, поэтому auto-fit заполняет ряд целиком,
    а на узком окне складывает их в столбик — пустых клеток не бывает. */
.am-stats__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(330px, 1fr));
  gap: var(--am-gap);
  align-items: start;
}

.am-stats__card {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* Широкая карточка: обе гистограммы во всю горизонтальную плоскость внизу экрана. */
.am-stats__card--wide {
  width: 100%;
}

.am-stats__head {
  gap: 12px;
}

.am-stats__head .am-seg {
  max-width: 100%;
  overflow-x: auto;
}

.am-stats__ring-wrap {
  position: relative;
  display: grid;
  place-items: center;
  width: 236px;
  height: 236px;
  margin: 0 auto;
}

/* Полотно колец: без поворота — доли повёрнуты внутри (RING_TURN), а сектор под курсором стоит
   в тех же координатах: повёрнутое целиком, оно уводит подсказку на чужую долю. */
.am-stats__ring {
  width: 100%;
  height: 100%;
}

.am-stats__ring-bg {
  fill: none;
  stroke: var(--am-fill-2);
  stroke-width: 16;
}

/* Цвет доли задаётся её ключом в одном месте: дуга кольца и точка легенды читают один токен. */
.am-stats__arc {
  fill: none;
  stroke: var(--am-slice, var(--am-faint));
  stroke-width: 16;
  /* Курсор ловит сектор под дугой: обводка не должна перехватывать наведение. */
  pointer-events: none;
  transition: stroke-dasharray var(--am-mid) var(--am-ease);
}

/* Сектор под курсором: прозрачный по покою, под наведением — светлеет и зовёт подпись. */
.am-stats__hit {
  fill: transparent;
  cursor: help;
  transition: fill var(--am-fast) var(--am-ease);
}

.am-stats__hit:hover {
  fill: color-mix(in srgb, var(--am-text) 12%, transparent);
}

.am-stats__arc--current {
  --am-slice: var(--am-accent);
}

.am-stats__arc--repeating {
  --am-slice: var(--am-accent-2);
}

.am-stats__arc--planning {
  --am-slice: var(--am-faint);
}

.am-stats__arc--completed {
  --am-slice: var(--am-good);
}

.am-stats__arc--paused {
  --am-slice: var(--am-warn);
}

.am-stats__arc--dropped {
  --am-slice: var(--am-bad);
}

.am-stats__arc--unknown {
  --am-slice: var(--am-dim);
}

/* Форматы: свой ряд цветов; «неизвестно» — тот же токен, что и у статусов. */
.am-stats__arc--tv {
  --am-slice: var(--am-accent);
}

.am-stats__arc--tv_short {
  --am-slice: color-mix(in srgb, var(--am-accent) 55%, var(--am-dim));
}

.am-stats__arc--movie {
  --am-slice: var(--am-accent-2);
}

.am-stats__arc--special {
  --am-slice: var(--am-good);
}

.am-stats__arc--ova {
  --am-slice: var(--am-warn);
}

.am-stats__arc--ona {
  --am-slice: var(--am-bad);
}

.am-stats__arc--music {
  --am-slice: var(--am-faint);
}

.am-stats__ring-num {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 1px;
  align-items: center;
  pointer-events: none;
}

.am-stats__ring-value {
  font-size: 32px;
  font-weight: 680;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.am-stats__ring-name {
  font-size: 11.5px;
  color: var(--am-faint);
}

.am-stats__legend {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.am-stats__legend-row {
  display: grid;
  grid-template-columns: 10px 1fr auto auto;
  gap: 10px;
  align-items: center;
  font-size: 12.5px;
}

.am-stats__dot {
  width: 10px;
  height: 10px;
  background: var(--am-slice, var(--am-faint));
  border-radius: var(--am-r-cap);
}

.am-stats__legend-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.am-stats__legend-num,
.am-stats__legend-share {
  font-variant-numeric: tabular-nums;
}

.am-stats__legend-num {
  color: var(--am-dim);
}

.am-stats__legend-share {
  min-width: 38px;
  color: var(--am-faint);
  text-align: right;
}


/* Столбчатый график со сплайн-кривой по верхам столбиков. */
.am-stats__plot {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
}

.am-stats__plot-row {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  width: 100%;
  justify-items: center;
}

.am-stats__plot-nums {
  height: 16px;
  align-items: end;
}

.am-stats__plot-num {
  font-size: 11px;
  color: var(--am-faint);
  font-variant-numeric: tabular-nums;
}

.am-stats__plot-tracks {
  position: relative;
  width: 100%;
  height: 110px;
}

.am-stats__plot--wide .am-stats__plot-tracks {
  height: 180px;
}

/* Сплайн-линия соединяет верхушки колонок. */
.am-stats__spline {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}

/* Краска градиента через классы: presentation-атрибут var() не во всех движках читает. */
.am-stats__grad-top {
  stop-color: var(--am-accent);
  stop-opacity: 0.25;
}

.am-stats__grad-end {
  stop-color: var(--am-accent);
  stop-opacity: 0;
}

.am-stats__spline-line {
  fill: none;
  stroke: var(--am-accent);
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
  filter: drop-shadow(0 2px 5px rgb(var(--am-accent-rgb) / 0.45));
}

.am-stats__plot-cols {
  position: relative;
  z-index: 1;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
}

.am-stats__plot-col {
  display: flex;
  justify-content: center;
  align-items: flex-end;
  width: 100%;
  height: 100%;
  cursor: default;
}

.am-stats__bar-track {
  position: relative;
  width: 100%;
  max-width: 26px;
  height: 100%;
  background: var(--am-fill-1);
  border-radius: var(--am-r-s);
  transition: background-color var(--am-fast) var(--am-ease);
}

.am-stats__plot--wide .am-stats__bar-track {
  max-width: 46px;
}

.am-stats__plot-col:hover .am-stats__bar-track {
  background: var(--am-fill-2);
}

.am-stats__bar-fill {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  background: linear-gradient(180deg, var(--am-accent), rgb(var(--am-accent-rgb) / 0.5));
  border-radius: var(--am-r-s);
  transition: height var(--am-mid) var(--am-ease);
}

/* Точка на верхушке столбика, через которую проходит плавная линия. */
.am-stats__bar-node {
  position: absolute;
  top: 0;
  left: 50%;
  width: 7px;
  height: 7px;
  background: var(--am-text);
  border: 2px solid var(--am-accent);
  border-radius: var(--am-r-cap);
  box-shadow: 0 0 6px rgb(var(--am-accent-rgb) / 0.7);
  transform: translate(-50%, -50%);
  transition:
    transform var(--am-fast) var(--am-ease),
    box-shadow var(--am-fast) var(--am-ease);
}

.am-stats__plot--wide .am-stats__bar-node {
  width: 9px;
  height: 9px;
  border-width: 2.5px;
}

.am-stats__plot-col:hover .am-stats__bar-node {
  transform: translate(-50%, -50%) scale(1.25);
  box-shadow: 0 0 10px var(--am-accent);
}

.am-stats__plot-keys {
  height: 18px;
  align-items: start;
}

.am-stats__plot-key {
  font-size: 11px;
  color: var(--am-dim);
  font-variant-numeric: tabular-nums;
}

.am-stats__plot--wide .am-stats__plot-key {
  font-size: 12px;
  font-weight: 600;
}

.am-stats__note {
  margin: 0;
  font-size: 12px;
  color: var(--am-faint);
}

/* Хвост легенды отделён тонкой чертой: без неё строка «Ещё 3 · 7 · 18%» читалась
   как продолжение предыдущей и приписывалась к третьему сектору. */
.am-stats__note--tail {
  padding-top: 10px;
  border-top: 1px solid var(--am-line-soft);
  font-variant-numeric: tabular-nums;
}
</style>
