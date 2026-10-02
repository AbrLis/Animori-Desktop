import { beforeEach, describe, expect, it } from 'vitest'

import type { MediaBrief } from '@/api/anilist-media'

import { installMockBridge, resetMockBridge } from './mocks/bridge-module'

const GRAPHQL_URL = 'https://graphql.anilist.co'

/** Узел GraphQL, каким его отдаёт сервер. */
function brief(id: number, malId = id) {
  return {
    id,
    idMal: malId,
    type: 'ANIME',
    format: 'TV',
    status: 'FINISHED',
    episodes: 12,
    seasonYear: 2020,
    averageScore: 70,
    isAdult: false,
    nextAiringEpisode: null,
    title: { romaji: `Title ${id}`, english: `Title ${id}`, native: `原題 ${id}` },
    coverImage: { large: null, medium: null, color: '#123' },
  }
}

/** Выписка после разбора — форма, которую ждёт ядро. Узел GraphQL сюда не годится:
 * `fetchStudioWorks` сверяет известные тайтлы по `mediaId` и `malId` и по остальным полям
 * тоже, а лишние и недостающие просто молча разъезжаются. */
function briefOf(id: number, malId: number | null = id): MediaBrief {
  return {
    mediaId: id,
    malId,
    type: 'ANIME',
    format: 'TV',
    status: 'FINISHED',
    episodes: 12,
    chapters: null,
    duration: 24,
    seasonYear: 2020,
    averageScore: 70,
    isAdult: false,
    romaji: `Title ${id}`,
    english: `Title ${id}`,
    native: `原題 ${id}`,
    cover: null,
    color: '#123',
    airingEpisode: null,
    airingAt: null,
    ownEntry: null,
  }
}

function response(page: number, ids: number[], hasNext: boolean, total: number) {
  return {
    status: 200,
    statusText: 'OK',
    ok: true,
    headers: {},
    text: JSON.stringify({
      data: {
        Studio: {
          id: 7,
          name: 'Studio',
          media: {
            pageInfo: { currentPage: page, hasNextPage: hasNext, total },
            nodes: ids.map(brief),
          },
        },
      },
    }),
    url: GRAPHQL_URL,
  }
}

describe('studio works', () => {
  beforeEach(() => {
    resetMockBridge()
  })

  it('дедуплицирует повторный тайтл внутри одной страницы', async () => {
    const mock = installMockBridge()
    mock.bridge.anilist.query = async () => response(1, [1, 1, 2], true, 3)

    const { fetchStudioWorks } = await import('@/api/anilist-media')
    const page = await fetchStudioWorks(7, 1)
    expect(page?.items.map((item) => item.mediaId)).toEqual([1, 2])
    expect(page?.known).toBe(2)
    expect(page?.hasNext).toBe(true)
  })

  it('добирает следующую страницу без повторов и останавливается по серверу', async () => {
    const mock = installMockBridge()
    mock.bridge.anilist.query = async (body: string) => {
      const variables = (JSON.parse(body) as { variables?: { page?: number } }).variables
      const page = variables?.page ?? 1
      return page === 1 ? response(1, [1], false, 3) : response(2, [2, 3], false, 3)
    }

    const { fetchStudioWorks } = await import('@/api/anilist-media')
    const first = await fetchStudioWorks(7, 1)
    expect(first?.hasNext).toBe(false)

    const second = await fetchStudioWorks(7, 2, first?.items ?? [])
    expect(second?.items.map((item) => item.mediaId)).toEqual([2, 3])
    expect(second?.known).toBe(3)
    expect(second?.hasNext).toBe(false)
  })

  it('останавливается, если страница состоит из уже известных тайтлов', async () => {
    const mock = installMockBridge()
    mock.bridge.anilist.query = async () => response(2, [1], true, 500)

    const { fetchStudioWorks } = await import('@/api/anilist-media')
    const page = await fetchStudioWorks(7, 2, [briefOf(1)])
    expect(page?.hasNext).toBe(false)
    expect(page?.known).toBe(1)
  })
})
