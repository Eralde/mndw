package palette

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const paletteFixturesDir = "../../../sdk/fixtures/palettes"

func valid() Palette {
	tokens := ThemeTokens{
		Bg: "#000000", Surface: "#010101", SurfaceRaised: "#020202", Border: "#030303",
		TextSubtle: "#040404", TextMuted: "#050505", Text: "#ffffff", Accent: "#016ca5",
		AccentHover: "#2b84bf", AccentContrast: "#ffffff", Danger: "#c5001b",
		DangerBg: "#ffd2cc", Success: "#5cb572", SuccessBg: "#d8f3dc", Warning: "#efa831",
		WarningBg: "#fff0c2", Info: "#016ca5", InfoBg: "#d6efff", FocusRing: "#2b84bf",
		SurfaceHover: "#040404", ShadowColor: "#0000002e",
	}

	return Palette{Dark: tokens, Light: tokens}
}

func TestValidateAcceptsWellFormed(t *testing.T) {
	if err := validate(valid()); err != nil {
		t.Fatalf("validate(valid()) = %v, want nil", err)
	}
}

func TestValidateAcceptsAllHexLengths(t *testing.T) {
	for _, hex := range []string{"#abc", "#aabbcc", "#aabbccdd", "#ABC", "#AABBCCDD"} {
		p := valid()
		p.Dark.Warning = hex

		if err := validate(p); err != nil {
			t.Errorf("validate with warning=%q = %v, want nil", hex, err)
		}
	}
}

func TestValidateRejectsMissingToken(t *testing.T) {
	p := valid()
	p.Dark.Accent = ""

	err := validate(p)
	if err == nil {
		t.Fatal("validate with empty dark.accent = nil, want error")
	}
	if !strings.Contains(err.Error(), "dark.accent") {
		t.Errorf("error %q does not name the offending token", err)
	}
}

func TestValidateRejectsEmptyTheme(t *testing.T) {
	p := valid()
	p.Light = ThemeTokens{}

	err := validate(p)
	if err == nil {
		t.Fatal("validate with an empty light theme = nil, want error")
	}
	if !strings.Contains(err.Error(), "light") {
		t.Errorf("error %q does not name the offending theme", err)
	}
}

func TestValidateRejectsBadHex(t *testing.T) {
	for _, hex := range []string{"rebeccapurple", "#12345", "ffffff", "#gggggg", "#"} {
		p := valid()
		p.Light.Text = hex

		if err := validate(p); err == nil {
			t.Errorf("validate with text=%q = nil, want error", hex)
		}
	}
}

func TestValidateSharedFixtureCorpus(t *testing.T) {
	for _, kind := range []string{"valid", "invalid"} {
		entries, err := os.ReadDir(filepath.Join(paletteFixturesDir, kind))
		if err != nil {
			t.Fatalf("read %s palette fixtures: %v", kind, err)
		}

		if len(entries) == 0 {
			t.Fatalf("no %s palette fixtures found", kind)
		}

		for _, entry := range entries {
			if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
				continue
			}

			t.Run(fmt.Sprintf("%s/%s", kind, entry.Name()), func(t *testing.T) {
				data, err := os.ReadFile(filepath.Join(paletteFixturesDir, kind, entry.Name()))
				if err != nil {
					t.Fatalf("read fixture: %v", err)
				}

				var palette Palette
				decoder := json.NewDecoder(bytes.NewReader(data))
				decoder.DisallowUnknownFields()
				decodeErr := decoder.Decode(&palette)
				validateErr := decodeErr

				if decodeErr == nil {
					validateErr = validate(palette)
				}

				if kind == "valid" && validateErr != nil {
					t.Fatalf("valid fixture rejected: %v", validateErr)
				}
				if kind == "invalid" && validateErr == nil {
					t.Fatal("invalid fixture accepted")
				}
			})
		}
	}
}
