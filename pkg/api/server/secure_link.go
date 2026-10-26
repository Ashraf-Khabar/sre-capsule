package server

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/SRE-Capsule/sre-capsule-community/pkg/core"
)

const linkTTL = 365 * 24 * time.Hour

type secureLink struct {
	K string `json:"k"`
	V string `json:"v,omitempty"`
	T string `json:"t,omitempty"`
	P string `json:"p,omitempty"`
	R string `json:"r,omitempty"`
	I int64  `json:"i,omitempty"`
	M int64  `json:"m,omitempty"`
	E int64  `json:"e"`
}

var linkViewRe = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)
var linkTopicRe = regexp.MustCompile(`^[a-z0-9_]{1,40}$`)

func linkKey() []byte {
	sum := sha256.Sum256(append(append([]byte{}, jwtKey...), []byte("sre-capsule-link-v1")...))
	return sum[:]
}

func sealLink(link secureLink) (string, error) {
	if len(jwtKey) == 0 {
		return "", errors.New("invalid link target")
	}
	payload, err := json.Marshal(link)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(linkKey())
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, payload, nil)
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

// linkPath is the address bar form: the page name, then the security hash.
// Records use /review/id=<hash> so the id is never a sequential number.
func linkPath(link secureLink, token string) string {
	switch link.K {
	case "comment", "report":
		return "/review/id=" + token
	case "view":
		if link.V == "about" && link.T != "" {
			return "/about/" + link.T + "/" + token
		}
		return "/" + viewSlug(link.V) + "/" + token
	default:
		return "/l/" + token
	}
}

func viewSlug(view string) string {
	switch view {
	case "organizations":
		return "workspaces"
	case "ingestion":
		return "gateways"
	case "ai-usage":
		return "ai"
	case "rca", "healing":
		return "healing"
	case "unified-report":
		return "review"
	default:
		return view
	}
}

func knownViewSlug(slug string) bool {
	switch strings.ToLower(slug) {
	case "dashboard", "suite", "activity", "unowned", "management", "dora", "finops", "healing", "ai", "ai-usage", "ai-config",
		"workspaces", "organizations", "gateways", "ingestion", "plugins", "settings", "profile", "about", "review", "workflow":
		return true
	default:
		return false
	}
}

// namedLinkToken reads /dashboard/<hash>, /about/<topic>/<hash>, and /review/id=<hash>.
func namedLinkToken(path string) (string, bool) {
	path = strings.Trim(path, "/")
	if path == "" || strings.Contains(path, ".") {
		return "", false
	}
	lower := strings.ToLower(path)
	if strings.HasPrefix(lower, "review/id=") {
		token := path[len("review/id="):]
		if token != "" && !strings.Contains(token, "/") {
			return token, true
		}
		return "", false
	}
	parts := strings.Split(path, "/")
	if len(parts) == 2 && knownViewSlug(parts[0]) {
		return parts[1], true
	}
	if len(parts) == 3 && strings.EqualFold(parts[0], "about") && linkTopicRe.MatchString(parts[1]) {
		return parts[2], true
	}
	return "", false
}

func pathMatchesLink(requestPath string, link secureLink, token string) bool {
	got := strings.TrimRight(requestPath, "/")
	want := strings.TrimRight(linkPath(link, token), "/")
	return strings.EqualFold(got, want)
}

// linkShards are kept so older /xxxx/yyyy/<hash> bookmarks still open.
func linkShards(token string) (string, string) {
	mac := hmac.New(sha256.New, linkKey())
	_, _ = mac.Write([]byte(token))
	sum := mac.Sum(nil)
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	encode := func(b []byte) string {
		out := make([]byte, 4)
		for i := 0; i < 4; i++ {
			out[i] = alphabet[int(b[i])%len(alphabet)]
		}
		return string(out)
	}
	return encode(sum[0:4]), encode(sum[4:8])
}

func splitDynamicLink(path string) (string, string, string, bool) {
	path = strings.Trim(path, "/")
	parts := strings.Split(path, "/")
	if len(parts) != 3 {
		return "", "", "", false
	}
	a, b, token := parts[0], parts[1], parts[2]
	if !shardRe.MatchString(a) || !shardRe.MatchString(b) || token == "" || strings.Contains(token, ".") {
		return "", "", "", false
	}
	switch a {
	case "js", "img", "css", "api", "web":
		return "", "", "", false
	}
	return a, b, token, true
}

var shardRe = regexp.MustCompile(`^[a-z0-9]{4}$`)

func openLink(token string, now time.Time) (secureLink, error) {
	token = strings.TrimSpace(token)
	if token == "" || len(token) > 700 || strings.ContainsAny(token, "/?#") {
		return secureLink{}, errors.New("invalid link")
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return secureLink{}, errors.New("invalid link")
	}
	block, err := aes.NewCipher(linkKey())
	if err != nil {
		return secureLink{}, errors.New("invalid link")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return secureLink{}, errors.New("invalid link")
	}
	nonceSize := gcm.NonceSize()
	if len(raw) <= nonceSize {
		return secureLink{}, errors.New("invalid link")
	}
	plain, err := gcm.Open(nil, raw[:nonceSize], raw[nonceSize:], nil)
	if err != nil {
		return secureLink{}, errors.New("invalid link")
	}
	var link secureLink
	if err := json.Unmarshal(plain, &link); err != nil || link.K == "" {
		return secureLink{}, errors.New("invalid link")
	}
	if now.Unix() > link.E {
		return secureLink{}, errors.New("expired link")
	}
	return link, nil
}

// mintCommentLink returns an opaque token. The URL does not contain the incident or comment id.
func mintCommentLink(incidentID, commentID int64, now time.Time) (string, error) {
	if incidentID <= 0 || commentID <= 0 {
		return "", errors.New("invalid link target")
	}
	return sealLink(secureLink{K: "comment", I: incidentID, M: commentID, E: now.Add(linkTTL).Unix()})
}

func openCommentLink(token string, now time.Time) (int64, int64, error) {
	link, err := openLink(token, now)
	if err != nil {
		return 0, 0, err
	}
	if link.K != "comment" || link.I <= 0 || link.M <= 0 {
		return 0, 0, errors.New("invalid link")
	}
	return link.I, link.M, nil
}

func handleMintLink(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	claims := claimsFromRequest(r)
	if claims == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	var body struct {
		Kind     string `json:"kind"`
		View     string `json:"view"`
		Topic    string `json:"topic"`
		Project  string `json:"project"`
		RunID    string `json:"run_id"`
		Incident int64  `json:"incident_id"`
		Comment  int64  `json:"comment_id"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	link, err := authorizeLink(claims, body.Kind, body.View, body.Topic, body.Project, body.RunID, body.Incident, body.Comment)
	if err != nil {
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	}
	link.E = time.Now().Add(linkTTL).Unix()
	token, err := sealLink(link)
	if err != nil {
		http.Error(w, "Could not build the link", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"token": token, "path": linkPath(link, token)})
}

func handleSecureLink(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	claims := claimsFromRequest(r)
	if claims == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	token := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/links/"), "/")
	link, err := openLink(token, time.Now())
	if err != nil {
		http.Error(w, "This link is not valid", http.StatusNotFound)
		return
	}
	switch link.K {
	case "view":
		if !core.CanAccessView(claims.Role, link.V) {
			http.Error(w, "Access denied", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"kind": "view", "view": link.V, "topic": link.T})
	case "report":
		if !userCanAccessProjectName(claims.Username, claims.Role, link.P) {
			http.Error(w, "Access denied", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"kind": "report", "project_name": link.P, "pipeline_run_id": link.R})
	case "comment":
		if !core.UserCanAccessIncidentByID(claims.Username, claims.Role, link.I) {
			http.Error(w, "Access denied", http.StatusForbidden)
			return
		}
		var project, runID string
		err = core.DB.QueryRow(`SELECT project_name, COALESCE(pipeline_run_id, '') FROM incidents WHERE id = ?`, link.I).Scan(&project, &runID)
		if err != nil || strings.TrimSpace(runID) == "" {
			http.Error(w, "This link is not valid", http.StatusNotFound)
			return
		}
		var found int64
		if err := core.DB.QueryRow(`SELECT id FROM incident_comments WHERE id = ? AND incident_id = ?`, link.M, link.I).Scan(&found); err != nil {
			http.Error(w, "This link is not valid", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"kind":            "comment",
			"project_name":    project,
			"pipeline_run_id": runID,
			"incident_id":     link.I,
			"comment_id":      link.M,
		})
	default:
		http.Error(w, "This link is not valid", http.StatusNotFound)
	}
}

func authorizeLink(claims *Claims, kind, view, topic, project, runID string, incidentID, commentID int64) (secureLink, error) {
	kind = strings.TrimSpace(kind)
	switch kind {
	case "view":
		view = strings.TrimSpace(view)
		if view == "rca" {
			view = "healing"
		}
		if !linkViewRe.MatchString(view) || !core.CanAccessView(claims.Role, view) {
			return secureLink{}, errString("Access denied")
		}
		topic = strings.TrimSpace(topic)
		if topic != "" && !linkTopicRe.MatchString(topic) {
			return secureLink{}, errString("Access denied")
		}
		if view != "about" {
			topic = ""
		}
		return secureLink{K: "view", V: view, T: topic}, nil
	case "report":
		project = strings.TrimSpace(project)
		runID = strings.TrimSpace(runID)
		if project == "" || runID == "" || len(project) > 200 || len(runID) > 200 {
			return secureLink{}, errString("Access denied")
		}
		if strings.ContainsAny(project, "\r\n") || strings.ContainsAny(runID, "\r\n") {
			return secureLink{}, errString("Access denied")
		}
		if !userCanAccessProjectName(claims.Username, claims.Role, project) {
			return secureLink{}, errString("Access denied")
		}
		return secureLink{K: "report", P: project, R: runID}, nil
	case "comment":
		if incidentID <= 0 || commentID <= 0 || !core.UserCanAccessIncidentByID(claims.Username, claims.Role, incidentID) {
			return secureLink{}, errString("Access denied")
		}
		var owner int64
		if err := core.DB.QueryRow(`SELECT incident_id FROM incident_comments WHERE id = ?`, commentID).Scan(&owner); err != nil || owner != incidentID {
			return secureLink{}, errString("Access denied")
		}
		return secureLink{K: "comment", I: incidentID, M: commentID}, nil
	default:
		return secureLink{}, errString("Access denied")
	}
}

func serveAppIndex(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-SRE-Capsule-Edition", core.EditionID())
	w.Header().Set("X-SRE-Capsule-Version", core.Version)
	http.ServeFile(w, r, "./web/index.html")
}

func requestPublicBase(r *http.Request) string {
	if base := strings.TrimRight(strings.TrimSpace(os.Getenv("SRE_PUBLIC_URL")), "/"); strings.HasPrefix(base, "http://") || strings.HasPrefix(base, "https://") {
		return base
	}
	proto := "http"
	if r != nil && r.TLS != nil {
		proto = "https"
	}
	if r != nil {
		if fwd := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]); fwd == "http" || fwd == "https" {
			proto = fwd
		}
	}
	host := ""
	if r != nil {
		host = strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Host"), ",")[0])
		if host == "" {
			host = r.Host
		}
	}
	if host == "" {
		host = "localhost:9000"
	}
	return proto + "://" + host
}
