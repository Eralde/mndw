# go-blanklr

**English** | [Русский](README.ru.md)

Post-`gofmt` reformatter that inserts blank lines between adjacent Go statements
of different semantic classes, mirroring the repo's ESLint
`padding-line-between-statements` policy for TypeScript.

`gofmt` handles indentation/alignment but has no blank-line policy. Go has no
ESLint equivalent. `go-blanklr` fills that gap.

## Policy

Each statement is classified as one of:

| class     | statements                                                            |
| --------- | -------------------------------------------------------------------- |
| `assign`  | `AssignStmt`, `IncDecStmt`, `SendStmt` (`ch <- v`), `var`/`const` decls |
| `call`    | `ExprStmt` (calls, receives, bare expressions)                       |
| `control` | `if`/`for`/`range`/`switch`/`type-switch`/`select`/`return`/`break`/`continue`/`goto`/`fallthrough`/`defer`/`go`/bare-`{}`/type decl; `LabeledStmt` by its inner statement |
| `case`    | `case`/`default`/`comm` clause headers (group with each other)         |

A blank line is inserted between two adjacent statements **unless** they share a
class that groups:

- `assign` → `assign`: no blank (a run of assignments may group)
- `call` → `call`: no blank (a run of calls may group)
- `case` → `case`: no blank (cases group)
- everything else: **blank**

### Err-guard exception

The Go idiom `x, err := f(); if err != nil { … }` is **not** separated — the
assignment and its immediate error check are one semantic unit, so no blank line
goes between them even though `assign → control` would normally require one.
Recognized when `prev` is an `AssignStmt` binding an identifier named `err` and
`cur` is the following `IfStmt` whose condition names `err` (covers
`err != nil`, `err == nil`, `errors.Is(err, …)`, and compound guards). A
non-`err` assign-then-if (`x := f(); if x > 0`) still gets a blank.

This single rule encodes the ESLint matrix:
`*: if/for/switch/try` + `if/for/switch/try → *` (control always separated),
`const/let/var → const/let/var` is `any` (group), `*: return` (return is
control), and assign↔call separation.

`case` is its own grouping class so `switch`/`select` arms are **not** forcibly
separated from each other; only the statements *inside* each arm are processed.

## Algorithm

1. `gofmt` the file (canonicalize spacing/alignment so line numbers are stable).
2. Parse with comments.
3. Walk every `BlockStmt`, `CaseClause.Body`, `CommClause.Body` (and top-level
   `Decls` with `--top`). For each adjacent pair whose classes require a blank,
   record the target line.
4. The target line is the statement's *effective start* — including any leading
   comment group between the prev statement and this one — so inserted blanks
   never detach a `// comment` from its statement.
5. Splice in the blanks (largest line first to keep earlier indices valid).
6. `gofmt` again. `gofmt` never strips a single blank line between statements, so
   the result is idempotent.

## CLI

```
go run ./tooling/go-blanklr [flags] path [path...]
```

| flag     | behavior                                                       |
| -------- | ------------------------------------------------------------- |
| (none)   | print reformatted source to stdout                            |
| `-w`     | write result back to the file(s) in place                     |
| `-l`     | list files whose formatting would change                      |
| `--check`| list changed files and exit non-zero if any (CI mode)         |
| `--top`  | also separate top-level declarations (func/type/var/const/import) |

Paths may be files or directories; directories are walked recursively
(`testdata/`, `vendor/`, and dot-prefixed dirs are skipped).

> **Note:** the module is stdlib-only and listed in the repo `go.work` purely so
> `go run ./tooling/go-blanklr` and `go test ./tooling/go-blanklr/...` resolve
> from the repo root. It has no dependencies and nothing imports it, so it never
> affects daemon/plugin builds or `go work sync`.

## Wiring

### pnpm scripts

```bash
pnpm fmt:go                         # writes — default daemon/packages/plugins roots
pnpm fmt:go -- daemon/mndwd         # writes — only this Go directory
pnpm fmt:go:check -- daemon/mndwd   # CI — checks only this Go directory
```

With explicit paths, scripts replace default roots rather than adding to them.
Root scripts delegate argument handling to `build/fmt-go.sh`. It accepts either
`pnpm fmt:go path` or `pnpm fmt:go -- path` syntax.
Both use a repo-local `GOCACHE` for sandbox reproducibility.

### Pre-commit (optional)

There is no husky/lefthook in this repo. To gate locally, drop this in
`.git/hooks/pre-commit` and `chmod +x` it:

```sh
#!/usr/bin/env sh
cd "$(git rev-parse --show-toplevel)"
pnpm fmt:go:check
```

Or stage and run `pnpm fmt:go` manually before committing.

## Limitations / taste

- Comment association is purely positional (comments between two statements
  attach to the following statement). Doc comments on declarations are not
  reflowed; only blank-line insertion is performed.
- No autofix for `--check`; it reports only. The `pnpm fmt:go` write pass is the
  fix.

## Tests

```bash
GOCACHE=<repo>/.cache/go-build go test ./tooling/go-blanklr/...
```

Cover: the policy matrix, the err-guard exception (joined, `errors.Is`, compound
guard, and the negative non-`err` case), comment attachment (leading + trailing),
nested blocks, switch/select arms, idempotency, `--top`, and the classifier unit
table.
