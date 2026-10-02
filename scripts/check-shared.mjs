// Сторонний инструмент: `npm run check:shared`.
//
// Что делает. Сверяет ядро (`src/shared/`) и наборы проверок (`tests/`) этого
// продукта с эталоном, зафиксированным в `shared-baseline.json`, и падает, если
// они разошлись с соседним продуктом. Смысл не в том, чтобы копии были
// одинаковы, а в том, чтобы расхождение было записано: у каждой расходящейся
// строки есть причина в реестре `diverged`. Не записана — падай.
//
// Про `tests/`. Наборы делятся на два класса, и реестр это различает: проверки
// общего ядра в списке не лежат и обязаны совпадать, а проверки экрана своего
// продукта лежат с причиной. Это оказалось важно на деле: падение семнадцати
// проверок в приставке началось с того, что наборы на общее ядро отстали на две
// ревизии, и сторож, смотревший только на `src/shared`, был на это слеп.
//
// Сравнение идёт по коду, а не по байтам. Ядро десктопа и приставки
// расходится на 45 файлов одними комментариями: приставка сжала их на
// 5.7 тыс. строк, десктоп оставил развёрнутыми. Побайтовое сравнение всегда
// красное, поэтому отпечатки считаются по коду: строки-комментарии, пустые
// строки и разница переводов строк отбрасываются.
//
// Токен и сеть не нужны: эталон лежит в репозитории. PAT понадобился бы
// только конвейеру, который дописывает в чужой репозиторий.
//
// Узкие места, о которых надо знать:
//   * Многострочные литералы не разбираются: строка, начавшаяся с `//` или
//     `*`, попадёт в отпечаток. На результат сравнения это не влияет —
//     разный текст даёт разный хеш, — но переносить такие в ядро не стоит.
//   * `core.autocrlf` в обоих репозиториях включён, а `.gitattributes`
//     требует LF для `.ts`. Без нормализации хеши в Windows и в CI разошлись
//     бы на пустом месте, поэтому переводы строк приводятся к LF всегда.
//   * Ветка `upstream` — «я сам десктоп, эталон моё же дерево»: там ловится
//     пропажа файла и новый файл, заведённый в обход экрана.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 'upstream' — канон (Animori-Desktop). 'mirror' — продукт, повторяющий ядро
// (Animori-TV). Меняется в одной строке при появлении следующего продукта.
const SIDE = 'upstream'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE = join(ROOT, 'shared-baseline.json')

// Что вообще сверяется. `tests/` добавлен не из любопытства: падение проверок
// в приставке началось с того, что наборы на общее ядро отстали на две ревизии,
// и никто этого не заметил. Сторож на `src/shared` был на это слеп.
const TREES = [
  { prefix: 'shared', dir: join(ROOT, 'src', 'shared') },
  { prefix: 'tests', dir: join(ROOT, 'tests') },
]

const SUCCESS = 0
const DRIFT = 1
const BROKEN = 2

/**
 * Код файла без строк-комментариев и пустых строк. Отпечаток строится по нему,
 * а не по исходному тексту: переносы комментариев не должны выдавать
 * расхождение ядра.
 */
function codeOf(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^(\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

/** Отпечаток файла по его коду. 16 знаков хеша — достаточно. */
function fingerprint(text) {
  return createHash('sha256').update(codeOf(text)).digest('hex').slice(0, 16)
}

/** Пути всех `.ts` ядра. Обход руками: `readdir` с `recursive` появился
 *  позже Node 20, а шаг 0 не хочется ставить на версию Node. */
function listTree(dir) {
  const found = []
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...listTree(full))
    else if (entry.name.endsWith('.ts')) found.push(full)
  }
  return found
}

/** Отпечатки дерева: путь относительно корня с приставкой дерева. */
function scan(dir, prefix = '') {
  const out = {}
  for (const full of listTree(dir)) {
    const rel = relative(dir, full).split('\\').join('/')
    out[prefix === '' ? rel : `${prefix}/${rel}`] = fingerprint(readFileSync(full, 'utf8'))
  }
  return out
}

/** Отпечатки всех сверяемых деревьев сразу: ключ один на файл во всей базе. */
function scanAll() {
  return Object.assign({}, ...TREES.map((tree) => scan(tree.dir, tree.prefix)))
}

function readBaseline() {
  if (!existsSync(BASELINE)) return { files: {}, diverged: {} }
  const raw = JSON.parse(readFileSync(BASELINE, 'utf8'))
  return { files: raw.files ?? {}, diverged: raw.diverged ?? {} }
}

function writeBaseline(files, diverged, note) {
  const sorted = (obj) =>
    Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : 1)))
  const body = {
    version: 1,
    canonical: 'Animori-Desktop',
    updated: new Date().toISOString().slice(0, 10),
    note,
    files: sorted(files),
    diverged: sorted(diverged),
  }
  writeFileSync(BASELINE, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  return body
}

const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n)
const say = (line) => process.stdout.write(`${line}\n`)

/** Русское окончание по числу: 1 файл, 2 файла, 5 файлов. */
function plural(n, one, few, many) {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 14) return many
  const mod10 = n % 10
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}

const nFiles = (n) => `${n} ${plural(n, 'файл', 'файла', 'файлов')}`
const nItems = (n) => `${n} ${plural(n, 'запись', 'записи', 'записей')}`

/**
 * Сверка дерева с эталоном. Функция без записи на диск: так же устроен
 * `--selftest`, которому нужен разбор на мусорных каталогах. `quiet`
 * глушит отчёт, иначе проверки сторожа утонут в его выводе.
 */
function compare(local, baseline, side, quiet = false) {
  const out = quiet ? () => {} : say
  const known = new Set(Object.keys(baseline.files))
  const excused = new Set(Object.keys(baseline.diverged))
  const drifted = []
  const gone = []
  const closable = []

  for (const [path, expected] of Object.entries(baseline.files)) {
    if (!(path in local)) {
      if (!excused.has(path)) gone.push(path)
      continue
    }
    if (local[path] === expected) {
      if (excused.has(path)) closable.push(path)
      continue
    }
    if (!excused.has(path)) drifted.push(path)
  }

  // Файл, которого нет в эталоне, — это набор своего продукта: `dpad` у
  // приставки, `posters` у десктопа. Запись в `diverged` прощает оба
  // направления: файл может отличаться и может отсутствовать. Иначе продуктовый
  // набор пришлось бы тащить в эталон, а эталон — это отпечатки ядра, не список.
  const stranger = Object.keys(local).filter((path) => !known.has(path) && !excused.has(path))

  // Расхождение с эталоном и файл не в эталоне — это правка ядра, минуя эталон.
  // Пропавший файл — наоборот, ядро урезали.
  for (const path of drifted) {
    out(`  РАСХОЖДЕНИЕ     ${pad(path, 32)} эталон ${baseline.files[path]}, здесь ${local[path]}`)
  }
  for (const path of stranger) {
    out(`  НЕ ЗАРЕГИСТРИРОВАН  ${pad(path, 32)} такого файла в эталоне нет`)
  }
  for (const path of gone) {
    out(`  ПРОПАЛ          ${pad(path, 32)} в эталоне есть, в этом продукте нет`)
  }

  const total = drifted.length + gone.length + stranger.length
  if (total > 0) {
    out('')
    out(
      side === 'upstream'
        ? `Ядро разошлось с эталоном: ${nItems(total)}. Обнови эталон, если правка осознанная.`
        : `Ядро разошлось с Animori-Desktop: ${nItems(total)}. Перенеси правку или запиши её в diverged.`,
    )
    return { code: DRIFT, total }
  }

  const count = Object.keys(local).length
  if (side === 'upstream') {
    out(`Ядро на месте: ${nFiles(count)}.`)
  } else {
    out(`Ядро совпадает с эталоном: ${nFiles(count)}, из них расходятся ${nItems(excused.size)}.`)
    // Подсказка осмысленна только здесь: в эталоне файл всегда совпадает сам
    // с собой, и подсказка срабатывала бы на каждом запуске.
    if (closable.length > 0) {
      out(`  можно убрать из diverged, теперь совпадает: ${closable.join(', ')}`)
    }
  }
  return { code: SUCCESS, total: 0 }
}

function update() {
  if (SIDE !== 'upstream') {
    say('Эталон ведётся в Animori-Desktop: из зеркала он не обновляется.')
    return BROKEN
  }
  const before = readBaseline()
  const files = scanAll()
  writeBaseline(
    files,
    before.diverged,
    'Отпечатки ядра и наборов проверок. Обновляется `npm run check:shared -- ' +
      '--update` после осознанной правки. Причины в diverged пишутся руками: ' +
      'сравнение не знает, что считать правкой, а что порчей.',
  )
  const kept = Object.keys(before.diverged).length
  say(`Эталон обновлён: ${nFiles(Object.keys(files).length)}, diverged ${kept}.`)
  return SUCCESS
}

/**
 * Сторож проверяет сторожа. Сторож, который всегда зелёный, хуже отсутствия:
 * на нём перестают смотреть. Каждый случай проверяется на своём дереве, иначе
 * одно расхождение маскирует другое.
 */
function selftest() {
  const root = join(ROOT, '.selftest-tmp')
  rmSync(root, { recursive: true, force: true })

  const code = 'export const a = 1\nexport const b = 2\n'
  const put = (name, files) => {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    for (const [file, text] of Object.entries(files)) {
      writeFileSync(join(dir, file), text, 'utf8')
    }
  }
  const tree = (name) => scan(join(root, name))
  const total = (local, bl) => compare(local, bl, 'mirror', true).total

  // 1: комментарий и пустые строки — не код, расхождением не считаются.
  put('c1a', { 'same.ts': `${code}// комментарий десктопа\n` })
  put('c1b', { 'same.ts': code })
  // 2: правка кода обязана ловиться.
  put('c2a', { 'same.ts': code })
  put('c2b', { 'same.ts': `${code}export const c = 3\n` })
  // 3: файла нет в эталоне — он заведён в обход экрана.
  put('c3a', { 'same.ts': code })
  put('c3b', { 'same.ts': code, 'new.ts': code })
  // 4: файл есть в эталоне, а в этом продукте его нет.
  put('c4a', { 'same.ts': code, 'only-a.ts': code })
  put('c4b', { 'same.ts': code })

  const c1 = { files: tree('c1a'), diverged: {} }
  const c2 = { files: tree('c2a'), diverged: {} }
  const c3 = { files: tree('c3a'), diverged: {} }
  const c4 = { files: tree('c4a'), diverged: {} }
  const c4excused = { files: c4.files, diverged: { 'only-a.ts': 'только в эталоне' } }
  // Файл, которого нет в эталоне, но он зарегистрирован: набор своего продукта.
  const c3own = { files: tree('c3a'), diverged: { 'new.ts': 'набор приставки' } }

  const checks = [
    ['комментарий и пустые строки не считаются расхождением', total(tree('c1b'), c1) === 0],
    ['правка кода ловится', total(tree('c2b'), c2) === 1],
    ['файл, которого нет в эталоне, ловится', total(tree('c3b'), c3) === 1],
    ['пропавший файл ловится', total(tree('c4b'), c4) === 1],
    ['зарегистрированное расхождение проходит', total(tree('c4b'), c4excused) === 0],
    ['файл своего продукта в реестре проходит', total(tree('c3b'), c3own) === 0],
  ]
  rmSync(root, { recursive: true, force: true })

  const bad = checks.filter(([, ok]) => !ok)
  for (const [name, ok] of checks) say(`  ${ok ? 'ок    ' : 'ПРОВАЛ'}  ${name}`)
  if (bad.length === 0) say('Сторож работает: расхождение ловится.')
  return bad.length === 0 ? SUCCESS : DRIFT
}

const argv = process.argv.slice(2)
const mode = argv.includes('--update') ? 'update' : argv.includes('--selftest') ? 'selftest' : 'check'

if (mode === 'update') process.exit(update())
if (mode === 'selftest') process.exit(selftest())

const label = SIDE === 'upstream' ? 'эталон ведётся здесь' : 'сверка с Animori-Desktop'
say(`AniMori: проверка ядра и наборов — ${label}`)
const missing = TREES.filter((tree) => !existsSync(tree.dir))
if (missing.length > 0) {
  for (const tree of missing) say(`Каталог не найден: ${tree.dir}`)
  process.exit(BROKEN)
}
process.exit(compare(scanAll(), readBaseline(), SIDE).code)

