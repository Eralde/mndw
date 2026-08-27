// Command go-blanklr reformats Go source so adjacent statements of different
// semantic classes (assignment / call / control-flow) are separated by a blank
// line, mirroring the repo's ESLint `padding-line-between-statements` policy.
//
// It is a post-gofmt pass: gofmt canonicalizes first, then go-blanklr inserts
// blank lines between statements whose classes differ, then gofmt runs again to
// keep the result idempotent. gofmt never removes a single blank line between
// statements, so the inserted separators survive.
//
// Run:  go run ./tooling/go-blanklr -w ./daemon ./packages ./plugins
package main

import (
	"bytes"
	"flag"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// stmtClass is the semantic class of a statement. The blank-line policy is:
//
//   - assign -> assign:   no blank (a run of assignments may group)
//   - call   -> call:     no blank (a run of calls may group)
//   - control -> control: blank (control statements separate from each other)
//   - anything -> control:    blank
//   - control  -> anything:   blank
//   - assign <-> call:        blank
//   - anything -> return:     blank (return is control)
//
// Equivalently: insert a blank unless both statements share a class AND that
// class is assign or call. This mirrors the repo ESLint `padding-line-between-
// statements` matrix where `*: if/for/switch/try` + `if/for/switch/try -> *`
// always blank, `const/let/var -> const/let/var` is `any`, and `*: return`
// always blanks.
type stmtClass int

const (
	cAssign  stmtClass = iota // assignments, var/const decls, inc/dec, channel send
	cCall                     // expression statements (calls, receives)
	cControl                  // if/for/range/switch/type-switch/select/return/branch/defer/go/block
	cCase                     // switch/select clause headers — group with each other (no blank between cases)
)

func (c stmtClass) String() string {
	switch c {
	case cAssign:
		return "assign"
	case cCall:
		return "call"
	default:
		return "control"
	}
}

// classify maps a statement node to its class. Unknown shapes default to
// cControl so anything not explicitly grouped gets separated (safe default).
func classify(s ast.Stmt) stmtClass {
	switch n := s.(type) {
	case *ast.AssignStmt, *ast.IncDecStmt, *ast.SendStmt:
		return cAssign
	case *ast.DeclStmt:
		if d, ok := n.Decl.(*ast.GenDecl); ok {
			switch d.Tok {
			case token.VAR, token.CONST, token.IMPORT:
				return cAssign
			case token.TYPE:
				return cControl
			}
		}

		return cControl
	case *ast.ExprStmt:
		return cCall
	case *ast.CaseClause, *ast.CommClause:
		return cCase
	case *ast.IfStmt, *ast.ForStmt, *ast.RangeStmt, *ast.SwitchStmt,
		*ast.TypeSwitchStmt, *ast.SelectStmt, *ast.ReturnStmt,
		*ast.BranchStmt, *ast.DeferStmt, *ast.GoStmt, *ast.BlockStmt:
		return cControl
	case *ast.LabeledStmt:
		return classify(n.Stmt)
	case *ast.EmptyStmt:
		return cControl
	}

	return cControl
}

// needBlank reports whether a blank line should separate two adjacent
// statements of the given classes per the policy above.
func needBlank(prev, cur stmtClass) bool {
	if prev == cur {
		switch prev {
		case cAssign, cCall, cCase:
			return false
		}
	}

	return true
}

// isErrGuard reports whether the (prev, cur) pair is the idiomatic Go
// "x, err := f(); if err != nil { ... }" error-guard. The assignment and its
// immediate error check are a single semantic unit, so no blank line separates
// them even though assign→control would normally require one.
//
// Recognized shapes:
//   - prev is an *ast.AssignStmt binding at least one identifier named "err"
//     (covers `err := f()`, `x, err := f()`, and `err = f()` reassignment);
//   - cur is an *ast.IfStmt whose condition references the "err" identifier
//     (covers `err != nil`, `err == nil`, `errors.Is(err, ...)`, `if err != nil { ... }`,
//     and compound conditions that still name err).
//
// The `if` body is irrelevant (return, log+continue, etc.) — only that the
// guard directly follows the call whose error it checks.
func isErrGuard(prev, cur ast.Stmt) bool {
	assign, ok := prev.(*ast.AssignStmt)

	if !ok {
		return false
	}

	ifStmt, ok := cur.(*ast.IfStmt)

	if !ok || ifStmt.Cond == nil {
		return false
	}

	if !bindsIdent(assign.Lhs, "err") {
		return false
	}

	return referencesIdent(ifStmt.Cond, "err")
}

// bindsIdent reports whether any expression in lhs is an identifier with the
// given name (covers `err`, `x, err`, `err, ok`).
func bindsIdent(lhs []ast.Expr, name string) bool {
	for _, e := range lhs {
		if id, ok := e.(*ast.Ident); ok && id.Name == name {
			return true
		}
	}

	return false
}

// referencesIdent reports whether expr contains any identifier with the given
// name. Walks the whole expression so `errors.Is(err, target)` and compound
// conditions (`err != nil && ready`) both match.
func referencesIdent(expr ast.Node, name string) bool {
	found := false

	ast.Inspect(expr, func(n ast.Node) bool {
		if id, ok := n.(*ast.Ident); ok && id.Name == name {
			found = true

			return false
		}

		return !found
	})

	return found
}

// classifyDecl maps a top-level declaration to a class (used with --top).
func classifyDecl(d ast.Decl) stmtClass {
	switch n := d.(type) {
	case *ast.GenDecl:
		switch n.Tok {
		case token.VAR, token.CONST, token.IMPORT:
			return cAssign
		case token.TYPE:
			return cControl
		}

		return cControl
	case *ast.FuncDecl:
		return cControl
	}

	return cControl
}

// formatFile applies the blank-line policy to src and returns the reformatted
// bytes. It is idempotent: running it twice yields the same output.
func formatFile(src []byte, opts options) ([]byte, error) {
	// 1. gofmt canonicalizes spacing/alignment so line numbers are stable.
	canonical, err := format.Source(src)

	if err != nil {
		return nil, fmt.Errorf("gofmt: %w", err)
	}

	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "", canonical, parser.ParseComments)

	if err != nil {
		return nil, fmt.Errorf("parse: %w", err)
	}

	// 2. Collect every "insert blank before line L" target.
	inserts := map[int]bool{}
	collect := func(stmts []ast.Stmt) {
		for i := 1; i < len(stmts); i++ {
			prev, cur := stmts[i-1], stmts[i]

			if isErrGuard(prev, cur) {
				continue
			}

			if !needBlank(classify(prev), classify(cur)) {
				continue
			}

			startLine := effectiveStartLine(fset, file, prev, cur)

			if startLine <= 1 {
				continue
			}

			inserts[startLine] = true
		}
	}

	ast.Inspect(file, func(n ast.Node) bool {
		switch v := n.(type) {
		case *ast.BlockStmt:
			collect(v.List)
		case *ast.CaseClause:
			collect(v.Body)
		case *ast.CommClause:
			collect(v.Body)
		}

		return true
	})

	if opts.topLevel {
		collectDecls(fset, file, inserts)
	}

	if len(inserts) == 0 {
		return canonical, nil
	}

	// 3. Apply insertions to the canonical text, largest line first so earlier
	//    indices stay valid as we splice.
	lines := strings.Split(string(canonical), "\n")
	targets := make([]int, 0, len(inserts))

	for l := range inserts {
		targets = append(targets, l)
	}

	sort.Sort(sort.Reverse(sort.IntSlice(targets)))

	for _, l := range targets {
		idx := l - 1 // insert "before line L" = at slice index L-1

		if idx <= 0 || idx > len(lines) {
			continue
		}

		// If the line immediately above (line L-1, slice idx-1) is already blank,
		// the separator exists — skip to avoid a double blank.
		if strings.TrimSpace(lines[idx-1]) == "" {
			continue
		}

		lines = append(lines[:idx], append([]string{""}, lines[idx:]...)...)
	}

	out := []byte(strings.Join(lines, "\n"))

	// 4. Final gofmt pass: cleans up any edge-case spacing and guarantees
	//    idempotency. It never strips a single blank line between statements.
	final, err := format.Source(out)

	if err != nil {
		// Should not happen — canonical was valid Go and we only inserted blanks.
		return nil, fmt.Errorf("final gofmt: %w", err)
	}

	return final, nil
}

// collectDecls handles top-level declarations when --top is set.
func collectDecls(fset *token.FileSet, file *ast.File, inserts map[int]bool) {
	decls := file.Decls

	for i := 1; i < len(decls); i++ {
		prev, cur := decls[i-1], decls[i]

		if !needBlank(classifyDecl(prev), classifyDecl(cur)) {
			continue
		}

		startLine := effectiveStartLineDecl(fset, file, prev, cur)

		if startLine <= 1 {
			continue
		}

		inserts[startLine] = true
	}
}

// effectiveStartLine returns the 1-indexed line where `cur` "logically" begins,
// including any leading comment group that sits between prev and cur. Inserting
// the blank before this line keeps attached comments with their statement.
func effectiveStartLine(fset *token.FileSet, file *ast.File, prev, cur ast.Stmt) int {
	prevEndLine := fset.Position(prev.End()).Line
	curStartLine := fset.Position(cur.Pos()).Line

	earliest := curStartLine

	for _, group := range file.Comments {
		gStart := fset.Position(group.Pos()).Line
		gEnd := fset.Position(group.End()).Line

		// A comment group is a leading comment of cur if it starts after prev's
		// last line and ends before cur's first line (excludes trailing comments
		// of prev which share prev's line, and same-line leading of cur).
		if gStart > prevEndLine && gEnd < curStartLine && gStart < earliest {
			earliest = gStart
		}
	}

	return earliest
}

// effectiveStartLineDecl is the top-level analogue of effectiveStartLine.
func effectiveStartLineDecl(fset *token.FileSet, file *ast.File, prev, cur ast.Decl) int {
	prevEndLine := fset.Position(prev.End()).Line
	curStartLine := fset.Position(cur.Pos()).Line

	earliest := curStartLine

	for _, group := range file.Comments {
		gStart := fset.Position(group.Pos()).Line
		gEnd := fset.Position(group.End()).Line

		if gStart > prevEndLine && gEnd < curStartLine && gStart < earliest {
			earliest = gStart
		}
	}

	return earliest
}

type options struct {
	topLevel bool
}

func main() {
	var (
		write    = flag.Bool("w", false, "write result to (source) file instead of stdout")
		list     = flag.Bool("l", false, "list files whose formatting would change")
		check    = flag.Bool("check", false, "list changed files and exit non-zero if any (CI mode)")
		topLevel = flag.Bool("top", false, "also separate top-level declarations (func/type/var/const/import)")
	)
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: go-blanklr [flags] path [path...]")
		fmt.Fprintln(os.Stderr, "flags:")
		flag.PrintDefaults()
	}

	flag.Parse()

	args := flag.Args()

	if len(args) == 0 {
		flag.Usage()
		os.Exit(2)
	}

	files, err := collectGoFiles(args)

	if err != nil {
		fmt.Fprintln(os.Stderr, "go-blanklr:", err)
		os.Exit(1)
	}

	opts := options{topLevel: *topLevel}
	changed := false

	for _, path := range files {
		src, err := os.ReadFile(path)

		if err != nil {
			fmt.Fprintln(os.Stderr, "go-blanklr:", err)
			os.Exit(1)
		}

		out, err := formatFile(src, opts)

		if err != nil {
			fmt.Fprintf(os.Stderr, "go-blanklr: %s: %v\n", path, err)
			os.Exit(1)
		}

		if bytes.Equal(src, out) {
			continue
		}

		changed = true

		switch {
		case *write:
			if err := os.WriteFile(path, out, 0o644); err != nil {
				fmt.Fprintln(os.Stderr, "go-blanklr:", err)
				os.Exit(1)
			}
		case *list, *check:
			fmt.Println(path)
		default:
			fmt.Print(string(out))
		}
	}

	if *check && changed {
		os.Exit(1)
	}
}

// collectGoFiles expands the given paths (files or directories) into a sorted
// list of *.go paths. Directories are walked recursively; testdata, vendor, and
// dot-prefixed directories are skipped.
func collectGoFiles(args []string) ([]string, error) {
	var out []string
	seen := map[string]bool{}

	for _, a := range args {
		info, err := os.Stat(a)

		if err != nil {
			return nil, err
		}

		if !info.IsDir() {
			if strings.HasSuffix(a, ".go") && !seen[a] {
				out = append(out, a)
				seen[a] = true
			}

			continue
		}

		err = filepath.WalkDir(a, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}

			if d.IsDir() {
				name := d.Name()

				if name == "testdata" || name == "vendor" || strings.HasPrefix(name, ".") {
					return filepath.SkipDir
				}

				return nil
			}

			if !strings.HasSuffix(path, ".go") || seen[path] {
				return nil
			}

			out = append(out, path)
			seen[path] = true

			return nil
		})

		if err != nil {
			return nil, err
		}
	}

	sort.Strings(out)

	return out, nil
}
