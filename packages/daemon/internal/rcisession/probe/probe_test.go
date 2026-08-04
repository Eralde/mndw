package probe

import (
	"context"
	"errors"
	"testing"

	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/model"
)

func TestCheckClassifiesTokenAuthSupport(t *testing.T) {
	tests := []struct {
		name    string
		status  int
		err     error
		support model.Support
		wantErr error
	}{
		{name: "supported", status: 200, support: model.SupportSupported},
		{name: "unsupported", status: 404, support: model.SupportUnsupported, wantErr: ErrUnsupported},
		{name: "rejected", status: 401, support: model.SupportUnsupported, wantErr: ErrUnsupported},
		{name: "timeout", err: context.DeadlineExceeded, support: model.SupportUnknown, wantErr: ErrUnknown},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			checker := Checker{Request: func(context.Context, enumeration.Member, model.TokenRecord) (int, error) {
				return test.status, test.err
			}}
			support, err := checker.Check(context.Background(), testMember(), model.TokenRecord{Token: "token"})
			if support != test.support {
				t.Fatalf("support = %q, want %q", support, test.support)
			}
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("error = %v, want %v", err, test.wantErr)
			}
		})
	}
}

func testMember() enumeration.Member {
	return enumeration.Member{Identity: "node-1", Name: "A", IP: "192.168.1.2", MAC: "aa:bb:cc:dd:ee:ff"}
}
