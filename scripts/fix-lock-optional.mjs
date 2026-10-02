/**
 * Возвращает признак `optional` платформенным пакетам в package-lock.json.
 *
 * npm проставляет `optional` только тем вариантам, что совпали с его собственной
 * платформой. Из-за этого в замке остаются записи с `os`/`cpu`, не помеченные
 * необязательными: на Windows их ~26, и на Linux `npm ci` падает с EBADPLATFORM,
 * требуя чужую сборку. Любой `npm install`, перезаписавший замок, снимет признаки
 * снова и вернёт поломку.
 *
 * Правило: пакет с `os` или `cpu` на несовпадающей платформе не устанавливается
 * никогда, поэтому он необязателен по сути, а не по расположению в графе.
 *
 * Прямые зависимости не трогаем: помечать необязательной реальную зависимость
 * нельзя — она просто молча перестанет ставиться. Такие случаи выводятся и
 * оставляются как есть.
 *
 * Запуск: npm run fix:lock
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lockPath = join(root, 'package-lock.json')

const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
const rootEntry = lock.packages?.['']
const packages = lock.packages

if (!packages || !rootEntry) {
  console.error('Замок без поля packages или без корневой записи — нечего править.')
  process.exit(1)
}

const direct = new Set([
  ...Object.keys(rootEntry.dependencies ?? {}),
  ...Object.keys(rootEntry.devDependencies ?? {}),
  ...Object.keys(rootEntry.optionalDependencies ?? {}),
])

// Имя пакета из пути `node_modules/a/node_modules/b` — последний непересечённый сегмент.
function packageNameOf(key) {
  const parts = key.split('node_modules/')
  return parts.length > 1 ? parts[parts.length - 1] : undefined
}

let marked = 0
let alreadySet = 0
const skippedDirect = []

for (const [key, entry] of Object.entries(packages)) {
  if (key === '') continue
  const constrained = Array.isArray(entry.os) || Array.isArray(entry.cpu)
  if (!constrained) continue

  if (entry.optional === true) {
    alreadySet++
    continue
  }

  const name = packageNameOf(key)
  if (name && direct.has(name)) {
    skippedDirect.push(`${name} — прямая зависимость`)
    continue
  }

  // Порядок ключей в записи не важен для npm, но ставим рядом с platform-полями.
  entry.optional = true
  marked++
}

if (marked > 0) {
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8')
}

console.log(`Платформенных записей: ${marked + alreadySet + skippedDirect.length}`)
console.log(`Помечено необязательными: ${marked}`)
console.log(`Уже было помечено: ${alreadySet}`)

if (skippedDirect.length > 0) {
  console.log('Пропущены прямые зависимости — снимите ограничение os/cpu или разберитесь вручную:')
  for (const line of skippedDirect) console.log(`  ${line}`)
  process.exitCode = 1
}

if (marked === 0) console.log('Замок уже в порядке.')
