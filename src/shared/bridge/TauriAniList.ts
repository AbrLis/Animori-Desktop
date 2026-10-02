// Реализация IAniList для десктопа. Инвариант: файл импортирует только TauriBridge,
// который отсекается псевдопутём '@bridge-impl'.

import { invoke } from '@tauri-apps/api/core'

import { BridgeHttpError, type HttpResponse, type IAniList } from './IBridge'

/** Повторяет GRAPHQL_URL из anilist.rs: ответ адреса не несёт, а контракт требует. */
const GRAPHQL_URL = 'https://graphql.anilist.co'

/** Ответ Rust: ни statusText, ни адреса — второе постоянно, первое в HTTP/2 не передаётся. */
type RawReply = {
  status: number
  headers: Record<string, string>
  text: string
}

// Вид сбоя по префиксу текста: через invoke приходит только строка, префиксы —
// единственный способ различить таймаут и сеть. Парное место — classify() в anilist.rs.
function toBridgeError(error: unknown): Error {
  const text = typeof error === 'string' ? error : String(error)

  if (text.startsWith('timeout:')) {
    return new BridgeHttpError('timeout', GRAPHQL_URL, text)
  }

  if (text.startsWith('network:')) {
    return new BridgeHttpError('network', GRAPHQL_URL, text)
  }

  // Не транспорт (например, вход не выполнен) — повторять нечего.
  return new Error(text)
}

export const tauriAniList: IAniList = {
  // Запрос собирает оболочка: сюда идёт только тело и флаг подписи. Куки окна
  // не участвуют — запрос идёт из Rust своим клиентом.
  async query(body: string, useAuth: boolean): Promise<HttpResponse> {
    let raw: RawReply

    try {
      raw = await invoke<RawReply>('animori_anilist_query', { body, useAuth })
    } catch (e) {
      throw toBridgeError(e)
    }

    return {
      status: raw.status,
      statusText: '',
      ok: raw.status >= 200 && raw.status < 300,
      headers: raw.headers,
      text: raw.text,
      url: GRAPHQL_URL,
    }
  },
}
