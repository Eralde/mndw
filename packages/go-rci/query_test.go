package rci

import (
	"errors"
	"reflect"
	"testing"
)

func TestValidatePathAcceptsLiteralSegments(t *testing.T) {
	for _, path := range []string{"show.version", "a[0].b", "FastEthernet0/Vlan3", "MAC-AA:BB"} {
		t.Run(path, func(t *testing.T) {
			if err := validatePath(path); err != nil {
				t.Fatalf("validatePath(%q) = %v, want nil", path, err)
			}
		})
	}
}

func TestValidatePathRejectsEmptySegments(t *testing.T) {
	for _, path := range []string{"", ".show", "show.", "show..version"} {
		t.Run(path, func(t *testing.T) {
			err := validatePath(path)
			if !errors.Is(err, ErrInvalidPath) {
				t.Fatalf("validatePath(%q) = %v, want ErrInvalidPath", path, err)
			}
		})
	}
}

func TestQStoresPathAndOptionalData(t *testing.T) {
	t.Run("without data", func(t *testing.T) {
		query := Q("show.version")

		if query.Path != "show.version" || query.Data != nil || query.Raw {
			t.Fatalf("Q(show.version) = %#v, want path, nil data, false Raw", query)
		}
	})

	t.Run("with data", func(t *testing.T) {
		data := map[string]any{"detail": 0, "attribute": "avg"}
		query := Q("show.system", data)

		if query.Path != "show.system" || !reflect.DeepEqual(query.Data, data) || query.Raw {
			t.Fatalf("Q(show.system, data) = %#v, want stored data and false Raw", query)
		}
	})
}

func TestQPanicsWhenGivenMoreThanOneDataArgument(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("Q accepted more than one data argument")
		}
	}()

	Q("x", 1, 2)
}
