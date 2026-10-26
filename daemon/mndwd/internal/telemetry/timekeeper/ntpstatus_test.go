package timekeeper

import (
	"testing"
)

func TestDecodeNTPStatusFields(t *testing.T) {
	body := []byte(`{"elapsed":12,"server":"pool.ntp.org","accurate":true,"synchronized":true,"ndsstime":false,"usertime":false}`)

	got, err := DecodeNTPStatus(body)
	if err != nil {
		t.Fatalf("DecodeNTPStatus() error = %v", err)
	}

	if got.ElapsedS != 12 || got.Server != "pool.ntp.org" || !got.Accurate || !got.Synchronized || got.NDSSTime || got.UserTime {
		t.Fatalf("DecodeNTPStatus() = %+v", got)
	}
}

func TestIsEvidenceTable(t *testing.T) {
	tests := []struct {
		name string
		stat NTPStatus
		want bool
	}{
		{name: "all good", stat: NTPStatus{Server: "pool.ntp.org", Accurate: true}, want: true},
		{name: "inaccurate", stat: NTPStatus{Server: "pool.ntp.org"}},
		{name: "empty server", stat: NTPStatus{Accurate: true}},
		{name: "user time", stat: NTPStatus{Server: "pool.ntp.org", Accurate: true, UserTime: true}},
		{name: "ndss time", stat: NTPStatus{Server: "pool.ntp.org", Accurate: true, NDSSTime: true}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.stat.IsEvidence(); got != tt.want {
				t.Fatalf("IsEvidence() = %t, want %t", got, tt.want)
			}
		})
	}
}
