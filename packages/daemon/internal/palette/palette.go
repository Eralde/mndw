// Package palette owns palette.json: the device's optional colour-palette override.
package palette

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

var hexPattern = regexp.MustCompile(`^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$`)

type ThemeTokens struct {
	Bg             string `json:"bg"`
	Surface        string `json:"surface"`
	SurfaceRaised  string `json:"surfaceRaised"`
	Border         string `json:"border"`
	TextSubtle     string `json:"textSubtle"`
	TextMuted      string `json:"textMuted"`
	Text           string `json:"text"`
	Accent         string `json:"accent"`
	AccentHover    string `json:"accentHover"`
	AccentContrast string `json:"accentContrast"`
	Danger         string `json:"danger"`
	DangerBg       string `json:"dangerBg"`
	Success        string `json:"success"`
	SuccessBg      string `json:"successBg"`
	Warning        string `json:"warning"`
	WarningBg      string `json:"warningBg"`
	Info           string `json:"info"`
	InfoBg         string `json:"infoBg"`
	FocusRing      string `json:"focusRing"`
	SurfaceHover   string `json:"surfaceHover"`
	ShadowColor    string `json:"shadowColor"`
}

type Palette struct {
	Dark  ThemeTokens `json:"dark"`
	Light ThemeTokens `json:"light"`
}

func (t ThemeTokens) named() [][2]string {
	return [][2]string{
		{"bg", t.Bg},
		{"surface", t.Surface},
		{"surfaceRaised", t.SurfaceRaised},
		{"border", t.Border},
		{"textSubtle", t.TextSubtle},
		{"textMuted", t.TextMuted},
		{"text", t.Text},
		{"accent", t.Accent},
		{"accentHover", t.AccentHover},
		{"accentContrast", t.AccentContrast},
		{"danger", t.Danger},
		{"dangerBg", t.DangerBg},
		{"success", t.Success},
		{"successBg", t.SuccessBg},
		{"warning", t.Warning},
		{"warningBg", t.WarningBg},
		{"info", t.Info},
		{"infoBg", t.InfoBg},
		{"focusRing", t.FocusRing},
		{"surfaceHover", t.SurfaceHover},
		{"shadowColor", t.ShadowColor},
	}
}

func validate(p Palette) error {
	var problems []string

	for _, theme := range []struct {
		name   string
		tokens ThemeTokens
	}{{"dark", p.Dark}, {"light", p.Light}} {
		empty := 0

		for _, entry := range theme.tokens.named() {
			key, value := entry[0], entry[1]

			if value == "" {
				empty++

				continue
			}

			if !hexPattern.MatchString(value) {
				problems = append(problems, fmt.Sprintf(
					"%s.%s must be a hex colour like #1a2b3c, got %q", theme.name, key, value))
			}
		}

		if empty == len(theme.tokens.named()) {
			problems = append(problems, fmt.Sprintf("%s theme is missing", theme.name))

			continue
		}

		for _, entry := range theme.tokens.named() {
			if entry[1] == "" {
				problems = append(problems, fmt.Sprintf("%s.%s is missing", theme.name, entry[0]))
			}
		}
	}

	if len(problems) > 0 {
		return errors.New(strings.Join(problems, "; "))
	}

	return nil
}
