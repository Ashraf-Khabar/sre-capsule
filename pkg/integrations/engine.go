// Package integrations provides the plugin engine that connects SRE Capsule
// incidents to external collaboration and alerting platforms (Jira, Slack,
// PagerDuty, GitHub Actions, webhooks, email, etc.). Each integration is
// described by a Manifest, configured through YAML-based workflow definitions,
// and executed by a typed Runner registered in the global Registry.
package integrations

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
)

// Engine executes registered integrations (no shell).
type Engine struct {
	registry *Registry
}

func NewEngine(reg *Registry) *Engine {
	return &Engine{registry: reg}
}

func (e *Engine) Registry() *Registry {
	return e.registry
}

func (e *Engine) Run(ctx context.Context, filePath string, inc IncidentContext, routing ProjectRouting) (Result, error) {
	m, ok := e.registry.GetByPath(filePath)
	if !ok {
		return Result{Success: false, Logs: "[ERROR] integration not found"}, fmt.Errorf("not found: %s", filePath)
	}
	if strings.EqualFold(m.Status, "disabled") {
		return Result{Success: false, Logs: "[SKIP] integration disabled"}, nil
	}
	return e.runManifest(ctx, m, inc, routing), nil
}

func (e *Engine) runManifest(ctx context.Context, m *Manifest, inc IncidentContext, routing ProjectRouting) Result {
	if ctx == nil {
		ctx = context.Background()
	}
	hctx, cancel := HTTPContext(ctx)
	defer cancel()

	switch m.Integration {
	case "slack":
		return runSlack(hctx, m, inc, routing)
	case "jira":
		return runJira(hctx, m, inc, routing)
	case "teams":
		return runTeams(hctx, m, inc, routing)
	case "pagerduty":
		return runPagerDuty(hctx, m, inc, routing)
	case "opsgenie":
		return runOpsgenie(hctx, m, inc, routing)
	case "victorops":
		return runVictorOps(hctx, m, inc, routing)
	case "webhook":
		return runWebhook(hctx, m, inc, routing)
	case "datadog":
		return runDatadog(hctx, m, inc, routing)
	case "sendgrid":
		return runSendGrid(hctx, m, inc, routing)
	case "smtp":
		return runSMTP(hctx, m, inc, routing)
	case "github":
		return runGitHub(hctx, m, inc, routing)
	case "k8s":
		return runK8sStub(hctx, m, inc, routing)
	case "testrail":
		return runTestRail(hctx, m, inc, routing)
	case "zephyr":
		return runZephyr(hctx, m, inc, routing)
	case "xray":
		return runXray(hctx, m, inc, routing)
	case "qa":
		return runWebhook(hctx, m, inc, routing)
	default:
		return runUnsupported(m.Integration)
	}
}

// EvaluateAlertRules triggers integrations with auto_run enabled when alert text matches trigger_on.
// If allowedPaths is non-empty, only those manifest file paths are considered (project SRE routing).
func (e *Engine) EvaluateAlertRules(alertName, alertError, alertConsole, alertStatus string, routing ProjectRouting, allowedPaths map[string]bool) {
	alertText := strings.ToLower(fmt.Sprintf("%s %s %s", alertName, alertError, alertConsole))
	incBase := IncidentContext{
		Name:        alertName,
		Error:       alertError,
		ConsoleLogs: alertConsole,
		Status:      alertStatus,
	}
	for _, m := range e.registry.List() {
		if !strings.EqualFold(m.Status, "active") || !m.AutoRun {
			continue
		}
		if allowedPaths != nil {
			if len(allowedPaths) == 0 {
				continue
			}
			if !allowedPaths[m.FilePath] {
				continue
			}
		}
		if !matchesTrigger(alertText, m.TriggerOn) {
			continue
		}
		mCopy := m
		inc := incBase
		inc.Action = "AUTO_EVENT:" + alertName
		slog.Info("remediation auto-trigger", "integration", m.Integration, "name", m.Name)
		RunRemediationAsync(func() {
			res := e.runManifest(context.Background(), mCopy, inc, routing)
			if !res.Success {
				slog.Warn("remediation failed", "integration", mCopy.Integration, "logs", res.Logs)
			}
		})
	}
}

func matchesTrigger(alertText string, triggers []string) bool {
	for _, t := range triggers {
		if t != "" && strings.Contains(alertText, strings.ToLower(t)) {
			return true
		}
	}
	return false
}
