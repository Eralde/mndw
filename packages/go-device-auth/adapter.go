package auth

import (
	"context"
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/sha3"
)

// AuthResult is the authenticated per-target session. The jar belongs only to
// Target and must never be shared with another extender.
type AuthResult struct {
	Jar        http.CookieJar
	Generation string
	ExpiresAt  time.Time
}

// Options configures one adapter. The Argon2 semaphore is process-wide by
// default, so background and foreground handshakes cannot exhaust router RAM.
type Options struct {
	Transport    Transport
	AuthTimeout  time.Duration
	Argon2Memory uint32
	Argon2Iter   uint32
	Argon2Sem    chan struct{}
	Random       func([]byte) error
}

// Authenticator negotiates x-ndw4 first and uses x-ndw2 only when the server
// advertises the authoritative legacy challenge.
type Authenticator struct {
	transport   Transport
	authTimeout time.Duration
	argon2Mem   uint32
	argon2Iter  uint32
	argon2Sem   chan struct{}
	random      func([]byte) error
}

var processArgon2Semaphore = make(chan struct{}, 1)

// New returns an auth adapter with slice-1 policy defaults.
func New(options Options) *Authenticator {
	if options.AuthTimeout <= 0 {
		options.AuthTimeout = 15 * time.Second
	}

	if options.Argon2Memory == 0 {
		options.Argon2Memory = 32768
	}

	if options.Argon2Iter == 0 {
		options.Argon2Iter = 64
	}

	if options.Argon2Sem == nil {
		options.Argon2Sem = processArgon2Semaphore
	}

	if options.Random == nil {
		options.Random = randomBytes
	}

	return &Authenticator{
		transport:   options.Transport,
		authTimeout: options.AuthTimeout,
		argon2Mem:   options.Argon2Memory,
		argon2Iter:  options.Argon2Iter,
		argon2Sem:   options.Argon2Sem,
		random:      options.Random,
	}
}

// Authenticate performs one complete controller/extender handshake.
func (a *Authenticator) Authenticate(ctx context.Context, target Target, credentials Credentials, jar http.CookieJar) (AuthResult, error) {
	if a.transport == nil {
		return AuthResult{}, &AuthError{Kind: ErrorTransport, Err: fmt.Errorf("auth transport unavailable")}
	}

	if credentials.Username == "" {
		return AuthResult{}, &AuthError{Kind: ErrorRejected, Err: fmt.Errorf("credentials rejected")}
	}

	if len(credentials.Password) == 0 {
		return AuthResult{}, &AuthError{Kind: ErrorRejected, Err: fmt.Errorf("credentials rejected")}
	}

	jar, err := newJar(jar)
	if err != nil {
		return AuthResult{}, err
	}

	operationCtx, cancel := context.WithTimeout(ctx, a.authTimeout)

	defer cancel()

	initial, err := a.transport.Do(operationCtx, target, jar, http.MethodGet, authPath, nil)
	if err != nil {
		return AuthResult{}, normalizeError(err)
	}

	if initial.Status == http.StatusOK {
		return AuthResult{Jar: jar, Generation: "existing"}, nil
	}

	header := headerValue(initial.Header, "WWW-Authenticate")

	if strings.Contains(header, scramSchema) {
		result, scramErr := a.authenticateNDW4(operationCtx, target, jar, credentials, initial)

		if scramErr == nil {
			return result, nil
		}

		if !strings.Contains(header, legacySchema) || operationCtx.Err() != nil {
			return AuthResult{}, scramErr
		}

		// Some devices advertise both protocols but have an incomplete or
		// incompatible x-ndw4 implementation. Retry legacy authentication with
		// a fresh session so cookies and handshake state cannot cross protocols.
		legacyResult, legacyErr := a.authenticateLegacyFallback(operationCtx, target, credentials)

		if legacyErr == nil {
			return legacyResult, nil
		}

		// Put legacy error first so errors.As callers classify the protocol that
		// was ultimately attempted last, while retaining the x-ndw4 cause.
		return AuthResult{}, errors.Join(legacyErr, scramErr)
	}

	if strings.Contains(header, legacySchema) {
		return a.authenticateNDW2(operationCtx, target, jar, credentials, initial)
	}

	return AuthResult{}, &AuthError{Kind: ErrorUnsupported, Err: fmt.Errorf("unsupported authentication")}
}

func (a *Authenticator) authenticateLegacyFallback(ctx context.Context, target Target, credentials Credentials) (AuthResult, error) {
	jar, err := newJar(nil)
	if err != nil {
		return AuthResult{}, err
	}

	initial, err := a.transport.Do(ctx, target, jar, http.MethodGet, authPath, nil)
	if err != nil {
		return AuthResult{}, normalizeError(err)
	}

	if initial.Status == http.StatusOK {
		return AuthResult{Jar: jar, Generation: "existing"}, nil
	}

	if !strings.Contains(headerValue(initial.Header, "WWW-Authenticate"), legacySchema) {
		return AuthResult{}, &AuthError{Kind: ErrorUnsupported, Err: fmt.Errorf("legacy authentication not advertised")}
	}

	return a.authenticateNDW2(ctx, target, jar, credentials, initial)
}

func (a *Authenticator) authenticateNDW2(ctx context.Context, target Target, jar http.CookieJar, credentials Credentials, initial Response) (AuthResult, error) {
	challenge := headerValue(initial.Header, "X-NDM-Challenge")
	realm := headerValue(initial.Header, "X-NDM-Realm")

	if challenge == "" || realm == "" {
		return AuthResult{}, &AuthError{Kind: ErrorMalformed, Err: fmt.Errorf("legacy challenge incomplete")}
	}

	password := []byte(credentials.Password)

	defer zero(password)

	inner := md5Hex(credentials.Username + ":" + realm + ":" + string(password))
	proof := sha256Hex(challenge + inner)
	body, _ := json.Marshal(map[string]string{"login": credentials.Username, "password": proof})

	defer zero(body)

	reply, err := a.transport.Do(ctx, target, jar, http.MethodPost, authPath, body)
	if err != nil {
		return AuthResult{}, normalizeError(err)
	}

	if reply.Status < 200 || reply.Status >= 300 {
		return AuthResult{}, &AuthError{Kind: ErrorRejected, Err: fmt.Errorf("legacy proof rejected")}
	}

	verified, err := a.transport.Do(ctx, target, jar, http.MethodGet, authPath, nil)
	if err != nil {
		return AuthResult{}, normalizeError(err)
	}

	if verified.Status != http.StatusOK {
		return AuthResult{}, &AuthError{Kind: ErrorRejected, Err: fmt.Errorf("legacy proof rejected")}
	}

	return AuthResult{Jar: jar, Generation: legacySchema}, nil
}

type ndw4FirstReply struct {
	Error   any `json:"error"`
	E       any `json:"e"`
	Salt    any `json:"salt"`
	Nonce   any `json:"nonce"`
	Iter    any `json:"iter"`
	Memcost any `json:"memcost"`
}

type ndw4SecondReply struct {
	Error     any `json:"error"`
	E         any `json:"e"`
	Signature any `json:"signature"`
}

func (a *Authenticator) authenticateNDW4(ctx context.Context, target Target, jar http.CookieJar, credentials Credentials, initial Response) (AuthResult, error) {
	clientNonceBytes := make([]byte, 16)

	if err := a.random(clientNonceBytes); err != nil {
		return AuthResult{}, &AuthError{Kind: ErrorTransport, Err: err}
	}

	clientNonce := base64.StdEncoding.EncodeToString(clientNonceBytes)
	endpoint := parseAuthEndpoint(headerValue(initial.Header, "WWW-Authenticate"))

	if endpoint == "" {
		return AuthResult{}, &AuthError{Kind: ErrorMalformed, Err: fmt.Errorf("scram endpoint missing")}
	}

	firstBody, _ := json.Marshal(map[string]string{"login": credentials.Username, "nonce": clientNonce})
	firstResponse, err := a.transport.Do(ctx, target, jar, http.MethodPost, endpoint, firstBody)
	if err != nil {
		return AuthResult{}, normalizeError(err)
	}

	var first ndw4FirstReply

	if err := decodeNDW4Reply(firstResponse, &first); err != nil {
		return AuthResult{}, err
	}

	if message := replyError(first.Error, first.E); message != "" {
		return AuthResult{}, &AuthError{Kind: ErrorRejected, Err: fmt.Errorf("scram challenge rejected")}
	}

	combinedNonce, ok := first.Nonce.(string)

	if !ok || combinedNonce == "" || !strings.HasPrefix(combinedNonce, clientNonce) {
		return AuthResult{}, &AuthError{Kind: ErrorMalformed, Err: fmt.Errorf("scram nonce invalid")}
	}

	saltString, ok := first.Salt.(string)

	if !ok || saltString == "" {
		return AuthResult{}, &AuthError{Kind: ErrorMalformed, Err: fmt.Errorf("scram salt invalid")}
	}

	salt, err := base64.StdEncoding.DecodeString(saltString)
	if err != nil || len(salt) != ndw4SaltLength {
		return AuthResult{}, &AuthError{Kind: ErrorMalformed, Err: fmt.Errorf("scram salt invalid")}
	}

	iterRaw, iterations, err := parseCost(first.Iter, 1, int(a.argon2Iter))
	if err != nil {
		if errors.Is(err, errCostCeiling) {
			return AuthResult{}, &AuthError{Kind: ErrorUnsupported, Err: fmt.Errorf("scram iterations exceed policy")}
		}

		return AuthResult{}, &AuthError{Kind: ErrorMalformed, Err: fmt.Errorf("scram iterations invalid")}
	}

	memRaw, memory, err := parseCost(first.Memcost, ndw4MinMemoryKiB, int(a.argon2Mem))
	if err != nil {
		if errors.Is(err, errCostCeiling) {
			return AuthResult{}, &AuthError{Kind: ErrorUnsupported, Err: fmt.Errorf("scram memory exceeds policy")}
		}

		return AuthResult{}, &AuthError{Kind: ErrorMalformed, Err: fmt.Errorf("scram memory invalid")}
	}

	clientFirst := "login1=" + credentials.Username + ",nonce1=" + clientNonce
	serverFirst := "iter2=" + iterRaw + ",memcost2=" + memRaw + ",nonce2=" + combinedNonce + ",salt2=" + saltString
	clientFinal := "login3=" + credentials.Username + ",nonce3=" + combinedNonce
	authMessage := clientFirst + ";" + serverFirst + ";" + clientFinal

	password := []byte(credentials.Password)

	defer zero(password)

	salted, err := a.derive(ctx, password, salt, uint32(iterations), uint32(memory))
	if err != nil {
		return AuthResult{}, err
	}

	defer zero(salted)

	clientKey := hmacSHA3(salted, []byte(ndw4ClientKey))

	defer zero(clientKey)

	storedKey := sha3Digest(clientKey)

	defer zero(storedKey)

	serverKey := hmacSHA3(salted, []byte(ndw4ServerKey))

	defer zero(serverKey)

	proof := xor(clientKey, hmacSHA3(storedKey, []byte(authMessage)))

	defer zero(proof)

	proofBody, _ := json.Marshal(map[string]string{"login": credentials.Username, "nonce": combinedNonce, "proof": base64.StdEncoding.EncodeToString(proof)})

	defer zero(proofBody)

	secondResponse, err := a.transport.Do(ctx, target, jar, http.MethodPost, endpoint, proofBody)
	if err != nil {
		return AuthResult{}, normalizeError(err)
	}

	var second ndw4SecondReply

	if err := decodeNDW4Reply(secondResponse, &second); err != nil {
		return AuthResult{}, err
	}

	if message := replyError(second.Error, second.E); message != "" {
		return AuthResult{}, &AuthError{Kind: ErrorRejected, Err: fmt.Errorf("scram proof rejected")}
	}

	signatureString, ok := second.Signature.(string)

	if !ok || signatureString == "" {
		return AuthResult{}, &AuthError{Kind: ErrorMalformed, Err: fmt.Errorf("scram signature missing")}
	}

	signature, err := base64.StdEncoding.DecodeString(signatureString)
	if err != nil || subtle.ConstantTimeCompare(signature, hmacSHA3(serverKey, []byte(authMessage))) != 1 {
		return AuthResult{}, &AuthError{Kind: ErrorRejected, Err: fmt.Errorf("scram server signature rejected")}
	}

	signatureAuthMessage := authMessage + ";signature4=" + signatureString
	signatureProof := xor(clientKey, hmacSHA3(storedKey, []byte(signatureAuthMessage)))

	defer zero(signatureProof)

	lastBody, _ := json.Marshal(map[string]string{"login": credentials.Username, "nonce": combinedNonce, "signature-proof": base64.StdEncoding.EncodeToString(signatureProof)})

	defer zero(lastBody)

	lastResponse, err := a.transport.Do(ctx, target, jar, http.MethodPost, endpoint, lastBody)
	if err != nil {
		return AuthResult{}, normalizeError(err)
	}

	if lastResponse.Status != http.StatusOK {
		return AuthResult{}, &AuthError{Kind: ErrorRejected, Err: fmt.Errorf("scram signature proof rejected")}
	}

	verified, err := a.transport.Do(ctx, target, jar, http.MethodGet, authPath, nil)
	if err != nil {
		return AuthResult{}, normalizeError(err)
	}

	if verified.Status != http.StatusOK {
		return AuthResult{}, &AuthError{Kind: ErrorRejected, Err: fmt.Errorf("scram authentication rejected")}
	}

	return AuthResult{Jar: jar, Generation: scramSchema}, nil
}

func parseAuthEndpoint(header string) string {
	for _, chunk := range strings.Split(header, ",") {
		if !strings.Contains(chunk, scramSchema) {
			continue
		}

		const prefix = `endpoint="`
		start := strings.Index(chunk, prefix)

		if start < 0 {
			continue
		}

		start += len(prefix)
		end := strings.Index(chunk[start:], `"`)

		if end > 0 {
			return chunk[start : start+end]
		}
	}

	return ""
}

func decodeNDW4Reply(response Response, destination any) error {
	encoded := headerValue(response.Header, ndw4ReplyHeader)

	if encoded == "" {
		return &AuthError{Kind: ErrorMalformed, Err: fmt.Errorf("scram reply missing")}
	}

	payload, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return &AuthError{Kind: ErrorMalformed, Err: err}
	}

	return decodeJSON(payload, destination)
}

func parseCost(value any, min, max int) (string, int, error) {
	var raw string

	switch typed := value.(type) {
	case string:
		if typed == "" || !regexp.MustCompile(`^\d+$`).MatchString(typed) {
			return "", 0, fmt.Errorf("invalid cost")
		}

		raw = typed
	case float64:
		if typed != float64(int(typed)) {
			return "", 0, fmt.Errorf("invalid cost")
		}

		raw = strconv.Itoa(int(typed))
	default:
		return "", 0, fmt.Errorf("invalid cost")
	}

	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed < min {
		return "", 0, fmt.Errorf("invalid cost")
	}

	if parsed > max {
		return "", 0, fmt.Errorf("%w: %d", errCostCeiling, parsed)
	}

	return raw, parsed, nil
}

var errCostCeiling = errors.New("cost exceeds configured ceiling")

func (a *Authenticator) derive(ctx context.Context, password, salt []byte, iterations, memory uint32) ([]byte, error) {
	select {
	case a.argon2Sem <- struct{}{}:
		defer func() { <-a.argon2Sem }()
	case <-ctx.Done():
		return nil, &AuthError{Kind: ErrorTimeout, Err: ctx.Err()}
	}

	derived := argon2.IDKey(password, salt, iterations, memory, ndw4Parallelism, ndw4HashLength)

	return derived, nil
}

func hmacSHA3(key, message []byte) []byte {
	mac := hmac.New(sha3.New512, key)
	_, _ = mac.Write(message)

	return mac.Sum(nil)
}

func sha3Digest(data []byte) []byte {
	digest := sha3.Sum512(data)

	return digest[:]
}

func xor(left, right []byte) []byte {
	if len(left) != len(right) {
		return nil
	}

	result := make([]byte, len(left))

	for index := range left {
		result[index] = left[index] ^ right[index]
	}

	return result
}

func replyError(first, second any) string {
	if message, ok := first.(string); ok && message != "" {
		return message
	}

	if message, ok := second.(string); ok && message != "" {
		return message
	}

	return ""
}

func normalizeError(err error) error {
	if _, ok := err.(*AuthError); ok {
		return err
	}

	return &AuthError{Kind: ErrorTransport, Err: err}
}

func headerValue(header http.Header, name string) string {
	for key, values := range header {
		if strings.EqualFold(key, name) && len(values) > 0 {
			// HTTP permits repeated WWW-Authenticate fields. Keep all values so
			// capability negotiation can see x-ndw4 when x-ndw2 appears first.
			return strings.Join(values, ",")
		}
	}

	return ""
}

func randomBytes(buffer []byte) error {
	_, err := rand.Read(buffer)

	return err
}

func zero(buffer []byte) {
	for index := range buffer {
		buffer[index] = 0
	}
}

func md5Hex(value string) string {
	digest := md5.Sum([]byte(value))

	return hex.EncodeToString(digest[:])
}

func sha256Hex(value string) string {
	digest := sha256.Sum256([]byte(value))

	return hex.EncodeToString(digest[:])
}
