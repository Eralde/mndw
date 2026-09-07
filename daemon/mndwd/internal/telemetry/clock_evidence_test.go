package telemetry

import (
	"testing"
)

func TestDecodeNTPStatus_Synchronized(t *testing.T) {
	body := []byte(`{"elapsed":8028,"server":"0.europe.pool.ntp.org","accurate":true,"synchronized":true,"ndsstime":false,"usertime":false}`)
	ev, err := decodeNTPStatus(body)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ev.Synchronized {
		t.Error("expected Synchronized=true")
	}
	if ev.ID != "0.europe.pool.ntp.org@8028" {
		t.Errorf("unexpected ID: %s", ev.ID)
	}
}

func TestDecodeNTPStatus_Unsynchronized(t *testing.T) {
	body := []byte(`{"elapsed":7,"server":"","accurate":false,"synchronized":false,"ndsstime":false,"usertime":false}`)
	ev, err := decodeNTPStatus(body)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ev.Synchronized {
		t.Error("expected Synchronized=false")
	}
	if ev.ID != "@7" {
		t.Errorf("unexpected ID: %s", ev.ID)
	}
}

func TestDecodeNTPStatus_RejectsArray(t *testing.T) {
	body := []byte(`[{"elapsed":8028,"server":"0.europe.pool.ntp.org","synchronized":true}]`)
	_, err := decodeNTPStatus(body)
	if err == nil {
		t.Error("expected error when decoding an array")
	}
}
