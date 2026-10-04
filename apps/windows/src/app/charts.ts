// Геометрия столбчатых диаграмм: координаты верхушек, кривая по ним и круглые деления шкалы. Отдельно от
// экрана: компонент не должен тянуться в код экрана за числами. Считает только по переданному.

/** Точка графика в относительной системе координат 0..1000 для построения SVG-кривой. */
export interface SplinePoint {
  x: number
  y: number
}

/** Высота кривой в поле 0..1000: выше нуля не пускаем, полотно одно на все ряды. */
function clampY(value: number): number {
  return Math.max(0, Math.min(1000, value))
}

/** Координаты верхушек столбиков для SVG-графика поверх гистограммы. X центрируется по ширине
 * столбика, Y — его верхний край. Доля приходит от потолка шкалы, а не от самой высокой колонки: иначе пик всегда упирался в край. */
export function pointsForBars(bars: readonly { share: number }[]): SplinePoint[] {
  const n = bars.length
  if (n === 0) return []

  return bars.map((b, i) => {
    const x = ((i + 0.5) / n) * 1000
    const fillPercent = b.share <= 0 ? 0 : Math.max(4, b.share * 100)
    const y = 1000 - fillPercent * 10
    return { x, y }
  })
}

/** Плавная кривая (монотонная интерполяция Фрича — Карлсона) по верхам столбиков. Прямая Безье
 * провисала
 * между вершинами, а данные у нас дискретные, и линия между ними читалась как правда. */
export function smoothPath(points: readonly SplinePoint[]): string {
  if (points.length < 2) return ''

  const first = points[0]
  if (!first) return ''
  const n = points.length

  // Уклоны между соседними вершинами: на них опираются касательные.
  const slopes: number[] = []
  for (let i = 0; i < n - 1; i += 1) {
    const a = points[i]
    const b = points[i + 1]
    const dx = a && b ? b.x - a.x : 0
    slopes.push(dx === 0 || !a || !b ? 0 : (b.y - a.y) / dx)
  }

  // Касательные: по своему уклону у краёв, между соседними — средняя, а на перелёте (локальный максимум или минимум) — ноль, иначе кривая прогнёлась бы через саму вершину.
  const tangents: number[] = new Array<number>(n).fill(0)
  tangents[0] = slopes[0] ?? 0
  tangents[n - 1] = slopes[n - 2] ?? 0
  for (let i = 1; i < n - 1; i += 1) {
    const before = slopes[i - 1] ?? 0
    const after = slopes[i] ?? 0
    tangents[i] = before * after <= 0 ? 0 : (before + after) / 2
  }

  // Прижим Фрича — Карлсона: если касательные разошлись с уклоном круче тройного, ужимаем их.
  for (let i = 0; i < n - 1; i += 1) {
    const slope = slopes[i] ?? 0
    if (slope === 0) {
      tangents[i] = 0
      tangents[i + 1] = 0
      continue
    }
    const a = (tangents[i] ?? 0) / slope
    const b = (tangents[i + 1] ?? 0) / slope
    const sum = a * a + b * b
    if (sum > 9) {
      const k = 3 / Math.sqrt(sum)
      tangents[i] = k * a * slope
      tangents[i + 1] = k * b * slope
    }
  }

  let d = `M ${first.x.toFixed(1)} ${first.y.toFixed(1)}`
  for (let i = 0; i < n - 1; i += 1) {
    const a = points[i]
    const b = points[i + 1]
    if (!a || !b) continue
    const step = (b.x - a.x) / 3
    const c1y = clampY(a.y + (tangents[i] ?? 0) * step)
    const c2y = clampY(b.y - (tangents[i + 1] ?? 0) * step)
    d += ` C ${(a.x + step).toFixed(1)} ${c1y.toFixed(1)}, ${(b.x - step).toFixed(1)} ${c2y.toFixed(1)}, ${b.x.toFixed(1)} ${b.y.toFixed(1)}`
  }

  return d
}

/** Замыкает кривую ко дну (bottomY), формируя замкнутый контур для градиентной подложки. */
export function smoothAreaPath(points: readonly SplinePoint[], bottomY = 1000): string {
  if (points.length < 2) return ''
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return ''

  const lineD = smoothPath(points)
  return `${lineD} L ${last.x.toFixed(1)} ${bottomY.toFixed(1)} L ${first.x.toFixed(1)} ${bottomY.toFixed(1)} Z`
}

/** Шаги сетки, кратные удобному числу: 1, 2, 2.5, 5 или 10 на степень десяти. */
const TICK_STEPS = [1, 2, 2.5, 5, 10] as const

/** Круглые деления шкалы от нуля до потолка. Делений — сколько просили, шаг округляется вверх,
 * чтобы верхняя линия была не ниже самой высокой колонки. Дробный шаг (2.5) берётся только на десятках. */
export function niceTicks(top: number, want = 4): number[] {
  if (!(top > 0)) return [0]

  const rough = top / Math.max(1, want)
  const power = 10 ** Math.floor(Math.log10(rough))
  const ladder = top < 20 ? ([1, 2, 5, 10] as const) : TICK_STEPS
  const step = (ladder.find((m) => m * power >= rough) ?? 10) * power

  const ticks: number[] = []
  // Деление берём и выше самой высокой колонки: иначе пик упирался бы в край поля, а подпись последней линии врала бы (44 читалось бы как 40).
  for (let value = 0; value < top + step; value += step) {
    ticks.push(Math.round(value * 100) / 100)
  }
  return ticks
}
