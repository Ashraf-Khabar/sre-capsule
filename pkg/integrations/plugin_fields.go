package integrations

// PluginField is one labeled input for a plugin. Each integration has its own set.
type PluginField struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Placeholder string `json:"placeholder"`
	InputType   string `json:"input_type"` // text, url, password, textarea
	Group       string `json:"group"`      // connection, delivery, message
	Hint        string `json:"hint,omitempty"`
	Gateway     bool   `json:"gateway"`
}

const templateHint = "Placeholders: {{name}} {{status}} {{error}} {{console}}"

// ConfigFieldsForIntegration is the Plugin Engine form for this integration.
func ConfigFieldsForIntegration(integration string) []PluginField {
	switch integration {
	case "smtp":
		return []PluginField{
			{Key: "SMTP_HOST", Label: "SMTP server", Placeholder: "smtp.office365.com", Group: "connection"},
			{Key: "SMTP_PORT", Label: "Port", Placeholder: "587", Group: "connection"},
			{Key: "SMTP_USER", Label: "Username", Group: "connection"},
			{Key: "SMTP_PASS", Label: "Password", InputType: "password", Group: "connection"},
			{Key: "SMTP_FROM", Label: "From", Placeholder: "sre@company.com", Group: "delivery"},
			{Key: "SMTP_TO", Label: "To", Placeholder: "oncall@company.com", Group: "delivery", Gateway: true},
			{Key: "SMTP_SUBJECT", Label: "Subject", Placeholder: "[SRE Capsule] {{name}}", Group: "message", Gateway: true, Hint: templateHint},
			{Key: "SMTP_BODY", Label: "Body", Placeholder: "Incident: {{name}}\n\n{{error}}", InputType: "textarea", Group: "message", Gateway: true, Hint: templateHint},
		}
	case "sendgrid":
		return []PluginField{
			{Key: "SENDGRID_API_KEY", Label: "API key", InputType: "password", Group: "connection"},
			{Key: "SENDGRID_FROM", Label: "From", Placeholder: "sre@company.com", Group: "delivery"},
			{Key: "SENDGRID_TO", Label: "To", Placeholder: "oncall@company.com", Group: "delivery", Gateway: true},
			{Key: "SENDGRID_SUBJECT", Label: "Subject", Placeholder: "[SRE Capsule] {{name}}", Group: "message", Gateway: true, Hint: templateHint},
			{Key: "SENDGRID_BODY", Label: "Body", Placeholder: "{{error}}", InputType: "textarea", Group: "message", Gateway: true, Hint: templateHint},
		}
	case "slack":
		return []PluginField{
			{Key: "SLACK_WEBHOOK_URL", Label: "Webhook URL", Placeholder: "https://hooks.slack.com/services/...", InputType: "url", Group: "connection"},
			{Key: "SLACK_CHANNEL", Label: "Channel", Placeholder: "#alerts-backend", Group: "delivery", Gateway: true},
			{Key: "SLACK_TITLE", Label: "Title", Placeholder: "SRE Alert: {{name}}", Group: "message", Gateway: true, Hint: templateHint},
			{Key: "SLACK_TEXT", Label: "Message", Placeholder: "{{error}}", InputType: "textarea", Group: "message", Gateway: true, Hint: templateHint},
		}
	case "jira":
		return []PluginField{
			{Key: "JIRA_URL", Label: "Jira URL", Placeholder: "https://company.atlassian.net", InputType: "url", Group: "connection"},
			{Key: "JIRA_EMAIL", Label: "Email", Group: "connection"},
			{Key: "JIRA_API_TOKEN", Label: "API token", InputType: "password", Group: "connection"},
			{Key: "JIRA_ISSUE_TYPE", Label: "Issue type", Placeholder: "Bug", Group: "connection"},
			{Key: "JIRA_PROJECT_KEY", Label: "Project key", Placeholder: "PAY", Group: "delivery", Gateway: true},
			{Key: "JIRA_SUMMARY", Label: "Summary", Placeholder: "[SRE Capsule] {{name}}", Group: "message", Gateway: true, Hint: templateHint},
			{Key: "JIRA_DESCRIPTION", Label: "Description", Placeholder: "{{error}}", InputType: "textarea", Group: "message", Gateway: true, Hint: templateHint},
		}
	case "teams":
		return []PluginField{
			{Key: "TEAMS_WEBHOOK_URL", Label: "Webhook URL", Placeholder: "https://...", InputType: "url", Group: "connection", Gateway: true},
			{Key: "TEAMS_TITLE", Label: "Title", Placeholder: "SRE incident: {{name}}", Group: "message", Gateway: true, Hint: templateHint},
			{Key: "TEAMS_TEXT", Label: "Message", Placeholder: "{{error}}", InputType: "textarea", Group: "message", Gateway: true, Hint: templateHint},
		}
	case "pagerduty":
		return []PluginField{
			{Key: "PAGERDUTY_ROUTING_KEY", Label: "Routing key", InputType: "password", Group: "connection", Gateway: true},
			{Key: "PAGERDUTY_API_URL", Label: "Events API URL", Placeholder: "https://events.pagerduty.com/v2/enqueue", InputType: "url", Group: "connection"},
			{Key: "PAGERDUTY_SUMMARY", Label: "Summary", Placeholder: "[SRE Capsule] {{name}}", Group: "message", Gateway: true, Hint: templateHint},
		}
	case "opsgenie":
		return []PluginField{
			{Key: "OPSGENIE_API_KEY", Label: "API key", InputType: "password", Group: "connection"},
			{Key: "OPSGENIE_API_URL", Label: "API URL", Placeholder: "https://api.opsgenie.com", InputType: "url", Group: "connection"},
			{Key: "OPSGENIE_TEAM", Label: "Team", Placeholder: "team-name", Group: "delivery", Gateway: true},
			{Key: "OPSGENIE_MESSAGE", Label: "Message", Placeholder: "[SRE Capsule] {{name}}", Group: "message", Gateway: true, Hint: templateHint},
			{Key: "OPSGENIE_DESCRIPTION", Label: "Description", Placeholder: "{{error}}", InputType: "textarea", Group: "message", Gateway: true, Hint: templateHint},
		}
	case "victorops":
		return []PluginField{
			{Key: "VICTOROPS_ROUTING_URL", Label: "Routing URL", Placeholder: "https://alert.victorops.com/integrations/generic/...", InputType: "url", Group: "connection", Gateway: true},
			{Key: "VICTOROPS_MESSAGE", Label: "State message", Placeholder: "[SRE Capsule] {{name}}", InputType: "textarea", Group: "message", Gateway: true, Hint: templateHint},
		}
	case "datadog":
		return []PluginField{
			{Key: "DD_API_KEY", Label: "API key", InputType: "password", Group: "connection"},
			{Key: "DD_SITE", Label: "Site", Placeholder: "datadoghq.com", Group: "connection"},
			{Key: "DATADOG_TAGS", Label: "Tags", Placeholder: "env:ci,service:api", Group: "delivery", Gateway: true},
			{Key: "DD_TITLE", Label: "Title", Placeholder: "SRE Capsule: {{name}}", Group: "message", Gateway: true, Hint: templateHint},
			{Key: "DD_TEXT", Label: "Text", Placeholder: "{{error}}", InputType: "textarea", Group: "message", Gateway: true, Hint: templateHint},
		}
	case "github":
		return []PluginField{
			{Key: "GITHUB_TOKEN", Label: "Token", InputType: "password", Group: "connection"},
			{Key: "GITHUB_OWNER", Label: "Owner", Placeholder: "org", Group: "delivery", Gateway: true},
			{Key: "GITHUB_REPO", Label: "Repository", Placeholder: "repo", Group: "delivery", Gateway: true},
			{Key: "GITHUB_WORKFLOW_ID", Label: "Workflow file", Placeholder: "ci.yml", Group: "delivery", Gateway: true},
			{Key: "GITHUB_REF", Label: "Git ref", Placeholder: "main", Group: "delivery", Gateway: true},
		}
	case "webhook":
		return []PluginField{
			{Key: "WEBHOOK_URL", Label: "Webhook URL", Placeholder: "https://...", InputType: "url", Group: "connection", Gateway: true},
			{Key: "QA_WEBHOOK_URL", Label: "QA webhook URL", Placeholder: "https://...", InputType: "url", Group: "connection", Gateway: true},
			{Key: "WEBHOOK_AUTH_HEADER", Label: "Authorization header", Placeholder: "Bearer ...", InputType: "password", Group: "connection"},
			{Key: "WEBHOOK_MESSAGE", Label: "Message", Placeholder: "{{name}}\n{{error}}", InputType: "textarea", Group: "message", Gateway: true, Hint: templateHint},
		}
	case "testrail":
		return []PluginField{
			{Key: "TESTRAIL_URL", Label: "TestRail URL", Placeholder: "https://company.testrail.io", InputType: "url", Group: "connection"},
			{Key: "TESTRAIL_USER", Label: "User", Group: "connection"},
			{Key: "TESTRAIL_API_KEY", Label: "API key", InputType: "password", Group: "connection"},
			{Key: "TESTRAIL_RUN_ID", Label: "Run ID", Group: "delivery", Gateway: true},
			{Key: "TESTRAIL_CASE_ID", Label: "Case ID", Group: "delivery", Gateway: true},
		}
	case "zephyr":
		return []PluginField{
			{Key: "ZEPHYR_API_URL", Label: "API URL", Placeholder: "https://api.zephyrscale.smartbear.com/v2", InputType: "url", Group: "connection"},
			{Key: "ZEPHYR_API_TOKEN", Label: "API token", InputType: "password", Group: "connection"},
			{Key: "ZEPHYR_PROJECT_KEY", Label: "Project key", Group: "delivery", Gateway: true},
			{Key: "ZEPHYR_TEST_CASE_KEY", Label: "Test case key", Group: "delivery", Gateway: true},
		}
	case "xray":
		return []PluginField{
			{Key: "XRAY_CLIENT_ID", Label: "Client ID", Group: "connection"},
			{Key: "XRAY_CLIENT_SECRET", Label: "Client secret", InputType: "password", Group: "connection"},
			{Key: "XRAY_PROJECT_KEY", Label: "Project key", Group: "delivery", Gateway: true},
			{Key: "XRAY_TEST_KEY", Label: "Test key", Group: "delivery", Gateway: true},
		}
	case "k8s":
		return []PluginField{
			{Key: "DEPLOYMENT_NAME", Label: "Deployment name", Placeholder: "my-app", Group: "delivery", Gateway: true},
		}
	default:
		return nil
	}
}
