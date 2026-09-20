<script setup lang="ts">
// Прокси: настройка соединения — одна на всю программу, а каналов у неё два.
// Трафик самого окна идёт через ключи запуска WebView2, и их читает
// src-tauri/src/proxy.rs; запросы программы уходят из Rust и из моста.
// Отсюда и поведение: запросы смену адреса подхватывают сразу, а окно —
// только с новым процессом, поэтому перезапуск здесь не роскошь, а условие.
//
// Своим узлом, а не частью экрана настроек: у панели своё состояние (поля,
// снимок запуска, исход проверки) и свой разговор с оболочкой. Экран настроек
// и без неё самый большой файл в приложении.
//
// ПОЧЕМУ НЕ В ТОМ ЖЕ ВИДЕ, ЧТО У СТАРОЙ КАРТОЧКИ
// Карточка в юзерскрипте сохраняла каждое поле и сразу объявляла «нужен
// перезапуск» — даже когда правка ничего не меняла. Здесь о перезапуске
// говорит сравнение записанного адреса с тем, с которым работает движок:
// кнопка появляется тогда, когда она вправду что-то изменит.
//
// Заодно ушёл и сам автоматический перезапуск по включению тумблера: настройка
// пишется по полю, и включают тумблер обычно до того, как набран адрес, —
// приложение поднималось бы с негодной настройкой и просило перезапуск снова.
//
// ПОРЯДОК ПОЛЕЙ
// Сверху то, без чего настройка не работает вовсе: тумблер, вид, адрес, порт.
// Ниже — то, что нужно редко: логин с паролем и исключения. Предупреждения
// стоят под полями, которых касаются, и показываются только когда есть о чём
// предупредить: открытый пароль, негодный адрес, SOCKS5 с логином.
//
// Оформление берётся из settings-screen.css — там же, где остальные настройки.
import { computed, onMounted, ref } from 'vue'

import { proxyLiveCheck } from '@/api/proxy-check'
import { Bridge, type ProxyStatus } from '@/bridge'
import {
  DEFAULT_PROXY,
  isProxyUsable,
  normalizeProxyKind,
  normalizeProxyPort,
  type ProxyConfig,
  type ProxyKind,
} from '@/core/proxy'
import { proxyRestartNeeded, readProxyConfig, saveProxyField } from '@/core/proxy-settings'

import PickBox from './PickBox.vue'

/**
 * Виды прокси. Список один на панель: из него же строится выбор, и порядок
 * строк задан здесь, а не разметкой.
 *
 * Своим списком, а не системным `<select>`: у того список рисует оболочка
 * окна, а не наши стили, и на тёмной теме он выпадал белым со светлым текстом.
 * Взят готовый — тот же `PickBox`, что стоит в «Моём» на порядке показа.
 *
 * Переключателем из двух кнопок вид не сделать, как ни просится: значений
 * и вправду два, но строке не хватает ширины. Замерено на стенде — на самом
 * узком окне, какое допускает приложение (1024px), строке достаётся 405px,
 * а переключатель занимает 142 и требует 440: порт уезжает на вторую строку.
 * Свой список стоит 99px против 94 у системного, и строка остаётся той же,
 * под какую выверена: те же 397px против тех же 405.
 */
const KINDS: ReadonlyArray<{ key: ProxyKind; title: string }> = [
  { key: 'http', title: 'HTTP' },
  { key: 'socks5', title: 'SOCKS5' },
]

/** Значения на случай отсутствия ключа. До первого чтения поля не пустуют. */
const enabled = ref(DEFAULT_PROXY.enabled)
const kind = ref(DEFAULT_PROXY.kind)
const host = ref(DEFAULT_PROXY.host)
const login = ref(DEFAULT_PROXY.login)
const password = ref(DEFAULT_PROXY.password)
const bypass = ref(DEFAULT_PROXY.bypass)

/**
 * Порт отдельной строкой, а не числом: человек вправе стереть поле целиком
 * и набрать заново, а normalizeProxyPort превратил бы пустоту в ноль прямо
 * под курсором. В настройки уходит уже разобранное число.
 */
const portDraft = ref(String(DEFAULT_PROXY.port))

/**
 * Снимок запуска. Из него берётся и строка состояния, и ответ на вопрос,
 * нужен ли перезапуск: адрес движок читает один раз, при создании окна.
 */
const status = ref<ProxyStatus | null>(null)

const error = ref('')

const checking = ref(false)
const checkText = ref('')
const checkOk = ref(false)

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Что записано сейчас, в том виде, в каком это понимает остальной код. */
function currentConfig(): ProxyConfig {
  return {
    enabled: enabled.value,
    kind: kind.value,
    host: host.value.trim(),
    port: normalizeProxyPort(portDraft.value),
    login: login.value.trim(),
    password: password.value,
    bypass: bypass.value,
  }
}

/** Включённый тумблер с пустым или негодным адресом: трафик пойдёт напрямую. */
const badConfig = computed(() => enabled.value && !isProxyUsable(currentConfig()))

/** Кнопка перезапуска показывается только тогда, когда он что-то изменит. */
const needsRestart = computed(
  () => status.value !== null && proxyRestartNeeded(status.value, currentConfig()),
)

/**
 * Пароль лежит в файле настроек открытым текстом, и сказать об этом надо
 * до ввода, а не после. Условие «поле не пустое»: предупреждение про пароль
 * на пустом поле — это шум, который читают один раз и больше не читают.
 */
const hasPassword = computed(() => password.value.length > 0)

/**
 * SOCKS5 с логином: движок окна учётные данные для этого вида не принимает.
 * Запросы программы — принимает, и это стоит сказать: иначе человек решит,
 * что не работает вся настройка.
 */
const socksWithAuth = computed(() => kind.value === 'socks5' && login.value.trim().length > 0)

/** Строка состояния теми же словами, что были у карточки в юзерскрипте. */
const statusText = computed(() => {
  const s = status.value
  if (s === null) return 'читаем…'

  if (s.outcome === 'off') return 'при запуске прокси был выключен — трафик идёт напрямую'
  if (s.outcome === 'invalid') {
    return 'при запуске прокси был включён, но адрес негоден — трафик идёт напрямую'
  }
  if (s.outcome === 'unreachable')
    return `при запуске ${s.server} не ответил — трафик идёт напрямую`
  if (s.outcome === 'windowUnsupported') {
    // Не «не ответил»: адрес как раз ответил, и врать про него нельзя. Беда
    // в платформе, и сказать надо ещё и о том, что тумблер не впустую:
    // запросы программы через прокси идут, а страница — нет.
    return (
      `${s.server} отвечает, но окно на этой платформе прокси не умеет: ` +
      'запросы программы идут через него, страница — напрямую'
    )
  }

  if (s.auth === 'rejected') {
    return `${s.server} применён, но логин или пароль он не принял — страница останется пустой`
  }
  if (s.auth === 'pending') return `${s.server} применён, авторизация запрошена и ответа пока нет`
  if (s.auth === 'accepted') return `применён ${s.server}, авторизация пройдена`

  return `при запуске применён ${s.server}${s.hasCredentials ? ' (с логином)' : ''}`
})

async function loadConfig(): Promise<void> {
  try {
    const config = await readProxyConfig()

    enabled.value = config.enabled
    kind.value = config.kind
    host.value = config.host
    // Ноль значит «значения нет»: показать вместо него ноль — соврать про адрес.
    portDraft.value = config.port === 0 ? '' : String(config.port)
    login.value = config.login
    password.value = config.password
    bypass.value = config.bypass
  } catch (e) {
    error.value = 'Настройки не прочитаны — поля показывают значения по умолчанию. ' + describe(e)
  }
}

/** Снимок запуска. Зовётся и по нажатию проверки: исход авторизации меняется по ходу. */
async function loadStatus(): Promise<void> {
  try {
    status.value = await Bridge.proxyDiagnostics.status()
  } catch (e) {
    // Без снимка строка состояния остаётся на «читаем…» навсегда, а кнопка
    // перезапуска не появится ни при каких правках. Молчать об этом нельзя:
    // человек решит, что настройка применилась.
    error.value = 'Состояние прокси неизвестно — перезапуск не предлагается. ' + describe(e)
  }
}

/**
 * Приведение адреса к тому виду, какой ждёт движок: схему выбирает поле вида,
 * и вставленный вместе с адресом «http://» дал бы «http://http://host:port».
 * Замыкающая косая черта отсекается по той же причине — порт приставляется
 * к адресу через двоеточие.
 */
function cleanHost(): void {
  host.value = host.value
    .trim()
    .replace(/^\w+:\/\//, '')
    .replace(/\/+$/, '')
}

function onEnabled(): void {
  void saveProxyField('enabled', enabled.value)
}

/**
 * Выбор вида. Сохранение прежнее — нормализация и запись поля.
 *
 * Значение приходит строкой, как у всякого своего списка, и нормализуется:
 * список закрытый, но нормализация здесь и стоит, чтобы чужое значение
 * не легло в файл настроек.
 *
 * Повторный выбор того же вида ничего не пишет: прежний `<select>` события
 * не давал, пока выбор не изменится, и лишняя запись в файл настроек на
 * ровном месте была бы новостью.
 */
function pickKind(next: string): void {
  const wanted = normalizeProxyKind(next)
  if (kind.value === wanted) return

  kind.value = wanted
  void saveProxyField('kind', kind.value)
}

function onHost(): void {
  cleanHost()
  void saveProxyField('host', host.value)
}

function onPort(): void {
  void saveProxyField('port', normalizeProxyPort(portDraft.value))
}

function onLogin(): void {
  login.value = login.value.trim()
  void saveProxyField('login', login.value)
}

/// Пароль не обрезается: пробел по краям в нём законен, а тихая правка
/// дала бы отказ авторизации без единого слова о причине.
function onPassword(): void {
  void saveProxyField('password', password.value)
}

function onBypass(): void {
  void saveProxyField('bypass', bypass.value)
}

function onRestart(): void {
  void Bridge.shell.restart()
}

/**
 * Проверка адреса в два шага, и оба нужны.
 *
 * Щуп открывает TCP-соединение с сохранённым адресом: он отвечает на вопрос
 * «этот адрес вообще кто-нибудь слушает». Настоящий запрос отвечает на другой
 * вопрос — «пускают ли через него наружу». Прокси, который принимает
 * соединение и не пускает дальше, щупом неотличим от рабочего.
 *
 * Расхождение ответов и есть самое ценное: «ответил, но не пустил» — это
 * логин, пароль или вид; «молчит, а запрос прошёл» — запрос ушёл мимо прокси.
 */
async function check(): Promise<void> {
  if (checking.value) return

  checking.value = true
  checkText.value = ''
  void loadStatus()

  try {
    const probe = await Bridge.proxyDiagnostics.probe()

    if (probe.outcome === 'off') {
      checkOk.value = false
      checkText.value = 'Прокси выключен — проверять нечего.'
      return
    }

    if (probe.outcome === 'invalid') {
      checkOk.value = false
      checkText.value = 'Адрес или порт заданы неверно — проверять нечего.'
      return
    }

    const reached = await proxyLiveCheck()

    if (probe.reachable && reached) {
      checkOk.value = true
      checkText.value = `Прокси ${probe.server} ответил за ${probe.latencyMs} мс, и запрос через него прошёл.`
    } else if (probe.reachable && !reached) {
      checkOk.value = false
      checkText.value = `Прокси ${probe.server} ответил, но наружу не пустил: проверьте логин, пароль и вид прокси.`
    } else if (!probe.reachable && reached) {
      checkOk.value = false
      checkText.value = `Прокси ${probe.server} не отвечает, а запрос всё равно прошёл — значит, он ушёл напрямую.`
    } else {
      checkOk.value = false
      checkText.value = `Прокси ${probe.server} не отвечает, и запрос не прошёл.`
    }
  } catch (e) {
    checkOk.value = false
    checkText.value = 'Проверка не удалась: ' + describe(e)
  } finally {
    checking.value = false
  }
}

onMounted(() => {
  void loadConfig()
  void loadStatus()
})
</script>

<template>
  <div class="am-panel am-box">
    <h3 class="am-h3">Прокси</h3>

    <label class="am-switch">
      <input v-model="enabled" type="checkbox" class="am-switch__box" @change="onEnabled" />
      <span class="am-switch__name">Использовать прокси</span>
    </label>

    <!-- Вид и порт узкие, адрес забирает остаток строки: набирают его чаще всего.

         Вид — своим списком, а не системным <select>: список у того рисует
         оболочка окна, и на тёмной теме он выпадал белым со светлым текстом.
         Подпись у списка невидимая, для читалок: у закрытого видно только
         значение, а чем оно является — ниоткуда не следует. -->
    <div class="am-row">
      <div class="am-field am-proxy__kind">
        <PickBox
          :model-value="kind"
          :items="KINDS"
          label="Вид прокси"
          @update:model-value="pickKind"
        />
      </div>

      <label class="am-field am-proxy__addr">
        <input
          v-model="host"
          v-tip="'Адрес без схемы: 127.0.0.1 или proxy.local'"
          class="am-input"
          type="text"
          placeholder="Адрес: 127.0.0.1 или proxy.local"
          @change="onHost"
        />
      </label>

      <label class="am-field am-proxy__port">
        <input
          v-model="portDraft"
          class="am-input"
          type="text"
          inputmode="numeric"
          placeholder="Порт"
          @change="onPort"
        />
      </label>
    </div>

    <div class="am-row">
      <label class="am-field">
        <input
          v-model="login"
          class="am-input"
          type="text"
          placeholder="Логин, если прокси его требует"
          @change="onLogin"
        />
      </label>

      <label class="am-field">
        <input
          v-model="password"
          class="am-input"
          type="password"
          placeholder="Пароль"
          @change="onPassword"
        />
      </label>
    </div>

    <!-- Обёртка не для вида, а по необходимости. У .am-field рост задан как
         flex: 1 1 240px, и это рост вдоль главной оси. В строке он даёт ширину,
         а прямо в колонке панели — высоту в 240px, из которых поле занимает
         верхушку. Все прочие поля в программе стоят в .am-row; это тоже. -->
    <div class="am-row">
      <label class="am-field">
        <input
          v-model="bypass"
          class="am-input"
          type="text"
          placeholder="Без прокси: localhost, 127.0.0.1"
          @change="onBypass"
        />
      </label>
    </div>

    <p class="am-meta">
      Адреса в обход прокси — через запятую или с новой строки. Пустое поле значит «через прокси
      идёт всё».
    </p>

    <p v-if="badConfig" class="am-warn">
      Прокси включён, но адрес или порт заданы неверно — трафик пойдёт напрямую.
    </p>

    <p v-if="hasPassword" class="am-warn">
      Пароль лежит в файле настроек открытым текстом: не вводите здесь пароль, который значит что-то
      ещё. Окно авторизуется у прокси само, второй раз его вводить не придётся.
    </p>

    <p v-if="socksWithAuth" class="am-warn">
      SOCKS5 с логином движок окна не поддерживает: страница пойдёт через такой прокси без
      авторизации и, скорее всего, получит отказ. Запросы AniMori логин и пароль используют, поэтому
      источники продолжат работать.
    </p>

    <!-- Строка состояния: подпись сверху, ответ снизу. Ответ длинный и переносится. -->
    <div class="am-proxy__state">
      <span class="am-proxy__name">Состояние</span>
      <span class="am-proxy__text">{{ statusText }}</span>
    </div>

    <p v-if="needsRestart" class="am-warn">
      Изменения сохранены и дойдут до окна только с новым запуском: ключи запуска движок читает один
      раз, при создании окна. Перезагрузка страницы здесь не поможет — она обновит разметку, а
      движок останется с прежним адресом.
    </p>

    <div class="am-row">
      <button class="am-btn am-btn--ghost" type="button" :disabled="checking" @click="check">
        {{ checking ? 'Проверяем…' : 'Проверить сейчас' }}
      </button>

      <button
        v-if="needsRestart"
        v-tip="'Перезапустить программу, чтобы новый адрес дошёл до окна'"
        class="am-btn"
        type="button"
        @click="onRestart"
      >
        Перезапустить
      </button>
    </div>

    <p v-if="checkText" :class="checkOk ? 'am-note' : 'am-error'">{{ checkText }}</p>
    <p v-if="error" class="am-error">{{ error }}</p>
  </div>
</template>

<style scoped src="../screens/settings-screen.css"></style>
