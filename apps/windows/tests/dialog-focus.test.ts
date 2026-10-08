// Ловушка фока окон: перенос при открытии, inert фона, возврат при закрытии, обход Tab.

import { afterEach, describe, expect, it } from 'vitest'

import { holdDialog, releaseAllDialogs } from '@/app/dialog-focus'

/** Каркас: кнопка на фоне и окно с двумя контролами. */
function scene(): { trigger: HTMLButtonElement; root: HTMLElement } {
  document.body.innerHTML =
    '<button id="trigger">Открыть</button>' +
    '<div id="win" role="dialog" aria-modal="true">' +
    '<button id="first">Один</button><button id="second">Два</button></div>'

  const trigger = document.getElementById('trigger') as HTMLButtonElement
  const root = document.getElementById('win') as HTMLElement
  trigger.focus()
  return { trigger, root }
}

function press(key: string, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
  document.dispatchEvent(event)
  return event
}

afterEach(() => {
  releaseAllDialogs()
  document.body.innerHTML = ''
})

describe('открытие окна', () => {
  it('фокус уходит в контейнер окна', () => {
    const { root } = scene()
    holdDialog(root)

    expect(document.activeElement).toBe(root)
    expect(root.getAttribute('tabindex')).toBe('-1')
  })

  it('фон становится невосприимчивым', () => {
    const { root } = scene()
    holdDialog(root)

    expect(document.getElementById('trigger')?.hasAttribute('inert')).toBe(true)
    expect(root.hasAttribute('inert')).toBe(false)
  })

  it('пока окно открыто, прокрутка документа заблокирована', () => {
    const { root } = scene()
    expect(document.documentElement.style.overflow).toBe('')

    const release = holdDialog(root)
    expect(document.documentElement.style.overflow).toBe('hidden')

    release()
    expect(document.documentElement.style.overflow).toBe('')
  })
})

describe('закрытие окна', () => {
  it('фокус возвращается на триггер', () => {
    const { trigger, root } = scene()
    const release = holdDialog(root)

    release()
    expect(document.activeElement).toBe(trigger)
    expect(document.getElementById('trigger')?.hasAttribute('inert')).toBe(false)
  })

  it('погибший триггер подменяется запасным узлом', () => {
    const { root } = scene()
    const spare = document.createElement('button')
    document.body.append(spare)
    const release = holdDialog(root, () => spare)

    document.getElementById('trigger')?.remove()
    release()
    expect(document.activeElement).toBe(spare)
  })

  it('без годного триггера фокус не прыгает на фон', () => {
    const { root } = scene()
    const other = document.createElement('button')
    document.getElementById('trigger')?.after(other)
    const release = holdDialog(root)

    document.getElementById('trigger')?.remove()
    release()
    // Рельс за занавесом не должен получать фокус: уходим из окна на body.
    expect(document.activeElement).not.toBe(other)
  })
})

describe('обход Tab', () => {
  it('Tab с последнего элемента возвращает на первый', () => {
    const { root } = scene()
    holdDialog(root)
    ;(document.getElementById('second') as HTMLElement).focus()

    const event = press('Tab')
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(document.getElementById('first'))
  })

  it('Shift+Tab с первого уходит на последний', () => {
    const { root } = scene()
    holdDialog(root)
    ;(document.getElementById('first') as HTMLElement).focus()

    const event = press('Tab', true)
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(document.getElementById('second'))
  })

  it('Tab с контейнера ведёт внутрь окна', () => {
    const { root } = scene()
    holdDialog(root)

    press('Tab')
    expect(document.activeElement).toBe(document.getElementById('first'))
  })
})

describe('стек окон', () => {
  /** Второе окно поверх первого: галерея и кадр. */
  function stack(): { gal: HTMLElement; look: HTMLElement; trigger: HTMLElement } {
    document.body.innerHTML =
      '<button id="trigger">Открыть</button>' +
      '<div id="gal" role="dialog"><button id="cell">Кадр</button></div>' +
      '<div id="look" role="dialog"><button id="closeLook">Закрыть</button></div>'

    const trigger = document.getElementById('trigger') as HTMLButtonElement
    trigger.focus()
    return {
      gal: document.getElementById('gal') as HTMLElement,
      look: document.getElementById('look') as HTMLElement,
      trigger,
    }
  }

  it('закрытие верхнего окна не оживляет фон, пока открыто нижнее', () => {
    const { gal, look } = stack()
    const releaseGal = holdDialog(gal)
    const releaseLook = holdDialog(look)

    expect(gal.hasAttribute('inert')).toBe(true)
    releaseLook()
    expect(gal.hasAttribute('inert')).toBe(false)
    expect(document.getElementById('trigger')?.hasAttribute('inert')).toBe(true)

    releaseGal()
    expect(document.getElementById('trigger')?.hasAttribute('inert')).toBe(false)
  })

  it('закрытие нижнего окна не возвращает прокрутку, пока открыто верхнее', () => {
    const { gal, look } = stack()
    const releaseGal = holdDialog(gal)
    const releaseLook = holdDialog(look)

    releaseGal()
    expect(document.documentElement.style.overflow).toBe('hidden')

    releaseLook()
    expect(document.documentElement.style.overflow).toBe('')
  })

  it('Tab ходит по верхнему окну, а не по нижнему', () => {
    const { gal, look } = stack()
    holdDialog(gal)
    holdDialog(look)
    ;(document.getElementById('closeLook') as HTMLElement).focus()

    const event = press('Tab')
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(document.getElementById('closeLook'))
  })

  it('фокус возвращается на триггер только за верхнее окно', () => {
    const { gal, look, trigger } = stack()
    const releaseGal = holdDialog(gal)
    const releaseLook = holdDialog(look)

    releaseLook()
    expect(document.activeElement).not.toBe(trigger)

    releaseGal()
    expect(document.activeElement).toBe(trigger)
  })
})
