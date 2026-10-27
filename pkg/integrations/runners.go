package integrations

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/smtp"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

func mergedConfig(m *Manifest, routing ProjectRouting) map[string]string {
	out := make(map[string]string, len(m.Config)+8)
	for k, v := range m.Config {
		out[k] = v
	}
	for k, v := range routing.Values {
		if strings.TrimSpace(v) != "" {
			out[k] = v
		}
	}
	if routing.SlackChannel != "" {
		out["SLACK_CHANNEL"] = routing.SlackChannel
	}
	if routing.JiraProjectKey != "" {
		out["JIRA_PROJECT_KEY"] = routing.JiraProjectKey
	}
	if routing.TeamsWebhookURL != "" {
		out["TEAMS_WEBHOOK_URL"] = routing.TeamsWebhookURL
	}
	return out
}

func configVal(key string, c map[string]string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return strings.TrimSpace(c[key])
}

func blockedPluginIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	return ip.IsLoopback() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast()
}

// pluginURLAllowed rejects non-HTTP URLs and hosts that point at this machine or link-local metadata.
// Private RFC1918 addresses stay allowed so an on-prem webhook can be used.
func pluginURLAllowed(raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" {
		return fmt.Errorf("invalid plugin url")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return fmt.Errorf("plugin url must be http or https")
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".localhost") || host == "0.0.0.0" || host == "metadata.google.internal" {
		return fmt.Errorf("plugin url host is not allowed")
	}
	if ip := net.ParseIP(host); ip != nil && blockedPluginIP(ip) {
		return fmt.Errorf("plugin url host is not allowed")
	}
	return nil
}

func pluginHTTPClient() *http.Client {
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil || len(ips) == 0 {
				if err == nil {
					err = fmt.Errorf("no addresses")
				}
				return nil, err
			}
			for _, ip := range ips {
				if blockedPluginIP(ip.IP) {
					return nil, fmt.Errorf("plugin destination %s is not allowed", host)
				}
			}
			return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
		},
	}
	return &http.Client{
		Timeout:   25 * time.Second,
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return fmt.Errorf("too many redirects")
			}
			return pluginURLAllowed(req.URL.String())
		},
	}
}

var pluginClient = pluginHTTPClient()

func doPluginHTTP(req *http.Request) (*http.Response, error) {
	if req == nil || req.URL == nil {
		return nil, fmt.Errorf("missing plugin url")
	}
	if err := pluginURLAllowed(req.URL.String()); err != nil {
		return nil, err
	}
	return pluginClient.Do(req)
}

func httpPostJSON(ctx context.Context, rawURL string, body any, headers map[string]string) (int, string, error) {
	b, err := json.Marshal(body)
	if err != nil {
		return 0, "", err
	}
	if err := pluginURLAllowed(rawURL); err != nil {
		return 0, "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, rawURL, bytes.NewReader(b))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := doPluginHTTP(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, string(raw), nil
}

func runSlack(ctx context.Context, m *Manifest, inc IncidentContext, routing ProjectRouting) Result {
	c := mergedConfig(m, routing)
	webhook := configVal("SLACK_WEBHOOK_URL", c)
	if webhook == "" {
		return Result{Success: false, Logs: "[ERROR] SLACK_WEBHOOK_URL not configured (env or Plugin config)."}
	}
	channel := configVal("SLACK_CHANNEL", c)
	if channel == "" {
		channel = "#general"
	}
	color := configVal("SLACK_COLOR", c)
	if color == "" {
		color = "#ff4444"
	}
	payload := map[string]any{
		"channel": channel,
		"attachments": []map[string]any{{
			"color":  color,
			"title":  alertText(c, "SLACK_TITLE", fmt.Sprintf("SRE Alert: %s", incidentSummary(inc)), inc),
			"text":   alertText(c, "SLACK_TEXT", fmt.Sprintf("Error detected by SRE Capsule.\n\n%s", inc.Error), inc),
			"footer": "SRE Capsule Remediation Engine",
		}},
	}
	if name := configVal("SLACK_USERNAME", c); name != "" {
		payload["username"] = name
	}
	if icon := configVal("SLACK_ICON_EMOJI", c); icon != "" {
		payload["icon_emoji"] = icon
	}
	code, body, err := httpPostJSON(ctx, webhook, payload, nil)
	if err != nil {
		return Result{Success: false, Logs: fmt.Sprintf("[ERROR] Slack request failed: %v", err)}
	}
	if code >= 200 && code < 300 {
		return Result{Success: true, Logs: fmt.Sprintf("[SLACK] Delivered to %s (HTTP %d)\n%s", channel, code, body)}
	}
	return Result{Success: false, Logs: fmt.Sprintf("[ERROR] Slack HTTP %d\n%s", code, body)}
}

func runJira(ctx context.Context, m *Manifest, inc IncidentContext, routing ProjectRouting) Result {
	c := mergedConfig(m, routing)
	base := strings.TrimSuffix(configVal("JIRA_URL", c), "/")
	email := configVal("JIRA_EMAIL", c)
	token := configVal("JIRA_API_TOKEN", c)
	projectKey := configVal("JIRA_PROJECT_KEY", c)
	issueType := configVal("JIRA_ISSUE_TYPE", c)
	if issueType == "" {
		issueType = "Bug"
	}
	if base == "" || email == "" || token == "" {
		return Result{Success: false, Logs: "[ERROR] JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN required."}
	}
	if projectKey == "" {
		return Result{Success: false, Logs: "[ERROR] JIRA_PROJECT_KEY required (Plugin config or CI/CD Gateway)."}
	}
	fields := map[string]any{
		"project":     map[string]string{"key": projectKey},
		"summary":     alertText(c, "JIRA_SUMMARY", fmt.Sprintf("[SRE Capsule] %s", incidentSummary(inc)), inc),
		"description": alertText(c, "JIRA_DESCRIPTION", fmt.Sprintf("Incident from SRE Capsule.\n\n%s", inc.Error), inc),
		"issuetype":   map[string]string{"name": issueType},
	}
	if priority := configVal("JIRA_PRIORITY", c); priority != "" {
		fields["priority"] = map[string]string{"name": priority}
	}
	if labels := configList(configVal("JIRA_LABELS", c)); len(labels) > 0 {
		fields["labels"] = labels
	}
	if assignee := configVal("JIRA_ASSIGNEE", c); assignee != "" {
		fields["assignee"] = map[string]string{"name": assignee}
	}
	if components := configList(configVal("JIRA_COMPONENTS", c)); len(components) > 0 {
		named := make([]map[string]string, 0, len(components))
		for _, name := range components {
			named = append(named, map[string]string{"name": name})
		}
		fields["components"] = named
	}
	payload := map[string]any{"fields": fields}
	body, err := json.Marshal(payload)
	if err != nil {
		return Result{Success: false, Logs: err.Error()}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/rest/api/2/issue", bytes.NewReader(body))
	if err != nil {
		return Result{Success: false, Logs: err.Error()}
	}
	req.SetBasicAuth(email, token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := doPluginHTTP(req)
	if err != nil {
		return Result{Success: false, Logs: fmt.Sprintf("[ERROR] Jira request failed: %v", err)}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == 201 {
		return Result{Success: true, Logs: fmt.Sprintf("[JIRA] Ticket created (HTTP 201)\n%s\nBrowse: %s/browse/...", base, base)}
	}
	return Result{Success: false, Logs: fmt.Sprintf("[ERROR] Jira HTTP %d\n%s", resp.StatusCode, raw)}
}

func runTeams(ctx context.Context, m *Manifest, inc IncidentContext, routing ProjectRouting) Result {
	c := mergedConfig(m, routing)
	webhook := configVal("TEAMS_WEBHOOK_URL", c)
	if webhook == "" {
		return Result{Success: false, Logs: "[ERROR] TEAMS_WEBHOOK_URL not configured."}
	}
	theme := configVal("TEAMS_THEME_COLOR", c)
	if theme == "" {
		theme = "E81123"
	}
	subtitle := alertText(c, "TEAMS_SUBTITLE", fmt.Sprintf("Status: %s", inc.Status), inc)
	payload := map[string]any{
		"@type":      "MessageCard",
		"@context":   "http://schema.org/extensions",
		"themeColor": theme,
		"summary":    "SRE Capsule alert",
		"sections": []map[string]any{{
			"activityTitle":    alertText(c, "TEAMS_TITLE", fmt.Sprintf("SRE incident: %s", incidentSummary(inc)), inc),
			"activitySubtitle": subtitle,
			"text":             alertText(c, "TEAMS_TEXT", inc.Error, inc),
			"markdown":         true,
		}},
	}
	code, body, err := httpPostJSON(ctx, webhook, payload, nil)
	if err != nil {
		return Result{Success: false, Logs: err.Error()}
	}
	if code == 200 || code == 202 {
		return Result{Success: true, Logs: fmt.Sprintf("[TEAMS] Success HTTP %d\n%s", code, body)}
	}
	return Result{Success: false, Logs: fmt.Sprintf("[ERROR] Teams HTTP %d\n%s", code, body)}
}

func runPagerDuty(ctx context.Context, m *Manifest, inc IncidentContext, routing ProjectRouting) Result {
	c := mergedConfig(m, routing)
	key := configVal("PAGERDUTY_ROUTING_KEY", c)
	if key == "" {
		return Result{Success: false, Logs: "[ERROR] PAGERDUTY_ROUTING_KEY not configured."}
	}
	apiURL := configVal("PAGERDUTY_API_URL", c)
	if apiURL == "" {
		apiURL = "https://events.pagerduty.com/v2/enqueue"
	}
	severity := configVal("PAGERDUTY_SEVERITY", c)
	if severity == "" {
		severity = "critical"
	}
	source := configVal("PAGERDUTY_SOURCE", c)
	if source == "" {
		source = "sre-capsule"
	}
	pdPayload := map[string]any{
		"summary":  alertText(c, "PAGERDUTY_SUMMARY", fmt.Sprintf("[SRE Capsule] %s", incidentSummary(inc)), inc),
		"source":   source,
		"severity": severity,
	}
	if component := configVal("PAGERDUTY_COMPONENT", c); component != "" {
		pdPayload["component"] = component
	}
	if group := configVal("PAGERDUTY_GROUP", c); group != "" {
		pdPayload["group"] = group
	}
	if class := configVal("PAGERDUTY_CLASS", c); class != "" {
		pdPayload["class"] = class
	}
	if details := strings.TrimSpace(configVal("PAGERDUTY_DETAILS", c)); details != "" {
		pdPayload["custom_details"] = map[string]string{"details": applyIncidentTemplate(details, inc)}
	}
	payload := map[string]any{
		"routing_key":  key,
		"event_action": "trigger",
		"payload":      pdPayload,
	}
	code, body, err := httpPostJSON(ctx, apiURL, payload, nil)
	if err != nil {
		return Result{Success: false, Logs: err.Error()}
	}
	if code == 200 || code == 202 {
		return Result{Success: true, Logs: fmt.Sprintf("[PAGERDUTY] Queued (HTTP %d)\n%s", code, body)}
	}
	return Result{Success: false, Logs: fmt.Sprintf("[ERROR] PagerDuty HTTP %d\n%s", code, body)}
}

func runOpsgenie(ctx context.Context, m *Manifest, inc IncidentContext, routing ProjectRouting) Result {
	c := mergedConfig(m, routing)
	key := configVal("OPSGENIE_API_KEY", c)
	if key == "" {
		return Result{Success: false, Logs: "[ERROR] OPSGENIE_API_KEY not configured (env or Plugin config)."}
	}
	apiURL := configVal("OPSGENIE_API_URL", c)
	if apiURL == "" {
		apiURL = "https://api.opsgenie.com"
	}
	u := strings.TrimSuffix(apiURL, "/") + "/v2/alerts"
	priority := configVal("OPSGENIE_PRIORITY", c)
	if priority == "" {
		priority = "P1"
	}
	payload := map[string]any{
		"message":     alertText(c, "OPSGENIE_MESSAGE", fmt.Sprintf("[SRE Capsule] %s", incidentSummary(inc)), inc),
		"description": alertText(c, "OPSGENIE_DESCRIPTION", inc.Error, inc),
		"priority":    priority,
		"source":      "sre-capsule",
	}
	if tags := configList(configVal("OPSGENIE_TAGS", c)); len(tags) > 0 {
		payload["tags"] = tags
	}
	if team := configVal("OPSGENIE_TEAM", c); team != "" {
		payload["responders"] = []map[string]string{{"name": team, "type": "team"}}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, mustJSON(payload))
	if err != nil {
		return Result{Success: false, Logs: err.Error()}
	}
	req.Header.Set("Authorization", "GenieKey "+key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := doPluginHTTP(req)
	if err != nil {
		return Result{Success: false, Logs: err.Error()}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return Result{Success: true, Logs: fmt.Sprintf("[OPSGENIE] Alert created (HTTP %d)\n%s", resp.StatusCode, raw)}
	}
	return Result{Success: false, Logs: fmt.Sprintf("[ERROR] Opsgenie HTTP %d\n%s", resp.StatusCode, raw)}
}

func runVictorOps(ctx context.Context, m *Manifest, inc IncidentContext, routing ProjectRouting) Result {
	c := mergedConfig(m, routing)
	u := configVal("VICTOROPS_ROUTING_URL", c)
	if u == "" {
		return Result{Success: false, Logs: "[ERROR] VICTOROPS_ROUTING_URL not configured."}
	}
	messageType := configVal("VICTOROPS_MESSAGE_TYPE", c)
	if messageType == "" {
		messageType = "CRITICAL"
	}
	entity := configVal("VICTOROPS_ENTITY", c)
	if entity == "" {
		entity = "SRE Capsule"
	}
	payload := map[string]any{
		"message_type":        messageType,
		"entity_display_name": entity,
		"state_message":       alertText(c, "VICTOROPS_MESSAGE", fmt.Sprintf("[SRE Capsule] %s", incidentSummary(inc)), inc),
	}
	if id := configVal("VICTOROPS_ENTITY_ID", c); id != "" {
		payload["entity_id"] = id
	}
	code, body, err := httpPostJSON(ctx, u, payload, nil)
	if err != nil {
		return Result{Success: false, Logs: err.Error()}
	}
	if code >= 200 && code < 300 {
		return Result{Success: true, Logs: fmt.Sprintf("[VICTOROPS] Success HTTP %d\n%s", code, body)}
	}
	return Result{Success: false, Logs: fmt.Sprintf("[ERROR] VictorOps HTTP %d\n%s", code, body)}
}

func runWebhook(ctx context.Context, m *Manifest, inc IncidentContext, routing ProjectRouting) Result {
	c := mergedConfig(m, routing)
	u := configVal("WEBHOOK_URL", c)
	if u == "" {
		u = configVal("QA_WEBHOOK_URL", c)
	}
	if u == "" {
		return Result{Success: false, Logs: "[ERROR] WEBHOOK_URL not configured."}
	}
	eventName := configVal("WEBHOOK_EVENT", c)
	if eventName == "" {
		eventName = "incident.detected"
	}
	payload := map[string]any{
		"source":   "sre-capsule",
		"event":    eventName,
		"incident": incidentSummary(inc),
		"error":    inc.Error,
		"status":   inc.Status,
		"action":   inc.Action,
	}
	if msg := strings.TrimSpace(configVal("WEBHOOK_MESSAGE", c)); msg != "" {
		payload["message"] = applyIncidentTemplate(msg, inc)
	}
	headers := map[string]string{}
	if auth := configVal("WEBHOOK_AUTH_HEADER", c); auth != "" {
		headers["Authorization"] = auth
	}
	code, body, err := httpPostJSON(ctx, u, payload, headers)
	if err != nil {
		return Result{Success: false, Logs: err.Error()}
	}
	if code >= 200 && code < 300 {
		return Result{Success: true, Logs: fmt.Sprintf("[WEBHOOK] Delivered HTTP %d\n%s", code, body)}
	}
	return Result{Success: false, Logs: fmt.Sprintf("[ERROR] Webhook HTTP %d\n%s", code, body)}
}

func runDatadog(ctx context.Context, m *Manifest, inc IncidentContext, routing ProjectRouting) Result {
	c := mergedConfig(m, routing)
	apiKey := configVal("DD_API_KEY", c)
	if apiKey == "" {
		return Result{Success: false, Logs: "[ERROR] DD_API_KEY not configured."}
	}
	site := configVal("DD_SITE", c)
	if site == "" {
		site = "datadoghq.com"
	}
	if strings.ContainsAny(site, "/\\@:?# ") || strings.Contains(site, "..") {
		return Result{Success: false, Logs: "[ERROR] DD_SITE must be a hostname such as datadoghq.com."}
	}
	alertType := configVal("DD_ALERT_TYPE", c)
	if alertType == "" {
		alertType = "error"
	}
	sourceType := configVal("DD_SOURCE", c)
	if sourceType == "" {
		sourceType = "sre-capsule"
	}
	payload := map[string]any{
		"title":            alertText(c, "DD_TITLE", fmt.Sprintf("SRE Capsule: %s", incidentSummary(inc)), inc),
		"text":             alertText(c, "DD_TEXT", inc.Error, inc),
		"alert_type":       alertType,
		"source_type_name": sourceType,
	}
	if priority := configVal("DD_PRIORITY", c); priority != "" {
		payload["priority"] = priority
	}
	if tags := datadogTags(configVal("DATADOG_TAGS", c)); len(tags) > 0 {
		payload["tags"] = tags
	}
	url := fmt.Sprintf("https://api.%s/api/v1/events", site)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, mustJSON(payload))
	if err != nil {
		return Result{Success: false, Logs: err.Error()}
	}
	req.Header.Set("DD-API-KEY", apiKey)
	if appKey := configVal("DD_APP_KEY", c); appKey != "" {
		req.Header.Set("DD-APPLICATION-KEY", appKey)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := doPluginHTTP(req)
	if err != nil {
		return Result{Success: false, Logs: err.Error()}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == 202 {
		return Result{Success: true, Logs: fmt.Sprintf("[DATADOG] Event created\n%s", raw)}
	}
	return Result{Success: false, Logs: fmt.Sprintf("[ERROR] Datadog HTTP %d\n%s", resp.StatusCode, raw)}
}

func mustJSON(v any) io.Reader {
	b, _ := json.Marshal(v)
	return bytes.NewReader(b)
}

func runSendGrid(ctx context.Context, m *Manifest, inc IncidentContext, routing ProjectRouting) Result {
	c := mergedConfig(m, routing)
	apiKey := configVal("SENDGRID_API_KEY", c)
	from := configVal("SENDGRID_FROM", c)
	to := configVal("SENDGRID_TO", c)
	if apiKey == "" || from == "" || to == "" {
		return Result{Success: false, Logs: "[ERROR] SENDGRID_API_KEY, SENDGRID_FROM, SENDGRID_TO required."}
	}
	fromObj := map[string]string{"email": from}
	if name := configVal("SENDGRID_FROM_NAME", c); name != "" {
		fromObj["name"] = name
	}
	personal := map[string]any{"to": []map[string]string{{"email": to}}}
	if cc := configList(configVal("SENDGRID_CC", c)); len(cc) > 0 {
		copied := make([]map[string]string, 0, len(cc))
		for _, addr := range cc {
			copied = append(copied, map[string]string{"email": addr})
		}
		personal["cc"] = copied
	}
	payload := map[string]any{
		"personalizations": []map[string]any{personal},
		"from":             fromObj,
		"subject":          alertText(c, "SENDGRID_SUBJECT", fmt.Sprintf("[SRE Capsule] %s", incidentSummary(inc)), inc),
		"content":          []map[string]string{{"type": "text/html", "value": brandedMailHTML(alertText(c, "SENDGRID_BODY", inc.Error, inc))}},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.sendgrid.com/v3/mail/send", mustJSON(payload))
	if err != nil {
		return Result{Success: false, Logs: err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := doPluginHTTP(req)
	if err != nil {
		return Result{Success: false, Logs: err.Error()}
	}
	defer resp.Body.Close()
	if resp.StatusCode == 202 || resp.StatusCode == 200 {
		return Result{Success: true, Logs: "[SENDGRID] Email accepted."}
	}
	raw, _ := io.ReadAll(resp.Body)
	return Result{Success: false, Logs: fmt.Sprintf("[ERROR] SendGrid HTTP %d\n%s", resp.StatusCode, raw)}
}

func runGitHub(ctx context.Context, m *Manifest, inc IncidentContext, routing ProjectRouting) Result {
	c := mergedConfig(m, routing)
	token := configVal("GITHUB_TOKEN", c)
	owner := configVal("GITHUB_OWNER", c)
	repo := configVal("GITHUB_REPO", c)
	workflow := configVal("GITHUB_WORKFLOW_ID", c)
	ref := configVal("GITHUB_REF", c)
	if ref == "" {
		ref = "main"
	}
	if token == "" || owner == "" || repo == "" || workflow == "" {
		return Result{Success: false, Logs: "[ERROR] GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_WORKFLOW_ID required."}
	}
	if !githubPathSegment(owner) || !githubPathSegment(repo) || !githubPathSegment(workflow) {
		return Result{Success: false, Logs: "[ERROR] GITHUB_OWNER, GITHUB_REPO, and GITHUB_WORKFLOW_ID must be a single path segment."}
	}
	u := fmt.Sprintf("https://api.github.com/repos/%s/%s/actions/workflows/%s/dispatches", owner, repo, workflow)
	inputs := map[string]string{
		"triggered_by": "sre-capsule",
		"incident":     incidentSummary(inc),
	}
	if note := strings.TrimSpace(configVal("GITHUB_NOTE", c)); note != "" {
		inputs["note"] = applyIncidentTemplate(note, inc)
	}
	payload := map[string]any{
		"ref":    ref,
		"inputs": inputs,
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, mustJSON(payload))
	if err != nil {
		return Result{Success: false, Logs: err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Content-Type", "application/json")
	resp, err := doPluginHTTP(req)
	if err != nil {
		return Result{Success: false, Logs: err.Error()}
	}
	defer resp.Body.Close()
	if resp.StatusCode == 204 {
		return Result{Success: true, Logs: "[GITHUB] Workflow dispatch accepted."}
	}
	raw, _ := io.ReadAll(resp.Body)
	return Result{Success: false, Logs: fmt.Sprintf("[ERROR] GitHub HTTP %d\n%s", resp.StatusCode, raw)}
}

func runSMTP(ctx context.Context, m *Manifest, inc IncidentContext, routing ProjectRouting) Result {
	c := mergedConfig(m, routing)
	host := configVal("SMTP_HOST", c)
	port := configVal("SMTP_PORT", c)
	if port == "" {
		port = "587"
	}
	user := configVal("SMTP_USER", c)
	pass := configVal("SMTP_PASS", c)
	from := configVal("SMTP_FROM", c)
	to := configVal("SMTP_TO", c)
	if host == "" || from == "" || to == "" {
		return Result{Success: false, Logs: "[ERROR] SMTP_HOST, SMTP_FROM, SMTP_TO required."}
	}
	subject := strings.NewReplacer("\r", " ", "\n", " ").Replace(alertText(c, "SMTP_SUBJECT", fmt.Sprintf("[SRE Capsule] %s", incidentSummary(inc)), inc))
	body := brandedMailHTML(alertText(c, "SMTP_BODY", fmt.Sprintf("Incident: %s\n\n%s", incidentSummary(inc), inc.Error), inc))
	cc := configList(configVal("SMTP_CC", c))
	header := fmt.Sprintf("From: %s\r\nTo: %s\r\n", from, to)
	if len(cc) > 0 {
		header += "Cc: " + strings.Join(cc, ", ") + "\r\n"
	}
	msg := []byte(header + fmt.Sprintf("Subject: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n%s", subject, body))
	recipients := append([]string{to}, cc...)
	addr := host + ":" + port
	auth := smtp.PlainAuth("", user, pass, host)
	done := make(chan error, 1)
	go func() {
		done <- smtp.SendMail(addr, auth, from, recipients, msg)
	}()
	select {
	case <-ctx.Done():
		return Result{Success: false, Logs: "[ERROR] SMTP timeout."}
	case err := <-done:
		if err != nil {
			return Result{Success: false, Logs: fmt.Sprintf("[ERROR] SMTP: %v", err)}
		}
		return Result{Success: true, Logs: "[SMTP] Message sent."}
	}
}

func githubPathSegment(v string) bool {
	v = strings.TrimSpace(v)
	if v == "" || v == "." || v == ".." {
		return false
	}
	return !strings.ContainsAny(v, "/\\?# ")
}

func runTestRail(ctx context.Context, m *Manifest, inc IncidentContext, routing ProjectRouting) Result {
	c := mergedConfig(m, routing)
	base := strings.TrimSuffix(configVal("TESTRAIL_URL", c), "/")
	user := configVal("TESTRAIL_USER", c)
	key := configVal("TESTRAIL_API_KEY", c)
	runID := configVal("TESTRAIL_RUN_ID", c)
	caseID := configVal("TESTRAIL_CASE_ID", c)
	statusID := configVal("TESTRAIL_STATUS_ID", c)
	if statusID == "" {
		statusID = "5"
	}
	if base == "" || user == "" || key == "" || runID == "" || caseID == "" {
		return Result{Success: false, Logs: "[ERROR] TESTRAIL_URL, TESTRAIL_USER, TESTRAIL_API_KEY, TESTRAIL_RUN_ID, TESTRAIL_CASE_ID required."}
	}
	comment := alertText(c, "TESTRAIL_COMMENT", fmt.Sprintf("%s\n\n%s", incidentSummary(inc), inc.Error), inc)
	var statusValue any = statusID
	if n, err := strconv.Atoi(statusID); err == nil {
		statusValue = n
	}
	payload := map[string]any{"status_id": statusValue, "comment": comment}
	u := fmt.Sprintf("%s/index.php?/api/v2/add_result_for_case/%s/%s", base, url.PathEscape(runID), url.PathEscape(caseID))
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, mustJSON(payload))
	if err != nil {
		return Result{Success: false, Logs: err.Error()}
	}
	req.SetBasicAuth(user, key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := doPluginHTTP(req)
	if err != nil {
		return Result{Success: false, Logs: fmt.Sprintf("[ERROR] TestRail request failed: %v", err)}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return Result{Success: true, Logs: fmt.Sprintf("[TESTRAIL] Result posted (HTTP %d)\n%s", resp.StatusCode, raw)}
	}
	return Result{Success: false, Logs: fmt.Sprintf("[ERROR] TestRail HTTP %d\n%s", resp.StatusCode, raw)}
}

func runZephyr(ctx context.Context, m *Manifest, inc IncidentContext, routing ProjectRouting) Result {
	c := mergedConfig(m, routing)
	base := strings.TrimSuffix(configVal("ZEPHYR_API_URL", c), "/")
	token := configVal("ZEPHYR_API_TOKEN", c)
	project := configVal("ZEPHYR_PROJECT_KEY", c)
	testCase := configVal("ZEPHYR_TEST_CASE_KEY", c)
	statusName := configVal("ZEPHYR_STATUS", c)
	if statusName == "" {
		statusName = "Fail"
	}
	if base == "" || token == "" || project == "" || testCase == "" {
		return Result{Success: false, Logs: "[ERROR] ZEPHYR_API_URL, ZEPHYR_API_TOKEN, ZEPHYR_PROJECT_KEY, ZEPHYR_TEST_CASE_KEY required."}
	}
	payload := map[string]any{
		"projectKey":    project,
		"testCaseKey":   testCase,
		"statusName":    statusName,
		"comment":       alertText(c, "ZEPHYR_COMMENT", fmt.Sprintf("%s\n\n%s", incidentSummary(inc), inc.Error), inc),
	}
	if envName := configVal("ZEPHYR_ENVIRONMENT", c); envName != "" {
		payload["environmentName"] = envName
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/testexecutions", mustJSON(payload))
	if err != nil {
		return Result{Success: false, Logs: err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := doPluginHTTP(req)
	if err != nil {
		return Result{Success: false, Logs: fmt.Sprintf("[ERROR] Zephyr request failed: %v", err)}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return Result{Success: true, Logs: fmt.Sprintf("[ZEPHYR] Execution posted (HTTP %d)\n%s", resp.StatusCode, raw)}
	}
	return Result{Success: false, Logs: fmt.Sprintf("[ERROR] Zephyr HTTP %d\n%s", resp.StatusCode, raw)}
}

func runXray(ctx context.Context, m *Manifest, inc IncidentContext, routing ProjectRouting) Result {
	c := mergedConfig(m, routing)
	clientID := configVal("XRAY_CLIENT_ID", c)
	secret := configVal("XRAY_CLIENT_SECRET", c)
	base := strings.TrimSuffix(configVal("XRAY_API_URL", c), "/")
	if base == "" {
		base = "https://xray.cloud.getxray.app"
	}
	project := configVal("XRAY_PROJECT_KEY", c)
	testKey := configVal("XRAY_TEST_KEY", c)
	statusName := configVal("XRAY_STATUS", c)
	if statusName == "" {
		statusName = "FAILED"
	}
	if clientID == "" || secret == "" || project == "" || testKey == "" {
		return Result{Success: false, Logs: "[ERROR] XRAY_CLIENT_ID, XRAY_CLIENT_SECRET, XRAY_PROJECT_KEY, XRAY_TEST_KEY required."}
	}
	authReq, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/v2/authenticate", mustJSON(map[string]string{
		"client_id":     clientID,
		"client_secret": secret,
	}))
	if err != nil {
		return Result{Success: false, Logs: err.Error()}
	}
	authReq.Header.Set("Content-Type", "application/json")
	authResp, err := doPluginHTTP(authReq)
	if err != nil {
		return Result{Success: false, Logs: fmt.Sprintf("[ERROR] Xray auth failed: %v", err)}
	}
	defer authResp.Body.Close()
	tokenRaw, _ := io.ReadAll(io.LimitReader(authResp.Body, 1<<20))
	if authResp.StatusCode < 200 || authResp.StatusCode >= 300 {
		return Result{Success: false, Logs: fmt.Sprintf("[ERROR] Xray auth HTTP %d\n%s", authResp.StatusCode, tokenRaw)}
	}
	token := strings.Trim(string(tokenRaw), "\" \n\r\t")
	test := map[string]any{
		"testKey": testKey,
		"status":  statusName,
		"comment": alertText(c, "XRAY_COMMENT", inc.Error, inc),
	}
	info := map[string]any{
		"project": project,
		"summary": alertText(c, "XRAY_SUMMARY", fmt.Sprintf("[SRE Capsule] %s", incidentSummary(inc)), inc),
	}
	if execKey := configVal("XRAY_TEST_EXEC", c); execKey != "" {
		info["testPlanKey"] = execKey
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/v2/import/execution", mustJSON(map[string]any{
		"info":  info,
		"tests": []map[string]any{test},
	}))
	if err != nil {
		return Result{Success: false, Logs: err.Error()}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := doPluginHTTP(req)
	if err != nil {
		return Result{Success: false, Logs: fmt.Sprintf("[ERROR] Xray import failed: %v", err)}
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return Result{Success: true, Logs: fmt.Sprintf("[XRAY] Execution imported (HTTP %d)\n%s", resp.StatusCode, raw)}
	}
	return Result{Success: false, Logs: fmt.Sprintf("[ERROR] Xray HTTP %d\n%s", resp.StatusCode, raw)}
}

func runK8sStub(_ context.Context, _ *Manifest, _ IncidentContext, _ ProjectRouting) Result {
	return Result{
		Success: false,
		Logs: `[ERROR] Kubernetes rollout is not available via shell anymore.
[HINT] Use a webhook integration pointing to your GitOps/operator API, or add in-cluster client-go in a future release.`,
	}
}

func runUnsupported(name string) Result {
	return Result{Success: false, Logs: fmt.Sprintf("[ERROR] integration %q not implemented in Go engine yet.", name)}
}
