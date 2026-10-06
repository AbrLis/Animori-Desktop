# Политика обработки персональных данных

**Редакция от 6 октября 2026 года.**

### 1. Оператор

Оператором персональных данных является владелец программного обеспечения AniMori —
владелец учётной записи GitHub `foulnike` (далее — Оператор). Адрес для обращений:
Issues репозитория `https://github.com/foulnike/Animori`.

### 2. Какие данные обрабатываются

Программа AniMori обрабатывает следующие данные пользователя, которые хранятся
исключительно на устройстве пользователя:

1. Список просмотра (закладки): статус, оценка, количество серий, пересмотры, даты,
   заметки, пользовательские идентификаторы записей.
2. Настройки программы (внешний вид, источники, параметры сетевых подключений,
   включая настройки прокси).
3. Токен доступа к AniList и токен доступа к Яндекс Диску — при использовании
   соответствующих функций.
4. Кэш изображений и датасет названий, загружаемые программой для своей работы.
5. Журнал отладки — только после явного включения пользователем.

### 3. Какие данные не обрабатываются

Программа не использует cookies, средства аналитики и телеметрии. У Оператора
отсутствуют собственные серверы: данные не передаются Оператору каким-либо образом.
Программа не собирает контактных данных и не использует профилирования.

### 4. Сетевые запросы

Программа выполняет сетевые запросы только к следующим сторонним сервисам и только
в объёме, необходимом для работы запрошенных пользователем функций:

| Сервис | Назначение |
| :--- | :--- |
| AniList (anilist.co, graphql.anilist.co) | каталог, список пользователя при входе, обновление расписания |
| Shikimori (shikimori.one, shikimori.io, shikimori.rip) | русские названия и описания, перенос списка по нику |
| Kodik, Anilibria и их CDN | получение ссылок на видео по выбору пользователя |
| Яндекс Диск (cloud-api.yandex.net, *.disk.yandex.ru) | сохранение и чтение копии списка — только по команде пользователя |
| GitHub (github.com, api.github.com, raw.githubusercontent.com) | проверка обновлений, загрузка датасета названий |

Каждый из перечисленных сервисов действует в соответствии с собственной политикой
конфиденциальности.

### 5. Передача данных третьим лицам

Передача копии списка на Яндекс Диск осуществляется исключительно по явной команде
пользователя (нажатию кнопки сохранения). Автоматическая передача данных в фоновом
режиме не производится. Выгрузка списка в файл XML производится только по команде
пользователя. Программа не передаёт данные третьим лицам иным образом.

### 6. Права пользователя

Пользователь вправе:

1. Получить сведения об обрабатываемых данных — из настоящей Политики и документации
   к программе.
2. Удалить данные — средствами программы (удаление списка, отключение аккаунта
   AniList) либо удалением программы и её файлов с устройства.
3. Отозвать согласие на обработку — путём прекращения использования программы
   и удаления её данных, как указано в пункте 2.

### 7. Срок хранения

Данные хранятся на устройстве пользователя до их удаления пользователем или
удаления программы. Оператор не хранит копий данных пользователей.

### 8. Изменение Политики

Настоящая Политика может изменяться. Новая редакция публикуется в репозитории
`https://github.com/foulnike/Animori` (файл `docs/PRIVACY.md`) и вступает в силу
с момента публикации.

---

## English version

**Effective date: October 6, 2026.**

### 1. Controller

The controller of personal data is the owner of the AniMori software — the owner of
the GitHub account `foulnike` (the "Controller"). Contact address: the Issues tab of
the `https://github.com/foulnike/Animori` repository.

### 2. Data processed

AniMori processes the following user data, stored exclusively on the user's device:

1. The watch list (bookmarks): status, score, episode counts, rewatches, dates, notes,
   user record identifiers.
2. Application settings (appearance, sources, network parameters, including proxy
   settings).
3. AniList access token and Yandex Disk access token — when the respective features
   are used.
4. Image cache and the title dataset downloaded by the application for its operation.
5. Debug log — only after explicit enablement by the user.

### 3. Data not processed

The application does not use cookies, analytics or telemetry. The Controller operates
no servers: no data is transmitted to the Controller. The application does not
collect contact details and performs no profiling.

### 4. Network requests

The application makes network requests only to the following third-party services and
only to the extent required by features requested by the user:

| Service | Purpose |
| :--- | :--- |
| AniList (anilist.co, graphql.anilist.co) | catalogue, the user's list upon sign-in, schedule updates |
| Shikimori (shikimori.one, shikimori.io, shikimori.rip) | Russian titles and descriptions, list import by nickname |
| Kodik, Anilibria and their CDNs | video links at the user's choice |
| Yandex Disk (cloud-api.yandex.net, *.disk.yandex.ru) | saving and reading a backup of the list — only on the user's command |
| GitHub (github.com, api.github.com, raw.githubusercontent.com) | update checks, title dataset download |

Each of the listed services acts in accordance with its own privacy policy.

### 5. Transfer to third parties

A backup of the list is transferred to Yandex Disk exclusively upon the user's
explicit command (pressing the save button). No background or automatic transfer
takes place. Export of the list to an XML file occurs only on the user's command.
The application does not transfer data to third parties in any other manner.

### 6. User rights

The user may:

1. Obtain information about the processed data — from this Policy and the software
   documentation.
2. Delete the data — by application means (list deletion, AniList account unlinking)
   or by removing the application and its files from the device.
3. Withdraw consent to processing — by ceasing use of the application and deleting
   its data as described in item 2.

### 7. Retention

Data is stored on the user's device until deleted by the user or until the
application is removed. The Controller keeps no copies of user data.

### 8. Changes to this Policy

This Policy may be amended. The new version is published in the repository
`https://github.com/foulnike/Animori` (file `docs/PRIVACY.md`) and takes effect
upon publication.

