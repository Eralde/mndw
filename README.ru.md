# mndw

[English](README.md) | **Русский**

mndw &mdash; это модульный веб-интерфейс для устройств Keenetic/Netcraze.
Хост-приложение, работающее в браузере, позволяет расширять интерфейс за счет плагинов,
а `mndwd` отвечает за взаимодействие с API устройства и бэкенды плагинов.

## Архитектура

```text
browser
  └─ mndwd
      ├─ статические файлы хост-приложения и плагинов
      ├─ прокси для rci/ и auth/
      └─ шлюз API и WebSocket
```

Хост-приложение, написанное на Svelte 5, управляет состоянием входа, маршрутизацией,
отрисовкой плагинов, оверлеями, темой и настройками. `mndwd`, написанный на Go,
управляет файлами плагинов, манифестами, бэкенд-процессами, HTTP-маршрутами,
WebSocket и реализует API для общего управление `mndw`. Маршрутизация запросов,
порты слушателей и целевые upstream-серверы определяются в
[`contracts/routing.ru.md`](contracts/routing.ru.md).

## Быстрый старт

Необходимое ПО: Node 22+, pnpm 10+, Go 1.26+.

```bash
git clone git@github.com:Eralde/mndw.git
pnpm install
pnpm dev
```

При запуске в режиме разработки `mndwd` работает локально на вашей машине.
Запросы к API устройства проксируются на реальное устройство Keenetic/Netcraze.
Чтобы задать адрес устройства, в терминале укажите `MNDW_HOST_DEVICE=<DEVICE_URL>`:
```shell
`MNDW_HOST_DEVICE=http://192.168.1.1 pnpm dev`
```

## Создание плагинов

```bash
pnpm exec mndw create my-widget --framework svelte --type widget
pnpm exec mndw dev my-widget
pnpm exec mndw validate my-widget
pnpm exec mndw pack my-widget
pnpm exec mndw zip my-widget
```

Стандартный цикл работы с исходным кодом плагина:
`create -> dev -> validate -> pack -> zip -> upload`.
Плагин должен реализовать `createInstance` из `@mndw/sdk` и иметь корректный `manifest.json`.
Существует два типа плагинов: виджеты (для дашборда `mndw`) и отдельные страницы.
Размеры для плагинов-виджеты используют размеры в единицах сетки; страницы объявляют
один корневой маршрут. Фронтенд плагина может быть написан на обычном TypeScript,
Svelte, Vue или Angular. Подробнее см. в
[руководстве автора плагинов SDK](frontend/sdk/README.ru.md).

Плагины могут использовать предоставленный хостом `context.rciManager` для доступа к
существующему API устройства `rci/`.

### Бэкенд плагина

Плагины могут объявить бэкенд в `manifest.json`. `mndw` поддерживает два
типа бэкенда: `exec` запускают одну команду для каждого объявленного HTTP-маршрута;
бэкенды `service` запускают постоянный процесс, предоставляющий HTTP/WebSocket-маршруты.
Фронтенды вызывают объявленные маршруты через `context.backend.fetch(id)`
или `context.backend.socket(id)`. Для запуска бэкенд-процессов требуется подтверждение;
они выполняются с привилегиями демона/устройства.

См. [руководство автора плагинов](docs/plugin-author-guide.ru.md) по бэкендам exec и
[руководство по service-бэкендам](docs/service-backend.ru.md) по манифестам сервисов,
готовности сокета, жизненному циклу и безопасности.

## Сборка IPK

```bash
pnpm build-ipk --arch mipsel
pnpm build-ipk --all
pnpm build-ipk --all --repo
```

Результат: `out/mndw_<version>_<opkg-arch>.ipk` (например,
`mndw_<version>_mipsel-3.4.ipk`). Для сборки требуется тулчейн
кросс-компиляции Go.

## Структура проекта

```text
frontend/
  angular-compiler/ shared Angular build-time compiler
  sdk/              plugin contracts, manifest schema, backend client, and design tokens
  host/             Svelte 5 host application
  ui/               reusable Lit custom elements and components
  ui-angular/       Angular UI adapter
  ui-svelte/        Svelte UI adapter
  ui-vue/           Vue UI adapter
tooling/
  cli/              `mndw` CLI and plugin packaging
  eslint/           shared ESLint rules
  go-blanklr/       Go blank-line formatter
  palette-core/     dependency-free palette leaf
daemon/
  mndwd/            Go device control plane
  contracts-go/     generated Go contract bindings
packages/
  go-device-auth/   shared device-auth handshake
  go-httpsocket/    shared Unix-socket HTTP lifecycle
  go-mws-members/   shared mesh-member parsing
  go-rci/           shared RCI client and transport
  go-rcisock/       shared persistent RCI transport
plugins/
  builtin/          shipped built-in plugins
  examples/         uploadable example plugins
build/
  palette/          palette engine and token generator
  packaging/        web server init, IPK, and install scripts
  ...               repository build orchestration and helpers
docs/               documentation
```

## Документация

[Хост-приложение](docs/host-app.ru.md) <br/>
[Система плагинов](docs/plugin-system.ru.md) <br/>
[Руководство автора плагинов](docs/plugin-author-guide.ru.md) <br/>
[CLI и разработка](docs/cli-and-development.ru.md) <br/>
[Демон](docs/daemon.ru.md) <br/>
[Развёртывание](docs/deployment.ru.md) <br/>
