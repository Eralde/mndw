# mndw contract corpus

`contracts/` owns language-neutral evidence. Runtime authorities remain in
their language-specific packages:

```text
frontend/sdk-internal/src/manifest-schema.ts
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

frontend/sdk-internal/src/shared-dependencies.ts
  → contracts/protocol/shared-deps.json
  → contracts/protocol/*.golden.json

contracts/protocol/*.golden.json
  → daemon/contracts-go/fixtures/protocol

contracts/mws-member/fixtures
  → frontend/sdk/fixtures/mws-members
  → packages/go-mws-members/fixtures

The Zod member schema in `frontend/sdk-internal/src/mws-member-schema.ts` owns member
input shape and eligibility precedence. The Go sessionmanager snapshot plus
handler JSON projection owns the capability-report shape; host runtime
validation consumes generated capability fixtures rather than becoming a
second report authority. Go `rcisession/status.Values()` generates the shared
failure-category JSON and TypeScript `as const` contract.

contracts/rci-session/fixtures/capability
  → frontend/host/src/services/fixtures/rci-session/capability
  → daemon/mndwd/internal/rcisession/testdata/capability

frontend/sdk/src/permissions.ts + frontend/sdk/src/event-schema.ts (EVENT_PERMISSION_PATTERN),
reached by build tooling through `frontend/sdk-internal/src/sdk-source.ts`
  → daemon/contracts-go/manifest/permissions_generated.go

contracts/mgmt/fixtures
  → daemon/mndwd/internal/mgmt/fixtures/mgmt
  → frontend/host/src/runtime/fixtures/mgmt

contracts/routing.md records runtime route ownership; it is descriptive, not a
second router configuration.
```

Manifest validation remains Zod-owned at runtime. JSON Schema is an
editor/tooling output. Go and TypeScript tests consume generated copies of
fixtures; neither binding mounts or imports files from another module.

Run `pnpm generate-contracts` from repository root after changing an authority
or a canonical fixture. The command copies files in sorted order and rewrites
only its generated destinations. `pnpm generate-manifest-schema` remains a
manifest-schema compatibility wrapper.

`contracts/mgmt/fixtures` is golden evidence for the management list-entry wire
shape. The Go handler test (`internal/mgmt/wire_contract_test.go`) seeds fixed
state and requires `GET /api/mgmt/list`, `GET /api/mgmt/pending`, and
`POST /api/mgmt/permission` to match the golden evidence. The host test
(`frontend/host/src/runtime/mgmt-wire-contract.test.ts`) requires each golden to
decode losslessly; that is the cross-language gate. A Go reflection test
requires every JSON field of `ListEntry` (nested types included) to appear in at
least one golden, so a new optional field must be seeded before it can pass.
`enums.json` is handwritten:
`source`, `approval`, and `runtimeState` must equal the daemon constants (the Go
test finds them by parsing `internal/state` and `internal/backend`) and the host
Zod enums. `depsStatus` lists the host-accepted set; the daemon currently emits
only `ready`.

When the wire shape changes, update the Go struct and the Zod schema, then
regenerate the goldens and review the diff:

    (cd daemon/mndwd && GOCACHE="$PWD/../../.cache/go-build" go test ./internal/mgmt -run TestWireGoldenFixtures -update)
    pnpm generate-contracts
