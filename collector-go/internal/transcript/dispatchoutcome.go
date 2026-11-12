// Go port of electron/severity/parseDispatchOutcome.ts (source of truth; the
// collector/src copy is generated). Edit the TS first, then mirror here. No Go
// sync script exists.
//
// Pure. Reads an Agent dispatch's outcome from its task-notification text. The
// <summary> and <result> bodies are transcript content, so fields are anchored
// by POSITION, never by a global match: real shape is status, summary, result,
// usage. <status> is read only from the text BEFORE the first <summary>/<result>
// opening tag; usage only from the text AFTER the last </summary>/</result>,
// and not at all if an opening tag still follows that point (truncated body).
package transcript

import (
	"regexp"
	"strconv"
	"strings"
)

// DispatchStatus is the notification's <status>, or StatusUnknown.
type DispatchStatus string

const (
	StatusCompleted DispatchStatus = "completed"
	StatusFailed    DispatchStatus = "failed"
	StatusKilled    DispatchStatus = "killed"
	StatusUnknown   DispatchStatus = "unknown"
)

// DispatchUsage is the usage block Claude Code computes for a finished run.
type DispatchUsage struct {
	Tokens     int64
	ToolUses   int64
	DurationMs int64
}

// DispatchOutcome holds no string except Status. Usage is nil when absent or
// untrustworthy.
type DispatchOutcome struct {
	Status DispatchStatus
	Usage  *DispatchUsage
}

// maxSafeInteger mirrors Number.MAX_SAFE_INTEGER (2^53 - 1).
const maxSafeInteger = 1<<53 - 1

var (
	contentOpenTag    = regexp.MustCompile(`<(summary|result)>`)
	statusTag         = regexp.MustCompile(`<status>([^<]*)</status>`)
	outcomeTokensTag  = regexp.MustCompile(`<subagent_tokens>(\d+)</subagent_tokens>`)
	outcomeToolUseTag = regexp.MustCompile(`<tool_uses>(\d+)</tool_uses>`)
	outcomeDurTag     = regexp.MustCompile(`<duration_ms>(\d+)</duration_ms>`)
)

func dispatchHeadPart(text string) string {
	if loc := contentOpenTag.FindStringIndex(text); loc != nil {
		return text[:loc[0]]
	}
	return text
}

// dispatchUsagePart returns the text after the last content close tag, and
// false when that tail still holds an opening tag, or when a
// <task-notification> opener has no closer after the usage start (truncated
// body: nothing after it can be trusted).
func dispatchUsagePart(text string) (string, bool) {
	end := -1
	if i := strings.LastIndex(text, "</result>"); i >= 0 && i+len("</result>") > end {
		end = i + len("</result>")
	}
	if i := strings.LastIndex(text, "</summary>"); i >= 0 && i+len("</summary>") > end {
		end = i + len("</summary>")
	}
	tail := text
	if end >= 0 {
		tail = text[end:]
	}
	if contentOpenTag.MatchString(tail) {
		return "", false
	}
	floor := end
	if floor < 0 {
		floor = 0
	}
	if strings.Contains(text, "<task-notification>") && strings.LastIndex(text, "</task-notification>") < floor {
		return "", false
	}
	return tail, true
}

func parseSafeInt(s string) (int64, bool) {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n > maxSafeInteger {
		return 0, false
	}
	return n, true
}

// ParseDispatchOutcome never fails: an unreadable status is StatusUnknown and
// absent or partial usage is nil.
func ParseDispatchOutcome(notificationText string) DispatchOutcome {
	raw := ""
	if m := statusTag.FindStringSubmatch(dispatchHeadPart(notificationText)); m != nil {
		raw = strings.TrimSpace(m[1])
	}
	status := StatusUnknown
	switch DispatchStatus(raw) {
	case StatusCompleted, StatusFailed, StatusKilled:
		status = DispatchStatus(raw)
	}

	tail, ok := dispatchUsagePart(notificationText)
	if !ok {
		return DispatchOutcome{Status: status}
	}
	tokens := outcomeTokensTag.FindStringSubmatch(tail)
	toolUses := outcomeToolUseTag.FindStringSubmatch(tail)
	duration := outcomeDurTag.FindStringSubmatch(tail)
	if tokens == nil || toolUses == nil || duration == nil {
		return DispatchOutcome{Status: status}
	}
	t, ok1 := parseSafeInt(tokens[1])
	u, ok2 := parseSafeInt(toolUses[1])
	d, ok3 := parseSafeInt(duration[1])
	if !ok1 || !ok2 || !ok3 {
		return DispatchOutcome{Status: status}
	}
	return DispatchOutcome{Status: status, Usage: &DispatchUsage{Tokens: t, ToolUses: u, DurationMs: d}}
}
