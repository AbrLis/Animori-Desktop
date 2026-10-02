// Возврат фокуса после работы кнопки. На время busy кнопка становится disabled и теряет
// фокус — WebView её отпускает, — а обход пульта, не найдя прежнего держателя, сажает
// фокус на крестик окна. После операции человек остаётся на крестике: не читает ответ
// рядом с кнопкой и по инерции жмёт ОК, закрывая окно.

import { nextTick } from 'vue'

/// Жив ли элемент как цель: остался в разметке и снова годится для обхода.
function live(el: HTMLElement | null): el is HTMLElement {
  return el !== null && el.isConnected && !el.hasAttribute('disabled') && el.tabIndex >= 0
}

/** Возвращает фокус прежнему держателю `was`, сделавшему это до работы. Если его больше
 *  нет — вопрос закрылся, кнопка ушла из разметки, окно сняли, — берётся `fallback`.
 *  И там, и там пусто: фокус остаётся, где его посадил обход, и это не поломка. */
export function restoreFocus(was: Element | null, fallback?: () => HTMLElement | null): void {
  void nextTick(() => {
    const from = was instanceof HTMLElement && was !== document.body ? was : null
    const goal = live(from) ? from : (fallback?.() ?? null)
    if (live(goal)) goal.focus({ preventScroll: true })
  })
}
