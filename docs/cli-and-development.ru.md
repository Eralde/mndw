[English](cli-and-development.md) | **Русский**

# CLI и разработка

CLI `mndw` упрощает работу автору плагина.

## Команды

```text
pnpm --filter @mndw/cli exec mndw create <name>       scaffold a plugin
pnpm --filter @mndw/cli exec mndw dev <plugin>        run source plugin with local host and daemon
pnpm --filter @mndw/cli exec mndw validate <path>     validate manifest and entry checks
pnpm --filter @mndw/cli exec mndw pack <path>         build an isolated loadable plugin directory
pnpm --filter @mndw/cli exec mndw zip <path>          pack and create an uploadable archive
pnpm --filter @mndw/cli exec mndw build-backend       build configured Go backend for current plugin
```

Эти команды работают с приватной рабочей копией репозитория. Запускайте их из корня
репозитория; пути, переданные CLI, разрешаются относительно `tooling/cli`.

Обычные варианты `create`: widget или page, vanilla/Svelte/Vue/Angular и необязательный
shell-бэкенд. Сгенерированный проект использует `@mndw/sdk` и дизайн-токены `--mndw-*`.

## Упаковка плагина

`mndw pack` выполняет следующие шаги:

1. читает и проверяет исходный манифест;
2. определяет или выбирает фронтенд-фреймворк;
3. разрешает `mndw.productionEntry` пакета, по умолчанию `src/index.ts`;
4. собирает выбранный исходник TypeScript с помощью esbuild;
5. выносит предоставляемые хостом общие зависимости во внешние зависимости;
6. создаёт entry и фиксированный результат `index.css`;
7. один раз копирует объявленные команды с исполняемым режимом;
8. записывает проверенные манифест и `mndw.lock.json`;
9. атомарно заменяет каталог результата.

Go-плагины используют декларативный хук сборки бэкенда. Имя хука хранится в
`mndw.backendBuildScript`, а имя выходного файла настраивается в `mndw.backend`:

```json
{
  "scripts": {"build-backend": "mndw build-backend"},
  "mndw": {
    "backendBuildScript": "build-backend",
    "backend": {"binaryName": "food", "entryPackage": "./cmd/food"}
  }
}
```

`mndw build-backend` читает id плагина из `name` в `manifest.json`, затем читает
`binaryName` и `entryPackage` из `mndw.backend`. Без аргументов команда собирает
бинарный файл для вашей машины. Для кросс-сборки обязательны и `--target <target>`,
и `--out-dir <dir>`.

`mndw zip` помещает `manifest.json` в корень архива. Благодаря этому демон может проверить
архив, не зная его полной внутренней структуры.

## Lock-файл и внешние зависимости

Lock-файл содержит версию плагина, фреймворк, версию SDK и версии общих зависимостей,
использованных при сборке. Общие бандлы имеют версии и разрешаются через один import map
в разработке и production.

Пакеты, предоставляемые хостом, включают базовый набор RxJS/hash-wasm/d3/rci-tools,
а также runtime для Vue и Angular. Плагины не должны включать эти пакеты в бандл.
Упаковщик проверяет метафайл esbuild на утечки до подготовки результата.
Пакеты, отсутствующие в списке общих зависимостей, остаются в бандле плагина:
например, плагины могут использовать расширения для `d3` вроде `d3-dag`.

## Разработка исходников

`mndw dev <plugin>` запускает изолированное локальное окружение:

```text
plugin source
  ├─ виртуальный модуль Vite -> хост-приложение
  └─ симлинк на директорию builtin -> локальные команды/сервисы бэкенда mndwd
```

CLI сначала выполняет проверку, создаёт временные корни данных и плагинов, запускает
`mndwd --dev --opkg stub`, ждёт `/api/mgmt/list`, затем запускает хост. Сигналы или отказ
дочернего процесса останавливают оба процесса и удаляют только временные каталоги, созданные
для этого запуска.

HMR работает транзакционно: корректное изменение перемонтирует кандидат;
некорректный манифест или ошибка перемонтирования оставляют прежний
плагин активным либо сообщают о необходимости перезапуска.

Плагины могут хранить поведение только для разработки в `src/index.ts`, который загружает
`mndw dev`. Чтобы выбрать другой production-исходник, добавьте настройку только для сборки
в `package.json`:

```json
"mndw": {"productionEntry": "src/index.prod.ts"}
```

`mndw pack` собирает только настроенный production-исходник; entry манифеста и имя файла
результата не меняются. Настроенный файл должен быть обычным `.ts` внутри `src/`, а
`src/index.ts` всё равно должен существовать: он нужен `mndw validate`, и `mndw dev` загружает
его по пути.

На уровне репозитория `pnpm dev` упаковывает встроенные плагины из `src/index.ts`, запускает
локальный демон, ждёт готовности и запускает хост под одним супервизором. Благодаря этому
доступно поведение только для разработки, например данные MWS mock. Обычная команда
`pnpm build-builtin-plugins` по-прежнему упаковывает настроенные production entry. Существующее
значение `MNDW_HOST_DEVICE` по-прежнему выбирает реальное сетевое устройство для вызовов
RCI/auth.

Примеры репозитория, предназначенные для загрузки, находятся в `plugins/examples`. Собирайте
их архивы командой `pnpm build-example-plugins`: она создаёт по одному архиву для каждого
непосредственного каталога примера с манифестом. Примеры с `mndw.backendBuildScript` и
`mndw.backend` получают по одному архиву с меткой цели для каждой из `aarch64`, `mips` и
`mipsel`; примеры без бэкенда получают один архив. Архивы бэкендов содержат бинарные файлы
для конкретной архитектуры и проходят этапы upload -> approval -> activation.

## Полный цикл разработки

Для нового плагина используйте такую последовательность:

```bash
pnpm --filter @mndw/cli exec mndw create hello --type widget --framework svelte --backend sh
pnpm --filter @mndw/cli exec mndw dev hello
pnpm --filter @mndw/cli exec mndw validate hello
pnpm --filter @mndw/cli exec mndw pack hello
pnpm --filter @mndw/cli exec mndw zip hello
```

Получившийся zip можно загрузить через интерфейс управления хоста или API управления демона.
Zip с бэкендом остаётся в области staging до подтверждения.
