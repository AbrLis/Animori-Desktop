// Память главной между показами экрана: переход на карточку сносит экран целиком.
// Это состояние сеанса: ни в снимок, ни в базу не пишется и гибнет вместе с окном.

import { ref } from 'vue'

import { emptyPick, type CatalogPick } from '@/api/anilist-catalog'
import type { MediaBrief } from '@/api/anilist-media'
import type { FeedRun } from '@/core/recs'

export const homePick = ref<CatalogPick>(emptyPick())

export interface FeedKeep {
  key: string
  run: FeedRun | null
  items: MediaBrief[]
}

/** Вне реактивности: ref на сотни описаний вешает наблюдателя на каждое поле. */
export const feedKeep: FeedKeep = { key: '', run: null, items: [] }

/** Забыть набранное: смена отбора начинает ленту заново. */
export function dropFeed(): void {
  feedKeep.key = ''
  feedKeep.run = null
  feedKeep.items = []
}
