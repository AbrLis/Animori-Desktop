<div align="center">

<img src="apps/windows/assets/screenshots/home.png" width="49%" alt="Главная">

# AniMori

**Клиент [AniList](https://anilist.co) со своим интерфейсом: настольное приложение
и приложение для телевизора. Списки, поиск, страницы тайтлов, встроенный плеер.
Всё на русском, без рекламы и телеметрии.**

[![Версия](https://img.shields.io/badge/версия-3.0.4-02A9FF?style=flat-square&labelColor=0B1622)](https://github.com/foulnike/Animori/releases)
[![Лицензия](https://img.shields.io/badge/лицензия-MIT-02A9FF?style=flat-square&labelColor=0B1622)](LICENSE)

</div>

---

## Что это

Программа работает с AniList напрямую: сама грузит данные, сама рисует экраны,
подставляет русские названия и описания из Shikimori и anime365.

Проект неофициальный и с командой AniList не связан.

## Два приложения

| | Настольное | Телевизор |
| :--- | :--- | :--- |
| Платформа | Windows 10/11 | Android TV, Android 7.0 и выше |
| Управление | мышь, клавиатура | пульт |
| Установка | [AniMori_3.0.4_x64-setup.exe](https://github.com/foulnike/Animori/releases/latest) | `AniMori_3.0.2_armv7.apk`, `AniMori_3.0.2_arm64.apk` |
| Обновление | само, из приложения | само, из приложения |
| Подробности | [`apps/windows`](apps/windows) | [`apps/android-tv`](apps/android-tv) |

<p align="center">
  <img src="apps/windows/assets/screenshots/lists.jpg" width="32%" alt="Списки">
  <img src="apps/windows/assets/screenshots/media.jpg" width="32%" alt="Тайтл">
  <img src="apps/windows/assets/screenshots/stats.png" width="32%" alt="Статистика">
</p>

## Сборка из исходников

Нужен Node.js 20 или новее. Для Android дополнительно Android SDK и NDK.

```bash
npm ci
npm test                              # общее ядро и оба приложения
npm run typecheck

cd apps/windows && npm run tauri dev            # настольное
cd apps/android-tv && npm run tauri -- android dev
```

Выпуск делается тегом с именем продукта: `windows-v3.0.5` или `android-tv-v3.0.3`.

## Устройство репозитория

| Каталог | Что в нём |
| :--- | :--- |
| `packages/core` | Общее ядро: данные, снимок, облачная копия, видео |
| `apps/windows` | Настольное приложение: экраны и оболочка |
| `apps/android-tv` | Приложение для телевизора: экраны и оболочка |

## Лицензия

[MIT](LICENSE). Русские названия и описания приходят из [Shikimori](https://shikimori.one)
и [anime365](https://anime365.ru); датасет собирается в
[animori-data](https://github.com/foulnike/animori-data).