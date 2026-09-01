# Владение маршрутами во время работы

[English](routing.md) | **Русский**

Этот документ фиксирует владение маршрутами. Пути являются публичной поверхностью протокола;
детали реализации остаются внутри runtime, которому они принадлежат.

| Route | Production owner | Development owner | Responsibility |
| --- | --- | --- | --- |
| `/api/**` | `mndwd` | Vite proxy to `mndwd` | Управление, диагностика, палитра и HTTP-диспетчеризация плагинов |
| `/api/plugins/<name>/**` | `mndwd` dispatch | `mndwd` через Vite proxy | Endpoint бэкендов одобренных/включённых плагинов |
| `/api/mgmt/**` | `mndwd` | `mndwd` через Vite proxy | Загрузка, approval, lifecycle, opkg и чтение данных управления |
| `/api/mndw/**` | `mndwd` | `mndwd` через Vite proxy | Доступ к устройству и API постоянных RCI-сессий |
| `/ws/**` | `mndwd` | Vite proxy to `mndwd` | WebSocket proxy бэкендов плагинов |
| `/plugins/<name>/**` | Статический frontend `mndwd` | Статический middleware плагинов Vite | Ресурсы встроенных плагинов |
| `/user-plugins/<name>/**` | Статический alias `mndwd` | Статический middleware плагинов Vite | Ресурсы одобренных пользовательских плагинов |
| `/shared/<bundle>@<version>.js` | Статический frontend `mndwd` | Middleware общих бандлов Vite | Предоставленные хостом общие JavaScript-бандлы и цели import map |
| `/rci/**` | In-process proxy устройства в `mndwd` | Vite device proxy | RCI API сетевого устройства; прозрачная передача |
| `/ci/**` | In-process proxy устройства в `mndwd` | Не проксируется и не предоставляется Vite | CI API сетевого устройства; прозрачная передача |
| `/auth/**` | In-process proxy устройства в `mndwd` | Vite device proxy | API аутентификации сетевого устройства и upstream проверки сессии |

## Listener и upstream-цели

Факты о production listener и upstream:

- `mndwd` владеет одним LAN listener, доступным браузеру, для статических файлов, proxy
  устройства, API и WebSocket-маршрутов. Режим front door включается через `--frontend-dir`.
- Порт front door по умолчанию — `1189`. Сначала `mndwd` пытается использовать сохранённый
  порт, затем seed миграции, затем `1189`, а после этого оставшиеся порты `1190..1289` по
  возрастанию.
- Выбранный порт атомарно сохраняется в `/opt/var/lib/mndw/frontend-port`. Во время передачи
  при одном обновлении `/opt/var/lib/mndw/lighttpd-port` является seed миграции и удаляется
  после успешного запуска front door. `lighttpd-port-policy` упразднён.
- `--frontend-listen` по умолчанию равен `0.0.0.0`, намеренно привязывается только к IPv4 для
  совместимости с прежним listener устройства. Обслуживание IPv6 не входит в scope.
- `S70mndwd` обнаруживает HTTP listener устройства `/auth` среди локальных TCP listener и по
  challenge `WWW-Authenticate: x-ndw2-interactive` / `x-ndw4-interactive`; совпавший URL
  передаётся mndwd для проверки сессии и proxy устройства.
- `MNDW_DEVICE_PORT` в `/opt/etc/mndw.conf` переопределяет обнаружение, когда устройство
  предоставляет несколько совпадающих listener. При отсутствии совпадающего listener или при
  наличии более одного обнаружение завершается безопасным отказом.
- Upstream проверки сессии устройства для standalone mndwd по-прежнему по умолчанию —
  `http://127.0.0.1:80`; init-скрипт пакета передаёт обнаруженный URL устройства.

Пакет mndw больше не зависит от lighttpd и не настраивает его. При обновлении `postinst`
удаляет устаревшие runtime-артефакты lighttpd, принадлежащие mndw, выводит однократное
уведомление об удалении только для старого маркера владения mndw и запускает новый front
door. Неудачный перезапуск сохраняет `lighttpd-port` для повторной попытки.

Цели proxy разработки настраиваются в `frontend/host/vite.config.ts`: `/api` и `/ws` используют
`MNDW_DAEMON` (по умолчанию `http://127.0.0.1:9090`), а `/rci` и `/auth` — `MNDW_HOST_DEVICE`.
Задайте `MNDW_HOST_DEVICE` как полный URL устройства, например `http://192.168.1.1`, а не как
простой IP-адрес.

Правила владения:

- `mndwd` владеет каждым browser-facing маршрутом production, включая статические файлы,
  proxy устройства, `/api` и `/ws`; состояние возможностей плагина за пределами реестра,
  выведенного из манифестов, он не определяет.
- Хост владеет загрузкой в браузере и proxy разработки; он не становится источником истины
  состояния демона.
- Пакеты плагинов владеют объявленными payload бэкенда и статическими ресурсами, но не
  общей политикой маршрутов или approval.
- URL общих бандлов используют `/shared/<bundle>@<version>.js`; таблица бандлов и версий
  берётся из `frontend/sdk/shared-dependencies.ts` и отражается в
  `contracts/protocol/shared-deps.json`.
