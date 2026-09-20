// Обёртка над hls.js: открыть манифест, сесть на нужную секунду, пережить
// срыв сети и убрать за собой. Больше никто в приложении про hls.js не знает.
//
// Почему библиотека, а не тег <video> напрямую: WebView2 на Windows не умеет
// HLS вовсе, а все наши источники отдают именно его. Где HLS родной
// (Safari, WebKitGTK), библиотека не нужна и только мешала бы.
//
// Смена качества у нас — это другой манифест, а не другая дорожка внутри
// одного: Kodik отдаёт каждое качество своим адресом без общего списка.
// Поэтому open() всегда принимает секунду, с которой продолжать.
//
// ОТКАЗ РАЗЛИЧАЕТСЯ ПО ПРИЧИНЕ, А НЕ ПО ТЕКСТУ
// Прежде наружу уходила одна строка на все случаи, и она же звала человека
// нажать кнопку: «ссылка могла устареть — переспросите её». Причин две, и
// лечатся они по-разному. Кончилась подпись адреса — площадка отвечает 403,
// и это норма нашей добычи: лечится новым адресом, а не словами. Оборвалась
// сеть — тут человеку и правда есть что проверить. Поэтому наверх уходит вид
// отказа, а решение «молчать и переспросить» принимает экран.
import Hls from 'hls.js'

import { Logger } from '@/utils/logger'

/**
 * Почему поток дальше не пойдёт.
 *
 *   'link' — адрес больше не отдают: срок подписи вышел. Лечится новой
 *            ссылкой, и человеку об этом знать незачем.
 *   'net'  — оборвалась связь, площадка молчит или движок не умеет HLS.
 *            Новый адрес тут ничего не изменит.
 */
export type DeadKind = 'link' | 'net'

/** Что экран умеет с воспроизведением. */
export interface Playback {
  /**
   * Открывает манифест и садится на startAt секунд.
   *
   * `andPlay` = false нужен молчаливой замене адреса на паузе: человек
   * остановил кадр сам, и продолжать за него нельзя.
   */
  open: (url: string, startAt: number, andPlay?: boolean) => void
  /** Гасит воспроизведение и освобождает память под буферы. */
  close: () => void
}

/** Обратные вызовы экрана. */
export interface PlaybackHooks {
  /**
   * Непоправимая ошибка: ссылка мертва или поток не читается. Текст — на
   * случай, если экран решит сказать о ней человеку; вид отказа — чтобы
   * он мог сначала попробовать вылечить всё сам.
   */
  onFatal: (text: string, kind: DeadKind) => void
}

/**
 * Числа с рабочего плеера Kodik. Заводские вдвое скромнее, и на тонком
 * канале фрагменты не успевают приехать до своей секунды.
 */
const TUNE = {
  maxBufferSize: 7e7,
  maxBufferLength: 30,
  maxMaxBufferLength: 60,
  liveSyncDuration: 30,
  fragLoadingTimeOut: 30000,
  manifestLoadingTimeOut: 20000,
  enableWorker: true,
  lowLatencyMode: false,
}

/** Сколько раз поднимать загрузку после срыва сети, прежде чем сдаться. */
const NET_TRIES = 2

/**
 * Чем площадка отвечает на мёртвую подпись. 403 — обычный её ответ, 401 и 410
 * встречались на пробах. Текст ответа разбирать незачем: код однозначен,
 * а слова у каждой площадки свои.
 */
const GONE = [401, 403, 410]

/** Коды тега <video>: сетевой отказ и непонятный источник. */
const ERR_NET = 2
const ERR_SRC = 4

/** Родной HLS есть только у WebKit; проверка дешёвая и честная. */
function nativeHls(video: HTMLVideoElement): boolean {
  return video.canPlayType('application/vnd.apple.mpegurl') !== ''
}

/**
 * Код ответа площадки из отказа библиотеки. Поле необязательное и в описаниях
 * плавает от версии к версии, поэтому спрашиваем его по факту, а не по типу.
 */
function codeOf(data: unknown): number {
  const box = data as { response?: { code?: unknown } }
  const code = box.response?.code

  return typeof code === 'number' ? code : 0
}

/**
 * Привязывает воспроизведение к тегу. Один тег — одна обёртка на всю жизнь
 * экрана: пересоздание hls.js на каждую серию оставляло бы висеть чужие
 * буферы: по семьдесят мегабайт на каждую.
 */
export function attachPlayback(video: HTMLVideoElement, hooks: PlaybackHooks): Playback {
  let hls: Hls | null = null
  let tries = 0
  let want = 0

  /** Пускать ли кадр после разбора манифеста. Слово за open(). */
  let go = true

  /** Посадка на нужную секунду: раньше готовности перемотка молча теряется. */
  function seat(): void {
    if (want <= 0) return
    video.currentTime = want
    want = 0
  }

  function play(): void {
    // Замена адреса на паузе кадр не пускает: пауза — слово человека.
    if (!go) return

    void video.play().catch((e: unknown) => {
      // Автозапуск мог быть запрещён — это не отказ, кнопка на месте.
      Logger('WARN', 'Плеер: автозапуск не случился', e)
    })
  }

  function drop(): void {
    hls?.destroy()
    hls = null
  }

  /** Отказ родного пути: у тега свои коды, и они грубее библиотечных. */
  const onNativeError: EventListener = () => {
    const code = video.error?.code ?? 0

    // Мёртвая подпись у родного пути выглядит сетевым отказом или испорченным
    // источником: и то и другое лечится новым адресом, а не жалобой.
    if (code === ERR_NET || code === ERR_SRC) {
      Logger('WARN', `Плеер: тег не принял поток (код ${code}), похоже на мёртвую ссылку`)
      hooks.onFatal('Ссылка на поток больше не действует.', 'link')
      return
    }

    Logger('ERROR', `Плеер: тег остановил воспроизведение (код ${code})`)
    hooks.onFatal('Поток оборвался. Проверьте сеть и нажмите «Переспросить».', 'net')
  }

  /** Разбор отказа: сеть и звук лечатся на месте, остальное — наверх. */
  function onError(details: string, kind: string, code: number): void {
    if (hls === null) return

    // Срок подписи вышел. Повторять загрузку бессмысленно: тот же адрес
    // площадка не отдаст ни с какой попытки.
    if (GONE.includes(code)) {
      Logger('WARN', `Плеер: площадка не отдаёт поток (${details}, код ${code})`)
      drop()
      hooks.onFatal('Ссылка на поток больше не действует.', 'link')
      return
    }

    if (kind === Hls.ErrorTypes.NETWORK_ERROR && tries < NET_TRIES) {
      tries += 1
      Logger('WARN', `Плеер: срыв сети (${details}), попытка ${tries}`)
      hls.startLoad()
      return
    }

    if (kind === Hls.ErrorTypes.MEDIA_ERROR) {
      Logger('WARN', `Плеер: сбой потока (${details}), восстанавливаю`)
      hls.recoverMediaError()
      return
    }

    Logger('ERROR', `Плеер: воспроизведение остановлено (${details})`)
    drop()

    // Сеть своё уже отработала выше, так что здесь она и есть сеть. Всё
    // прочее пробуем вылечить новым адресом: у нашей добычи это первая
    // и самая частая причина.
    if (kind === Hls.ErrorTypes.NETWORK_ERROR) {
      hooks.onFatal('Поток оборвался. Проверьте сеть и нажмите «Переспросить».', 'net')
      return
    }

    hooks.onFatal('Источник не даёт рабочую ссылку на эту серию.', 'link')
  }

  function open(url: string, startAt: number, andPlay = true): void {
    want = startAt
    tries = 0
    go = andPlay

    // Родной путь: браузер сам разберёт манифест, обёртка лишняя.
    if (!Hls.isSupported()) {
      if (!nativeHls(video)) {
        hooks.onFatal('Этот движок не умеет HLS: смотреть нечем.', 'net')
        return
      }

      // Слушатель один на все открытия: иначе на смене качества их копилось
      // бы по числу серий, и один отказ докладывался бы многократно.
      video.removeEventListener('error', onNativeError)
      video.addEventListener('error', onNativeError)

      video.src = url
      video.addEventListener('loadedmetadata', seat, { once: true })
      play()
      return
    }

    drop()

    const next = new Hls(TUNE)
    hls = next

    next.on(Hls.Events.MANIFEST_PARSED, () => {
      seat()
      play()
    })

    next.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return
      onError(String(data.details), String(data.type), codeOf(data))
    })

    next.loadSource(url)
    next.attachMedia(video)
  }

  function close(): void {
    drop()
    video.removeEventListener('error', onNativeError)
    video.removeAttribute('src')
    video.load()
  }

  return { open, close }
}
