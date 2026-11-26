package run

import (
	"io"
	"os"
	"testing"
)

func TestMainArgumentErrors(t *testing.T) {
	tests := []struct {
		name       string
		args       []string
		wantOutput string
	}{
		{
			name:       "usage",
			wantOutput: "{\"success\":false,\"error\":\"USAGE\",\"message\":\"usage: dns-util lookup <hostname>\"}\n",
		},
		{
			name:       "unknown command",
			args:       []string{"status", ""},
			wantOutput: "{\"success\":false,\"error\":\"UNKNOWN_COMMAND\",\"message\":\"unknown subcommand: status\"}\n",
		},
		{
			name:       "invalid hostname encoding",
			args:       []string{"lookup", "%"},
			wantOutput: "{\"success\":false,\"error\":\"INVALID_HOSTNAME_ENCODING\",\"message\":\"hostname is not valid URL encoding\"}\n",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			originalStdout := os.Stdout

			output, err := os.CreateTemp(t.TempDir(), "dns-util-output-*.json")
			if err != nil {
				t.Fatal(err)
			}

			defer output.Close()

			os.Stdout = output

			defer func() {
				os.Stdout = originalStdout
			}()

			if exitCode := Main(tt.args); exitCode != 1 {
				t.Fatalf("Main() exit code = %d, want 1", exitCode)
			}

			if _, err := output.Seek(0, io.SeekStart); err != nil {
				t.Fatal(err)
			}

			gotOutput, err := io.ReadAll(output)
			if err != nil {
				t.Fatal(err)
			}

			if string(gotOutput) != tt.wantOutput {
				t.Fatalf("Main() output = %q, want %q", gotOutput, tt.wantOutput)
			}
		})
	}
}
