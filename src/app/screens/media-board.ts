// Раскладка плиток карточки тайтла: сколько колонок и какую высоту
// занимает каждая плитка, решает измерение, а не набор именованных областей.
//
// Области с фиксированными шаблонами обещали «красиво при любой ширине»,
// а давали обратное: под коротким описанием оставался чёрный прогал
// в полэкрана, порядок плиток приходилось описывать заново на каждом рубеже
// ширины, и лишний сиквел в хронологии перестраивал карточку целиком.
//
// Здесь про плитки не знает никто: поток укладывает их по колонкам сам
// (grid-auto-flow: dense), а натуральная высота переводится в шаги
// вертикальной сетки — поэтому короткая плитка не забирает высоту соседней,
// и дыра под ней закрывается следующей по порядку.
//
// Почему не чистый CSS: masonry в гриде живёт за флагом, и WebView2 его
// не знает. Почему не колонки на flex: колонки пришлось бы строить
// в разметке, и тогда плитка не смогла бы занять две из них — описанию
// это нужно, иначе строка читается столбиком в 40 знаков.
import { onBeforeUnmount, onMounted, watch, type Ref } from 'vue'

/** Ниже этой ширины колонка перестаёт быть читаемой: цифры записи
 *  и таймлайн музыки в ней уже жмутся. */
const COL_MIN = 320

/** Шаг вертикальной сетки. Мельче — плотнее прилегание плиток,
 *  но длиннее список строк у сетки на каждой перекладке. */
const ROW = 8

/** Сколько колонок просит плитка. Описание читается строкой, а не столбиком,
 *  поэтому берёт две, когда они есть; люди — полка во всю ширину доски. */
function wantCols(el: HTMLElement, cols: number): number {
  if (el.classList.contains('am-board__folk')) return cols
  if (el.classList.contains('am-about-box')) return Math.min(2, cols)
  return 1
}

/** Плитки доски. Сквозную обёртку (display: contents) сетка за плитку
 *  не считает — значит и мы считаем плитками её содержимое. */
function tiles(board: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = []

  for (const kid of Array.from(board.children)) {
    if (!(kid instanceof HTMLElement)) continue

    if (window.getComputedStyle(kid).display === 'contents') {
      for (const inner of Array.from(kid.children)) {
        if (inner instanceof HTMLElement) out.push(inner)
      }
      continue
    }

    out.push(kid)
  }

  return out
}

/** Запись в стиль только при смене значения: та же строка ничего
 *  не перекладывает, но наблюдатель размеров на неё всё равно просыпается,
 *  и перекладка начинает гоняться за собственным хвостом. */
function keep(
  el: HTMLElement,
  name: 'gridColumn' | 'gridRowEnd' | 'gridTemplateColumns',
  value: string,
): void {
  if (el.style[name] === value) return
  el.style[name] = value
}

/** Одна перекладка доски: колонки от ширины, высоты от измерения. */
function lay(board: HTMLElement): void {
  const wide = board.clientWidth
  if (wide <= 0) return

  const gap = Number.parseFloat(window.getComputedStyle(board).rowGap) || 0
  const cols = Math.max(1, Math.floor((wide + gap) / (COL_MIN + gap)))

  keep(board, 'gridTemplateColumns', `repeat(${cols}, minmax(0, 1fr))`)

  const list = tiles(board)

  // Сначала ширина: высота плитки зависит от того, во сколько колонок она
  // встала, поэтому мерить до этого нечего.
  for (const el of list) keep(el, 'gridColumn', `span ${wantCols(el, cols)}`)

  const tall = list.map((el) => el.getBoundingClientRect().height)

  board.style.setProperty('--am-board-row', `${ROW}px`)
  board.classList.add('am-board--flow')

  list.forEach((el, at) => {
    const steps = Math.max(1, Math.ceil((tall[at] + gap) / (ROW + gap)))
    keep(el, 'gridRowEnd', `span ${steps}`)
  })
}

/**
 * Держит раскладку доски в согласии с её содержимым: ширина окна, доехавшие
 * картинки, подъехавшие темы музыки — любой сдвиг размеров пересчитывает
 * колонки и высоты. Наблюдатель висит и на самой доске, и на каждой плитке:
 * высота доски от внутреннего роста меняется не всегда, а высота плитки —
 * всегда.
 */
export function useBoardFlow(board: Ref<HTMLElement | null>): void {
  const watched = new Set<HTMLElement>()
  let eye: ResizeObserver | null = null
  let turn = 0

  /** Плитки под наблюдением: ушедшие снимаются, новые добавляются.
   *  Перезаводить наблюдение целиком нельзя — каждый observe отвечает
   *  первым срабатыванием, и перекладка звала бы себя по кругу. */
  function follow(box: HTMLElement): void {
    if (!eye) return

    for (const el of watched) {
      if (el.isConnected) continue
      eye.unobserve(el)
      watched.delete(el)
    }

    for (const el of tiles(box)) {
      if (watched.has(el)) continue
      eye.observe(el)
      watched.add(el)
    }
  }

  /** Перекладка не чаще кадра: за один поток событий размеры сообщают
   *  о себе и доска, и десяток плиток. */
  function plan(): void {
    if (turn !== 0) return

    turn = window.requestAnimationFrame(() => {
      turn = 0

      const box = board.value
      if (!box) return

      lay(box)
      follow(box)
    })
  }

  onMounted(() => {
    eye = new ResizeObserver(plan)

    const box = board.value
    if (box) eye.observe(box)

    plan()
  })

  // Доска появляется вместе с карточкой, а не вместе с экраном: до ответа
  // сервера на её месте скелет, и ссылка пуста.
  watch(board, (box, gone) => {
    if (!eye) return

    if (gone) {
      eye.unobserve(gone)
      for (const el of watched) eye.unobserve(el)
      watched.clear()
    }

    if (box) {
      eye.observe(box)
      plan()
    }
  })

  onBeforeUnmount(() => {
    if (turn !== 0) window.cancelAnimationFrame(turn)
    turn = 0
    eye?.disconnect()
    eye = null
    watched.clear()
  })
}
