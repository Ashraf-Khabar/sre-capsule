package server

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/SRE-Capsule/sre-capsule-community/pkg/core"

	"github.com/golang-jwt/jwt/v5"
)

// parseBearerClaims validates the Authorization Bearer token and returns claims.
func parseBearerClaims(r *http.Request) (*Claims, error) {
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	if authHeader == "" {
		return nil, fmt.Errorf("missing token")
	}
	tokenString := strings.TrimPrefix(authHeader, "Bearer ")
	if tokenString == authHeader {
		return nil, fmt.Errorf("invalid authorization scheme")
	}
	claims := &Claims{}
	token, err := jwt.ParseWithClaims(tokenString, claims, jwtSigningKey)
	if err != nil || token == nil || !token.Valid {
		return nil, fmt.Errorf("invalid token")
	}
	return claims, nil
}

// jwtSigningKey accepts only HMAC signatures. Other algorithms, including none, are rejected.
func jwtSigningKey(token *jwt.Token) (interface{}, error) {
	if token == nil || token.Method == nil {
		return nil, fmt.Errorf("missing signing method")
	}
	if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
		return nil, fmt.Errorf("unexpected signing method")
	}
	return jwtKey, nil
}

// validateTokenString parses a raw JWT string (e.g. WebSocket ?token=).
func validateTokenString(tokenString string) (*Claims, error) {
	tokenString = strings.TrimSpace(tokenString)
	if tokenString == "" {
		return nil, fmt.Errorf("missing token")
	}
	claims := &Claims{}
	token, err := jwt.ParseWithClaims(tokenString, claims, jwtSigningKey)
	if err != nil || token == nil || !token.Valid {
		return nil, fmt.Errorf("invalid token")
	}
	return claims, nil
}

// EnforceProductionSecurity fails fast when critical secrets are missing outside dev.
func EnforceProductionSecurity(config *core.Config) {
	if isDevelopmentEnv() {
		return
	}
	mcpToken := strings.TrimSpace(os.Getenv("SRECAPSULE_MCP_TOKEN"))
	if mcpToken == "" && config != nil {
		mcpToken = strings.TrimSpace(config.Telemetry.WebhookToken)
	}
	if mcpToken == "" {
		log.Fatal("[FATAL] SRECAPSULE_MCP_TOKEN (or telemetry.webhook_token) is required in production — MCP endpoints must not be open")
	}
}

func securityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		if r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

func wsCheckOrigin(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	o, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := r.Host
	if fwd := strings.TrimSpace(r.Header.Get("X-Forwarded-Host")); fwd != "" {
		host = strings.Split(fwd, ",")[0]
		host = strings.TrimSpace(host)
	}
	return strings.EqualFold(o.Host, host)
}

func isPrivateOrRestrictedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
		return true
	}
	privateRanges := []string{
		"0.0.0.0/8",
		"10.0.0.0/8",
		"100.64.0.0/10",
		"127.0.0.0/8",
		"169.254.0.0/16",
		"172.16.0.0/12",
		"192.0.0.0/24",
		"192.0.2.0/24",
		"192.168.0.0/16",
		"198.18.0.0/15",
		"224.0.0.0/4",
		"240.0.0.0/4",
		"::1/128",
		"fc00::/7",
		"fe80::/10",
	}
	for _, cidr := range privateRanges {
		_, network, err := net.ParseCIDR(cidr)
		if err != nil {
			continue
		}
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

// isSSRFSafeURL returns false for non-http(s) URLs and hosts resolving to private networks.
func isSSRFSafeURL(rawURL string) bool {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return false
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return false
	}
	host := strings.TrimSpace(u.Hostname())
	if host == "" {
		return false
	}
	lowerHost := strings.ToLower(strings.TrimSuffix(host, "."))
	if lowerHost == "localhost" || strings.HasSuffix(lowerHost, ".localhost") || lowerHost == "0.0.0.0" {
		return false
	}
	if ip := net.ParseIP(host); ip != nil {
		return !isPrivateOrRestrictedIP(ip)
	}
	ips, err := net.LookupIP(host)
	if err != nil {
		return false
	}
	if len(ips) == 0 {
		return false
	}
	for _, ip := range ips {
		if isPrivateOrRestrictedIP(ip) {
			return false
		}
	}
	return true
}
