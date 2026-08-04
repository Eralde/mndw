package minter

import (
	"context"
	"errors"
	"testing"

	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/model"
)

func TestProvisionReturnsMixedPerMemberOutcomes(t *testing.T) {
	generator := GeneratorFunc(func(_ context.Context, member enumeration.Member, _ Credentials) (model.TokenRecord, error) {
		if member.Identity == "node-2" {
			return model.TokenRecord{}, errors.New("unreachable")
		}
		return model.TokenRecord{Key: member.Identity + "-key", Token: member.Identity + "-token", Support: model.SupportSupported}, nil
	})
	members := []enumeration.Member{
		{Identity: "node-1", IP: "192.168.1.2", MAC: "aa:bb:cc:dd:ee:01"},
		{Identity: "node-2", IP: "192.168.1.3", MAC: "aa:bb:cc:dd:ee:02"},
	}

	outcomes := Provision(context.Background(), generator, members, Credentials{Username: "admin", Password: "password"})
	if len(outcomes) != 2 {
		t.Fatalf("outcomes = %#v", outcomes)
	}
	if outcomes[0].Record.Token != "node-1-token" || outcomes[0].Err != nil {
		t.Fatalf("success outcome = %#v", outcomes[0])
	}
	if outcomes[1].Err == nil || outcomes[1].Record.Token != "" {
		t.Fatalf("failure outcome = %#v", outcomes[1])
	}
}

type GeneratorFunc func(context.Context, enumeration.Member, Credentials) (model.TokenRecord, error)

func (f GeneratorFunc) Generate(ctx context.Context, member enumeration.Member, credentials Credentials) (model.TokenRecord, error) {
	return f(ctx, member, credentials)
}
