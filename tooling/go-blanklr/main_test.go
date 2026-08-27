package main

import (
	"bytes"
	"go/ast"
	"go/parser"
	"go/token"
	"strings"
	"testing"
)

// trim is a tiny helper so test cases can use indentation in the source without
// leading whitespace leaking into the Go literal. Each case is dedented by the
// leading whitespace of the first non-empty line.
func trim(t string) string {
	lines := strings.Split(t, "\n")

	// Drop a leading empty line (common when using backtick literals that start
	// with a newline for readability).
	if len(lines) > 0 && strings.TrimSpace(lines[0]) == "" {
		lines = lines[1:]
	}

	prefix := ""

	for _, l := range lines {
		if strings.TrimSpace(l) == "" {
			continue
		}

		rest := strings.TrimLeft(l, "\t")
		prefix = l[:len(l)-len(rest)]

		break
	}

	for i, l := range lines {
		lines[i] = strings.TrimPrefix(l, prefix)
	}

	return strings.Join(lines, "\n")
}

// wrap embeds a fragment (starting with a top-level construct like `func`) in a
// package so formatFile — which needs a complete file — can process it.
func wrap(fragment string) string {
	return "package p\n\n" + fragment
}

// norm trims trailing whitespace per line and collapses to a single trailing
// newline, so EOF quirks don't cause spurious mismatches.
func norm(s string) string {
	lines := strings.Split(s, "\n")

	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " \t")
	}

	for len(lines) > 1 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}

	return strings.Join(lines, "\n") + "\n"
}

func TestFormatFile(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{
			name: "assign then control gets blank",
			input: trim(`
				func f() {
					x := 1
					if x > 0 {
						return
					}
				}`),
			want: trim(`
				func f() {
					x := 1

					if x > 0 {
						return
					}
				}`),
		},
		{
			name: "call then control gets blank",
			input: trim(`
				func f() {
					doThing()
					if cond {
						return
					}
				}`),
			want: trim(`
				func f() {
					doThing()

					if cond {
						return
					}
				}`),
		},
		{
			name: "assign then call gets blank",
			input: trim(`
				func f() {
					x := 1
					doThing()
				}`),
			want: trim(`
				func f() {
					x := 1

					doThing()
				}`),
		},
		{
			name: "block of assignments stays grouped",
			input: trim(`
				func f() {
					x := 1
					y := 2
					z := x + y
				}`),
			want: trim(`
				func f() {
					x := 1
					y := 2
					z := x + y
				}`),
		},
		{
			name: "block of calls stays grouped",
			input: trim(`
				func f() {
					a()
					b()
					c()
				}`),
			want: trim(`
				func f() {
					a()
					b()
					c()
				}`),
		},
		{
			name: "control then control gets blank",
			input: trim(`
				func f() {
					if a {
						return
					}
					for i := 0; i < 10; i++ {
						g(i)
					}
				}`),
			want: trim(`
				func f() {
					if a {
						return
					}

					for i := 0; i < 10; i++ {
						g(i)
					}
				}`),
		},
		{
			name: "return is always preceded by blank",
			input: trim(`
				func f() {
					x := compute()
					return x
				}`),
			want: trim(`
				func f() {
					x := compute()

					return x
				}`),
		},
		{
			name: "leading comment stays with its statement",
			input: trim(`
				func f() {
					x := 1
					// cur needs a blank above the comment
					if x > 0 {
						return
					}
				}`),
			want: trim(`
				func f() {
					x := 1

					// cur needs a blank above the comment
					if x > 0 {
						return
					}
				}`),
		},
		{
			name: "trailing comment of prev is not detached",
			input: trim(`
				func f() {
					x := 1 // prev trailing
					doThing()
				}`),
			want: trim(`
				func f() {
					x := 1 // prev trailing

					doThing()
				}`),
		},
		{
			name: "switch case bodies are processed",
			input: trim(`
				func f(n int) {
					switch n {
					case 1:
						x := 10
						return x
					case 2:
						y := 20
						return y
					}
				}`),
			want: trim(`
				func f(n int) {
					switch n {
					case 1:
						x := 10

						return x
					case 2:
						y := 20

						return y
					}
				}`),
		},
		{
			name: "already separated is unchanged (idempotent)",
			input: trim(`
				func f() {
					x := 1

					if x > 0 {
						return
					}
				}`),
			want: trim(`
				func f() {
					x := 1

					if x > 0 {
						return
					}
				}`),
		},
		{
			name: "var/const decls group as assign",
			input: trim(`
				func f() {
					var a = 1
					var b = 2
					doThing()
				}`),
			want: trim(`
				func f() {
					var a = 1
					var b = 2

					doThing()
				}`),
		},
		{
			name: "defer is control",
			input: trim(`
				func f() {
					x := open()
					defer x.Close()
				}`),
			want: trim(`
				func f() {
					x := open()

					defer x.Close()
				}`),
		},
		{
			name: "nested blocks are processed",
			input: trim(`
				func f() {
					for i := 0; i < 3; i++ {
						v := compute(i)
						if v > 0 {
							g(v)
						}
					}
				}`),
			want: trim(`
				func f() {
					for i := 0; i < 3; i++ {
						v := compute(i)

						if v > 0 {
							g(v)
						}
					}
				}`),
		},
		{
			name: "err-guard assign+if stays joined (x, err := f())",
			input: trim(`
				func f() {
					x, err := doThing()
					if err != nil {
						return err
					}
					use(x)
				}`),
			want: trim(`
				func f() {
					x, err := doThing()
					if err != nil {
						return err
					}

					use(x)
				}`),
		},
		{
			name: "err-guard single err stays joined",
			input: trim(`
				func f() {
					err := doThing()
					if err != nil {
						return err
					}
				}`),
			want: trim(`
				func f() {
					err := doThing()
					if err != nil {
						return err
					}
				}`),
		},
		{
			name: "err-guard errors.Is stays joined",
			input: trim(`
				func f() error {
					_, err := doThing()
					if errors.Is(err, ErrGone) {
						return err
					}
					return nil
				}`),
			want: trim(`
				func f() error {
					_, err := doThing()
					if errors.Is(err, ErrGone) {
						return err
					}

					return nil
				}`),
		},
		{
			name: "non-err assign+if still gets blank",
			input: trim(`
				func f() {
					x := compute()
					if x > 0 {
						return
					}
				}`),
			want: trim(`
				func f() {
					x := compute()

					if x > 0 {
						return
					}
				}`),
		},
		{
			name: "err-guard compound condition stays joined",
			input: trim(`
				func f() {
					err := open()
					if err != nil && !closed {
						return err
					}
				}`),
			want: trim(`
				func f() {
					err := open()
					if err != nil && !closed {
						return err
					}
				}`),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := formatFile([]byte(wrap(tc.input)), options{})

			if err != nil {
				t.Fatalf("formatFile: %v", err)
			}

			if norm(string(got)) != norm(wrap(tc.want)) {
				t.Errorf("mismatch\n--- got ---\n%s\n--- want ---\n%s", got, wrap(tc.want))
			}
		})
	}
}

// TestIdempotent ensures formatting the output again produces no further change.
func TestIdempotent(t *testing.T) {
	cases := []string{
		wrap(trim(`
			func f() {
				x := 1
				if x > 0 {
					doThing()
					return
				}
			}`)),
		trim(`
			package p

			func a() { x := 1; doThing() }
			func b() {}`),
	}

	for i, src := range cases {
		once, err := formatFile([]byte(src), options{})

		if err != nil {
			t.Fatalf("case %d first pass: %v", i, err)
		}

		twice, err := formatFile(once, options{})

		if err != nil {
			t.Fatalf("case %d second pass: %v", i, err)
		}

		if !bytes.Equal(once, twice) {
			t.Errorf("case %d not idempotent\n--- once ---\n%s\n--- twice ---\n%s", i, once, twice)
		}
	}
}

func TestTopLevel(t *testing.T) {
	src := trim(`
		package p

		var X = 1
		func a() {}
	`)
	// With --top: var (assign) then func (control) -> blank between.
	want := trim(`
		package p

		var X = 1

		func a() {}
	`)
	got, err := formatFile([]byte(src), options{topLevel: true})

	if err != nil {
		t.Fatalf("formatFile: %v", err)
	}

	if norm(string(got)) != norm(want) {
		t.Errorf("mismatch\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

func TestClassify(t *testing.T) {
	// Sanity-check the classifier on representative node types, by parsing a
	// tiny function body and classifying its first statement.
	checks := []struct {
		body string
		want stmtClass
	}{
		{`x := 1`, cAssign},
		{`x++`, cAssign},
		{`ch <- 1`, cAssign},
		{`var a = 1`, cAssign},
		{`const k = 2`, cAssign},
		{`doThing()`, cCall},
		{`if x { return }`, cControl},
		{`for i := 0; i < 1; i++ {}`, cControl},
		{`return`, cControl},
		{`defer g()`, cControl},
		{`go g()`, cControl},
		{`break`, cControl},
	}

	for _, c := range checks {
		got := classifyFirstBodyStmt(t, c.body)

		if got != c.want {
			t.Errorf("classify(%q) = %s, want %s", c.body, got, c.want)
		}
	}
}

// classifyFirstBodyStmt wraps `body` in `func f(){ <body> }`, parses it, and
// returns the class of the first statement in f's body.
func classifyFirstBodyStmt(t *testing.T, body string) stmtClass {
	t.Helper()

	src := "package p\nfunc f(){\n" + body + "\n}\n"
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "src.go", src, 0)

	if err != nil {
		t.Fatalf("parse %q: %v", body, err)
	}

	fn, ok := file.Decls[0].(*ast.FuncDecl)

	if !ok || fn.Body == nil || len(fn.Body.List) == 0 {
		t.Fatalf("no body stmt in %q", body)
	}

	return classify(fn.Body.List[0])
}
