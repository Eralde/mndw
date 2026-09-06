package events

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"testing"
)

var fixtureULID = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{26}$`)

func TestValidFixturesDecodeAsEvents(t *testing.T) {
	fixtureRoot := filepath.Join("..", "..", "..", "contracts", "events", "fixtures", "valid")
	entries, err := os.ReadDir(fixtureRoot)
	if err != nil {
		t.Fatal(err)
	}

	var files []string

	for _, entry := range entries {
		if !entry.IsDir() && filepath.Ext(entry.Name()) == ".json" {
			files = append(files, entry.Name())
		}
	}

	sort.Strings(files)

	if len(files) != 26 {
		t.Fatalf("valid event fixture count = %d, want 26", len(files))
	}

	seenTopics := make(map[Topic]bool, len(files))

	for _, file := range files {
		raw, readErr := os.ReadFile(filepath.Join(fixtureRoot, file))

		if readErr != nil {
			t.Fatal(readErr)
		}

		var event Event

		if unmarshalErr := json.Unmarshal(raw, &event); unmarshalErr != nil {
			t.Fatalf("decode %s: %v", file, unmarshalErr)
		}

		if event.ID == "" || event.Topic == "" || event.Source == "" || len(event.Payload) == 0 {
			t.Fatalf("fixture %s decoded incomplete event: %#v", file, event)
		}

		seenTopics[event.Topic] = true
	}

	if len(seenTopics) != 26 {
		t.Fatalf("fixture topics = %d, want 26", len(seenTopics))
	}
}

func TestInvalidFixturesFailEnvelopeAndBoundChecks(t *testing.T) {
	fixtureRoot := filepath.Join("..", "..", "..", "contracts", "events", "fixtures", "invalid")
	entries, err := os.ReadDir(fixtureRoot)
	if err != nil {
		t.Fatal(err)
	}

	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}

		raw, readErr := os.ReadFile(filepath.Join(fixtureRoot, entry.Name()))

		if readErr != nil {
			t.Fatal(readErr)
		}

		var envelope struct {
			ID      string          `json:"id"`
			Topic   string          `json:"topic"`
			Source  string          `json:"source"`
			Payload json.RawMessage `json:"payload"`
		}

		if unmarshalErr := json.Unmarshal(raw, &envelope); unmarshalErr != nil {
			t.Fatalf("decode %s: %v", entry.Name(), unmarshalErr)
		}

		valid := fixtureULID.MatchString(envelope.ID)
		valid = valid && (envelope.Source == string(SourceHook) || envelope.Source == string(SourceLog) || envelope.Source == string(SourceInternal))
		valid = valid && len(envelope.Payload) > 0 && envelope.Topic != ""

		if entry.Name() == "oversized-payload.json" {
			valid = valid && len(envelope.Payload) <= 4*1024
		}

		if entry.Name() == "missing-field.json" {
			var payload map[string]any

			if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
				t.Fatal(err)
			}

			_, validAddress := payload["address"]
			valid = valid && validAddress
		}

		if entry.Name() == "bad-topic.json" {
			valid = valid && envelope.Topic == string(TopicWanDisconnected)
		}

		if valid {
			t.Fatalf("invalid fixture %s passed envelope checks", entry.Name())
		}
	}
}
