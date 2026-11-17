package opkg

import (
	"slices"
	"testing"
)

func TestParseNames(t *testing.T) {
	out := "curl - 8.0.1-1 - a tool\nttyd - 1.7.4 - terminal\n\n"
	got := parseNames(out)

	if !slices.Equal(got, []string{"curl", "ttyd"}) {
		t.Errorf("parseNames = %v, want [curl ttyd]", got)
	}
}

func TestParseNamesIgnoresArchitectureWarnings(t *testing.T) {
	out := "Package mndw version 0.0.1 has no valid architecture, ignoring.\n" +
		"curl - 8.0.1-1 - a tool\n"

	got := parseNames(out)

	if !slices.Equal(got, []string{"curl"}) {
		t.Errorf("parseNames = %v, want [curl]", got)
	}
}

func TestParseEntries(t *testing.T) {
	tests := []struct {
		name    string
		output  string
		wantLen int
		wantErr bool
	}{
		{name: "valid with description", output: "curl - 8.0.1-1 - Client URL retrieval utility\r\n", wantLen: 1},
		{name: "valid without description", output: "antiscan2 - 2-alpha18\n", wantLen: 1},
		{name: "separator in description", output: "pkg - 1.0-1 - desc - with separator\n", wantLen: 1},
		{name: "empty description", output: "pkg - 1.0-1 - \n", wantLen: 1},
		{name: "missing version separator", output: "pkg 1.0-1\n", wantErr: true},
		{name: "empty name", output: " - 1.0-1 - desc\n", wantErr: true},
		{name: "empty version", output: "pkg -  - desc\n", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseEntries(tt.output)
			if (err != nil) != tt.wantErr {
				t.Fatalf("parseEntries() error = %v, wantErr %v", err, tt.wantErr)
			}

			if err == nil && len(got) != tt.wantLen {
				t.Fatalf("len(parseEntries()) = %d, want %d", len(got), tt.wantLen)
			}
		})
	}
}

func TestParseInfoBlocksSelectsInstalledExactBlock(t *testing.T) {
	out := "Package: curl\nVersion: 8.0.1-1\nDescription: Feed description\nSize: 100\nDepends: libc, libcurl | libssl\n\n" +
		"Package: curl\nVersion: 7.55.1-1\nDescription: Installed description\nSize: 90\nDepends: libc, libcurl | libssl\n"
	blocks, err := parseInfoBlocks(out)
	if err != nil {
		t.Fatal(err)
	}

	got, err := selectInfoBlock(blocks, "curl", "7.55.1-1")
	if err != nil {
		t.Fatal(err)
	}

	if got.Version != "7.55.1-1" || got.Description != "Installed description" {
		t.Fatalf("selected block = %+v", got)
	}

	if !slices.Equal(got.Dependencies, []string{"libc", "libcurl | libssl"}) {
		t.Fatalf("dependencies = %v", got.Dependencies)
	}
}

func TestParseInfoBlocksFallsBackToFirstFeedBlock(t *testing.T) {
	out := "Package: curl\nVersion: 8.0.1-1\nDescription: First\n\nPackage: curl\nVersion: 9.0.0-1\nDescription: Second\n"
	blocks, err := parseInfoBlocks(out)
	if err != nil {
		t.Fatal(err)
	}

	got, err := selectInfoBlock(blocks, "curl", "")
	if err != nil {
		t.Fatal(err)
	}

	if got.Version != "8.0.1-1" {
		t.Fatalf("selected version = %q", got.Version)
	}
}

func TestParseInfoBlocksAcceptsDescriptionContinuationLines(t *testing.T) {
	out := "Package: antiscan2\nVersion: 2-alpha26\nDescription: Anti-scan utility\n /opt/etc/antiscan/ascn.conf 81f1eaf851c2d60ce907bc59c1061f0a3cb52813e1879f0b1bad7d9721f78601\nSize: 123\n"

	blocks, err := parseInfoBlocks(out)
	if err != nil {
		t.Fatal(err)
	}

	if len(blocks) != 1 {
		t.Fatalf("len(blocks) = %d, want 1", len(blocks))
	}

	if blocks[0].Description != "Anti-scan utility\n/opt/etc/antiscan/ascn.conf 81f1eaf851c2d60ce907bc59c1061f0a3cb52813e1879f0b1bad7d9721f78601" {
		t.Fatalf("description = %q", blocks[0].Description)
	}
}

func TestParseInfoBlocksAcceptsConffilesListLines(t *testing.T) {
	out := "Package: antiscan2\n" +
		"Version: 2.0-alpha26\n" +
		"Status: install ok installed\n" +
		"Architecture: aarch64-3.10\n" +
		"Size: 74141\n" +
		"Conffiles:\n" +
		" /opt/etc/antiscan/ascn.conf 81f1eaf851c2d60ce907bc59c1061f0a3cb52813e1879f0b1bad7d9721f78601\n" +
		" /opt/etc/antiscan/ascn_crontab.conf 2ea489b2c8a2cafbb982101a0defb40afe15cb6b47b0e526ea81037f26bc9706\n" +
		"Description: Antiscan2 utility\n" +
		"Installed-Time: 1787315636\n"

	blocks, err := parseInfoBlocks(out)
	if err != nil {
		t.Fatal(err)
	}

	if len(blocks) != 1 {
		t.Fatalf("len(blocks) = %d, want 1", len(blocks))
	}

	if blocks[0].Description != "Antiscan2 utility" {
		t.Fatalf("description = %q", blocks[0].Description)
	}

	if blocks[0].InstalledTime != "1787315636" {
		t.Fatalf("installed time = %q", blocks[0].InstalledTime)
	}
}

func TestParseInfoBlocksAcceptsUnindentedDescriptionContinuationLines(t *testing.T) {
	out := "Package: antiscan2\nVersion: 2-alpha26\nDescription: Anti-scan utility\n/opt/etc/antiscan/ascn.conf 81f1eaf851c2d60ce907bc59c1061f0a3cb52813e1879f0b1bad7d9721f78601\nSize: 123\n"

	blocks, err := parseInfoBlocks(out)
	if err != nil {
		t.Fatal(err)
	}

	if len(blocks) != 1 {
		t.Fatalf("len(blocks) = %d, want 1", len(blocks))
	}

	if blocks[0].Description == "" {
		t.Fatal("description is empty")
	}
}

func TestDetectDependents(t *testing.T) {
	tests := []struct {
		name       string
		out        string
		wantPkg    string
		wantDepend []string
		wantNil    bool
	}{
		{
			name:    "no warning",
			out:     "Removing package curl from root...\n",
			wantNil: true,
		},
		{
			name:       "plain warning",
			out:        "Package curl is depended upon by packages:\n\twget-ssl\n\tThese might cease to work if package curl is removed.\n",
			wantPkg:    "curl",
			wantDepend: []string{"wget-ssl"},
		},
		{
			// The device's opkg prefixes EVERY line — dependent names and the advisory
			// lines included — with the " * <function>: " collected-error decoration.
			name: "collected-errors label on every line",
			out: "Collected errors:\n" +
				" * print_dependents_warning: Package curl is depended upon by packages:\n" +
				" * print_dependents_warning: \twget-ssl\n" +
				" * print_dependents_warning: \taria2\n" +
				" * print_dependents_warning: These might cease to work if package curl is removed.\n" +
				" * print_dependents_warning: Force removal of this package via --force-depends\n" +
				" * print_dependents_warning: Force removal of this and dependent packages via --force-removal-of-dependent-packages\n",
			wantPkg:    "curl",
			wantDepend: []string{"wget-ssl", "aria2"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := detectDependents(tt.out)

			if tt.wantNil {
				if got != nil {
					t.Fatalf("detectDependents = %v, want nil", got)
				}

				return
			}

			if got == nil {
				t.Fatal("detectDependents = nil, want conflict")
			}

			if got.Package != tt.wantPkg {
				t.Errorf("package = %q, want %q", got.Package, tt.wantPkg)
			}

			if !slices.Equal(got.DependedBy, tt.wantDepend) {
				t.Errorf("dependedBy = %v, want %v", got.DependedBy, tt.wantDepend)
			}
		})
	}
}
