package mgmt

import (
	"net/http"

	"mndwd/internal/httpx"
)

// BodyLimitForRequest selects the request-body cap for the management API.
func BodyLimitForRequest(maxUploadBytes int64) func(*http.Request) httpx.BodyLimit {
	return func(request *http.Request) httpx.BodyLimit {
		if request.Method == http.MethodPost && request.URL.Path == "/api/mgmt/upload" {
			return httpx.BodyLimit{
				MaxBytes:     maxUploadBytes,
				Timeout:      uploadBodyTimeout,
				TooLargeCode: httpx.CodeUploadTooLarge,
			}
		}

		return httpx.BodyLimit{
			MaxBytes:     httpx.MaxJSONBodyBytes,
			Timeout:      httpx.JSONBodyTimeout,
			TooLargeCode: httpx.CodeBodyTooLarge,
		}
	}
}
