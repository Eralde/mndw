package minter

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"mndwd/internal/keenetic/auth"
	"mndwd/internal/keenetic/discovery"
	"mndwd/internal/keenetic/target"
	"mndwd/internal/rcisession/enumeration"
	"mndwd/internal/rcisession/model"
)

type Credentials struct {
	Username string
	Password string
}

func DefaultRequestBody() []byte {
	return []byte(`{"cmd":"authentication token generate"}`)
}

type Generator interface {
	Generate(context.Context, enumeration.Member, Credentials) (model.TokenRecord, error)
}

type Outcome struct {
	Member enumeration.Member
	Record model.TokenRecord
	Err    error
}

func Provision(ctx context.Context, generator Generator, members []enumeration.Member, credentials Credentials) []Outcome {
	outcomes := make([]Outcome, 0, len(members))
	for _, member := range members {
		if err := ctx.Err(); err != nil {
			outcomes = append(outcomes, Outcome{Member: member, Err: err})
			continue
		}
		record, err := generator.Generate(ctx, member, credentials)
		outcomes = append(outcomes, Outcome{Member: member, Record: record, Err: err})
	}
	return outcomes
}

type Authenticator interface {
	Authenticate(context.Context, auth.Target, auth.Credentials, http.CookieJar) (auth.AuthResult, error)
}

type HTTPGenerator struct {
	Authenticator Authenticator
	Transport     auth.Transport
	RequestBody   func() []byte
}

func (g HTTPGenerator) Generate(ctx context.Context, member enumeration.Member, credentials Credentials) (model.TokenRecord, error) {
	if g.Authenticator == nil || g.Transport == nil || g.RequestBody == nil {
		return model.TokenRecord{}, fmt.Errorf("token generator unavailable")
	}
	device, err := target.Resolve(discovery.Member{CID: member.Identity, Name: member.Name, IP: member.IP, MAC: member.MAC})
	if err != nil {
		return model.TokenRecord{}, err
	}
	authResult, err := g.Authenticator.Authenticate(ctx, device.AuthTarget(), auth.Credentials{
		Username: credentials.Username,
		Password: credentials.Password,
	}, nil)
	if err != nil {
		return model.TokenRecord{}, err
	}
	response, err := g.Transport.Do(ctx, device.AuthTarget(), authResult.Jar, http.MethodPost, "/rci/", g.RequestBody())
	if err != nil {
		return model.TokenRecord{}, err
	}
	if response.Status < 200 || response.Status >= 300 {
		return model.TokenRecord{}, fmt.Errorf("token generation rejected")
	}
	var payload struct {
		Key   string `json:"key"`
		Token string `json:"token"`
	}
	if err := json.Unmarshal(response.Body, &payload); err != nil || payload.Key == "" || payload.Token == "" {
		return model.TokenRecord{}, fmt.Errorf("token generation response malformed")
	}
	return model.TokenRecord{Key: payload.Key, Token: payload.Token, Support: model.SupportSupported}, nil
}
