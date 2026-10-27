package integrations

import (
	"html"
	"regexp"
	"strings"
)

// alertText returns a configured template after placeholder substitution, or fallback when unset.
func alertText(c map[string]string, key, fallback string, inc IncidentContext) string {
	tpl := strings.TrimSpace(configVal(key, c))
	if tpl == "" {
		return fallback
	}
	return applyIncidentTemplate(tpl, inc)
}

func configList(raw string) []string {
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

var (
	mailScript    = regexp.MustCompile(`(?is)<script[\s\S]*?</script>|<style[\s\S]*?</style>`)
	mailEvent     = regexp.MustCompile(`(?i)\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)`)
	mailStyleAttr = regexp.MustCompile(`(?i)\sstyle\s*=\s*("([^"]*)"|'([^']*)')`)
	mailHexColor  = regexp.MustCompile(`(?i)#[0-9a-f]{6}`)
	mailFontSize  = regexp.MustCompile(`(?i)font-size\s*:\s*(12|14|16|18|20|24|28)px`)
)

// brandedMailHTML wraps the author's text in the fixed SRE Capsule mail frame.
func brandedMailHTML(inner string) string {
	const logo = `<svg xmlns="http://www.w3.org/2000/svg" width="88" height="40" viewBox="0 0 88 40" role="img" aria-label="SRE Capsule"><rect x="4" y="6" width="80" height="28" rx="14" fill="#c6ef4a"/><path d="M18 6h26v28H18A14 14 0 0 1 18 6z" fill="#128078"/></svg>`
	return `<!DOCTYPE html><html><body style="margin:0;background:#0e141b;padding:24px;">` +
		`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">` +
		`<table role="presentation" width="560" style="max-width:560px;background:#161d27;border:1px solid #2a3544;border-radius:12px;font-family:Segoe UI,Arial,sans-serif;color:#e7eef6;">` +
		`<tr><td style="padding:20px 24px 8px;background:#0c1218;text-align:center;">` + logo +
		`<div style="letter-spacing:.16em;font-size:12px;color:#9aa7b5;margin-top:8px;">SRE CAPSULE</div></td></tr>` +
		`<tr><td style="padding:22px 24px;font-size:15px;line-height:1.55;">` + mailFragment(inner) + `</td></tr>` +
		`<tr><td style="padding:12px 24px 16px;background:#0c1218;color:#8b98a8;font-size:11px;letter-spacing:.08em;">SRE CAPSULE</td></tr>` +
		`</table></td></tr></table></body></html>`
}

func mailFragment(inner string) string {
	inner = strings.TrimSpace(inner)
	if inner == "" {
		return "<p></p>"
	}
	if !strings.Contains(inner, "<") {
		return "<p>" + strings.ReplaceAll(html.EscapeString(inner), "\n", "<br>") + "</p>"
	}
	cleaned := mailScript.ReplaceAllString(inner, "")
	cleaned = mailEvent.ReplaceAllString(cleaned, "")
	return mailStyleAttr.ReplaceAllStringFunc(cleaned, func(attr string) string {
		parts := mailStyleAttr.FindStringSubmatch(attr)
		val := ""
		if len(parts) > 2 {
			val = parts[2]
		}
		if len(parts) > 3 && parts[3] != "" {
			val = parts[3]
		}
		var kept []string
		lower := strings.ToLower(val)
		if strings.Contains(lower, "color") {
			if color := mailHexColor.FindString(val); color != "" {
				kept = append(kept, "color:"+strings.ToLower(color))
			}
		}
		if size := mailFontSize.FindStringSubmatch(val); len(size) == 2 {
			kept = append(kept, "font-size:"+size[1]+"px")
		}
		if len(kept) == 0 {
			return ""
		}
		return ` style="` + strings.Join(kept, ";") + `"`
	})
}
