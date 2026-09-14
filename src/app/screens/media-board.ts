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
// Всю высоту плитке выдаёт только растяжка сетки, поэтому здесь жёстко
// держится height: auto. Процентная высота была катастрофой: в момент
// измерения плитка стоит в строке в один шаг сетки, height: 100% считался
// от него, и все виджеты мерились в 8 пикселей — содержимое вываливалось
// наружу и налезало на соседние плитки.
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

/** Потолок списка хронологии в обычном состоянии. Без него франшиза
 *  на три десятка частей вытягивает доску на несколько экранов. */
const RAIL_CAP = 'clamp(280px, 34vh, 440px)'

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
  name: 'gridColumn' | 'gridRowEnd' | 'gridTemplateColumns' | 'alignSelf' | 'height' | 'maxHeight',
  value: string,
): void {
  if (el.style[name] === value) return
  el.style[name] = value
}

/** Список хронологии внутри плитки франшизы, если он вообще есть. */
function railOf(el: HTMLElement): HTMLElement | null {
  if (!el.classList.contains('am-fran')) return null
  return el.querySelector<HTMLElement>('.am-rail')
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

/** Одна перекладка доски: ширина, натуральная высота, добор за счёт
 *  переполнения и добор нижних плиток до общего низа. */
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
  // и возвращаем потолок списку хронологии: измерять надо именно
  // обычное состояние плитки, иначе прошлый добор копится и плитки
  // растут от перекладки к перекладке без конца.
  for (const el of list) {
    keep(el, 'gridColumn', `span ${wantCols(el, cols)}`)
    keep(el, 'gridRowEnd', 'auto')
    keep(el, 'alignSelf', 'start')
    keep(el, 'height', 'auto')

    const rail = railOf(el)
    if (rail) keep(rail, 'maxHeight', RAIL_CAP)
  }

  const sized = list.map((el) => ({ el, high: el.getBoundingClientRect().height }))

  // Заход второй. Высота шагами сетки — после неё поток уже знает,
  // где какая плитка лежит и кто кому сосед снизу. Растяжка безопасна:
  // строк выдано ровно под измеренную высоту, сжать плитку она не может.
  const step = new Map<HTMLElement, number>()

  for (const { el, high } of sized) {
    const steps = rows(high, gap)
    step.set(el, steps)
    keep(el, 'gridRowEnd', `span ${steps}`)
    keep(el, 'alignSelf', 'stretch')
  }

  // Заход третий. Проверка переполнения: если содержимое доехало уже
  // после измерения, плитка стоит в строках под пустой верстке и текст
  // вылезает за панель. Растянутая плитка больше не меняет внешний
  // размер, и наблюдатель размеров такой рост просто не видит — поэтому
  // спрашиваем сами. Плитки со своей прокруткой внутри сюда не попадают:
  // их содержимое держит скроллер, а не сама панель.
  for (const { el } of sized) {
    const over = el.scrollHeight - el.clientHeight
    if (over <= NEAR) continue

    const steps = step.get(el) ?? 1
    const add = Math.ceil(over / (ROW + gap))
    step.set(el, steps + add)
    keep(el, 'gridRowEnd', `span ${steps + add}`)
  }

  const spots: Spot[] = sized.map(({ el }) => {
    const box = el.getBoundingClientRect()

    return {
      el,
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      steps: step.get(el) ?? 1,
    }
  })

  if (spots.length === 0) return

  // Заход четвёртый. Низ доски — самый глубокий край среди плиток; всё,
  // что кончается выше и ничего под собой не держит, добирает строки
  // до него. Списку хронологии в такой плитке потолок снимается: высоту
  // держит уже сама плитка, и добор уходит в лишние строки списка,
  // а не в пустую полосу под последней частью.
  const floor = Math.max(...spots.map((spot) => spot.bottom))

  for (const spot of spots) {
    const room = floor - spot.bottom
    if (room <= NEAR) continue
    if (hasBelow(spot, spots)) continue

    const add = Math.round(room / (ROW + gap))
    if (add <= 0) continue

    keep(spot.el, 'gridRowEnd', `span ${spot.steps + add}`)

    const rail = railOf(spot.el)
    if (rail) keep(rail, 'maxHeight', 'none')
  }
}

/**
 * Держит раскладку доски в согласии с её содержимым: ширина окна, доехавшие
 * картинки, подъехавшие темы музыки и части франшизы — любой сдвиг
 * пересчитывает колонки и высоты.
 *
 * Следим двумя наблюдателями. Размеры — сама доска, плитки и их внутренние
 * блоки: плитка, растянутая на выданные строки, свой размер больше не меняет,
 * и поздний ответ сети без этого оставался бы незамеченным. Состав разметки —
 * MutationObserver: виджет может появиться или наполниться спустя секунды
 * после первой отрисовки.
 */
export function useBoardFlow(board: Ref<HTMLElement | null>): void {
  const watched = new Set<HTMLElement>()
  let eye: ResizeObserver | null = null
  let ear: MutationObserver | null = null
  let turn = 0
  let busy = false
  let again = false

  /** Что стоит мерить: сами плитки и их прямые блоки. Глубже не лезем:
   *  рост любой внутренности всё равно меняет размер своего блока,
   *  а наблюдателей на каждой строке списка было бы сотни. */
  function marks(box: HTMLElement): HTMLElement[] {
    const out: HTMLElement[] = []

    for (const el of tiles(box)) {
      out.push(el)

      for (const inner of Array.from(el.children)) {
        if (inner instanceof HTMLElement) out.push(inner)
      }
    }

    return out
  }

  /** Блоки под наблюдением: ушедшие снимаются, новые добавляются.
   *  Перезаводить наблюдение целиком нельзя — каждый observe отвечает
   *  первым срабатыванием, и перекладка звала бы себя по кругу. */
  function follow(box: HTMLElement): void {
    if (!eye) return

    for (const el of watched) {
      if (el.isConnected) continue
      eye.unobserve(el)
      watched.delete(el)
    }

    for (const el of marks(box)) {
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

  /** Наблюдение за составом разметки. Следим только за появлением и уходом
   *  узлов: свои же записи в style и классы тогда не будят перекладку. */
  function listen(box: HTMLElement): void {
    ear?.disconnect()
    ear = new MutationObserver(plan)
    ear.observe(box, { childList: true, subtree: true })
  }

  onMounted(() => {
    eye = new ResizeObserver(plan)

    const box = board.value
    if (box) {
      eye.observe(box)
      listen(box)
    }

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
      ear?.disconnect()
      ear = null
    }

    if (box) {
      eye.observe(box)
      listen(box)
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
    ear?.disconnect()
    ear = null
    watched.clear()
  })
}
