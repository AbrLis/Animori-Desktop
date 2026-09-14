<script setup lang="ts">
// Музыка тайтла: опенинги и эндинги с AnimeThemes. Плеер в блоке один,
// а темы — строки списка: выбранная заряжается в плеер и звучит.
//
// ПОЧЕМУ ПЛЕЕР ОДИН, А НЕ КНОПКА В КАЖДОЙ СТРОКЕ
//
// Кнопки по строкам давали восемь огрызков плеера: у каждой своя полоса
// и ни у одной — ни перемотки, ни повтора, ни громкости. Управление
// собрано в один пульт над списком, и все органы нарисованы здесь же:
// родной <audio> с системными кнопками в стеклянной панели выглядит
// деталью от другого приложения.
//
// Звук тоже один: <audio> создаётся один раз и переключает src. Файл
// тянется только по выбору темы и в базу не кладётся — тема весит
// мегабайты, а кэш заведён под мелкие ответы служб, не под музыку.
//
// ВИЗУАЛИЗАТОР НЕ В ТАКТ, И ЭТО НАРОЧНО
//
// Пульс и вращение цветка идут ровным ходом, а не по громкости трека.
// Разбор звука требует AnalyserNode, а тот отдаёт данные только при
// crossOrigin: 'anonymous' на элементе: заголовков CORS у выдачи
// AnimeThemes нет, и запрос такого режима просто ломает
// воспроизведение. Обмен звука на дрожание лепестков не стоит того.
//
// Панель молчит, пока тем нет: у половины тайтлов AnimeThemes не знает
// ничего, и пустая коробка «Музыка» была бы честной, но бесполезной.
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { fetchMalThemes, type ThemeLink } from '@/api/animethemes'
import { Bridge } from '@/bridge'
import { Logger } from '@/utils/logger'

import SakuraBloom from './SakuraBloom.vue'

const props = defineProps<{ malId: number | null }>()

/** Сколько строк видно до раскрытия: пятая и дальше уходят под кнопку. */
const FOLD_AT = 4

/** Шаг перемотки стрелками, секунды. */
const STEP_SEC = 5

/** Строка блока: тема с подписью, звуком и ссылками. */
interface TuneRow {
  key: string
  tag: string
  title: string
  artist: string
  audio: string | null
  links: ThemeLink[]
}

/**
 * Громкость живёт вне компонента: карточка пересобирается при каждом
 * переходе, и выставленный уровень иначе возвращался бы к своему
 * значению на каждом тайтле.
 */
let keepVol = 0.8

const rows = ref<TuneRow[]>([])
const open = ref(false)

/** Ключ заряженной темы; null — плеер пуст. */
const pick = ref<string | null>(null)
const playing = ref(false)
const at = ref(0)
const len = ref(0)
const loop = ref(false)
const vol = ref(keepVol)
const mute = ref(false)

/** Тянут ручку таймлайна: показания времени в это время наши, не плеера. */
const drag = ref(false)

let sound: HTMLAudioElement | null = null

/** Номер захода: ответ про прошлое аниме в блок не попадёт. */
let run = 0

const shownRows = computed<TuneRow[]>(() =>
  open.value ? rows.value : rows.value.slice(0, FOLD_AT),
)

const hiddenCount = computed<number>(() => Math.max(0, rows.value.length - FOLD_AT))

const nowRow = computed<TuneRow | null>(
  () => rows.value.find((row) => row.key === pick.value) ?? null,
)

/** Первая тема со звуком: с неё начинает пустой плеер. */
const firstSound = computed<TuneRow | null>(() => rows.value.find((row) => row.audio !== null) ?? null)

const donePart = computed<string>(() =>
  len.value > 0 ? `${Math.min(100, (at.value / len.value) * 100)}%` : '0%',
)

const volPart = computed<string>(() => `${Math.round((mute.value ? 0 : vol.value) * 100)}%`)

const atText = computed<string>(() => timeText(at.value))
const lenText = computed<string>(() => (len.value > 0 ? timeText(len.value) : '--:--'))

const playHint = computed<string>(() => {
  if (nowRow.value === null && firstSound.value === null) return 'Записи нет'
  return playing.value ? 'Пауза' : 'Слушать'
})

/** Время вида «1:07». Часов у тем не бывает, так что без третьего разряда. */
function timeText(sec: number): string {
  const whole = Math.max(0, Math.floor(sec))
  const min = Math.floor(whole / 60)
  const rest = whole % 60
  return `${min}:${rest < 10 ? '0' : ''}${rest}`
}

/** Общий на все органы: доля от левого края до курсора. */
function ratioAt(event: PointerEvent, box: HTMLElement): number {
  const rect = box.getBoundingClientRect()
  if (rect.width <= 0) return 0
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
}

/** Звуковой элемент заводится один раз: переключаем ему src, а не плодим новые. */
function gear(): HTMLAudioElement {
  if (sound !== null) return sound

  const next = new Audio()
  next.preload = 'none'
  next.volume = mute.value ? 0 : vol.value

  next.addEventListener('loadedmetadata', () => {
    len.value = Number.isFinite(next.duration) ? next.duration : 0
  })
  // Пока тянут ручку, время считает рука, а не плеер: иначе ручка дёргалась бы назад.
  next.addEventListener('timeupdate', () => {
    if (!drag.value) at.value = next.currentTime
  })
  next.addEventListener('play', () => {
    playing.value = true
  })
  next.addEventListener('pause', () => {
    playing.value = false
  })
  // Повтор снят — уезжаем на следующую тему со звуком: слушают их обычно подряд.
  next.addEventListener('ended', () => {
    playing.value = false
    at.value = 0
    const after = nextRow()
    if (after !== null) charge(after)
  })
  next.addEventListener('error', () => {
    Logger('WARN', `Музыка: звук темы не пошёл (${pick.value ?? '—'})`)
    playing.value = false
  })

  sound = next
  return next
}

/** Следующая тема со звуком после заряженной. На последней — тишина. */
function nextRow(): TuneRow | null {
  const now = rows.value.findIndex((row) => row.key === pick.value)
  if (now < 0) return null
  return rows.value.slice(now + 1).find((row) => row.audio !== null) ?? null
}

/** Заряжает тему в плеер и пускает её. */
function charge(row: TuneRow): void {
  if (row.audio === null) return

  const box = gear()
  pick.value = row.key
  at.value = 0
  len.value = 0
  box.loop = loop.value
  box.src = row.audio

  void box.play().catch((e) => {
    Logger('WARN', `Музыка: воспроизведение не началось (${row.tag})`, e)
    playing.value = false
  })
}

/** Нажатие по строке: своя тема — пауза и пуск, чужая — смена. */
function onRow(row: TuneRow): void {
  if (row.audio === null) return
  if (row.key === pick.value) {
    onPlay()
    return
  }
  charge(row)
}

/** Главная кнопка. Пустой плеер начинает с первой темы со звуком. */
function onPlay(): void {
  const row = nowRow.value
  if (row === null || sound === null) {
    const first = firstSound.value
    if (first !== null) charge(first)
    return
  }

  if (playing.value) {
    sound.pause()
    return
  }

  void sound.play().catch((e) => {
    Logger('WARN', `Музыка: воспроизведение не началось (${row.tag})`, e)
    playing.value = false
  })
}

function onLoop(): void {
  loop.value = !loop.value
  if (sound !== null) sound.loop = loop.value
}

/** Перемотка на месте: и стрелками, и прыжком по полосе. */
function seekTo(sec: number): void {
  if (sound === null || len.value <= 0) return
  const fixed = Math.min(len.value, Math.max(0, sec))
  at.value = fixed
  sound.currentTime = fixed
}

function onSeekDown(event: PointerEvent): void {
  const box = event.currentTarget as HTMLElement
  if (len.value <= 0) return

  box.setPointerCapture(event.pointerId)
  drag.value = true
  at.value = ratioAt(event, box) * len.value
}

function onSeekMove(event: PointerEvent): void {
  if (!drag.value) return
  at.value = ratioAt(event, event.currentTarget as HTMLElement) * len.value
}

function onSeekUp(): void {
  if (!drag.value) return
  drag.value = false
  seekTo(at.value)
}

function setVol(part: number): void {
  vol.value = part
  keepVol = part
  mute.value = part <= 0
  if (sound !== null) sound.volume = part
}

function onVolDown(event: PointerEvent): void {
  const box = event.currentTarget as HTMLElement
  box.setPointerCapture(event.pointerId)
  drag.value = false
  setVol(ratioAt(event, box))
}

function onVolMove(event: PointerEvent): void {
  if (event.buttons === 0) return
  setVol(ratioAt(event, event.currentTarget as HTMLElement))
}

/** Тишина без потери уровня: обратное нажатие возвращает прежнюю громкость. */
function onMute(): void {
  mute.value = !mute.value
  if (sound !== null) sound.volume = mute.value ? 0 : vol.value
}

/**
 * Клавиши внутри блока: пробел — пуск и пауза, стрелки — перемотка.
 * Пробел на кнопках отдаём кнопке: там он и так нажатие.
 */
function onKey(event: KeyboardEvent): void {
  const onButton = (event.target as HTMLElement | null)?.closest('button') !== null

  if (event.key === ' ' && !onButton) {
    event.preventDefault()
    onPlay()
    return
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault()
    seekTo(at.value + STEP_SEC)
    return
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    seekTo(at.value - STEP_SEC)
  }
}

/** Стриминг — наружу через оболочку: в WebView2 обычный переход уносит окно. */
function openLink(url: string): void {
  void Bridge.shell.openExternal(url).catch((e) => {
    Logger('WARN', `Музыка: ссылка не открылась (${url})`, e)
  })
}

/** Глушит звук и забывает элемент: переход на другой тайтл обязан быть тишиной. */
function stop(): void {
  if (sound !== null) {
    sound.pause()
    sound.src = ''
    sound = null
  }
  pick.value = null
  playing.value = false
  at.value = 0
  len.value = 0
}

/** Забирает темы по MAL ID. Неудача тихая: блок просто не появится. */
async function load(): Promise<void> {
  const mine = ++run

  stop()
  open.value = false
  rows.value = []

  const id = props.malId
  if (id === null) return

  try {
    const themes = await fetchMalThemes(id)
    if (mine !== run || themes === null) return

    const out: TuneRow[] = []

    themes.openings.forEach((t) => {
      out.push({
        key: `OP${t.seq}`,
        tag: `OP${t.seq}`,
        title: t.title,
        artist: t.artist,
        audio: t.audio,
        links: t.links,
      })
    })

    themes.endings.forEach((t) => {
      out.push({
        key: `ED${t.seq}`,
        tag: `ED${t.seq}`,
        title: t.title,
        artist: t.artist,
        audio: t.audio,
        links: t.links,
      })
    })

    rows.value = out
  } catch (e) {
    Logger('WARN', 'Музыка: темы не загрузились', e)
  }
}

watch(
  () => props.malId,
  () => {
    void load()
  },
  { immediate: true },
)

onBeforeUnmount(stop)
</script>

<template>
  <div v-if="rows.length > 0" class="am-panel am-tune" @keydown="onKey">
    <div class="am-tune__head">
      <h3 class="am-h3">Музыка</h3>
      <span class="am-tune__count">{{ rows.length }}</span>
    </div>

    <!-- Пульт: цветок пуска, подпись звучащего, таймлайн, повтор и громкость. -->
    <div class="am-tune__deck">
      <button
        v-tip="playHint"
        class="am-tune__hit"
        :class="{ 'am-tune__hit--live': playing }"
        type="button"
        :aria-label="playHint"
        @click="onPlay"
      >
        <SakuraBloom />
        <span class="am-tune__mark" aria-hidden="true">
          <svg v-if="playing" class="am-tune__sign" viewBox="0 0 16 16">
            <rect x="4" y="3.2" width="2.9" height="9.6" rx="1.2" />
            <rect x="9.1" y="3.2" width="2.9" height="9.6" rx="1.2" />
          </svg>
          <svg v-else class="am-tune__sign" viewBox="0 0 16 16">
            <path d="M5.2 3.4 12.4 8l-7.2 4.6z" />
          </svg>
        </span>
      </button>

      <div class="am-tune__now">
        <span v-if="nowRow" class="am-tune__nowtag">{{ nowRow.tag }}</span>
        <span class="am-tune__nowname">{{ nowRow ? nowRow.title : 'Выберите тему' }}</span>
        <span v-if="nowRow && nowRow.artist" class="am-tune__nowartist">{{ nowRow.artist }}</span>
      </div>

      <!-- Полоса своя: у родного ползунка ни формы темы, ни нужной толщины.
           Захват указателя нужен, чтобы тяга не срывалась за краем полосы. -->
      <div class="am-tune__wave">
        <span class="am-tune__clock">{{ atText }}</span>
        <div
          class="am-tune__seek"
          :class="{ 'am-tune__seek--hold': drag }"
          role="slider"
          aria-label="Перемотка"
          :aria-valuetext="`${atText} из ${lenText}`"
          @pointerdown="onSeekDown"
          @pointermove="onSeekMove"
          @pointerup="onSeekUp"
          @pointercancel="onSeekUp"
        >
          <span class="am-tune__track">
            <span class="am-tune__done" :style="{ width: donePart }" />
          </span>
          <span class="am-tune__knob" :style="{ left: donePart }" />
        </div>
        <span class="am-tune__clock">{{ lenText }}</span>
      </div>

      <div class="am-tune__tools">
        <button
          v-tip="loop ? 'Повтор включён' : 'Повторять тему'"
          class="am-tune__tool"
          :class="{ 'am-tune__tool--on': loop }"
          type="button"
          aria-label="Повторять тему"
          @click="onLoop"
        >
          <svg class="am-tune__glyph" viewBox="0 0 16 16">
            <path d="M4.4 5.2h5.2a2.8 2.8 0 0 1 2.8 2.8v.4" />
            <path d="M11.6 10.8H6.4a2.8 2.8 0 0 1-2.8-2.8V7.6" />
            <path d="M6.2 3.2 4.1 5.2l2.1 2" />
            <path d="M9.8 12.8l2.1-2-2.1-2" />
          </svg>
        </button>

        <button
          v-tip="mute ? 'Включить звук' : 'Без звука'"
          class="am-tune__tool"
          type="button"
          aria-label="Громкость"
          @click="onMute"
        >
          <svg class="am-tune__glyph" viewBox="0 0 16 16">
            <path d="M3 6.2h2.1L8.4 3.4v9.2L5.1 9.8H3z" />
            <template v-if="!mute">
              <path d="M10.6 6.1a2.6 2.6 0 0 1 0 3.8" />
              <path d="M12.4 4.4a5 5 0 0 1 0 7.2" />
            </template>
            <template v-else>
              <path d="M10.8 6.4l3.2 3.2" />
              <path d="M14 6.4l-3.2 3.2" />
            </template>
          </svg>
        </button>

        <!-- Громкость тем же органом, что таймлайн, только короче: две разные
             полосы в одном пульте читались бы деталями от разных приборов. -->
        <div
          class="am-tune__vol"
          role="slider"
          aria-label="Уровень громкости"
          :aria-valuetext="volPart"
          @pointerdown="onVolDown"
          @pointermove="onVolMove"
        >
          <span class="am-tune__track">
            <span class="am-tune__done" :style="{ width: volPart }" />
          </span>
          <span class="am-tune__knob" :style="{ left: volPart }" />
        </div>

        <span v-if="nowRow && nowRow.links.length > 0" class="am-tune__links">
          <button
            v-for="link in nowRow.links"
            :key="link.site"
            v-tip="`Открыть в ${link.label}`"
            class="am-tune__tool"
            type="button"
            :aria-label="link.label"
            @click="openLink(link.url)"
          >
            <svg v-if="link.site === 'spotify'" class="am-tune__glyph" viewBox="0 0 16 16">
              <circle cx="8" cy="8" r="6.4" />
              <path d="M4.6 6.1c2.2-.7 4.8-.4 6.8.8" />
              <path d="M5.2 8.4c1.8-.5 3.8-.3 5.4.7" />
              <path d="M5.8 10.5c1.4-.4 2.9-.2 4 .5" />
            </svg>
            <svg v-else-if="link.site === 'apple'" class="am-tune__glyph" viewBox="0 0 16 16">
              <path d="M6.4 11V4.4l5-1.1V10" />
              <circle cx="4.8" cy="11.2" r="1.7" />
              <circle cx="9.8" cy="10.1" r="1.7" />
            </svg>
            <svg v-else-if="link.site === 'youtube'" class="am-tune__glyph" viewBox="0 0 16 16">
              <rect x="1.6" y="3.6" width="12.8" height="8.8" rx="3" />
              <path d="M6.8 6.3 10.3 8l-3.5 1.7z" fill="currentColor" stroke="none" />
            </svg>
            <svg v-else class="am-tune__glyph" viewBox="0 0 16 16">
              <path d="M6.2 10.4V5.6l4.4-.9v4.6" />
              <path d="M2.6 12.1c3.2 1.6 7.6 1.6 10.8-.1" />
            </svg>
          </button>
        </span>
      </div>
    </div>

    <ul class="am-tune__list">
      <li v-for="row in shownRows" :key="row.key">
        <button
          v-tip="row.audio === null ? 'Записи нет' : `Слушать ${row.tag}`"
          class="am-tune__row"
          :class="{
            'am-tune__row--on': row.key === pick,
            'am-tune__row--mute': row.audio === null,
          }"
          type="button"
          :disabled="row.audio === null"
          @click="onRow(row)"
        >
          <!-- Три палочки у звучащей строки: место под знак занято всегда,
               иначе пуск сдвигал бы названия соседних строк. -->
          <span class="am-tune__beat" aria-hidden="true">
            <span v-if="row.key === pick && playing" class="am-tune__beats">
              <i /><i /><i />
            </span>
            <span v-else class="am-tune__dot" />
          </span>

          <span class="am-tune__tag">{{ row.tag }}</span>

          <span class="am-tune__text">
            <span class="am-tune__name">{{ row.title }}</span>
            <span v-if="row.artist" class="am-tune__artist">{{ row.artist }}</span>
          </span>
        </button>
      </li>
    </ul>

    <button v-if="hiddenCount > 0" class="am-tune__more" type="button" @click="open = !open">
      {{ open ? 'Свернуть' : `Показать все · ещё ${hiddenCount}` }}
    </button>
  </div>
</template>

<style scoped>
.am-tune {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.am-tune__head {
  display: flex;
  gap: 10px;
  align-items: center;
}

.am-tune__head .am-h3 {
  margin: 0;
}

/* Счётчик тем бледной пилюлей: цифра рядом с заголовком заменяет подпись
   «всего тем» и не занимает строки. */
.am-tune__count {
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 650;
  color: var(--am-faint);
  background: var(--am-fill-1);
  border-radius: var(--am-r-cap);
  font-variant-numeric: tabular-nums;
}

/* Пульт: цветок слева на два ряда, подпись и таймлайн справа от него,
   мелкие органы строкой во всю ширину под ними. */
.am-tune__deck {
  display: grid;
  grid-template-columns: 46px minmax(0, 1fr);
  gap: 8px 12px;
  align-items: center;
  padding: 12px 13px 11px;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-l);
}

/* Кнопка остаётся прямоугольной и без своей одежды: круг и распускающуюся
   сакуру рисует вложенный слой, а кнопке остаются попадание курсора
   по всей цели и кольцо фокуса. Оттенки цветка — как у окна правки. */
.am-tune__hit {
  --am-bloom-deep: var(--am-hover);
  --am-bloom-petal: color-mix(in srgb, var(--am-sakura) 30%, var(--am-hover));
  --am-bloom-shade: var(--am-sh-1);
  --am-bloom-out: 3px;

  position: relative;
  display: grid;
  grid-row: 1 / 3;
  place-items: center;
  width: 46px;
  height: 46px;
  padding: 0;
  color: var(--am-dim);
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--am-r-cap);
  transition: color var(--am-fast) var(--am-ease);
}

.am-tune__hit:hover,
.am-tune__hit:focus-visible {
  color: var(--am-text);
}

/* Знак поднят над цветком: тот лежит своим слоем и накрыл бы содержимое. */
.am-tune__mark {
  position: relative;
  display: block;
}

.am-tune__sign {
  display: block;
  width: 18px;
  height: 18px;
  fill: currentcolor;
}

/* Играет — цветок остаётся распущенным сам, без курсора, и живёт:
   лепестки медленно крутятся, сердцевина дышит. Ровным ходом, а не
   по громкости: почему — в шапке файла. */
.am-tune__hit--live {
  color: var(--am-text);
}

.am-tune__hit--live :deep(.am-bloom__petals) {
  opacity: 1;
  animation: am-tune-turn 9s linear infinite;
}

.am-tune__hit--live :deep(.am-bloom__bud) {
  animation: am-tune-beat 2.4s var(--am-ease-soft) infinite;
}

.am-tune__hit--live :deep(.am-bloom) {
  filter: drop-shadow(var(--am-sh-1)) drop-shadow(0 0 10px rgb(var(--am-sakura-rgb) / 0.45));
}

@keyframes am-tune-turn {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@keyframes am-tune-beat {
  0%,
  100% {
    transform: scale(0.9);
  }
  50% {
    transform: scale(1);
  }
}

.am-tune__now {
  display: flex;
  gap: 7px;
  align-items: baseline;
  min-width: 0;
}

.am-tune__nowtag {
  flex: none;
  padding: 2px 7px;
  font-size: 10.5px;
  font-weight: 700;
  color: var(--am-accent);
  background: rgb(var(--am-accent-rgb) / 0.14);
  border-radius: var(--am-r-cap);
}

.am-tune__nowname {
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.am-tune__nowartist {
  overflow: hidden;
  font-size: 12px;
  color: var(--am-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.am-tune__nowartist::before {
  margin-right: 5px;
  content: '·';
}

.am-tune__wave {
  display: flex;
  gap: 9px;
  align-items: center;
  min-width: 0;
}

.am-tune__clock {
  flex: none;
  font-size: 11px;
  color: var(--am-faint);
  font-variant-numeric: tabular-nums;
}

/* Цель тяги высокая, а сама полоса тонкая: ручку в четыре пикселя
   мышью не поймать, поэтому под ней прозрачный запас по высоте. */
.am-tune__seek,
.am-tune__vol {
  position: relative;
  display: flex;
  align-items: center;
  height: 22px;
  cursor: pointer;
  touch-action: none;
}

.am-tune__seek {
  flex: 1;
  min-width: 0;
}

/* Громкость короче таймлайна, но не огрызок: на шестидесяти пикселях
   одно деление шло шесть процентов, и уровень выставлялся наугад. */
.am-tune__vol {
  flex: none;
  width: 96px;
}

.am-tune__track {
  display: block;
  width: 100%;
  height: 6px;
  overflow: hidden;
  background: var(--am-fill-3);
  border-radius: var(--am-r-cap);
}

.am-tune__done {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--am-accent), var(--am-accent-2));
  border-radius: inherit;
}

/* Ручка — лепесток, а не серый шарик системы: тот же розовый, что у цветка. */
.am-tune__knob {
  position: absolute;
  top: 50%;
  width: 13px;
  height: 13px;
  background: var(--am-sakura);
  border-radius: var(--am-r-blob);
  box-shadow: 0 0 0 3px rgb(var(--am-sakura-rgb) / 0.2);
  transform: translate(-50%, -50%);
  transition:
    box-shadow var(--am-fast) var(--am-ease),
    transform var(--am-fast) var(--am-ease);
}

.am-tune__seek:hover .am-tune__knob,
.am-tune__vol:hover .am-tune__knob,
.am-tune__seek--hold .am-tune__knob {
  box-shadow: 0 0 0 5px rgb(var(--am-sakura-rgb) / 0.26);
  transform: translate(-50%, -50%) rotate(38deg) scale(1.1);
}

.am-tune__tools {
  display: flex;
  grid-column: 1 / -1;
  gap: 6px;
  align-items: center;
  min-width: 0;
  padding-top: 2px;
}

/* Органы пульта размером под палец, а не под прицел: рядом
   с цветком в 46px кнопки в 28 читались мелочью. */
.am-tune__tool {
  display: grid;
  flex: none;
  place-items: center;
  width: 34px;
  height: 34px;
  padding: 0;
  color: var(--am-faint);
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--am-r-cap);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease);
}

.am-tune__tool:hover,
.am-tune__tool:focus-visible {
  color: var(--am-text);
  background: var(--am-fill-2);
}

/* Включённый повтор светится акцентом: без этого состояние кнопки
   приходилось бы проверять на слух. */
.am-tune__tool--on {
  color: var(--am-accent);
  background: var(--am-accent-soft);
}

.am-tune__glyph {
  width: 19px;
  height: 19px;
  fill: none;
  stroke: currentcolor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* Стриминги той же песни уходят к правому краю пульта. */
.am-tune__links {
  display: flex;
  flex: none;
  gap: 2px;
  align-items: center;
  margin-left: auto;
}

.am-tune__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* Вся строка — цель нажатия: выбор темы мышью не должен требовать
   попадания в кругляш. */
.am-tune__row {
  display: flex;
  gap: 9px;
  align-items: center;
  width: 100%;
  min-height: 34px;
  padding: 4px 8px;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--am-r-m);
  transition: background-color var(--am-fast) var(--am-ease);
}

.am-tune__row:hover:not(:disabled) {
  background: var(--am-fill-1);
}

.am-tune__row--on {
  background: rgb(var(--am-accent-rgb) / 0.1);
  box-shadow: inset 0 0 0 1px rgb(var(--am-accent-rgb) / 0.3);
}

/* Темы без записи встречаются: строка остаётся в списке со ссылками
   и подписью, но не зовёт нажать. */
.am-tune__row--mute {
  cursor: default;
  opacity: 0.55;
}

.am-tune__beat {
  display: grid;
  flex: none;
  place-items: center;
  width: 14px;
  height: 14px;
}

.am-tune__dot {
  width: 5px;
  height: 5px;
  background: var(--am-faint);
  border-radius: var(--am-r-cap);
}

.am-tune__row--on .am-tune__dot {
  background: var(--am-accent);
}

/* Три палочки эквалайзера у звучащей строки: нарисованы полосками,
   а не картинкой, и качаются со своим сдвигом каждая. */
.am-tune__beats {
  display: flex;
  gap: 2px;
  align-items: flex-end;
  height: 12px;
}

.am-tune__beats i {
  width: 2px;
  height: 100%;
  background: var(--am-accent);
  border-radius: var(--am-r-cap);
  animation: am-tune-wag 1.1s var(--am-ease-soft) infinite;
}

.am-tune__beats i:nth-child(2) {
  animation-delay: 0.22s;
}

.am-tune__beats i:nth-child(3) {
  animation-delay: 0.44s;
}

@keyframes am-tune-wag {
  0%,
  100% {
    transform: scaleY(0.4);
  }
  50% {
    transform: scaleY(1);
  }
}

/* Номер темы пилюлей акцентом: OP1 и ED2 ищут глазом первыми. */
.am-tune__tag {
  flex: none;
  min-width: 34px;
  padding: 3px 7px;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--am-accent);
  text-align: center;
  background: rgb(var(--am-accent-rgb) / 0.14);
  border-radius: var(--am-r-cap);
}

.am-tune__text {
  display: flex;
  flex: 1;
  gap: 4px;
  align-items: baseline;
  min-width: 0;
}

.am-tune__name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Исполнитель через точку и бледнее: это подпись к названию, а не вторая
   строка — иначе блок из восьми тем вырастал вдвое. */
.am-tune__artist {
  overflow: hidden;
  font-size: 12px;
  color: var(--am-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.am-tune__artist::before {
  margin-right: 4px;
  content: '·';
}

.am-tune__more {
  align-self: flex-start;
  min-height: 30px;
  padding: 0 13px;
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--am-dim);
  cursor: pointer;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-cap);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease),
    border-color var(--am-fast) var(--am-ease);
}

.am-tune__more:hover {
  color: var(--am-accent);
  background: var(--am-fill-2);
  border-color: rgb(var(--am-accent-rgb) / 0.5);
}

/* Просьба о покое сильнее красот: цветок просто остаётся распущенным,
   палочки — поднятыми. */
@media (prefers-reduced-motion: reduce) {
  .am-tune__hit--live :deep(.am-bloom__petals),
  .am-tune__hit--live :deep(.am-bloom__bud),
  .am-tune__beats i {
    animation: none;
  }

  .am-tune__seek:hover .am-tune__knob,
  .am-tune__vol:hover .am-tune__knob,
  .am-tune__seek--hold .am-tune__knob {
    transform: translate(-50%, -50%);
  }
}
</style>
