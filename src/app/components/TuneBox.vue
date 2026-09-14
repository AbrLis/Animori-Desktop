<script setup lang="ts">
// Музыка тайтла: опенинги и эндинги с AnimeThemes строками. Звук слушается
// прямо в карточке, рядом — ссылки на стриминги той же песни.
//
// Звук один на весь блок: нажатый ряд глушит предыдущий. Файл тянется
// только по нажатию и в базу не кладётся — тема весит мегабайты, а кэш
// заведён под мелкие ответы служб, не под музыку.
//
// Панель молчит, пока тем нет: у половины тайтлов AnimeThemes не знает
// ничего, и пустая коробка «Музыка» была бы честной, но бесполезной.
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { fetchMalThemes, type ThemeLink } from '@/api/animethemes'
import { Bridge } from '@/bridge'
import { Logger } from '@/utils/logger'

const props = defineProps<{ malId: number | null }>()

/** Сколько строк видно до раскрытия: пятая и дальше уходят под кнопку. */
const FOLD_AT = 4

/** Строка блока: тема с подписью, звуком и ссылками. */
interface TuneRow {
  key: string
  tag: string
  title: string
  artist: string
  audio: string | null
  links: ThemeLink[]
}

const rows = ref<TuneRow[]>([])
const open = ref(false)

/** Ключ звучащей строки; null — тишина. */
const live = ref<string | null>(null)

/** Доля проигранного: полоса под звучащей строкой. */
const done = ref(0)

let sound: HTMLAudioElement | null = null

/** Номер захода: ответ про прошлое аниме в блок не попадёт. */
let run = 0

const shownRows = computed<TuneRow[]>(() =>
  open.value ? rows.value : rows.value.slice(0, FOLD_AT),
)

const hiddenCount = computed<number>(() => Math.max(0, rows.value.length - FOLD_AT))

const donePart = computed<string>(() => `${Math.round(done.value * 100)}%`)

/** Глушит звук и забывает его: элемент живёт ровно одно прослушивание. */
function stop(): void {
  if (sound !== null) {
    sound.pause()
    sound.src = ''
    sound = null
  }
  live.value = null
  done.value = 0
}

/** Пуск и остановка одной кнопкой: второй раз по звучащей строке — тишина. */
function toggle(row: TuneRow): void {
  if (row.audio === null) return

  if (live.value === row.key) {
    stop()
    return
  }

  stop()

  const next = new Audio(row.audio)
  next.preload = 'none'

  next.addEventListener('timeupdate', () => {
    done.value = next.duration > 0 ? next.currentTime / next.duration : 0
  })
  next.addEventListener('ended', () => {
    stop()
  })
  next.addEventListener('error', () => {
    Logger('WARN', `Музыка: звук темы не пошёл (${row.tag})`)
    stop()
  })

  sound = next
  live.value = row.key

  void next.play().catch((e) => {
    Logger('WARN', `Музыка: воспроизведение не началось (${row.tag})`, e)
    stop()
  })
}

/** Стриминг — наружу через оболочку: в WebView2 обычный переход уносит окно. */
function openLink(url: string): void {
  void Bridge.shell.openExternal(url).catch((e) => {
    Logger('WARN', `Музыка: ссылка не открылась (${url})`, e)
  })
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

// Звук переживает карточку, если его не снять: уход с экрана обязан быть тишиной.
onBeforeUnmount(stop)
</script>

<template>
  <div v-if="rows.length > 0" class="am-panel am-tune">
    <div class="am-tune__head">
      <h3 class="am-h3">Музыка</h3>
      <span class="am-tune__count">{{ rows.length }}</span>
    </div>

    <ul class="am-tune__list">
      <li
        v-for="row in shownRows"
        :key="row.key"
        class="am-tune__row"
        :class="{ 'am-tune__row--live': live === row.key }"
      >
        <button
          v-tip="row.audio === null ? 'Записи нет' : live === row.key ? 'Остановить' : 'Послушать'"
          class="am-tune__play"
          type="button"
          :disabled="row.audio === null"
          @click="toggle(row)"
        >
          <svg v-if="live === row.key" class="am-tune__sign" viewBox="0 0 12 12" aria-hidden="true">
            <rect x="2.5" y="2" width="2.6" height="8" rx="0.9" />
            <rect x="6.9" y="2" width="2.6" height="8" rx="0.9" />
          </svg>
          <svg v-else class="am-tune__sign" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3.6 2.3 9.6 6l-6 3.7z" />
          </svg>
        </button>

        <span class="am-tune__tag">{{ row.tag }}</span>

        <span class="am-tune__text">
          <span class="am-tune__name">{{ row.title }}</span>
          <span v-if="row.artist" class="am-tune__artist">{{ row.artist }}</span>
        </span>

        <span v-if="row.links.length > 0" class="am-tune__links">
          <button
            v-for="link in row.links"
            :key="link.site"
            v-tip="`Открыть в ${link.label}`"
            class="am-tune__link"
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

        <span v-if="live === row.key" class="am-tune__bar" aria-hidden="true">
          <span class="am-tune__fill" :style="{ width: donePart }" />
        </span>
      </li>
    </ul>

    <button
      v-if="hiddenCount > 0"
      class="am-tune__more"
      type="button"
      @click="open = !open"
    >
      {{ open ? 'Свернуть' : `Показать все · ещё ${hiddenCount}` }}
    </button>
  </div>
</template>

<style scoped>
.am-tune {
  display: flex;
  flex-direction: column;
  gap: 10px;
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

.am-tune__list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* Строка-капсула с местом под полосу проигрывания внизу: полоса лежит
   в потоке абсолютной, поэтому пуск не двигает соседние строки. */
.am-tune__row {
  position: relative;
  display: flex;
  gap: 9px;
  align-items: center;
  min-width: 0;
  padding: 5px 8px 6px;
  border-radius: var(--am-r-m);
  transition: background-color var(--am-fast) var(--am-ease);
}

.am-tune__row:hover {
  background: var(--am-fill-1);
}

.am-tune__row--live {
  background: rgb(var(--am-accent-rgb) / 0.1);
  box-shadow: inset 0 0 0 1px rgb(var(--am-accent-rgb) / 0.32);
}

/* Круглая кнопка того же вида, что стрелка «назад» в окне персоны:
   одинаковые кругляши по всему приложению читаются одним языком. */
.am-tune__play {
  display: grid;
  flex: none;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  color: var(--am-accent);
  cursor: pointer;
  background: var(--am-accent-soft);
  border: 0;
  border-radius: var(--am-r-cap);
  transition:
    background-color var(--am-fast) var(--am-ease),
    transform var(--am-fast) var(--am-ease);
}

.am-tune__play:hover:not(:disabled),
.am-tune__play:focus-visible:not(:disabled) {
  transform: scale(1.06);
}

/* Темы без записи встречаются: кнопка остаётся на месте, но гаснет —
   пропажа кругляша ломала бы ровный столбик строк. */
.am-tune__play:disabled {
  color: var(--am-faint);
  cursor: default;
  background: var(--am-fill-1);
}

.am-tune__sign {
  width: 12px;
  height: 12px;
  fill: currentcolor;
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

.am-tune__links {
  display: flex;
  flex: none;
  gap: 2px;
  align-items: center;
  margin-left: auto;
}

.am-tune__link {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
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

.am-tune__link:hover,
.am-tune__link:focus-visible {
  color: var(--am-accent);
  background: var(--am-fill-2);
}

.am-tune__glyph {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentcolor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* Полоса проигрывания по низу самой строки: отдельный ряд под ней
   разрывал бы столбик, а тут она читается как заполнение капсулы. */
.am-tune__bar {
  position: absolute;
  right: 8px;
  bottom: 2px;
  left: 8px;
  height: 2px;
  overflow: hidden;
  background: rgb(var(--am-accent-rgb) / 0.16);
  border-radius: var(--am-r-cap);
}

.am-tune__fill {
  display: block;
  height: 100%;
  background: var(--am-accent);
  border-radius: inherit;
  transition: width var(--am-fast) linear;
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

@media (prefers-reduced-motion: reduce) {
  .am-tune__play:hover:not(:disabled),
  .am-tune__play:focus-visible:not(:disabled) {
    transform: none;
  }

  .am-tune__fill {
    transition: none;
  }
}
</style>
