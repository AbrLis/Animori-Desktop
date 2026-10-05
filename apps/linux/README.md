# AniMori — сборка под Linux

Неофициальная сборка [AniMori](https://github.com/foulnike/Animori) под Linux,
собранная из кода оригинального проекта.

## Что это

Приложение настольное, окно одно. Весь код, кроме перечисленного ниже, взят из
оригинального проекта: оболочка, экраны, общее ядро, права доступа, конфигурация
сборки. Изменений в чужом коде нет, и они не требуются: оболочка на Linux
собирается из тех же модулей, что и на Windows, различается только платформенным
поведением.

Правки в этой сборке:

- обход [WebKit bug 324551](https://bugs.webkit.org/show_bug.cgi?id=324551): на
  проприетарном NVIDIA приложение падало с `Gdk-Message: Error 71`;
- нативный Wayland-бэкенд: приложение выбирает его сам, когда доступен
  `WAYLAND_DISPLAY`, X11-сессии не затрагиваются.

## Что отключено и почему

Обе возможности реализованы в оригинале через WebView2 — внутренности браузера
Windows. В WebKitGTK такой API нет, и аналога у них нет.

| Возможность | Что делает в Windows | Почему нет здесь |
| :--- | :--- | --- |
| Панель трансляции экрана | Открывает системные адреса `ms-settings:connecteddevices`, выбор приёмника делает Windows | Приёмника трансляции в Linux нет. В KDE и GNOME передачу изображения на телевизор делает сам рабочий стол, а не приложение |
| Консоль разработчика | `ICoreWebView2.OpenDevToolsWindow()` — метод WebView2 | У WebKit другой API. Инструменты разработчика включаются в самом окне движком; собственный вызов можно будет дописать, это несколько строк |

Обе команды остаются в списке команд и в правах — они отвечают понятной ошибкой,
а не «команда не разрешена». Интерфейс их не показывает: набор умений оболочки
задан в `vite.config.ts` флагами `cast: false` и `devtools: false`. Лишний навык
хуже недобного — человек увидел бы кнопку, которая не работает.

Остальное работает как в оригинале: вход в AniList, поиск, страницы тайтлов,
плеер с HLS, списки, статистика, темы, выгрузка списка в папку, сохранение трека
темы, прокси с авторизацией, автообновление.

## Как устроено

```
apps/linux/src-tauri/   оболочка: единственный наш файл с кодом
apps/windows/           экраны и оболочка оригинала, не копируются
packages/core/          общее ядро оригинала
```

Модули оболочки (`auth`, `anilist`, `files`, `export`, `updater`, `proxy`)
подключаются прямо из `apps/windows/src-tauri/src` через `#[path]`. Правки
оригинала в них попадают сюда сами; расхождение живёт только в `lib.rs` и в
`vite.config.ts` — там, где описана платформа.

Интерфейс собирается из `apps/windows/src/app` тем же приёмом.

## Отличия в конфигурации

| Что | Windows | Здесь |
| :--- | :--- | :--- |
| Идентификатор | `com.foulnike.animori` | `io.github.abrlis.animori` |
| Канал обновлений | `windows-latest` оригинала | `linux-latest` здесь |
| Пакеты | `nsis`, `msi` | `deb` |
| Умения оболочки | трансляция и консоль есть | обе выключены |
| Права подписи | оригинальные | свои, обновления приходят отсюда |

## Сборка из исходников

Нужны Node.js, [окружение Rust и Tauri](https://tauri.app/start/prerequisites/) и
системные библиотеки WebKitGTK 4.1.

Debian, Ubuntu:

```
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Arch, CachyOS:

```
sudo pacman -S webkit2gtk-4.1 gtk3 base-devel curl wget file \
  libxdo openssl ayatana-appindicator librsvg
```

Затем из корня репозитория:

```
npm install
npm run typecheck:linux          # проверка типов
npm run build:linux              # собрать интерфейс
npm --prefix apps/linux run tauri:build -- --bundles deb
```

Пакет появится в `apps/linux/src-tauri/target/release/bundle/deb/`. Установка:

```
sudo apt install ./AniMori_3.1.0_amd64.deb
```

Запуск из исходников, без установки:

```
npm --prefix apps/linux run tauri:dev
```

При сборке артефактов обновления не создаются: для них нужен ключ подписи, и
создаёт их только CI.

## Лицензия

Код оригинального проекта распространяется по лицензии MIT, автор
[foulnike](https://github.com/foulnike/Animori). Сборка под Linux сделана
[в форке](https://github.com/AbrLis/Animori-Desktop) и распространяется на тех же
условиях.