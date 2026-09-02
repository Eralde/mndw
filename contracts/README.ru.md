[English](README.md) | **Русский**

# mndw — набор контрактов

Каталог `contracts/` хранит артефакты, не зависящие от языка. Источники истины времени
выполнения остаются в пакетах, написанных на соответствующих языках:

```text
frontend/sdk/src/manifest-schema.ts
  → contracts/manifest/manifest.schema.json
  → frontend/sdk/manifest.schema.json

contracts/manifest/fixtures
  → frontend/sdk/fixtures/manifests
  → daemon/mndwd/internal/manifest/fixtures/manifests
  → daemon/contracts-go/fixtures/manifests

contracts/palette/fixtures
  → frontend/sdk/fixtures/palettes
  → daemon/mndwd/internal/palette/fixtures/palettes

tooling/palette-core metadata + palette authority
  → contracts/tokens.json
  → frontend/sdk/src/tokens.ts
  → frontend/sdk/src/tokens.css
  → daemon/mndwd/internal/palette/theme_tokens_generated.go

frontend/sdk/shared-dependencies.ts
  → contracts/protocol/shared-deps.json
  → contracts/protocol/*.golden.json

contracts/protocol/*.golden.json
  → daemon/contracts-go/fixtures/protocol

contracts/mws-member/fixtures
  → frontend/sdk/fixtures/mws-members
  → packages/go-mws-members/fixtures

Схема участников Zod в `frontend/sdk/src/mws-member-schema.ts` определяет форму входных данных
участника и приоритет eligibility. Снимок sessionmanager Go вместе с JSON-проекцией обработчика
определяет форму отчёта о возможностях; проверка хостом использует сгенерированные фикстуры
возможностей, а не создаёт второй источник истины отчёта. `Go rcisession/status.Values()`
генерирует общий JSON категорий ошибок и контракт TypeScript `as const`.

contracts/rci-session/fixtures/capability
  → frontend/host/src/services/fixtures/rci-session/capability
  → daemon/mndwd/internal/rcisession/testdata/capability

contracts/routing.md фиксирует владение маршрутами во время работы; это описание, а не второй
конфигурационный файл маршрутизатора.
```

Проверка манифестов во время работы остаётся в ведении Zod. JSON Schema — производный результат
для редакторов и инструментов. Тесты Go и TypeScript используют сгенерированные копии фикстур;
ни одна привязка не подключает и не импортирует файлы из другого модуля.

После изменения источника истины или канонической фикстуры запустите `pnpm generate-contracts`
из корня репозитория. Команда копирует файлы в отсортированном порядке и перезаписывает только
сгенерированные назначения. `pnpm generate-manifest-schema` остаётся совместимой обёрткой для
схемы манифеста.
