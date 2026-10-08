// Окна поверх экрана: фокус переезжает в окно, фон становится невосприимчивым,
// закрытие возвращает фокус туда, откуда окно открыли.

/** Что считается фокусируемым — тот же набор, что у обхода Tab браузером. */
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]'

/** Открытое окно: где оно, куда ведёт фокус и чем возвращать, если триггер погиб. */
interface Hold {
  root: HTMLElement
  aim: HTMLElement
  trigger: HTMLElement | null
  restore: (() => HTMLElement | null) | null
  release: () => void
}

/** Стек открытых окон: верхнее — последнее, оно и держит обход Tab. */
const stack: Hold[] = []

/** Помеченные невосприимчивыми: снимаю только то, что ставил сам. */
let inerted = new Set<HTMLElement>()

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('disabled') && el.tabIndex >= 0 && !el.hasAttribute('hidden'),
  )
}

/** Годится ли узел для возврата фокуса: живой, в обходе и видимый. */
function usable(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled') || el.tabIndex < 0) return false
  if (typeof el.checkVisibility === 'function')
    return el.checkVisibility({ checkVisibilityCSS: true })
  return getComputedStyle(el).visibility !== 'hidden'
}

/** Куда ведёт фокус при открытии: контейнер окна, он же объявляется скринридеру. */
function aimOf(root: HTMLElement): HTMLElement {
  const named = root.matches('[role="dialog"]')
    ? root
    : root.querySelector<HTMLElement>('[role="dialog"]')
  const target = named ?? root
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
  return target
}

/** inert фона: невосприимчиво всё, кроме верхнего окна и его предков. */
function syncBackground(): void {
  const top = stack.at(-1)?.root ?? null
  const want = new Set<HTMLElement>()

  for (let node: HTMLElement | null = top; node !== null && node !== document.body;) {
    const parent = node.parentElement
    if (parent === null) break
    for (const sibling of parent.children) {
      if (sibling !== node && sibling instanceof HTMLElement) want.add(sibling)
    }
    node = parent
  }

  for (const el of inerted) if (!want.has(el)) el.removeAttribute('inert')
  for (const el of want) if (!inerted.has(el)) el.setAttribute('inert', '')
  inerted = want
}

/** Прошлое значение overflow корня; null — блокировки прокрутки нет. */
let pageLock: string | null = null

/** Прокрутка документа: wheel доходит и через inert, поэтому фон блокируется overflow. */
function syncScrollLock(): void {
  const root = document.documentElement
  if (stack.length > 0) {
    if (pageLock === null) {
      pageLock = root.style.overflow
      root.style.overflow = 'hidden'
    }
    return
  }
  if (pageLock !== null) {
    root.style.overflow = pageLock
    pageLock = null
  }
}

/** Tab не уходит из верхнего окна: за концом — начало, вне окна — внутрь. */
function onTab(event: KeyboardEvent): void {
  if (event.key !== 'Tab') return
  const top = stack.at(-1)
  if (top === undefined) return

  const items = focusables(top.root)
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement

  // Пустое окно или фокус на контейнере — ведём внутрь сами: естественный обход
  // со Shift+Tab увёл бы за занавес.
  if (first === undefined || last === undefined) {
    event.preventDefault()
    top.aim.focus({ preventScroll: true })
    return
  }
  if (active === top.aim) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus({ preventScroll: true })
    return
  }

  if (!(active instanceof HTMLElement) || !top.root.contains(active)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus({ preventScroll: true })
    return
  }

  const at = items.indexOf(active)
  if (at === -1) return
  if (event.shiftKey && at === 0) {
    event.preventDefault()
    last.focus({ preventScroll: true })
  } else if (!event.shiftKey && at === items.length - 1) {
    event.preventDefault()
    first.focus({ preventScroll: true })
  }
}

/** Возврат фокуса: триггер, при его смерти — запасной узел. Если годного нет,
 *  фокус не трогаем: прыжок на первый контроль фона уводил его на рельс. */
function backWhere(hold: Hold): void {
  const wanted: Array<HTMLElement | null> = [hold.trigger, hold.restore?.() ?? null]
  for (const el of wanted) {
    if (el === null || !el.isConnected || !usable(el)) continue
    el.focus({ preventScroll: true })
    if (document.activeElement === el) return
  }
}

/** Открывает окно: запоминает триггер, ограждает фон, ведёт фокус внутрь. Отдаёт закрытие. */
export function holdDialog(root: HTMLElement, restore?: () => HTMLElement | null): () => void {
  const active = document.activeElement
  const trigger = active instanceof HTMLElement && active !== document.body ? active : null
  const aim = aimOf(root)

  const hold: Hold = { root, aim, trigger, restore: restore ?? null, release: () => {} }
  hold.release = (): void => {
    const at = stack.indexOf(hold)
    if (at === -1) return
    const wasTop = at === stack.length - 1
    stack.splice(at, 1)
    if (stack.length === 0) document.removeEventListener('keydown', onTab)
    syncBackground()
    syncScrollLock()
    if (wasTop) backWhere(hold)
  }

  stack.push(hold)
  if (stack.length === 1) document.addEventListener('keydown', onTab)
  syncBackground()
  syncScrollLock()
  aim.focus({ preventScroll: true })
  return hold.release
}

/** Снимает все окна разом — для тестов, где нет размонтирования приложения. */
export function releaseAllDialogs(): void {
  for (const hold of [...stack].reverse()) hold.release()
}
