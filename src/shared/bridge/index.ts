// Единственная точка входа к мосту: вне src/shared/bridge импортируют только '@/bridge'. Реализацию
// выбирает сборка (alias '@bridge-impl'), а не рантайм. Псевдопуть прописан в трёх файлах.

export {
  BridgeHttpError,
  type HttpBytesResponse,
  type HttpErrorKind,
  type HttpMethod,
  type HttpRequestOptions,
  type HttpResponse,
  type IAniList,
  type IBridge,
  type IClipboard,
  type IHttp,
  type IProxyDiagnostics,
  type IShell,
  type IStorage,
  type ProxyOutcome,
  type ProxyProbe,
  type ProxyStatus,
} from './IBridge'

/**
 * Мост к платформе: хранилище, файлы, выгрузка, сеть, AniList, буфер, окно, диагностика прокси.
 * Реализацию подставляет сборка; ветвиться по Bridge.platform негде — значение одно.
 */
export { platformBridge as Bridge } from '@bridge-impl'
