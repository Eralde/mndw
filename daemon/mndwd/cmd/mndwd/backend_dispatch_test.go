package main

import (
	"bytes"
	"reflect"
	"strings"
	"testing"
)

func TestDispatchBackend(t *testing.T) {
	var gotArgs []string
	var gotProcessNames []string
	calls := 0
	entries := []backendEntry{
		{
			name: "known-a",
			main: func(args []string) int {
				calls++
				gotArgs = append([]string(nil), args...)

				return 17
			},
		},
		{
			name: "known-b",
			main: func([]string) int {
				return 0
			},
		},
	}

	tests := []struct {
		name                 string
		args                 []string
		wantHandled          bool
		wantExitCode         int
		wantBackendCallCount int
		wantArgs             []string
		wantProcessNames     []string
		wantErrorNames       bool
	}{
		{
			name: "daemon invocation is not handled",
			args: []string{"--version"},
		},
		{
			name:           "backend without name is invalid",
			args:           []string{"backend"},
			wantHandled:    true,
			wantExitCode:   2,
			wantErrorNames: true,
		},
		{
			name:           "unknown backend is invalid",
			args:           []string{"backend", "missing"},
			wantHandled:    true,
			wantExitCode:   2,
			wantErrorNames: true,
		},
		{
			name:                 "known backend receives trailing arguments and exit code",
			args:                 []string{"backend", "known-a", "--flag", "value"},
			wantHandled:          true,
			wantExitCode:         17,
			wantBackendCallCount: 1,
			wantArgs:             []string{"--flag", "value"},
			wantProcessNames:     []string{"known-a"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			calls = 0
			gotArgs = nil
			gotProcessNames = nil
			var stderr bytes.Buffer

			handled, exitCode := dispatchBackend(test.args, entries, &stderr, func(name string) {
				gotProcessNames = append(gotProcessNames, name)
			})

			if handled != test.wantHandled {
				t.Fatalf("handled = %t, want %t", handled, test.wantHandled)
			}

			if exitCode != test.wantExitCode {
				t.Fatalf("exit code = %d, want %d", exitCode, test.wantExitCode)
			}

			if calls != test.wantBackendCallCount {
				t.Fatalf("backend calls = %d, want %d", calls, test.wantBackendCallCount)
			}

			if !reflect.DeepEqual(gotArgs, test.wantArgs) {
				t.Fatalf("backend args = %#v, want %#v", gotArgs, test.wantArgs)
			}

			if !reflect.DeepEqual(gotProcessNames, test.wantProcessNames) {
				t.Fatalf("process names = %#v, want %#v", gotProcessNames, test.wantProcessNames)
			}

			if test.wantErrorNames {
				output := stderr.String()

				if strings.Count(output, "\n") != 1 {
					t.Fatalf("stderr = %q, want one line", output)
				}

				for _, name := range []string{"known-a", "known-b"} {
					if !strings.Contains(output, name) {
						t.Fatalf("stderr = %q, want known name %q", output, name)
					}
				}
			} else if stderr.Len() != 0 {
				t.Fatalf("stderr = %q, want empty", stderr.String())
			}
		})
	}
}

func TestBuiltinBackendEntriesHaveExpectedNames(t *testing.T) {
	got := make([]string, 0, len(builtinBackendEntries))

	for _, entry := range builtinBackendEntries {
		got = append(got, entry.name)
	}

	want := []string{"terminal-backend", "mwsd", "dns-util"}

	if !reflect.DeepEqual(got, want) {
		t.Fatalf("builtin backend names = %#v, want %#v", got, want)
	}
}
