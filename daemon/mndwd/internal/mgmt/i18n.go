package mgmt

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"sort"

	"mndwd/internal/manifest"
)

// validateCatalogArchive checks catalog files without interpreting their message
// values. ICU grammar remains a CLI concern; the daemon only protects archive
// shape, declared paths, and bounded reads.
func (h *Handler) validateCatalogArchive(zr *zip.Reader, m *manifest.Manifest) error {
	if m == nil || m.I18n == nil {
		return nil
	}

	locales := make([]string, 0, len(m.I18n.Locales))

	for locale := range m.I18n.Locales {
		locales = append(locales, locale)
	}

	sort.Strings(locales)

	for _, locale := range locales {
		declaredPath := m.I18n.Locales[locale]
		file := archiveFile(zr, declaredPath)

		if file == nil {
			return fmt.Errorf("catalog for locale %q is missing at %q", locale, declaredPath)
		}

		catalog, err := h.readCatalogFile(file)
		if err != nil {
			return fmt.Errorf("catalog for locale %q at %q is invalid: %w", locale, declaredPath, err)
		}

		if err := validateCatalogValues(catalog, ""); err != nil {
			return fmt.Errorf("catalog for locale %q at %q is invalid: %w", locale, declaredPath, err)
		}
	}

	return nil
}

func validateCatalogValues(catalog map[string]json.RawMessage, prefix string) error {
	for key, value := range catalog {
		fullKey := key

		if prefix != "" {
			fullKey = prefix + "." + key
		}

		var message *string

		if err := json.Unmarshal(value, &message); err == nil && message != nil {
			continue
		}

		var nested map[string]json.RawMessage

		if err := json.Unmarshal(value, &nested); err == nil && nested != nil {
			if err := validateCatalogValues(nested, fullKey); err != nil {
				return err
			}

			continue
		}

		return fmt.Errorf("has non-string value for key %q", fullKey)
	}

	return nil
}

func archiveFile(zr *zip.Reader, name string) *zip.File {
	for _, file := range zr.File {
		if file.Name == name {
			return file
		}
	}

	return nil
}

func (h *Handler) readCatalogFile(file *zip.File) (map[string]json.RawMessage, error) {
	limit := h.cfg.MaxUploadBytes

	if limit <= 0 {
		limit = maxUncompressedBytes
	}

	rc, err := file.Open()
	if err != nil {
		return nil, err
	}

	defer rc.Close()

	contents, err := io.ReadAll(io.LimitReader(rc, limit+1))
	if err != nil {
		return nil, err
	}

	if int64(len(contents)) > limit {
		return nil, fmt.Errorf("catalog exceeds upload size boundary of %d bytes", limit)
	}

	var catalog map[string]json.RawMessage

	if err := json.Unmarshal(contents, &catalog); err != nil {
		return nil, fmt.Errorf("catalog must be a JSON object: %w", err)
	}

	if catalog == nil {
		return nil, fmt.Errorf("catalog must be a non-null JSON object")
	}

	return catalog, nil
}
