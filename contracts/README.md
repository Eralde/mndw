# mndw contract corpus

`contracts/` owns language-neutral evidence. Runtime authorities remain in
their language-specific packages:

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
