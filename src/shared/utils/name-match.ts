// Скоринговый матчер имён: чистые функции без сети. Шкалу и пороги (80 — каталог, 55 —
// роли тайтла) не менять без проверки на живых данных. Короткая подстрока кандзи — не довод.

export interface NameCandidate {
  name?: string | null
  russian?: string | null
  japanese?: string | null
}

export interface NameTarget {
  full?: string | null
  native?: string | null
}

/** Иероглифы без каны: именно их расхождение говорит о разных людях. */
const KANJI_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/

/** Потолок при расхождении кандзи: ниже обоих порогов, 55 и 80. */
const WEAK_CAP = 30

export function amNormRomaji(str: string | null | undefined): string {
  if (!str) return ''
  return str
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['\u2019\u02bc`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Сжимает долгие гласные: Yuuki = Yuki, Ryou = Ryo, Kaneda = Kaneda. */
export function amCollapseVowels(str: string): string {
  return str
    .replace(/ou/g, 'o')
    .replace(/oo/g, 'o')
    .replace(/uu/g, 'u')
    .replace(/aa/g, 'a')
    .replace(/ee/g, 'e')
    .replace(/ii/g, 'i')
}

export function amTokens(str: string | null | undefined): string[] {
  return amNormRomaji(str).split(' ').filter(Boolean)
}

/** Убирает все пробелы: разделители в источниках разные. */
export function amNormNative(str: string | null | undefined): string {
  return (str ?? '').replace(/\s+/g, '').trim()
}

/** Есть ли иероглифы: кана и латиница сравниваются ненадёжно. */
export function amHasKanji(str: string | null | undefined): boolean {
  return KANJI_RE.test(str ?? '')
}

/** Балл по ромаджи; порядок токенов игнорируется (AniList — западный порядок, Shikimori — японский). */
function scoreRomaji(cand: NameCandidate, target: NameTarget): number {
  const tTok = amTokens(target.full)
  const cTok = amTokens(cand.name)
  if (tTok.length === 0 || cTok.length === 0) return 0

  const tSet = [...tTok].sort().join(' ')
  const cSet = [...cTok].sort().join(' ')
  if (tSet === cSet) return 85
  if (amCollapseVowels(tSet) === amCollapseVowels(cSet)) return 80

  // Допускаем ровно один лишний токен (среднее имя, титул).
  const tS = new Set(tTok.map(amCollapseVowels))
  const cS = new Set(cTok.map(amCollapseVowels))
  const small = tS.size <= cS.size ? tS : cS
  const big = tS.size <= cS.size ? cS : tS
  let all = true
  for (const x of small) {
    if (!big.has(x)) {
      all = false
      break
    }
  }
  if (all && small.size >= 2 && small.size >= big.size - 1) return 55

  // Ограничение на 5 символов гасит мусор вроде "Ai" в "Aiko".
  const tJoin = amCollapseVowels(tTok.join(''))
  const cJoin = amCollapseVowels(cTok.join(''))
  if (tJoin.length >= 5 && cJoin.length >= 5 && (cJoin.includes(tJoin) || tJoin.includes(cJoin))) {
    return WEAK_CAP
  }

  return 0
}

/** Оценивает совпадение кандидата Shikimori с целью AniList: 0..100 (100 — точный кандзи, 80+ — точный ромаджи). */
export function scoreNameMatch(cand: NameCandidate, target: NameTarget): number {
  // Кандзи надёжнее ромаджи: транслитераций много, оригинал один.
  const tNative = amNormNative(target.native)
  const cNative = amNormNative(cand.japanese)

  /** Кандзи хотя бы пересеклись: тогда наказывать за расхождение не за что. */
  let nativeAgree = false

  if (tNative && cNative) {
    if (tNative === cNative) return 100

    if (cNative.includes(tNative) || tNative.includes(cNative)) {
      nativeAgree = true

      // Длина короткой строки: она и есть подстрока.
      const short = Math.min(tNative.length, cNative.length)
      if (short >= 4) return 90
      if (short === 3) return 70
    }
  }

  const romaji = scoreRomaji(cand, target)

  // Оба иероглифами и не сошлись — совпавшее чтение ничего не значит.
  if (!nativeAgree && amHasKanji(tNative) && amHasKanji(cNative)) {
    return Math.min(romaji, WEAK_CAP)
  }

  return romaji
}
