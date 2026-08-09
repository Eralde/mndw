package service

import (
	"context"
	"errors"
	"testing"

	"mws-page/internal/config"
	"mws-page/internal/persistent"
)

type writeSource struct {
	target   bool
	response persistent.Response
	err      error
	requests []persistent.Request
}

func (source *writeSource) Run(context.Context) {}

func (source *writeSource) Snapshot() []persistent.Session { return nil }

func (source *writeSource) Diagnostics() persistent.Diagnostics { return persistent.Diagnostics{} }

func (source *writeSource) HasTarget(string) bool { return source.target }

func (source *writeSource) Send(_ context.Context, _ string, request persistent.Request) (persistent.Response, error) {
	source.requests = append(source.requests, request)

	return source.response, source.err
}

func TestWriteSetPowerBuildsExactSetAndSaveBatch(t *testing.T) {
	source := &writeSource{
		target: true,
		response: persistent.Response{Status: 200, Body: []byte(`{
			"0":{"interface":{"power":{"status":[{"status":"message","code":"31261672","ident":"Network::Interface::Mtk::WifiMaster","message":"set"}]}}},
			"1":{"system":{"configuration":{"save":{"status":[{"status":"message","code":"8912996","ident":"Core::System::StartupConfig","message":"saving"}]}}}}
		}`)},
	}
	service := New(config.Config{})

	service.SetPersistentSource(source)

	result, err := service.Write(context.Background(), WriteRequest{
		Operation: `wifi.set-power`,
		NodeID:    `cid-1`,
		Params:    []byte(`{"interface":"WifiMaster0","power":75,"persist":true}`),
	})
	if err != nil {
		t.Fatal(err)
	}

	if !result.OK || len(result.Steps) != 2 || !result.Steps[0].OK || !result.Steps[1].OK {
		t.Fatalf(`result = %#v`, result)
	}

	if len(source.requests) != 1 {
		t.Fatalf(`requests = %#v`, source.requests)
	}

	want := `[{"interface":{"name":"WifiMaster0","power":75}},{"system":{"configuration":{"save":{}}}}]`

	if string(source.requests[0].Body) != want {
		t.Fatalf(`request body = %s, want %s`, source.requests[0].Body, want)
	}
}

func TestWriteSetPowerDefaultsPersistAndRejectsInvalidInput(t *testing.T) {
	source := &writeSource{target: true, response: persistent.Response{Status: 200, Body: []byte(`[{"interface":{"power":{"status":[{"status":"message"}]}}},{"system":{"configuration":{"save":{"status":[{"status":"message"}]}}}}]`)}}
	service := New(config.Config{})

	service.SetPersistentSource(source)

	result, err := service.Write(context.Background(), WriteRequest{
		Operation: `wifi.set-power`,
		NodeID:    `cid-1`,
		Params:    []byte(`{"interface":"WifiMaster1","power":0}`),
	})
	if err != nil || !result.OK || len(source.requests) != 1 {
		t.Fatalf(`default persist result=%#v err=%v requests=%d`, result, err, len(source.requests))
	}

	for _, request := range []WriteRequest{
		{Operation: `unknown`, NodeID: `cid-1`, Params: []byte(`{}`)},
		{Operation: `wifi.set-power`, NodeID: `cid-1`, Params: []byte(`{"interface":"WifiMaster2","power":50}`)},
		{Operation: `wifi.set-power`, NodeID: `cid-1`, Params: []byte(`{"interface":"WifiMaster0","power":101}`)},
		{Operation: `wifi.set-power`, NodeID: `cid-1`, Params: []byte(`{"interface":"WifiMaster0","power":1,"extra":true}`)},
	} {
		_, err := service.Write(context.Background(), request)
		if err == nil {
			t.Fatalf(`Write(%#v) succeeded`, request)
		}

		var operationErr *OperationError

		if !errors.As(err, &operationErr) || operationErr.Status() != 400 {
			t.Fatalf(`Write(%#v) error = %v`, request, err)
		}
	}
}

func TestWriteMapsTargetAndTransportFailures(t *testing.T) {
	t.Run(`unknown target`, func(t *testing.T) {
		source := &writeSource{}
		service := New(config.Config{})

		service.SetPersistentSource(source)

		_, err := service.Write(context.Background(), validWriteRequest())

		assertOperationStatus(t, err, 400)
	})
	t.Run(`no session`, func(t *testing.T) {
		source := &writeSource{target: true, err: persistent.ErrNoSession}
		service := New(config.Config{})

		service.SetPersistentSource(source)

		_, err := service.Write(context.Background(), validWriteRequest())

		assertOperationStatus(t, err, 503)
	})
	t.Run(`write rejected`, func(t *testing.T) {
		source := &writeSource{target: true, err: errors.New(`write not permitted`)}
		service := New(config.Config{})

		service.SetPersistentSource(source)

		_, err := service.Write(context.Background(), validWriteRequest())

		assertOperationStatus(t, err, 403)
	})
	t.Run(`non-200`, func(t *testing.T) {
		source := &writeSource{target: true, response: persistent.Response{Status: 503, Body: []byte(`busy`)}}
		service := New(config.Config{})

		service.SetPersistentSource(source)

		_, err := service.Write(context.Background(), validWriteRequest())

		assertOperationStatus(t, err, 502)
	})
}

func validWriteRequest() WriteRequest {
	return WriteRequest{
		Operation: `wifi.set-power`,
		NodeID:    `cid-1`,
		Params:    []byte(`{"interface":"WifiMaster0","power":75,"persist":false}`),
	}
}

func assertOperationStatus(t *testing.T, err error, status int) {
	t.Helper()

	if err == nil {
		t.Fatalf(`error = nil, want status %d`, status)
	}

	var operationErr *OperationError

	if !errors.As(err, &operationErr) || operationErr.Status() != status {
		t.Fatalf(`error = %v, want status %d`, err, status)
	}
}
