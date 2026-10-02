<script setup lang="ts">
// Столбчатая гистограмма экрана статистики: одна на «Оценки», «Год просмотра» и «Год выпуска».
// Числа и кривую присылает экран (график — декорация, а не источник чисел), а масштаб, сетку и
// подписи оси считает сам: высота столбика — доля от потолка шкалы, а не от самой высокой
// колонки, иначе пик всегда упирался бы в край поля, а деления читались бы неверно.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

interface PlotBar {
  key: string
  /** Подпись под столбиком. */
  label: string
  /** Подпись значения: у пика над столбиком и в подсказке. */
  valueText: string
  /** Доля от потолка шкалы, 0..1. */
  share: number
  tip: string
  /** Год для раскрытия; 0 — столбик не раскрывается. */
  year: number
}

interface PlotTick {
  value: number
  text: string
}

/**
 * Оттенок краски. Три соседних цвета палитры — синий, фиолетовый, розовый: они и в трёх
 * темах смотрятся вместе, и зелёный с красным не занимаются — те у темы значат «хорошо»
 * и «плохо», а украшать ими график значило бы выдавать его за оценку.
 */
type PlotTone = 'accent' | 'violet' | 'sakura'

const props = defineProps<{
  bars: PlotBar[]
  ticks: PlotTick[]
  /** Кривая по верхам столбиков и её замкнутый контур для заливки. */
  line: string
  area: string
  /** Оттенок краски; без него — синий. */
  tone?: PlotTone
}>()

const emit = defineEmits<{ pick: [year: number] }>()

// На экране три графика: имена градиентов не должны совпадать.
let plots = 0
const gradId = `am-plot-grad-${(plots += 1)}`

/** Потолок шкалы: последнее деление, от него считаются высоты столбиков и положение сетки. */
const ceiling = computed(() => props.ticks[props.ticks.length - 1]?.value ?? 0)

/** Положение деления в поле SVG (0..1000, ноль снизу). */
function tickY(tick: PlotTick): number {
  return ceiling.value > 0 ? 1000 - (tick.value / ceiling.value) * 1000 : 1000
}

/** Положение деления по вертикали, проценты от низа поля. */
function tickTop(tick: PlotTick): number {
  return ceiling.value > 0 ? (tick.value / ceiling.value) * 100 : 0
}

/** Самая высокая колонка: её значение стоит над столбиком, а не над каждым. */
const peak = computed(() => {
  const ranked = props.bars.map((bar, at) => ({ bar, at })).sort((a, b) => b.bar.share - a.bar.share)
  return ranked[0] ?? null
})

/** Подпись пика: над его столбиком, а не над всем рядом, — иначе она отрывалась от бара. */
const peakStyle = computed(() => {
  const found = peak.value
  if (!found || props.bars.length === 0) return { left: '0%', bottom: '0' }
  return {
    left: `${(((found.at + 0.5) / props.bars.length) * 100).toFixed(2)}%`,
    bottom: `calc(${(found.bar.share * 100).toFixed(2)}% + 5px)`,
  }
})

/** Подписи оси X через одну на длинных рядах: иначе год и столбик не разойдутся. */
const labelStep = computed(() => {
  const count = props.bars.length
  if (count > 40) return 5
  if (count > 20) return 2
  return 1
})

/** Ширина колонки: на длинных рядах она уже, и на экране влезает вдвое больше лет. */
const colWidth = computed(() => (props.bars.length > 26 ? 30 : 46))

/** Ряд не уже суммы колонок — иначе длинный ряд сожмётся в нить. */
const plotStyle = computed(() => ({
  '--am-plot-col': `${colWidth.value}px`,
  minWidth: props.bars.length > 0 ? `calc(${props.bars.length} * var(--am-plot-col))` : '0',
}))

/** Ряд уехал за край: края притухают, иначе про прокрутку никто не знает. */
const scroller = ref<HTMLElement | null>(null)
const overflow = ref(false)
let eye: ResizeObserver | null = null

function checkOverflow(): void {
  const box = scroller.value
  overflow.value = box !== null && box.scrollWidth > box.clientWidth + 1
}

onMounted(() => {
  checkOverflow()
  if (typeof ResizeObserver !== 'undefined' && scroller.value !== null) {
    eye = new ResizeObserver(checkOverflow)
    eye.observe(scroller.value)
  }
})

onBeforeUnmount(() => {
  eye?.disconnect()
  eye = null
})
</script>

<template>
  <div class="am-plot" :class="tone ? `am-plot--${tone}` : ''">
    <!-- Деления стоят вне прокручиваемого ряда: подписи оси не должны уезжать с годами. -->
    <div class="am-plot__axis" aria-hidden="true">
      <span
        v-for="tick in ticks"
        :key="tick.value"
        class="am-plot__tick"
        :style="{ bottom: `${tickTop(tick)}%` }"
      >
        {{ tick.text }}
      </span>
    </div>

    <div
      ref="scroller"
      class="am-plot__scroll"
      :class="{ 'am-plot__scroll--more': overflow }"
    >
      <div class="am-plot__plot" :style="plotStyle">
        <div class="am-plot__tracks">
          <span
            v-if="peak && peak.bar.valueText"
            class="am-plot__peak"
            :style="peakStyle"
          >
            {{ peak.bar.valueText }}
          </span>
          <svg
            v-if="line"
            class="am-plot__curve"
            viewBox="0 0 1000 1000"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient :id="gradId" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" class="am-plot__grad-top" />
                <stop offset="100%" class="am-plot__grad-end" />
              </linearGradient>
            </defs>

            <g class="am-plot__grid">
              <line
                v-for="tick in ticks"
                v-show="tick.value > 0"
                :key="tick.value"
                x1="0"
                x2="1000"
                :y1="tickY(tick)"
                :y2="tickY(tick)"
                vector-effect="non-scaling-stroke"
              />
            </g>

            <path v-if="area" :d="area" :fill="`url(#${gradId})`" />
            <path :d="line" class="am-plot__spline" />
          </svg>

          <ol class="am-plot__cols">
            <li
              v-for="(bar, at) in bars"
              :key="bar.key"
              class="am-plot__col"
              :class="{ 'am-plot__col--peak': peak?.at === at }"
            >
              <!-- Раскрываемый год — кнопка: по клавиатуре до него было не дойти. -->
              <component
                :is="bar.year > 0 ? 'button' : 'div'"
                class="am-plot__hit"
                v-tip="bar.tip"
                :type="bar.year > 0 ? 'button' : undefined"
                :aria-label="bar.year > 0 ? bar.tip : undefined"
                @click="bar.year > 0 && emit('pick', bar.year)"
              >
                <span class="am-plot__bar" :style="{ height: `${(bar.share * 100).toFixed(2)}%` }" />
              </component>
            </li>
          </ol>
        </div>

        <ol class="am-plot__keys">
          <li v-for="(bar, at) in bars" :key="bar.key">{{ at % labelStep === 0 ? bar.label : '' }}</li>
        </ol>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Поле графика: высота и ширина колонки — переменными, ими же управляет разметка ряда.
   Краска приходит из --am-plot-ink: оттенок выбирает разметка, а красятся по нему заливка,
   кривая, точка и подсветка — иначе пришлось бы дублировать правила под каждый цвет. */
.am-plot {
  --am-plot-h: 180px;
  --am-plot-ink: var(--am-accent);
  display: flex;
  gap: 10px;
  width: 100%;
  /* Мышью область не выделяется: клик по столбику оставлял бы на краске прямоугольник
     выделения, а подсказка и раскрытие года от него не зависят. */
  user-select: none;
}

/* Фиолетовый и розовый — соседи синего по кругу, поэтому три графика в ряд читаются как
   одна палитра, а не как три разных графика. Зелёный с красным не занимаем: у темы они
   значат «хорошо» и «плохо», а красить ими график значило бы выдавать его за оценку. */
.am-plot--violet {
  --am-plot-ink: var(--am-accent-2);
}

/* Розовый у темы пастельный: на светлой подложке к низу столбика он бы рассыпался, поэтому
   подмешиваем немного красного. На тёмной подложке это лишь чуть плотнее того же тона. */
.am-plot--sakura {
  --am-plot-ink: color-mix(in srgb, var(--am-sakura) 78%, var(--am-bad));
}

/* Деления шкалы стоят вне прокручиваемого ряда и на своих линиях. */
.am-plot__axis {
  position: relative;
  flex: none;
  width: 30px;
  height: var(--am-plot-h);
}

.am-plot__tick {
  position: absolute;
  right: 0;
  font-size: 10.5px;
  line-height: 1;
  color: var(--am-faint);
  font-variant-numeric: tabular-nums;
  transform: translateY(50%);
}

.am-plot__scroll {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
}

/* Ряд уехал за край — края притухают: иначе про прокрутку никто не знает. */
.am-plot__scroll--more {
  mask-image: linear-gradient(90deg, transparent 0, #000 18px, #000 calc(100% - 18px), transparent 100%);
}

.am-plot__plot {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
}

/* Значение пика стоит над своим столбиком: остальные значения — в подсказке. */
.am-plot__peak {
  position: absolute;
  z-index: 2;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--am-dim);
  font-variant-numeric: tabular-nums;
  transform: translateX(-50%);
}

.am-plot__tracks {
  position: relative;
  height: var(--am-plot-h);
  margin-top: 22px;
  border-bottom: 1px solid var(--am-line-soft);
}

.am-plot__curve {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}

.am-plot__grid line {
  /* Линии сетки несут масштаб, а не украшают: на --am-line-soft их почти не видно. */
  stroke: var(--am-line);
  stroke-width: 1;
}

.am-plot__grad-top {
  stop-color: var(--am-plot-ink);
  stop-opacity: 0.22;
}

.am-plot__grad-end {
  stop-color: var(--am-plot-ink);
  stop-opacity: 0;
}

.am-plot__spline {
  fill: none;
  stroke: var(--am-plot-ink);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

.am-plot__cols {
  position: relative;
  z-index: 1;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(var(--am-plot-col, 46px), 1fr);
  height: 100%;
  margin: 0;
  padding: 0;
  list-style: none;
}

.am-plot__col {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  height: 100%;
  min-width: 0;
}

/* Полоса под курсором заменила дорожки во весь рост: те читались как пустые слоты, и маленький
   столбик тонул среди них, а график выглядел пустым. */
.am-plot__hit {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: 0;
  background: none;
  border: 0;
  border-radius: var(--am-r-s);
  transition: background-color var(--am-fast) var(--am-ease);
}

button.am-plot__hit {
  cursor: pointer;
}

.am-plot__col:hover .am-plot__hit {
  background: var(--am-fill-1);
}

.am-plot__bar {
  position: relative;
  width: 100%;
  max-width: 40px;
  background: linear-gradient(
    180deg,
    var(--am-plot-ink),
    color-mix(in srgb, var(--am-plot-ink) 45%, transparent)
  );
  border-radius: var(--am-r-s);
  transition: height var(--am-mid) var(--am-ease);
}

/* Точка — у пика и под курсором: по одной на весь ряд они не превращались бы в гирлянду. */
.am-plot__col--peak .am-plot__bar::after,
.am-plot__col:hover .am-plot__bar::after {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  width: 8px;
  height: 8px;
  background: var(--am-text);
  border: 2px solid var(--am-plot-ink);
  border-radius: var(--am-r-cap);
  transform: translate(-50%, -50%);
}

.am-plot__col:hover .am-plot__bar::after {
  box-shadow: 0 0 8px color-mix(in srgb, var(--am-plot-ink) 60%, transparent);
}

.am-plot__keys {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(var(--am-plot-col, 46px), 1fr);
  justify-items: center;
  margin: 7px 0 0;
  padding: 0;
  list-style: none;
  font-size: 11.5px;
  color: var(--am-dim);
  font-variant-numeric: tabular-nums;
}
</style>
