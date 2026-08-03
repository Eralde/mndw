package testsupport

import (
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/sha3"
)

type AuthGeneration string

const (
	LegacyAuth AuthGeneration = "x-ndw2-interactive"
	ScramAuth  AuthGeneration = "x-ndw4-interactive"
)

type FakeExtender struct {
	Server        *httptest.Server
	Generation    AuthGeneration
	Username      string
	Password      string
	mu            sync.Mutex
	authenticated bool
	phase         int
	clientNonce   string
	combinedNonce string
}

func NewFakeExtender(t *testing.T, generation AuthGeneration, username, password string) *FakeExtender {
	t.Helper()
	fake := &FakeExtender{Generation: generation, Username: username, Password: password}
	fake.Server = httptest.NewServer(http.HandlerFunc(fake.handle))
	t.Cleanup(fake.Server.Close)
	return fake
}

func (f *FakeExtender) Expire() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.authenticated = false
	f.phase = 0
}

func (f *FakeExtender) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	authenticated := f.authenticated
	f.mu.Unlock()
	if r.URL.Path != "/auth" {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if r.Method == http.MethodGet {
		if authenticated {
			w.WriteHeader(http.StatusOK)
			return
		}
		if f.Generation == LegacyAuth {
			w.Header().Set("WWW-Authenticate", string(LegacyAuth))
			w.Header().Set("X-NDM-Challenge", "extender-challenge")
			w.Header().Set("X-NDM-Realm", "extender-realm")
		} else {
			w.Header().Set("WWW-Authenticate", `x-ndw4-interactive endpoint="/auth"`)
		}
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	if f.Generation == LegacyAuth {
		f.legacy(w, r)
		return
	}
	f.scram(w, r)
}

func (f *FakeExtender) legacy(w http.ResponseWriter, r *http.Request) {
	var request map[string]string
	_ = json.NewDecoder(r.Body).Decode(&request)
	inner := md5Hex(f.Username + ":extender-realm:" + f.Password)
	want := sha256Hex("extender-challenge" + inner)
	if request["login"] != f.Username || request["password"] != want {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	f.mu.Lock()
	f.authenticated = true
	f.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "fake-extender", Value: "ok", Path: "/"})
	w.WriteHeader(http.StatusOK)
}

func (f *FakeExtender) scram(w http.ResponseWriter, r *http.Request) {
	var request map[string]string
	_ = json.NewDecoder(r.Body).Decode(&request)
	salt := []byte("0123456789abcdef")
	iter := uint32(2)
	memory := uint32(8)
	if f.phase == 0 {
		combined := request["nonce"] + "server"
		f.mu.Lock()
		f.phase = 1
		f.clientNonce = request["nonce"]
		f.combinedNonce = combined
		f.mu.Unlock()
		f.reply(w, http.StatusUnauthorized, map[string]any{"salt": base64.StdEncoding.EncodeToString(salt), "nonce": combined, "iter": iter, "memcost": memory})
		return
	}
	if f.phase == 1 {
		f.mu.Lock()
		clientNonce := f.clientNonce
		combinedNonce := f.combinedNonce
		f.mu.Unlock()
		keys := deriveFakeKeys(f.Password, salt, iter, memory)
		authMessage := "login1=" + f.Username + ",nonce1=" + clientNonce + ";iter2=2,memcost2=8,nonce2=" + combinedNonce + ",salt2=" + base64.StdEncoding.EncodeToString(salt) + ";login3=" + f.Username + ",nonce3=" + combinedNonce
		signature := hmacSHA3(keys.serverKey, []byte(authMessage))
		f.mu.Lock()
		f.phase = 2
		f.mu.Unlock()
		f.reply(w, http.StatusUnauthorized, map[string]any{"signature": base64.StdEncoding.EncodeToString(signature)})
		return
	}
	f.mu.Lock()
	f.phase = 3
	f.authenticated = true
	f.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "fake-extender", Value: "ok", Path: "/"})
	w.WriteHeader(http.StatusOK)
}

func (f *FakeExtender) reply(w http.ResponseWriter, status int, value any) {
	data, _ := json.Marshal(value)
	w.Header().Set("X-NDM-Data", base64.StdEncoding.EncodeToString(data))
	w.WriteHeader(status)
}

func deriveFakeKeys(password string, salt []byte, iter, memory uint32) struct{ serverKey []byte } {
	salted := argon2.IDKey([]byte(password), salt, iter, memory, 1, 64)
	return struct{ serverKey []byte }{serverKey: hmacSHA3(salted, []byte("NDW4 Interactive Server Key"))}
}

func hmacSHA3(key, data []byte) []byte {
	mac := hmac.New(sha3.New512, key)
	_, _ = mac.Write(data)
	return mac.Sum(nil)
}

func md5Hex(value string) string {
	digest := md5.Sum([]byte(value))
	return hex.EncodeToString(digest[:])
}

func sha256Hex(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}
