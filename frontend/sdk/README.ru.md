[English](README.md) | **Русский**

# @mndw/sdk — руководство автора плагинов

Хост mndw загружает плагины как виджеты панели или маршруты полноэкранных страниц.

## 1. Что такое mndw?

Одна SPA. Плагины — это виджеты панели или полноэкранные маршруты, загружаемые динамически.
Это руководство описывает пакет `@mndw/sdk` — всё необходимое автору плагина.

## 2. Начало работы

```bash
pnpm exec mndw create my-widget --framework svelte --type widget
```

Команда использует приватный CLI workspace из checkout репозитория. Установка через npm
отложена; руководство не обещает опубликованные пакеты `@mndw/sdk` или `@mndw/cli`.

Каркас содержит `manifest.json`, `src/index.ts`, компонент точки входа выбранного фреймворка,
если он нужен, и `src/index.css`.

## 3. Справочник манифеста

| Поле              | Тип                    | Обяз. | Описание                   |
|-------------------|------------------------|-------|----------------------------|
| `manifestVersion` | `1`                    | да    | Всегда 1                   |
| `name`            | string                 | да    | `^[a-z0-9][a-z0-9-]*$`     |
| `version`         | string                 | да    | Semver                     |
| `type`            | `"widget"` или `"page"` | да   |                            |
| `label`           | string                 | да    | Человекочитаемое имя       |
| `entry`           | string                 | да    | Относительный путь к JS-бандлу |
| `icon`            | string?                | нет   |                            |

Виджеты: `size: { w, h, minW?, minH? }` в единицах сетки (сетка из 12 колонок). Страницы:
`route` (один сегмент; зарезервированы `/`, `/login`, `/packages`, `/packages/services`,
`/settings`). Проверка SDK и маршрутизация хоста отклоняют эти статические пути.

Backend (необязательно): `kind: "exec"` с командами HTTP-маршрутов или `kind: "service"`
с одной командой переднего плана, версией протокола и HTTP/WebSocket-маршрутами. Команды —
относительные пути к исполняемым файлам; аргументы service — буквальные значения.

## 4. Модуль плагина

```ts
import type {PluginContext, PluginInstance} from '@mndw/sdk'

export function createInstance(
  container: HTMLElement,
  context: PluginContext,
): PluginInstance | Promise<PluginInstance> {
  return {
    unmount() {
      // Clean up DOM, dispose framework component.
      // Return type: void | Promise<void>
    },
    onResize(size: {w: number; h: number}) {
      // Optional widget resize callback.
      void size
    },
  };
}
```

### Svelte (Svelte 5)

```ts
import {mount, unmount} from 'svelte'
import type {PluginContext, PluginInstance} from '@mndw/sdk'
import App from './App.svelte'

export function createInstance(container: HTMLElement, ctx: PluginContext): PluginInstance {
  const app = mount(App, {target: container, props: {ctx}});

  return {
    unmount() {
      void unmount(app);
    },
  };
}
```

### Vue

```ts
import {createApp} from 'vue'
import type {PluginContext, PluginInstance} from '@mndw/sdk'
import App from './App.vue'

export function createInstance(container: HTMLElement, ctx: PluginContext): PluginInstance {
  const app = createApp(App, {ctx});

  app.mount(container);

  return {
    unmount() {
      app.unmount()
    },
  };
}
```

### Angular

`@mndw/sdk/angular` предоставляет необязательные вспомогательные функции для распространённых задач
жизненного цикла Angular-плагина. Авторы по-прежнему могут напрямую использовать API Angular,
если им нужно другое управление приложением или компонентом; эти вспомогательные функции сокращают
повторяющийся код монтирования и очистки.

```ts
import type {PluginContext, PluginInstance} from '@mndw/sdk';
import {createAngularPluginInstance, provideTranslator} from '@mndw/sdk/angular';
import 'zone.js'
import '@angular/compiler'
import {AppComponent} from './app.component'

export function createInstance(el: HTMLElement, ctx: PluginContext): PluginInstance {
  return createAngularPluginInstance(el, {
    rootComponent: AppComponent,
    providers: [provideTranslator(ctx.i18n)],
    configure: ({component}) => {
      component.setInput('deviceName', ctx.hostInfo.deviceName);
    },
  });
}
```

Вспомогательная функция управляет созданием приложения, подключением корневого view, отменой, если
компонент размонтирован до завершения bootstrap, очисткой после ошибки монтирования и
уничтожением компонента/приложения. Добавьте `provideTranslator(ctx.i18n)`, если дерево
компонентов внедряет токен SDK `TRANSLATOR`.

Для компонента, открываемого через управляемый хостом сервис оверлеев, используйте необязательную
вспомогательную функцию `mountComponentInOverlay`. Передайте `appRef` из обратного вызова
`configure` корневой вспомогательной функции и позвольте слою оверлея управлять очисткой; при
необходимости верните очистку подписок из `setup`:

```ts
import {mountComponentInOverlay} from '@mndw/sdk/angular';

configure: ({appRef, component}) => {
  component.setInput('openSettings', () => {
    ctx.overlay.open({
      kind: 'modal',
      title: 'Settings',
      mount(target, layer) {
        mountComponentInOverlay({
          appRef,
          target,
          layer,
          component: SettingsComponent,
          setup: (ref) => {
            ref.setInput('value', 'current');

            return () => {
              // Unsubscribe from plugin-owned subscriptions here.
            };
          },
        });
      },
    });
  });
}
```

`mountComponentInOverlay` подключает дочерний view и регистрирует отсоединение/уничтожение
вместе со слоем оверлея. Прямое монтирование Angular по-прежнему поддерживается, если этот
жизненный цикл не подходит плагину.

## 5. Тикер на базе Worker

Используйте `@mndw/sdk/ticker` для периодических обновлений с коррекцией дрейфа. Планирование
выполняется в отдельном WebWorker, поэтому код плагина не владеет логикой таймеров и протоколом
worker.

```ts
import {Ticker} from '@mndw/sdk/ticker'

const ticker = new Ticker()
const unsubscribe = ticker.onTick(() => {
  // Update plugin state.
})

ticker.start(1000)

// During plugin teardown:
unsubscribe()
ticker.destroy()
```

`Ticker.destroy()` останавливает и завершает его worker. Упаковщик CLI автоматически включает
worker SDK в дистрибутив плагина.

## 6. API PluginContext

```ts
type PluginContext = WidgetPluginContext | PagePluginContext;

interface WidgetPluginContext {
  kind: 'widget';
  rciManager: RciManager;
  storage: PluginStorage;
  sharedStorage: PluginStorage;
  hostInfo: HostInfo;
  i18n: PluginI18n;
  injector: ServiceInjector;
  instanceId: string;
  backend?: BackendClient;
  overlay: OverlayService;
  setTileTitle?: (title: string) => void;
  onThemeChange(callback: (theme: MndwThemeName) => void): () => void;
  getTokens(): PaletteTokenMap;
  onPaletteChange(callback: (tokens: PaletteTokenMap) => void): () => void;
  // pageRoute is unavailable on widget contexts.
}

interface PagePluginContext {
  kind: 'page';
  rciManager: RciManager;
  storage: PluginStorage;
  sharedStorage: PluginStorage;
  hostInfo: HostInfo;
  i18n: PluginI18n;
  injector: ServiceInjector;
  instanceId: string;
  backend?: BackendClient;
  overlay: OverlayService;
  pageRoute: PageRoute;
  // setTileTitle is unavailable on page contexts.
  onThemeChange(callback: (theme: MndwThemeName) => void): () => void;
  getTokens(): PaletteTokenMap;
  onPaletteChange(callback: (tokens: PaletteTokenMap) => void): () => void;
}

interface PageRoute {
  readonly childPath$: Observable<string>;
  navigate(
    childPath: string,
    options?: {replace?: boolean; scrollToTop?: boolean},
  ): Promise<void>;
}

type PageRouteErrorCode = 'INVALID_PATH' | 'COMPLETED' | 'NAVIGATION_FAILED';

class PageRouteError extends Error {
  readonly code: PageRouteErrorCode;
}

interface HostInfo {
  deviceName: string;
  vendor: string;
  firmwareVersion: string;
  theme: MndwThemeName;
}

interface PluginStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}
```

`PluginContext` создаётся хостом. Сужайте вариантные поля через `context.kind`; дискриминант
не задаётся автором плагина. `success` означает текущие подтверждённые данные, `refreshing`
сохраняет предыдущие данные во время запроса, а `error` может сохранять предыдущие данные после
неудачного обновления. `unsupported` — терминальный результат возможности на время жизни
плагина.

## 6.1. Каноническое асинхронное состояние

```ts
type LoadState<T, E = unknown> =
  | {status: 'idle'}
  | {status: 'loading'}
  | {status: 'success'; data: T}
  | {status: 'refreshing'; data: T}
  | {status: 'error'; error: E; data?: T}
  | {status: 'unsupported'; reason: string};
```

Reducer должен переносить `data` в `error`, если неудачный запрос начался из состояния с
данными. Для начальных ошибок `idle`/`loading` это поле можно опустить.

## Локализация

`PluginContext.i18n` обязателен. Это синхронный снимок `PluginI18n` для зафиксированной локали
хоста. JSON-каталог вложен; поиск по точкам проходит по этому дереву, а дефисы разделяют слова
внутри одной части ключа:

```json
{
  "wifi": {
    "encryption": {"disabled": "Unsecured"},
    "band": {"2": "2.4 GHz Wi-Fi"}
  },
  "error": {"integer-only": "Only integer values are allowed"}
}
```

Используйте в коде `wifi.encryption.disabled`, `wifi.band.2` и `error.integer-only`.
`i18n.t()` возвращает исходный ключ, если значения в каталоге нет; пустая строка никогда не
выводится. `formatNumber()` и `formatDate()` следуют зафиксированной локали хоста. Зарезервированное
значение `direction` — `'ltr'`; RTL выходит за рамки этого плана.

Используйте вспомогательные функции фреймворка, чтобы дочерние компоненты наблюдали ту же ревизию локали:

```svelte
<script lang="ts">
  import type {PluginI18n} from '@mndw/sdk';
  import {createTranslator} from '@mndw/sdk/svelte';

  let {i18n}: {i18n: PluginI18n} = $props();
  const translator = createTranslator(i18n);
</script>

<h1>{$translator.t('wifi.encryption.disabled')}</h1>
```

```ts
import {useTranslator} from '@mndw/sdk/vue';

const translator = useTranslator(props.ctx.i18n);
const label = translator.t('wifi.band.2');
```

```ts
import {DestroyRef, inject} from '@angular/core';
import {createTranslatorSignals} from '@mndw/sdk/angular';

const translator = createTranslatorSignals(ctx.i18n, inject(DestroyRef));
```

```ts
import {bindLocale} from '@mndw/sdk/bind-locale';

const unsubscribe = bindLocale(ctx.i18n, render);
// Call unsubscribe from PluginInstance.unmount().
```

Angular-плагины предоставляют один translator через корневой токен `TRANSLATOR`, а дочерние
компоненты внедряют этот токен. Дочерние компоненты Svelte получают translator store/helper, а не
сырой `PluginI18n`. Вызовы переводов vanilla должны находиться в проверенных render-модулях с очисткой
через `bindLocale`. Код, доступный из шаблонов, не должен вызывать сырой `PluginI18n.t`,
`formatNumber` или `formatDate`; типизированное lint-правило проверяет это для Svelte и Angular,
а adapter label MWS — явное исключение.

Парсер Vue SFC остаётся вне типизированной проверки и не имеет текстового правила для raw-i18n.
Сгенерированные тесты смены локали и smoke-тест упакованного плагина обеспечивают поведенческое
покрытие Vue.

Общий разбор каталога доступен из `@mndw/sdk/catalog`:

```ts
import {parseCatalog} from '@mndw/sdk/catalog';

const catalog = parseCatalog({wifi: {band: {'2': '2.4 GHz Wi-Fi'}}}, '<catalog>');
```

`@mndw/sdk/testing` экспортирует `createTestI18n`, принимающий вложенные каталоги как в
production или плоские карты dotted-key для коротких тестов. Каждый сгенерированный тест, тест
плагина и packed-smoke-тест должен использовать разные английские и русские значения и проверять
`enValue !== ruValue` до переключения; иначе тест может пройти, не доказав реакцию DOM.

### Overlay

```ts
interface OverlayService {
  createLayer<Result>(options: OverlayLayerOptions): OverlayLayer<Result>;
  open<Result>(options: OverlayOpenOptions<Result>): OverlaySession<Result>;
  closeAll(): void;
}
```

`OverlayOpenOptions` требует `kind` (`"modal"` или `"drawer"`), `title?`, `description?`,
`showCloseButton?` и callback `mount(target, layer, signal)`.

## 7. Клиент бэкенда

```ts
interface BackendClient {
  fetch(id: string, options?: BackendFetchOptions): Promise<Response>;
  socket(id: string, options?: BackendSocketOptions): WebSocket;
  status(options?: BackendStatusOptions): Promise<BackendStatus>;
}
```

Метод и относительный путь берутся из объявления конечной точки в манифесте. Типизированные ошибки
включают ошибки дескриптора (`BackendNotApproved`, `BackendDisabled`, `BackendUnknownId` и
`BackendTransportMismatch`) и ошибки жизненного цикла демона: `BackendStarting`,
`BackendUnavailable`, `BackendIncompatible`, `BackendMaintenance` и `BackendBadGateway`.
Ошибки жизненного цикла содержат `id` и буквальный `daemonCode`; starting и maintenance также
содержат разобранный целочисленный `retryAfterSeconds` или `null`.

Плагины-страницы используют `context.pageRoute` для дочерних маршрутов. `childPath$` выдаёт
нормализованный путь дочернего маршрута (например, `/clients`), а `navigate()` принимает
путь без query или hash. Он сохраняет корректное стандартное процентное кодирование, отклоняет
некорректные или неоднозначные пути и возвращает отклонённый promise с `PageRouteError`
(`INVALID_PATH`, `COMPLETED` или `NAVIGATION_FAILED`), если навигация невозможна.
`scrollToTop` по умолчанию равен `true`.

```ts
const client = context.backend;

if (client) {
  try {
    const res = await client.fetch('stats');
    void res;
  } catch (error) {
    if (error instanceof BackendNotApproved || error instanceof BackendDisabled) {
      // Show approval/availability UI.
    } else if (error instanceof BackendStarting || error instanceof BackendMaintenance) {
      // Show retrying UI; retryAfterSeconds is informational in this slice.
    } else if (error instanceof BackendUnavailable || error instanceof BackendIncompatible
      || error instanceof BackendBadGateway) {
      // Classify daemon lifecycle state or degraded transport.
    } else if (error instanceof BackendUnknownId || error instanceof BackendTransportMismatch) {
      // Fix a stale declaration or route transport mismatch.
    }
  }
}
```

## 8. Дизайн-токены

Стилизуйте с помощью пользовательских свойств `var(--mndw-*)`, автоматически меняющихся между
светлой и тёмной темами:

```css
.my-widget {
  background: var(--mndw-surface);
  color: var(--mndw-text-subtle);
  border: 1px solid var(--mndw-border);
}
```

Полный справочник: `@mndw/sdk/tokens` (типизированный) и `@mndw/sdk/tokens.css` (CSS-свойства).

Для получения цветов в JavaScript во время выполнения используйте `context.getTokens()` и подписывайтесь через
`context.onPaletteChange(...)`. `MNDW_TOKENS` содержит только скомпилированные значения по
умолчанию и не включает переопределение палитры устройства.

## 9. Политика внешних зависимостей

Предоставляются хостом, включать в бандл **НЕЛЬЗЯ**:

| Пакет                                                                                           | Относится к          |
|-------------------------------------------------------------------------------------------------|----------------------|
| `@rci-tools/core`, `rxjs`, `rxjs/operators`, `hash-wasm`, `d3`                                  | все плагины          |
| `@mndw/ui`                                                                                      | все плагины          |
| `vue`                                                                                           | только Vue-плагины   |
| `zone.js`, `@angular/core`, `@angular/common`, `@angular/platform-browser`, `@angular/compiler` | только Angular-плагины |

CLI проверяет это во время pack. Плагины напрямую импортируют `@mndw/ui` для общих custom
elements; хост регистрирует эти элементы и предоставляет версионированный бандл.

### D3 и расширения

Хост предоставляет полный пакет `d3@7.9.0` в одном общем бандле. Используйте обычный импорт:

```ts
import * as d3 from 'd3';
```

Все официальные API d3, включая `zoom`, доступны из этого namespace. Держите `d3` и `@types/d3`
в `devDependencies`, чтобы локальные тесты и проверка типов находили пакет; `mndw pack` вынесет
его во внешнюю зависимость, а import map хоста предоставит его во время работы.

Сторонние расширения не предоставляются хостом автоматически. Объявите расширение вроде
`d3-dag` в плагине и позвольте упаковщику включить его в бандл. Любой пакет, отсутствующий в
таблице общих зависимостей хоста, подчиняется тому же запасному правилу; его использование не
требует выпуска хоста. Не включайте отдельно официальные модули d3, уже доступные в полном
namespace `d3`.

## 10. Упаковка и загрузка

```bash
mndw pack my-widget   # bundle -> my-widget/dist/
mndw zip my-widget    # pack + create my-widget/my-widget.zip
```

Загружайте через Settings панели (рекомендуется). Для аутентифицированного ручного запроса
используйте сохранённый порт панели из `/opt/var/lib/mndw/frontend-port`, активную cookie
сессии и CSRF-заголовок:

```bash
curl --cookie '<authenticated-session-cookie>' \
  -H 'X-Mndw-Csrf: 1' \
  --data-binary @my-widget.zip \
  http://<device>:<dashboard-port>/api/mgmt/upload
```

Каждый zip содержит `mndw.lock.json` с точными версиями общих зависимостей.

## 11. Примеры

Встроенные плагины в `plugins/builtin/`:

- `device-info-widget`
- `tx-rx-chart-widget`
- `terminal-page`
- `clock-widget`
- `dns-lookup-widget`
- `mws-page`
- `clients-widget`
- `system-log-page`

Примеры, предназначенные для загрузки, в `plugins/examples/`:

- `backend-echo`
- `demo-page`
- `device-traffic-widget`
- `ping-widget`
