package server

import (
	"testing"

	"github.com/SRE-Capsule/sre-capsule-community/pkg/core"

	"github.com/golang-jwt/jwt/v5"
)

func TestIsDevelopmentEnv(t *testing.T) {
	t.Setenv("APP_ENV", "production")
	if isDevelopmentEnv() {
		t.Fatal("production should not be development")
	}
	t.Setenv("APP_ENV", "development")
	if !isDevelopmentEnv() {
		t.Fatal("expected development")
	}
}

func TestInitJWT_allowsDevelopmentFallback(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	t.Setenv("SRECAPSULE_JWT_SECRET", "")
	InitJWT(&core.Config{})
	if len(jwtKey) == 0 {
		t.Fatal("expected dev fallback JWT key")
	}
}

func TestJWTSigningKeyRejectsNoneAndAcceptsHMAC(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	t.Setenv("SRECAPSULE_JWT_SECRET", "unit-test-secret")
	InitJWT(&core.Config{})

	none := "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJ1c2VybmFtZSI6IngiLCJyb2xlIjoiYWRtaW4ifQ."
	if _, err := jwt.ParseWithClaims(none, &Claims{}, jwtSigningKey); err == nil {
		t.Fatal("alg none must be rejected")
	}

	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, &Claims{Username: "x", Role: "lead"}).SignedString(jwtKey)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := jwt.ParseWithClaims(signed, &Claims{}, jwtSigningKey); err != nil {
		t.Fatal(err)
	}
}
