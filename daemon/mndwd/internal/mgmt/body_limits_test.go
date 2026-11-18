package mgmt

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"mndwd/internal/httpx"
)

func TestJSONManagementEndpointsRejectOversizedBodies(t *testing.T) {
	handler := New(Config{
		Runtime:        passthroughRuntime{},
		SelfUpdate:     &fakeSelfUpdateService{},
		ServiceManager: &fakeServiceManager{},
		Builtins:       emptyBuiltinSource{},
		Logger:         discardLogger(),
	})
	mux := http.NewServeMux()

	handler.Register(mux)

	paths := []string{
		"/api/mgmt/capability",
		"/api/mgmt/service/start",
		"/api/mgmt/service/stop",
		"/api/mgmt/service/restart",
		"/api/mgmt/service/set-enabled",
		"/api/mgmt/opkg/install",
		"/api/mgmt/opkg/remove",
		"/api/mgmt/opkg/upgrade",
		"/api/mgmt/approve",
		"/api/mgmt/deny",
		"/api/mgmt/delete",
		"/api/mgmt/restart",
		"/api/mgmt/self-update/check",
		"/api/mgmt/self-update/apply",
		"/api/mgmt/self-update/revert",
	}
	body := `{}` + strings.Repeat(" ", int(httpx.MaxJSONBodyBytes))
	intake := httpx.NewBodyIntake(16).Middleware(BodyLimitForRequest(10<<20), mux)

	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
			response := httptest.NewRecorder()

			intake.ServeHTTP(response, request)

			if response.Code != http.StatusRequestEntityTooLarge || !strings.Contains(response.Body.String(), `"code":"BODY_TOO_LARGE"`) {
				t.Fatalf("response = %d %s, want 413 BODY_TOO_LARGE", response.Code, response.Body.String())
			}
		})
	}
}

func TestUploadBodyLimitUsesUploadEnvelopeThroughIntake(t *testing.T) {
	handler := New(Config{
		Runtime:        passthroughRuntime{},
		SelfUpdate:     &fakeSelfUpdateService{},
		ServiceManager: &fakeServiceManager{},
		Builtins:       emptyBuiltinSource{},
		Logger:         discardLogger(),
	})
	mux := http.NewServeMux()

	handler.Register(mux)

	intake := httpx.NewBodyIntake(16).Middleware(BodyLimitForRequest(10<<20), mux)
	request := httptest.NewRequest(http.MethodPost, "/api/mgmt/upload", strings.NewReader(strings.Repeat("x", (10<<20)+1)))
	response := httptest.NewRecorder()

	intake.ServeHTTP(response, request)

	if response.Code != http.StatusRequestEntityTooLarge || !strings.Contains(response.Body.String(), `"code":"UPLOAD_TOO_LARGE"`) {
		t.Fatalf("response = %d %s, want 413 UPLOAD_TOO_LARGE", response.Code, response.Body.String())
	}
}
