// Раскладка плиток карточки тайтла: сколько колонок и какую высоту
// занимает каждая плитка, решает измерение, а не набор именованных областей.
//
// Области с фиксированными шаблонами обещали «красиво при любой ширине»,
// а давали обратное: под коротким описанием оставался чёрный прогал
// в полэкрана, порядок плиток приходилось описывать заново на каждом рубеже
// ширины, и лишний сиквел в хронологии перестраивал карточку целиком.
//
// Порядок работы: колонки от ширины доски, ширина плитки от её содержимого,
// высота от измерения шагами вертикальной сетки, а dense-поток закрывает дыры
// сам. Последним шагом нижние плитки тянутся до общего низа: без этого
// доска кончалась лесенкой из разновысоких углов.
//
// Почему не чистый CSS: masonry в гриде живёт за флагом, и WebView2 его
// не знает. Почему не колонки на flex: колонки пришлось бы строить
// в разметке, и тогда плитка не смогла бы занять две из них — описанию,
// музыке и хронологии это нужно.
import { onBeforeUnmount, onMounted, watch, type Ref } from 'vue'

/** Ниже этой ширины колонка перестаёт быть читаемой: цифры записи
 *  и оценки площадок в ней уже жмутся. */
const COL_MIN = 320

/** Шаг вертикальной сетки. Мельче — плотнее прилегание плиток,
 *  но длиннее список строк у сетки на каждой перекладке. */
const ROW = 8

/** Допуск при сравнении краёв: дробные пиксели при масштабе окна
 *  иначе превращают совпадающие границы в разные. */
const NEAR = 2

/** Плитки, которым одной колонки мало. Описание читается строкой,
 *  а не столбиком; у музыки в строке название темы, исполнитель
 *  и плеер с таймлайном; у хронологии — год, длинное название части
 *  и метки справа. В 320 пикселей всё это обрезалось многоточием. */
const WIDE_TILE = ['am-about-box', 'am-tune', 'am-fran']

/** Положение плитки после укладки плюс её текущая высота в шагах. */
type Spot = {
  el: HTMLElement
  left: number
  right: number
  top: number
  bottom: number
  steps: number
}

/** Сколько колонок просит плитка: люди — полка во всю ширину доски,
 *  широкие плитки — две колонки, когда они есть, остальные — одну. */
function wantCols(el: HTMLElement, cols: number): number {
  if (el.classList.contains('am-board__folk')) return cols
  if (WIDE_TILE.some((name) => el.classList.contains(name))) return Math.min(2, cols)
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
 *  не перекладывает, но лишняя запись в стиль стоит пересчёта макета. */
function keep(
  el: HTMLElement,
  name: 'gridColumn' | 'gridRowEnd' | 'gridTemplateColumns' | 'alignSelf',
  value: string,
): void {
  if (el.style[name] === value) return
  el.style[name] = value
}

/** Высота в шагах сетки. Просвет входит в шаг: между строками
 *  сетки тоже стоит gap, и без этой поправки плитка брала бы лишние строки. */
function rows(high: number, gap: number): number {
  return Math.max(1, Math.ceil((high + gap) / (ROW + gap)))
}

/** Есть ли под плиткой сосед: хотя бы частичное совпадение по горизонтали
 *  и начало ниже её низа. Такую плитку тянуть нельзя: она сдвинет соседа
 *  вниз и сама же создаст новую ступеньку. */
function hasBelow(one: Spot, all: Spot[]): boolean {
  return all.some((other) => {
    if (other === one) return false
    if (other.top < one.bottom - NEAR) return false

    const over = Math.min(other.right, one.right) - Math.max(other.left, one.left)
    return over > NEAR
  })
}

/** Одна перекладка доски в три захода: ширина, натуральная высота,
 *  добор нижних плиток до общего низа. */
function lay(board: HTMLElement): void {
  const wide = board.clientWidth
  if (wide <= 0) return

  const gap = Number.parseFloat(window.getComputedStyle(board).rowGap) || 0
  const cols = Math.max(1, Math.floor((wide + gap) / (COL_MIN + gap)))
  const list = tiles(board)

  board.style.setProperty('--am-board-row', `${ROW}px`)
  board.classList.add('am-board--flow')
  keep(board, 'gridTemplateColumns', `repeat(${cols}, minmax(0, 1fr))`)

  // Заход первый. Ширина идёт впереди высоты: число строк текста зависит
  // от того, во сколько колонок плитка встала. Заодно снимаем растяжку
  // прошлой перекладки, иначе вместо натуральной высоты мы измерим её же
  // вчерашний добор и плитки будут расти от перекладки к перекладке.
  for (const el of list) {
    keep(el, 'gridColumn', `span ${wantCols(el, cols)}`)
    keep(el, 'gridRowEnd', 'auto')
    keep(el, 'alignSelf', 'start')
  }

  const sized = list.map((el) => ({ el, high: el.getBoundingClientRect().height }))

  // Заход второй. Высота шагами сетки — после неё поток уже знает,
  // где какая плитка лежит и кто кому сосед снизу.
  for (const { el, high } of sized) {
    keep(el, 'gridRowEnd', `span ${rows(high, gap)}`)
    keep(el, 'alignSelf', 'stretch')
  }

  const spots: Spot[] = sized.map(({ el, high }) => {
    const box = el.getBoundingClientRect()

    return {
      el,
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      steps: rows(high, gap),
    }
  })

  if (spots.length === 0) return

  // Заход третий. Низ доски — самый глубокий край среди плиток; всё,
  // что кончается выше и ничего под собой не держит, добирает строки
  // до него. Высоту забирает содержимое плитки: списки расходятся по высоте,
  // хронология показывает больше строк до прокрутки — это уже дело CSS.
  const floor = Math.max(...spots.map((spot) => spot.bottom))

  for (const spot of spots) {
    const room = floor - spot.bottom
    if (room <= NEAR) continue
    if (hasBelow(spot, spots)) continue

    const add = Math.round(room / (ROW + gap))
    if (add <= 0) continue

    keep(spot.el, 'gridRowEnd', `span ${spot.steps + add}`)
  }
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
  let busy = false
  let again = false

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

  /** Перекладка не чаще кадра и не во время самой себя. Заслонка нужна
   *  из-за измерения: чтобы узнать натуральную высоту, мы снимаем с плиток
   *  прошлые строки, а это их же размер и меняет — наблюдатель без заслонки
   *  звал бы нас снова и снова. События, пришедшие пока заслонка закрыта,
   *  не теряются: они сворачиваются в один повторный заход. */
  function plan(): void {
    if (busy) {
      again = true
      return
    }

    if (turn !== 0) return

    turn = window.requestAnimationFrame(() => {
      turn = 0

      const box = board.value
      if (!box) return

      busy = true
      lay(box)
      follow(box)

      window.requestAnimationFrame(() => {
        busy = false

        if (!again) return
        again = false
        plan()
      })
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
    busy = false
    again = false
    eye?.disconnect()
    eye = null
    watched.clear()
  })
}
