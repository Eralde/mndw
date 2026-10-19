package auth

import (
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type legacyGolden struct {
	Generation  string `json:"generation"`
	Credentials struct {
		Username  string `json:"username"`
		Password  string `json:"password"`
		Realm     string `json:"realm"`
		Challenge string `json:"challenge"`
	} `json:"credentials"`
	Proof string `json:"proof"`
}

type scramGolden struct {
	Generation  string `json:"generation"`
	Credentials struct {
		Username string `json:"username"`
		Password string `json:"password"`
	} `json:"credentials"`
	Challenge struct {
		ClientNonce   string `json:"clientNonce"`
		CombinedNonce string `json:"combinedNonce"`
		Salt          string `json:"salt"`
		Iter          string `json:"iter"`
		Memcost       string `json:"memcost"`
	} `json:"challenge"`
	AuthMessage     string `json:"authMessage"`
	SaltedPassword  string `json:"saltedPassword"`
	ClientKey       string `json:"clientKey"`
	StoredKey       string `json:"storedKey"`
	ServerKey       string `json:"serverKey"`
	Proof           string `json:"proof"`
	ServerSignature string `json:"serverSignature"`
	SignatureProof  string `json:"signatureProof"`
}

func TestLegacyGoldenVector(t *testing.T) {
	var vector legacyGolden

	readGolden(t, "legacy.json", &vector)

	inner := md5.Sum([]byte(vector.Credentials.Username + ":" + vector.Credentials.Realm + ":" + vector.Credentials.Password))
	challenge := vector.Credentials.Challenge + hexBytes(inner[:])
	proof := sha256.Sum256([]byte(challenge))

	if hexBytes(proof[:]) != vector.Proof {
		t.Fatalf("legacy proof = %q, want %q", hexBytes(proof[:]), vector.Proof)
	}
}

func TestScramGoldenVector(t *testing.T) {
	var vector scramGolden

	readGolden(t, "scram.json", &vector)

	salt, err := base64.StdEncoding.DecodeString(vector.Challenge.Salt)
	if err != nil {
		t.Fatal(err)
	}

	adapter := New(Options{Argon2Memory: 8, Argon2Iter: 2, Argon2Sem: make(chan struct{}, 1)})
	salted, err := adapter.derive(context.Background(), []byte(vector.Credentials.Password), salt, 2, 8)
	if err != nil {
		t.Fatal(err)
	}

	assertBase64(t, "salted password", salted, vector.SaltedPassword)

	clientKey := hmacSHA3(salted, []byte(ndw4ClientKey))

	assertBase64(t, "client key", clientKey, vector.ClientKey)

	storedKey := sha3Digest(clientKey)

	assertBase64(t, "stored key", storedKey, vector.StoredKey)

	serverKey := hmacSHA3(salted, []byte(ndw4ServerKey))

	assertBase64(t, "server key", serverKey, vector.ServerKey)

	proof := xor(clientKey, hmacSHA3(storedKey, []byte(vector.AuthMessage)))

	assertBase64(t, "proof", proof, vector.Proof)

	serverSignature := hmacSHA3(serverKey, []byte(vector.AuthMessage))

	assertBase64(t, "server signature", serverSignature, vector.ServerSignature)

	signatureMessage := vector.AuthMessage + ";signature4=" + vector.ServerSignature
	signatureProof := xor(clientKey, hmacSHA3(storedKey, []byte(signatureMessage)))

	assertBase64(t, "signature proof", signatureProof, vector.SignatureProof)
}

func readGolden(t *testing.T, name string, destination any) {
	t.Helper()

	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}

	if err := json.Unmarshal(data, destination); err != nil {
		t.Fatal(err)
	}
}

func assertBase64(t *testing.T, name string, actual []byte, expected string) {
	t.Helper()

	got := base64.StdEncoding.EncodeToString(actual)

	if got != expected {
		t.Fatalf("%s = %q, want %q", name, got, expected)
	}
}

func hexBytes(data []byte) string {
	const alphabet = "0123456789abcdef"
	result := make([]byte, len(data)*2)

	for index, value := range data {
		result[index*2] = alphabet[value>>4]
		result[index*2+1] = alphabet[value&15]
	}

	return string(result)
}
