/** Ловит правку одной копии, не доехавшую до второй.
 *
 *  Файлы двух приложений намеренно разные (у приставки меньше настроек, своя вёрстка), поэтому
 *  расхождение само по себе не ошибка. Ошибка — рост сверх зафиксированного в drift.json.
 *  Комментарии и пустые строки в расчёт не входят: правка формулировки — не расхождение.
 *  Запуск: npm run drift (проверка, в CI), npm run drift:accept (зафиксировать как задуманное). */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, sep } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAIRS = [
  { name: 'windows', dir: join(root, 'apps', 'windows', 'src', 'app') },
  { name: 'android-tv', dir: join(root, 'apps', 'android-tv', 'src', 'app') },
]
const SNAPSHOT = join(root, 'drift.json')
const EXT = new Set(['.ts', '.vue', '.mts', '.cts'])

/** Всё, что не код: комментарии разных стилей и пустые строки. */
function isNoise(line) {
  const t = line.trim()
  return (
    t === '' ||
    t.startsWith('//') ||
    t.startsWith('/*') ||
    t.startsWith('*') ||
    t.startsWith('<!--')
  )
}

/** Множество значимых строк: сравнение множеств не ругается на перестановку строк. */
function codeLines(path) {
  return new Set(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((l) => !isNoise(l)),
  )
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, acc)
    else if (EXT.has(full.slice(full.lastIndexOf('.')))) acc.push(full)
  }
  return acc
}

/** Расхождение пары: сколько значимых строк есть в одной копии и нет в другой. */
function measure(a, b) {
  let onlyA = 0
  let onlyB = 0
  for (const line of a) if (!b.has(line)) onlyA++
  for (const line of b) if (!a.has(line)) onlyB++
  return onlyA + onlyB
}

const [first, second] = PAIRS
if (!existsSync(first.dir) || !existsSync(second.dir)) {
  console.error('Каталог приложения не найден — скрипту не с чем сравнивать.')
  process.exit(1)
}

// Ключ пары — путь относительно каталога приложения: он одинаков у обеих копий.
const relKey = (full, dir) => relative(dir, full).split(sep).join('/')
const left = new Map(walk(first.dir).map((f) => [relKey(f, first.dir), f]))

const current = {}
for (const [key, file] of left) {
  const twin = join(second.dir, ...key.split('/'))
  if (!existsSync(twin)) continue
  current[key] = measure(codeLines(file), codeLines(twin))
}

const saved = existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, 'utf8')) : { files: {} }

if (process.argv.includes('--accept')) {
  const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(SNAPSHOT, JSON.stringify({ files: sorted }, null, 2) + '\n', 'utf8')
  const identical = Object.values(sorted).filter((n) => n === 0).length
  console.log(
    `Зафиксировано пар: ${Object.keys(sorted).length}, из них с одинаковым кодом: ${identical}.`,
  )
  process.exit(0)
}

const previous = saved.files ?? {}
const grew = []
const shrunk = []
const fresh = []
const gone = []

for (const [key, value] of Object.entries(current)) {
  const before = previous[key]
  if (before === undefined) {
    // Новая пара: её появление само по себе не ошибка, но зафиксировать надо.
    fresh.push({ key, value })
  } else if (value > before) grew.push({ key, before, value })
  else if (value < before) shrunk.push({ key, before, value })
}

for (const key of Object.keys(previous)) {
  if (current[key] === undefined) gone.push(key)
}

const identical = Object.values(current).filter((n) => n === 0).length
console.log(`Пар всего: ${Object.keys(current).length}, с одинаковым кодом: ${identical}.`)
console.log(
  `Разошлись сильнее: ${grew.length}. Сблизились: ${shrunk.length}. Новых пар: ${fresh.length}.`,
)

if (grew.length) {
  console.log('\nРазошлись сильнее — обычно это забытая правка второй копии:')
  for (const item of grew) {
    console.log(`  ${item.key}: ${item.before} -> ${item.value} строк`)
  }
}

if (shrunk.length) {
  console.log('\nСблизились (обычно две копии стали одинаковыми):')
  for (const item of shrunk) console.log(`  ${item.key}: ${item.before} -> ${item.value}`)
}

if (fresh.length) {
  console.log('\nНовые пары, их ещё нет в снимке:')
  for (const item of fresh) console.log(`  ${item.key}: ${item.value}`)
}

if (gone.length) {
  console.log('\nПары, которые были в снимке и пропали:')
  for (const key of gone) console.log(`  ${key}`)
}

// Расхождение выросло — это подозрение на забытую правку, и оно должно мешать.
// Остальное (новые пары, сближение) — нормальная работа, её достаточно зафиксировать.
process.exit(grew.length > 0 ? 1 : 0)
