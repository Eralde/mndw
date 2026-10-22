package mgmt

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"mndwd/internal/selfupdate"
)

type fakeSelfUpdateService struct {
	status      selfupdate.Status
	check       selfupdate.CheckResult
	accepted    selfupdate.Accepted
	err         error
	checkCalls  int
	updateCalls int
	revertCalls int
}

func (s *fakeSelfUpdateService) Status() (selfupdate.Status, error) { return s.status, s.err }

func (s *fakeSelfUpdateService) Check(context.Context) (selfupdate.CheckResult, error) {
	s.checkCalls++

	return s.check, s.err
}

func (s *fakeSelfUpdateService) BeginUpdate(context.Context) (selfupdate.Accepted, error) {
	s.updateCalls++

	return s.accepted, s.err
}

func (s *fakeSelfUpdateService) BeginRevert(context.Context) (selfupdate.Accepted, error) {
	s.revertCalls++

	return s.accepted, s.err
}

func newSelfUpdateHandler(t *testing.T, service selfupdate.Service) *Handler {
	t.Helper()

	return New(Config{SelfUpdate: service, Runtime: passthroughRuntime{}}, nil, nil, nil, nil, discardLogger())
}

func TestSelfUpdateApplyReturnsServerDerivedTarget(t *testing.T) {
	service := &fakeSelfUpdateService{accepted: selfupdate.Accepted{Operation: selfupdate.OperationUpdate, TargetVersion: "0.0.4"}}
	h := newSelfUpdateHandler(t, service)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/mgmt/self-update/apply", strings.NewReader(`{}`))

	h.handleSelfUpdateApply(recorder, request)

	if recorder.Code != http.StatusAccepted || !strings.Contains(recorder.Body.String(), `"targetVersion":"0.0.4"`) {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}

	if service.updateCalls != 1 {
		t.Fatalf("update calls = %d", service.updateCalls)
	}
}

func TestSelfUpdateRejectsNonEmptyAndTrailingBodies(t *testing.T) {
	service := &fakeSelfUpdateService{}
	h := newSelfUpdateHandler(t, service)

	for _, body := range []string{`null`, `{"targetVersion":"0.0.4"}`, `{} {}`} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/mgmt/self-update/check", strings.NewReader(body))

		h.handleSelfUpdateCheck(recorder, request)

		if recorder.Code != http.StatusBadRequest {
			t.Errorf("body %q status=%d", body, recorder.Code)
		}
	}

	if service.checkCalls != 0 {
		t.Fatalf("check calls = %d after invalid bodies", service.checkCalls)
	}
}

func TestSelfUpdateStatusDoesNotCheck(t *testing.T) {
	service := &fakeSelfUpdateService{status: selfupdate.Status{State: selfupdate.StateIdle, Version: "0.0.3"}}
	h := newSelfUpdateHandler(t, service)
	recorder := httptest.NewRecorder()

	h.handleSelfUpdateStatus(recorder, httptest.NewRequest(http.MethodGet, "/api/mgmt/self-update/status", nil))

	if recorder.Code != http.StatusOK || service.checkCalls != 0 {
		t.Fatalf("status=%d check calls=%d", recorder.Code, service.checkCalls)
	}
}

func TestSelfUpdateErrorMapping(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		code string
	}{
		{name: "busy", err: selfupdate.ErrBusy, code: "OPKG_BUSY"},
		{name: "no update", err: errors.Join(selfupdate.ErrNoRollback, errors.New("wrapped")), code: "SELF_UPDATE_ROLLBACK_UNAVAILABLE"},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := &fakeSelfUpdateService{err: test.err}
			h := newSelfUpdateHandler(t, service)
			recorder := httptest.NewRecorder()

			h.handleSelfUpdateApply(recorder, httptest.NewRequest(http.MethodPost, "/api/mgmt/self-update/apply", strings.NewReader(`{}`)))

			if recorder.Code != http.StatusConflict || !strings.Contains(recorder.Body.String(), `"code":"`+test.code+`"`) {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
		})
	}
}
