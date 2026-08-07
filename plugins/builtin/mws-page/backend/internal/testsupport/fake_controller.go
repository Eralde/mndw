package testsupport

import (
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

type FakeController struct {
	Server        *httptest.Server
	mu            sync.Mutex
	user          string
	password      string
	memberPayload []byte
	authenticated bool
}

func NewFakeController(t *testing.T, username, password string, members []byte) *FakeController {
	t.Helper()
	fake := &FakeController{user: username, password: password, memberPayload: append([]byte(nil), members...)}
	fake.Server = httptest.NewServer(http.HandlerFunc(fake.handle))
	t.Cleanup(fake.Server.Close)
	return fake
}

func (f *FakeController) SetMembers(data []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.memberPayload = append([]byte(nil), data...)
}

func (f *FakeController) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	authenticated := f.authenticated
	f.mu.Unlock()
	if r.URL.Path == "/auth" {
		if r.Method == http.MethodGet {
			if authenticated {
				w.WriteHeader(http.StatusOK)
				return
			}
			w.Header().Set("WWW-Authenticate", "x-ndw2-interactive")
			w.Header().Set("X-NDM-Challenge", "controller-challenge")
			w.Header().Set("X-NDM-Realm", "controller-realm")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var request map[string]string
		_ = json.NewDecoder(r.Body).Decode(&request)
		inner := md5.Sum([]byte(f.user + ":controller-realm:" + f.password))
		proof := sha256.Sum256([]byte("controller-challenge" + hex.EncodeToString(inner[:])))
		if request["login"] == f.user && request["password"] == hex.EncodeToString(proof[:]) {
			f.mu.Lock()
			f.authenticated = true
			f.mu.Unlock()
			http.SetCookie(w, &http.Cookie{Name: "fake-controller", Value: "ok", Path: "/"})
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if r.URL.Path == "/rci/" && r.Method == http.MethodPost {
		if !authenticated {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		f.mu.Lock()
		payload := append([]byte(nil), f.memberPayload...)
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		response := append([]byte(`[ {"show":{"mws":{"member":`), payload...)
		response = append(response, []byte(`}}}]`)...)
		_, _ = w.Write(response)
		return
	}
	w.WriteHeader(http.StatusNotFound)
}
