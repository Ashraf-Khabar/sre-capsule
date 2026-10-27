package integrations

import "strings"

// alertText returns a configured template after placeholder substitution, or fallback when unset.
func alertText(c map[string]string, key, fallback string, inc IncidentContext) string {
	tpl := strings.TrimSpace(configVal(key, c))
	if tpl == "" {
		return fallback
	}
	return applyIncidentTemplate(tpl, inc)
}

func datadogTags(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var out []string
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func applyIncidentTemplate(tpl string, inc IncidentContext) string {
	return strings.NewReplacer(
		"{{name}}", incidentSummary(inc),
		"{{status}}", inc.Status,
		"{{error}}", inc.Error,
		"{{console}}", inc.ConsoleLogs,
		"{{action}}", inc.Action,
	).Replace(tpl)
}
