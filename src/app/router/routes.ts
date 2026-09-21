// Пункт 3.2: список экранов и их подписи — один источник правды.
// Новый экран = три места: имя здесь, подпись в SCREEN_TITLES
// и сам компонент в App.vue. Меню — четвёртое и необязательное место.

export const SCREEN_NAMES = [
  'home',
  'lists',
  'history',
  'search',
  'media',
  'studio',
  'player',
  'settings',
  'log',
] as const

export type ScreenName = (typeof SCREEN_NAMES)[number]

export type Route = {
  name: ScreenName
  params: Record<string, string>
}

export const DEFAULT_ROUTE: Route = { name: 'home', params: {} }

export type MenuItem = {
  name: ScreenName
  title: string
  icon: string
}

// Карточки тайтла в меню нет: на неё попадают из списков и поиска.
// Студии в меню нет: на неё ведут чипы карточки.
// Плеера в меню нет: без тайтла смотреть нечего, вход только из карточки.
// Журнала нет ни в меню, ни в настройках: он нужен при разборе поломки,
// а не каждый день. Открывается адресом окна: #/log.
//
// История стоит рядом со списками, а не вместо них: список отвечает за то,
// что человек собирается смотреть, история — за то, что уже смотрел.
//
// Подписи и имена экранов живут раздельно: имя 'lists' стоит в адресе
// окна и в памяти отбора, поэтому подпись меняется, а имя остаётся.
export const MENU: ReadonlyArray<MenuItem> = [
  { name: 'home', title: 'Главная', icon: '⌂' },
  { name: 'lists', title: 'Моё', icon: '≡' },
  { name: 'history', title: 'История', icon: '◷' },
  { name: 'search', title: 'Поиск', icon: '⌕' },
  { name: 'settings', title: 'Настройки', icon: '⚙' },
]

/**
 * Глубина экрана: насколько он далёк от вкладок.
 *
 * По ней смена экрана получает направление — см. navDirection в router/index.ts.
 * Вкладки стоят вровень: переход с главной в поиск не уходит ни внутрь, ни
 * наружу, это другой раздел того же уровня. Карточка глубже вкладок, студия
 * и плеер глубже карточки: вход в них — шаг внутрь, выход — шаг наружу.
 *
 * Журнал глубже вкладок, хоть в меню его и нет: он открывается из настроек
 * и стоит в том же списке экранов с кнопкой «Назад», что карточка со студией.
 * Человек заходит в него за справкой и выходит обратно — это шаг внутрь,
 * а не смена раздела.
 */
export const SCREEN_DEPTH: Record<ScreenName, number> = {
  home: 0,
  lists: 0,
  history: 0,
  search: 0,
  settings: 0,
  log: 1,
  media: 1,
  studio: 2,
  player: 2,
}

export const SCREEN_TITLES: Record<ScreenName, string> = {
  home: 'Главная',
  lists: 'Моё',
  history: 'История',
  search: 'Поиск',
  media: 'Аниме',
  studio: 'Студия',
  player: 'Просмотр',
  settings: 'Настройки',
  log: 'Журнал',
}
