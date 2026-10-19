package journal

import (
	"bytes"
	"testing"
)

func FuzzDecodeRecord(f *testing.F) {
	f.Add(loadGoldenFuzzCorpus(f, "sample.hex"))
	f.Add(loadGoldenFuzzCorpus(f, "anchor.hex"))
	f.Add(loadGoldenFuzzCorpus(f, "clock-transition.hex"))
	f.Add(loadGoldenFuzzCorpus(f, "publication.hex"))
	f.Add(loadGoldenFuzzCorpus(f, "loss.hex"))
	f.Add(loadGoldenFuzzCorpus(f, "boot-start.hex"))
	f.Add(loadGoldenFuzzCorpus(f, "header.hex"))

	f.Fuzz(func(t *testing.T, data []byte) {
		record, err := DecodeRecord(bytes.NewReader(data))
		if err != nil {
			return
		}

		// Any accepted framing must decode its declared kind without panicking
		// and without allocating more than the frozen maximum body.
		if len(record.Payload) > maxBodyBytes {
			t.Fatalf("payload %d exceeds maximum body", len(record.Payload))
		}

		switch record.Kind {
		case KindSample:
			_, _ = DecodeSample(record)
		case KindAnchor:
			_, _ = DecodeAnchor(record)
		case KindClockTransition:
			_, _ = DecodeClockTransition(record)
		case KindPublication:
			_, _ = DecodePublication(record)
		case KindLoss:
			_, _ = DecodeLoss(record)
		case KindBootStart:
			_, _ = DecodeBootStart(record)
		}
	})
}

func loadGoldenFuzzCorpus(f *testing.F, name string) []byte {
	f.Helper()

	return loadGoldenTestData(name)
}
