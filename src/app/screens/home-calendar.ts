// Календарь выхода на Главной: своя неделя по дням.
//
// Зачем он вообще: у витрины не было ответа на вопрос «а что будет завтра».
// Полки показывают то, что уже есть, и открывать приложение на следующий день
// человеку незачем — он и так ничего не пропустит. Календарь отвечает именно
// на это, поэтому и стоит под шапкой, выше всего остального.
//
// ЧТО ЗДЕСЬ СЧИТАЕТСЯ НЕДЕЛЕЙ
//
// Неделя календарная: с понедельника по воскресенье, по местным суткам.
// Не «семь дней вперёд» — полоса подписана Пн…Вс и обещает календарь, а
// начать её со среды значило бы врать подписями. Не по UTC — серия,
// вышедшая в час ночи, уехала бы во вчерашний день.
//
// Прошедшие дни недели не выкидываются. Вышедшее сегодня утром — такой же
// повод открыть приложение, как то, что выйдет вечером, а пустые клетки
// понедельника и вторника читались бы поломкой.
//
// ОТКУДА ЧТО БЕРЁТСЯ
//
// Расписание — один запрос на всю неделю (`api/anilist-schedule`), номера
// тайтлов даёт список. Имя берётся по старшинству: русское из
// `core/media-title`, затем название сервера из самого ответа. Обложка — из
// `core/media-looks`: снимок картинок не держит, а полке без неё нечего
// показывать.
//
// ВЫХОДЫ ПОКАЗЫВАЮТСЯ ПОСТЕРАМИ, А НЕ СТРОКАМИ
//
// Прежний список перечислял день построчно и рос вниз вместе с числом выходов:
// в чужом показе суббота давала под два десятка строк и вытесняла полки за
// нижний край окна, а человек всё равно читал не строки, а знакомые обложки.
// Теперь день — полка постеров в один ряд с боковой прокруткой. Высота
// перестала зависеть от числа выходов вовсе, поэтому и потолок с «Ещё N»
// больше не нужен. Час выхода и номер серии переехали в подпись под названием,
// где им и место: постер говорит «что», подпись — «когда».
//
// МЕТКИ ДОСТУПНОСТИ
//
// На постере есть знак «можно посмотреть» или «нет в каталоге». Ставит его
// один Kodik: у Aniliberty вопроса о наличии больше нет вовсе, а Kodik входит
// по номеру MAL и тайтл без номера ему не адресуем. Значит, без номера метки
// не будет ни у кого — очередь просто не найдёт, кого спрашивать.
//
// Номеров календарь не хранит: в расписании их нет. Берутся они лестницей
// `fetchMalIds` — память запуска, выпуск, склад, и лишь потом сеть. Своим
// тайтлам отвечает выпуск или склад, чужим — сеть, причём тем же запросом,
// которого уже ждёт добор имён: очередь в `api/anilist-lookup` у них общая.
//
// Отдельного показа у меток нет: спрашивается показанный день целиком, а не
// то, что попало в окно. День — это два десятка плиток, и «спросить про то,
// что видно» здесь сэкономило бы один запрос ценой знака, которого нет
// у половины полки после прокрутки.
//
// ДВЕ ОБЛАСТИ ПОКАЗА
//
// «Моё» — всё из списка, кроме брошенного. Именно так, а не только «Смотрю»:
// календарь отвечает на вопрос «что выходит у меня», а тайтл в планах выходит
// ровно так же, как идущий. Брошенное выброшено потому, что человек от него
// отказался: показывать его выходы значило бы держать перед глазами то,
// от чего он ушёл.
//
// «Популярное» — выходы верхушки идущих по популярности. Не «всё, что выходит
// в мире»: такого запроса у AniList нет (см. `api/anilist-schedule`), и честное
// название лучше красивого.
//
// ВЗРОСЛОЕ ПРЯЧЕТСЯ ЗДЕСЬ ТОЖЕ
//
// Календарь спрашивает расписание по номерам, а не по облику, и метки 18+
// у него своего не было вовсе: у чужого тайтла облика нет, и спросить признак
// было неоткуда. Теперь признак приходит с самим расписанием (`media { isAdult }`)
// и отбор идёт по нему — один на обе области показа, потому что расписание
// у них общее.
//
// Отбор стоит на входе, а не на отрисовке: спрятанное не должно занимать
// место в доборах. Иначе скрытый выход тянул бы за собой имя, обложку
// и вопрос о доступности — три запроса к чужим службам ради строки, которой
// человек не увидит.
import { computed, ref, type ComputedRef, type Ref } from 'vue'

import { fetchMalIds } from '@/api/anilist-media'
import { fetchAiringSchedules, fetchPopularOngoing, type AiringEntry } from '@/api/anilist-schedule'
import { adultAllowed, hiddenCount, keepAllowed } from '@/core/adult'
import { peekLook, warmLooks } from '@/core/media-looks'
import { peekRussianName, prefetchRussianNames } from '@/core/media-title'
import {
  onPlayableChange,
  peekPlayable,
  primePlayable,
  requestPlayable,
  type PlayAsk,
  type PlayState,
} from '@/core/playable'
import { Logger } from '@/utils/logger'

import { statusList } from '../labels'

/** Подписи дней коротко. У JS неделя идёт с воскресенья, поэтому порядок свой. */
const DAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const

/** Те же дни полностью: для подписи клетки. */
const DAY_FULL = [
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
  'воскресенье',
] as const

/** Месяцы в родительном падеже: «21 сентября», а не «21 сентябрь». */
const MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
] as const

/** Сколько дней в полосе. */
const WEEK_DAYS = 7

/** По скольку имён просить за заход: источники отвечают по одному. */
const NAME_CHUNK = 6

/**
 * Сколько имён добираем за один показ дня.
 *
 * Потолок нужен из-за чужого показа: в нём день бывает в два десятка
 * выходов, и каждый — чужой тайтл, которого нет ни в датасете, ни в складе.
 * Двадцать четыре покрывают замеренный день целиком (самый полный был
 * в девятнадцать выходов), поэтому полка дня не остаётся наполовину
 * на латинице. Четыре захода по шесть.
 */
const NAME_LIMIT = 24

/**
 * Сколько идущих тайтлов брать для чужого показа.
 *
 * Сотня выбрана замером по живому расписанию: верхушка в сто даёт 81 выход
 * за неделю, ровно разложенный по дням (от пяти до девятнадцати на день),
 * а верхушка в сто пятьдесят добавляет к ним три выхода. Дальше растёт
 * только счёт запросов.
 */
const POPULAR_LIMIT = 100

/** Область показа календаря. */
export type CalendarScope = 'mine' | 'popular'

/**
 * Закладки, которые календарь считает своими. Собираются из общего словаря,
 * а не переписываются здесь списком: закладку завёл бы один файл, а забыл
 * бы другой, и календарь молча перестал бы показывать новый статус.
 */
export const OWN_STATUSES: readonly string[] = statusList()
  .map((item) => item.key)
  .filter((key) => key !== 'DROPPED')

/** Один выход в строке календаря. Поля названы так, как их зовёт плитка:
    полка под полосой собирается из этого без единого пересчёта. */
export interface WeekRow {
  /** Ключ строки: тайтл и срок. */
  key: string
  mediaId: number
  episode: number
  /** Срок выхода в миллисекундах: по нему идёт порядок внутри дня. */
  at: number
  /** Час выхода: «19:30». */
  time: string
  title: string
  /** Подпись под названием: «19:30 · серия 7», а у вышедшей — «вышла · серия 7». */
  facts: string
  /** Обложка постера. До добора её нет, и плитка покажет букву названия. */
  cover: string | null
  /** Цвет обложки: подложка, пока картинка едет. */
  color: string | null
  /** Есть ли выход у источников видео. `null` — ещё не спрашивали, и знака не будет. */
  play: PlayState | null
  /** Серия уже вышла. */
  aired: boolean
}

/** День полосы. */
export interface WeekDay {
  /** Начало местных суток: и ключ дня, и то, по чему его выбирают. */
  key: number
  /** «Пн». */
  word: string
  /** «16». */
  num: string
  /** Полная подпись для подсказки: «среда, 16 сентября». */
  title: string
  /** Сегодня ли это. */
  today: boolean
  /** День уже прошёл: выходы в нём уже вышли. */
  past: boolean
  rows: WeekRow[]
}

/** Начало местных суток. По нему дни и различаются. */
export function dayStart(stamp: number): number {
  const date = new Date(stamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/**
 * Сдвиг на дни вперёд или назад по календарю. Через `setDate`, а не
 * прибавлением суток в миллисекундах: в сутках их не всегда ровно
 * восемьдесят шесть миллионов четыреста.
 */
export function addDays(stamp: number, days: number): number {
  const date = new Date(stamp)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

/** Начало недели, в которой лежит срок: понедельник, местные сутки. */
export function weekStart(stamp: number): number {
  const date = new Date(dayStart(stamp))
  const shift = (date.getDay() - 1 + WEEK_DAYS) % WEEK_DAYS
  return addDays(date.getTime(), -shift)
}

/** Час выхода по местным часам. Не через toLocaleTimeString: тот отдаёт
    двенадцатичасовой вид и точку вместо двоеточия на чужих настройках. */
export function hourText(stamp: number): string {
  const date = new Date(stamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Подпись недели: «15 — 21 сентября». Месяц и год появляются, только
    когда они разные: внутри одного месяца они бы только мешали. */
export function weekText(start: number): string {
  const from = new Date(start)
  const to = new Date(addDays(start, WEEK_DAYS - 1))

  const fromMonth = MONTHS[from.getMonth()] ?? ''
  const toMonth = MONTHS[to.getMonth()] ?? ''

  if (from.getMonth() === to.getMonth()) {
    return `${from.getDate()} — ${to.getDate()} ${fromMonth}`
  }

  if (from.getFullYear() === to.getFullYear()) {
    return `${from.getDate()} ${fromMonth} — ${to.getDate()} ${toMonth}`
  }

  return (
    `${from.getDate()} ${fromMonth} ${from.getFullYear()} — ` +
    `${to.getDate()} ${toMonth} ${to.getFullYear()}`
  )
}

/**
 * Имя выхода по старшинству: русское знание, затем название сервера,
 * затем номер тайтла. Номер — не заглушка на время загрузки, а честный
 * ответ: имени у этого тайтла нет нигде.
 */
function titleOf(entry: AiringEntry): string {
  return (
    peekRussianName(entry.mediaId) ?? entry.romaji ?? entry.english ?? `Аниме #${entry.mediaId}`
  )
}

/**
 * Подпись под названием: час и серия, а у вышедшей серии — слово вместо часа.
 *
 * Час у вышедшего не показывается нарочно. Он уже ничего не решает: серия
 * лежит и ждёт, а минута, в которую она вышла, — подробность, за которой
 * не идут. Зато «вышла» отвечает на вопрос, ради которого в календарь
 * и заходят: можно ли смотреть сейчас.
 */
function factsOf(episode: number, time: string, aired: boolean): string {
  return aired ? `вышла · серия ${episode}` : `${time} · серия ${episode}`
}

/** Выход сервера в строку календаря. */
function toRow(entry: AiringEntry, at: number): WeekRow {
  const look = peekLook(entry.mediaId)
  const time = hourText(at)
  const aired = at <= Date.now()

  return {
    key: `${entry.mediaId}|${entry.airingAt}`,
    mediaId: entry.mediaId,
    episode: entry.episode,
    at,
    time,
    title: titleOf(entry),
    facts: factsOf(entry.episode, time, aired),
    cover: look?.cover ?? null,
    color: look?.color ?? null,
    play: peekPlayable(entry.mediaId),
    aired,
  }
}

/**
 * Раскладывает выходы по семи дням недели, начиная с `start`.
 *
 * Дни строятся всегда, даже пустые: полоса из семи клеток — это и есть
 * календарь, и клетка без выходов говорит «здесь ничего», а пропущенная
 * клетка не говорит ничего.
 */
export function buildDays(entries: AiringEntry[], start: number, today: number): WeekDay[] {
  const buckets = new Map<number, WeekRow[]>()

  for (const entry of entries) {
    const at = entry.airingAt * 1000
    const key = dayStart(at)
    const bucket = buckets.get(key)

    if (bucket === undefined) buckets.set(key, [toRow(entry, at)])
    else bucket.push(toRow(entry, at))
  }

  const out: WeekDay[] = []

  for (let i = 0; i < WEEK_DAYS; i += 1) {
    const key = addDays(start, i)
    const date = new Date(key)
    const rows = buckets.get(key) ?? []
    rows.sort((a, b) => a.at - b.at)

    out.push({
      key,
      word: DAY_SHORT[i] ?? '',
      num: String(date.getDate()),
      title: `${DAY_FULL[i] ?? ''}, ${date.getDate()} ${MONTHS[date.getMonth()] ?? ''}`.trim(),
      today: key === today,
      past: key < today,
      rows,
    })
  }

  return out
}

/** Всё, что разметка календаря берёт готовым. */
export interface HomeCalendar {
  /** Идёт запрос расписания. */
  busy: Ref<boolean>
  /** Расписание не пришло: пустая полоса без этой отметки читалась бы
      «ничего не выходит», а это неправда. */
  failed: Ref<boolean>
  days: ComputedRef<WeekDay[]>
  /** Выбранный день. Ноль — «тот, что сегодня». */
  picked: Ref<number>
  shown: ComputedRef<WeekDay | null>
  /** Подпись недели: «15 — 21 сентября». */
  span: ComputedRef<string>
  /** Чья неделя показывается. */
  scope: Ref<CalendarScope>
  /**
   * Сколько выходов недели спрятал тумблер показа взрослого. Нужно подписи
   * под календарём: день без строк читался бы «здесь ничего не выходит»,
   * а это неправда, если выход был и его убрал отбор.
   */
  hidden: Ref<number>
  /**
   * Дни, где выходы были, но их спрятал отбор. Ключ — начало местных суток,
   * как у дней недели. Отдельно от счёта за неделю: пустой день говорит
   * «здесь ничего не выходит», и отличить правду от отбора можно только так.
   */
  hiddenDays: Ref<Set<number>>
  pick: (key: number) => void
  /** Смена области показа. Выбранный день не трогается: человек смотрит
      на четверг и хочет увидеть тот же четверг, а не вернуться к сегодня. */
  setScope: (next: CalendarScope, mediaIds: number[]) => Promise<void>
  load: (mediaIds: number[]) => Promise<void>
}

const entries = ref<AiringEntry[]>([])
const busy = ref(false)
const failed = ref(false)
const picked = ref(0)
const scope = ref<CalendarScope>('mine')
const startKey = ref(0)
const todayKey = ref(0)
const hidden = ref(0)
const hiddenDays = ref<Set<number>>(new Set())

/** Счётчик добора: `peekRussianName`, `peekLook` и `peekPlayable` не реактивны,
    и без него полка не пересобралась бы, когда приедет имя, обложка или метка. */
const stamp = ref(0)

/** Номера заходов: старый видит по своему номеру, что его ответ уже не нужен. */
let run = 0
let nameRun = 0
let coverRun = 0
let playRun = 0

/** Верхушка идущих на время сеанса: за неделю она не меняется, а стоит
    двух запросов. Живёт в памяти и честно гибнет вместе с окном — как и
    состояние отбора на Главной (`home-keep`). */
let popularIds: number[] = []

const days = computed<WeekDay[]>(() => {
  void stamp.value
  return startKey.value === 0 ? [] : buildDays(entries.value, startKey.value, todayKey.value)
})

/** Показанный день: выбранный, а если его нет в этой неделе — сегодняшний.
    Так смена недели сама сбрасывает выбор, не оставляя пустую полосу. */
const shown = computed<WeekDay | null>(() => {
  const list = days.value
  if (list.length === 0) return null

  return (
    list.find((day) => day.key === picked.value) ?? list.find((day) => day.today) ?? list[0] ?? null
  )
})

const span = computed<string>(() => (startKey.value === 0 ? '' : weekText(startKey.value)))

/**
 * Русские имена для выходов показанного дня. Именно дня, а не всей недели:
 * в чужом показе за неделю набирается восемь десятков тайтлов, и просить
 * перевод для тех, кого на экране нет, значило бы гонять источник вхолостую.
 * Подпись без имени нечитаема, но и держать из-за неё экран незачем — имя
 * приедет и перерисует полку.
 */
async function warmNames(): Promise<void> {
  const mine = ++nameRun
  const day = shown.value
  if (day === null) return

  const wanted = [
    ...new Set(
      day.rows.filter((row) => peekRussianName(row.mediaId) === null).map((row) => row.mediaId),
    ),
  ].slice(0, NAME_LIMIT)

  if (wanted.length === 0) return

  try {
    for (let from = 0; from < wanted.length; from += NAME_CHUNK) {
      if (mine !== nameRun) return

      await prefetchRussianNames(wanted.slice(from, from + NAME_CHUNK))
      if (mine !== nameRun) return

      stamp.value += 1
    }
  } catch (e) {
    // Без перевода название останется на латинице — это не повод ругаться.
    Logger('WARN', 'Календарь: русские названия добрать не вышло', e)
  }
}

/**
 * Обложки для выходов показанного дня. Расчёт тот же, что у имён, и по той же
 * причине: видно всегда один день, а неделя в чужом показе — это восемь
 * десятков тайтлов.
 *
 * Потолка здесь нет нарочно. У имён он нужен потому, что источники отвечают
 * по одному и день стоит четырёх заходов; выписки же едут пачкой до пятидесяти
 * тайтлов, и самый полный день укладывается в одну. Повторный зов и вовсе
 * ничего не стоит: `warmLooks` сам помнит, что уже спрашивал.
 */
async function warmCovers(): Promise<void> {
  const mine = ++coverRun
  const day = shown.value
  if (day === null) return

  const wanted = [
    ...new Set(day.rows.filter((row) => row.cover === null).map((row) => row.mediaId)),
  ]

  if (wanted.length === 0) return

  try {
    const added = await warmLooks(wanted)
    if (mine !== coverRun || added === 0) return

    stamp.value += 1
  } catch (e) {
    // Без обложки плитка останется с буквой названия — это не повод ругаться.
    Logger('WARN', 'Календарь: обложки добрать не вышло', e)
  }
}

/**
 * Выходы недели, попавшие в этот день.
 *
 * Вопрос источникам собирается по ним, а не по строкам показа: у выхода
 * с сервера есть оба названия, а у строки — только то, что победило
 * в старшинстве. Названий же источнику нужно столько, сколько их есть.
 */
function entriesOf(dayKey: number): AiringEntry[] {
  return entries.value.filter((entry) => dayStart(entry.airingAt * 1000) === dayKey)
}

/**
 * Вопрос источникам по одному выходу.
 *
 * По делу здесь нужен один номер MAL: метку ставит Kodik, а он входит только
 * по номеру Шикимори и названий не читает вовсе. Остальное заполняется
 * потому, что вопрос в приложении один на всех, и календарный не должен
 * выглядеть беднее вопросов полок: названия — по убыванию пригодности, как
 * в `app/tile-row`, год — тем, кто отсеивает по нему.
 *
 * `airing: true` — не догадка, а факт: тайтл стоит в расписании, значит показ
 * идёт. Отсюда и срок хранения отказа — у идущего он короче, потому что
 * источник ещё может его завести.
 */
function askOf(entry: AiringEntry, malId: number | null): PlayAsk {
  const look = peekLook(entry.mediaId)
  const names = [peekRussianName(entry.mediaId), entry.romaji, entry.english, look?.romaji]

  return {
    mediaId: entry.mediaId,
    malId,
    titles: [
      ...new Set(names.filter((name): name is string => typeof name === 'string' && name !== '')),
    ],
    year: look?.seasonYear ?? undefined,
    airing: true,
  }
}

/**
 * Метки доступности для выходов показанного дня.
 *
 * Склад спрашивается первым и по всем номерам разом: он отвечает даром и без
 * сети, а показанное в прошлые заходы покажется сразу. Номера MAL нужны службе
 * Kodik — без них вопрос некому задать, и знака не будет ни у кого (см. шапку
 * файла). Идут они лестницей `fetchMalIds`, где сеть — последняя ступень,
 * и запрос этот общий с добором имён.
 */
async function warmPlay(): Promise<void> {
  const mine = ++playRun
  const day = shown.value
  if (day === null) return

  const wanted = entriesOf(day.key).filter((entry) => peekPlayable(entry.mediaId) === null)
  if (wanted.length === 0) return

  try {
    const primed = await primePlayable(wanted.map((entry) => entry.mediaId))
    if (mine !== playRun) return
    if (primed > 0) stamp.value += 1

    const left = wanted.filter((entry) => peekPlayable(entry.mediaId) === null)
    if (left.length === 0) return

    const malIds = await fetchMalIds(left.map((entry) => entry.mediaId))
    if (mine !== playRun) return

    requestPlayable(left.map((entry) => askOf(entry, malIds.get(entry.mediaId) ?? null)))
  } catch (e) {
    // Без метки плитка останется без знака — так и задумано, а не с ложным.
    Logger('WARN', 'Календарь: метки доступности не доехали', e)
  }
}

/**
 * Подписка на ответы о доступности.
 *
 * Живёт вместе с модулем, а не с экраном: неделя переживает уход с Главной,
 * и метка, приехавшая после ухода, обязана быть на месте при возврате.
 * Отписываться некому и незачем — модуль живёт столько же, сколько окно,
 * и подписчик у него один.
 *
 * Зовут подписчика любые метки в приложении, а не только календарные:
 * различить их снаружи нечем. Поэтому перерисовка заказывается лишь тогда,
 * когда неделя и вправду собрана, — иначе каждый ответ поиска или списков
 * гонял бы пересборку пустого календаря.
 */
onPlayableChange(() => {
  if (startKey.value === 0 || entries.value.length === 0) return

  stamp.value += 1
})

/**
 * Номера для запроса расписания: свои из списка или верхушка популярности.
 * Верхушка берётся один раз на сеанс.
 */
async function idsFor(mediaIds: number[]): Promise<number[]> {
  if (scope.value === 'mine') return mediaIds

  if (popularIds.length === 0) popularIds = await fetchPopularOngoing(POPULAR_LIMIT)
  return popularIds
}

/**
 * Собирает неделю. Полоса рисуется сразу, до сети: дни — это календарь,
 * а не данные, и ждать их неоткуда.
 *
 * Границы окна строгие у самого AniList, поэтому расширены на секунду внутрь:
 * серия ровно в полночь начала недели иначе осталась бы за бортом.
 */
async function fetchWeek(mediaIds: number[]): Promise<void> {
  const mine = ++run
  failed.value = false
  busy.value = true

  try {
    const ids = await idsFor(mediaIds)
    if (mine !== run) return

    if (ids.length === 0) {
      entries.value = []
      hidden.value = 0
      hiddenDays.value = new Set()
      return
    }

    const from = Math.floor(startKey.value / 1000) - 1
    const to = Math.floor(addDays(startKey.value, WEEK_DAYS) / 1000) + 1
    const found = await fetchAiringSchedules(ids, from, to)
    if (mine !== run) return

    // Отбор взрослого стоит здесь, до доборов: спрятанный выход не тянет
    // за собой ни имени, ни обложки, ни вопроса о доступности.
    hidden.value = hiddenCount(found, (entry) => entry.isAdult)

    const hushed = new Set<number>()
    for (const entry of found) {
      if (!adultAllowed(entry.isAdult)) hushed.add(dayStart(entry.airingAt * 1000))
    }
    hiddenDays.value = hushed

    entries.value = keepAllowed(found, (entry) => entry.isAdult) as AiringEntry[]

    void warmNames()
    void warmCovers()
    void warmPlay()
  } catch (e) {
    if (mine !== run) return

    Logger('WARN', 'Календарь: расписание не пришло', e)
    entries.value = []
    hidden.value = 0
    hiddenDays.value = new Set()
    failed.value = true
  } finally {
    if (mine === run) busy.value = false
  }
}

/** Первая сборка недели: неделя ставится по текущему мгновению, выбор сбрасывается. */
async function load(mediaIds: number[]): Promise<void> {
  startKey.value = weekStart(Date.now())
  todayKey.value = dayStart(Date.now())
  picked.value = 0

  await fetchWeek(mediaIds)
}

/** Смена области показа: неделя та же, выбор дня тот же, меняется только наполнение.
 *
 *  Повторное нажатие на текущую область ничего не делает — но только если
 *  показ не пуст. Пустой означает и «в этот раз ничего не вышло», и «запрос
 *  не дошёл»; различить их отсюда нечем, а второй случай человек лечит именно
 *  повторным нажатием, потому что другой кнопки у календаря нет. */
async function setScope(next: CalendarScope, mediaIds: number[]): Promise<void> {
  if (scope.value === next && entries.value.length > 0) return

  // Прежний показ уходит сразу. Иначе до ответа на экране висели бы строки
  // прошлой области под новой подписью, и все шесть секунд ожидания это
  // выглядело бы как «переключатель не сработал».
  entries.value = []
  hidden.value = 0
  hiddenDays.value = new Set()
  scope.value = next

  await fetchWeek(mediaIds)
}

/** Выбор дня: полке тут же нужны имена, обложки и метки того, что в нём выходит. */
function pick(key: number): void {
  picked.value = key
  void warmNames()
  void warmCovers()
  void warmPlay()
}

/** Состояние одно на приложение: экран Главной один, а знание о неделе
    переживает уход на другой экран и возврат. */
export function useHomeCalendar(): HomeCalendar {
  return {
    busy,
    failed,
    days,
    picked,
    shown,
    span,
    scope,
    hidden,
    hiddenDays,
    pick,
    setScope,
    load,
  }
}
