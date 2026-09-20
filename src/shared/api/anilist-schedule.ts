// Расписание выхода серий: что и когда выйдет у своего списка.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ЗАПРОС, А НЕ ПОЛЕ ОБЛИКА
//
// Облик тайтла (`core/media-looks`) знает только ближайшую серию: у AniList
// поле `nextAiringEpisode` одно на тайтл. Полке этого хватало, календарю нет —
// календарю нужна вся неделя, и по тайтлу, выходящему дважды, тоже.
//
// Запрос идёт через `airingSchedules`: это готовый отбор по времени и списку
// номеров, один заход на всю неделю вместо обхода тайтлов по одному.
//
// ТРИ ЛОВУШКИ ЭТОГО ПОЛЯ, ПРОВЕРЕННЫЕ ЖИВЬЁМ
//
//   * `airingSchedules` — обычный список, а не соединение. `nodes` внутри
//     него не принимается вовсе, хотя у большинства полей AniList наоборот.
//   * границы `airingAt_greater` и `airingAt_lesser` строгие. Серия ровно
//     в полночь начала недели под первое условие не подойдёт, и её не будет
//     видно — поэтому окно расширяется на секунду внутрь с обеих сторон.
//   * сортировка у выходов только по времени. Ни популярности, ни оценки
//     среди значений `AiringSort` нет (ID, TIME, MEDIA_ID, EPISODE и их
//     обратные), а `pageInfo.total` упирается в потолок 5000 и на неделе,
//     и на одних сутках. Значит «всё, что выходит в мире» не выгружается
//     в принципе: первых двести строк по времени — это сплошной понедельник.
//     Отсюда `fetchPopularOngoing`: глобальный показ строится не на окне,
//     а на верхушке идущих по популярности.
//
// ПОЧЕМУ ТЕПЕРЬ ЗАПРАШИВАЕТСЯ НАЗВАНИЕ
//
// Прежде `media` в ответе не было: имя и обложку приложение держит у себя
// (`core/media-looks`, `core/media-title`), и второй источник правды разошёлся
// бы с первым. Для глобального показа это перестало работать: своих названий
// у чужих тайтлов нет вовсе, взять их неоткуда, кроме как у сервера. Поэтому
// название запрашивается всегда, но русское имя по-прежнему главнее: локальное
// знание — первое, серверное — запасное.
import { Logger } from '../utils/logger'

import { anilistQuery } from './anilist'

/** Потолок страницы у AniList. */
const PAGE_SIZE = 50

/**
 * Сколько страниц терпим. Неделя своего списка в две страницы не влезает
 * почти никогда, а четвёртая — уже защита от бесконечного круга на чужой
 * ошибке в `pageInfo`, а не рабочий случай.
 */
const PAGE_LIMIT = 4

/**
 * Предохранитель от чужой ошибки в `pageInfo`, а не рабочий случай.
 * Сколько тайтлов брать, решает вызывающий: это вопрос показа, а не сети.
 */
const POPULAR_PAGE_LIMIT = 4

const SCHEDULE_QUERY = `query Week($from: Int, $to: Int, $ids: [Int], $page: Int) {
  Page(page: $page, perPage: ${PAGE_SIZE}) {
    pageInfo {
      hasNextPage
    }
    airingSchedules(
      airingAt_greater: $from
      airingAt_lesser: $to
      mediaId_in: $ids
      sort: TIME
    ) {
      airingAt
      episode
      mediaId
      media {
        isAdult
        title {
          romaji
          english
        }
      }
    }
  }
}`

const ONGOING_QUERY = `query Ongoing($page: Int) {
  Page(page: $page, perPage: ${PAGE_SIZE}) {
    pageInfo {
      hasNextPage
    }
    media(status: RELEASING, sort: POPULARITY_DESC, type: ANIME) {
      id
    }
  }
}`

/** Один выход: серия одного тайтла в назначенный срок. */
export interface AiringEntry {
  mediaId: number
  episode: number
  /**
   * Срок выхода в секундах. Именно в секундах его держит и облик тайтла:
   * так его отдаёт AniList, и переводить его в миллисекунды здесь значило бы
   * завести вторую меру длины времени в одном и том же поле.
   */
  airingAt: number
  /** Название сервера: запасное к русскому имени, а для чужого тайтла — единственное. */
  romaji: string | null
  english: string | null
  /**
   * Метка 18+ с записи каталога. Нужна отбору показа: календарь спрашивает
   * расписание по номерам, а не по облику, и взрослое иначе прошло бы мимо
   * тумблера — облика у чужого тайтла нет вовсе, и спросить его неоткуда.
   */
  isAdult: boolean
}

interface ScheduleAnswer {
  Page?: {
    pageInfo?: { hasNextPage?: boolean | null } | null
    airingSchedules?: Array<{
      airingAt?: number | null
      episode?: number | null
      mediaId?: number | null
      media?: {
        isAdult?: boolean | null
        title?: { romaji?: string | null; english?: string | null } | null
      } | null
    }> | null
  } | null
}

interface OngoingAnswer {
  Page?: {
    pageInfo?: { hasNextPage?: boolean | null } | null
    media?: Array<{ id?: number | null }> | null
  } | null
}

/** Строка, если она непустая: пустая строка названием не считается. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Расписание выхода для перечисленных тайтлов за окно `from`…`to`.
 * Границы — в секундах, как их отдаёт AniList.
 *
 * Номер серии нулём быть не может, а вот срок нулём приходит у служебных
 * записей: такие пропускаем, ставить их некуда.
 */
export async function fetchAiringSchedules(
  mediaIds: number[],
  from: number,
  to: number,
): Promise<AiringEntry[]> {
  if (mediaIds.length === 0 || to <= from) return []

  const out: AiringEntry[] = []
  const seen = new Set<string>()

  for (let page = 1; page <= PAGE_LIMIT; page += 1) {
    const answer = await anilistQuery<ScheduleAnswer>(SCHEDULE_QUERY, {
      from,
      to,
      ids: mediaIds,
      page,
    })

    const box = answer.data?.Page
    const rows = box?.airingSchedules ?? []

    for (const row of rows) {
      const mediaId = typeof row.mediaId === 'number' ? row.mediaId : 0
      const airingAt = typeof row.airingAt === 'number' ? row.airingAt : 0
      if (mediaId <= 0 || airingAt <= 0) continue

      // Повтор возможен, если между страницами расписание успело измениться.
      // Ключ по тайтлу и сроку, а не по номеру серии: нумерация у повторов
      // и спецвыпусков бывает и нулевой, и одинаковой у двух записей.
      const key = `${mediaId}|${airingAt}`
      if (seen.has(key)) continue
      seen.add(key)

      const title = row.media?.title

      out.push({
        mediaId,
        episode: typeof row.episode === 'number' ? row.episode : 0,
        airingAt,
        romaji: text(title?.romaji),
        english: text(title?.english),
        // Неизвестный признак считается безопасным: из двух ошибок хуже
        // спрятать половину календаря из-за пустого поля.
        isAdult: row.media?.isAdult === true,
      })
    }

    if (box?.pageInfo?.hasNextPage !== true) break
    if (page === PAGE_LIMIT) {
      Logger('WARN', `Расписание: страниц больше ${PAGE_LIMIT}, остальное не взято`)
    }
  }

  return out
}

/**
 * Номера идущих тайтлов, начиная с самых популярных.
 *
 * Нужны глобальному показу календаря. Взять всю неделю целиком нельзя:
 * сортировка у выходов только по времени, а `pageInfo.total` упирается
 * в потолок 5000 и на неделе, и на одних сутках, — то есть первые страницы
 * окна были бы сплошным понедельником, а до субботы очередь не дошла бы
 * никогда. Верхушка популярности, наоборот, ложится на все семь дней сразу.
 *
 * Порядок ответа не трогается: популярность убывает, и первый тайтл списка
 * действительно самый популярный из идущих.
 */
export async function fetchPopularOngoing(limit: number): Promise<number[]> {
  if (limit <= 0) return []

  const pages = Math.min(Math.ceil(limit / PAGE_SIZE), POPULAR_PAGE_LIMIT)
  const out: number[] = []
  const seen = new Set<number>()

  for (let page = 1; page <= pages; page += 1) {
    const answer = await anilistQuery<OngoingAnswer>(ONGOING_QUERY, { page })
    const box = answer.data?.Page
    const rows = box?.media ?? []

    for (const row of rows) {
      const id = typeof row.id === 'number' ? row.id : 0
      if (id <= 0 || seen.has(id)) continue

      seen.add(id)
      out.push(id)
      if (out.length >= limit) return out
    }

    if (box?.pageInfo?.hasNextPage !== true) break
  }

  return out
}
