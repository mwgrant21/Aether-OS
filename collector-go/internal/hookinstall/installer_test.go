package hookinstall

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const scriptPath = `C:\Users\test\.aether-os\aether-hook-emit.mjs`
const permissionScriptPath = `C:\Users\test\.aether-os\aether-permission-hook.mjs`

func tempSettingsPath(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	return filepath.Join(dir, "settings.json")
}

func tempSettingsPathWithContent(t *testing.T, content string) string {
	t.Helper()
	p := tempSettingsPath(t)
	if err := os.WriteFile(p, []byte(content), 0644); err != nil {
		t.Fatalf("write initial settings.json: %v", err)
	}
	return p
}

func readWritten(t *testing.T, path string) map[string]interface{} {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read settings.json: %v", err)
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("parse settings.json: %v", err)
	}
	return parsed
}

// hooksGroups returns hooks[event] as a []interface{}, failing the test if
// it isn't an array-shaped value.
func hooksGroups(t *testing.T, written map[string]interface{}, event string) []interface{} {
	t.Helper()
	hooksVal, ok := written["hooks"]
	if !ok {
		t.Fatalf("written settings.json has no hooks key")
	}
	hooksObj, ok := hooksVal.(map[string]interface{})
	if !ok {
		t.Fatalf("written settings.json hooks is not an object")
	}
	groups, ok := hooksObj[event].([]interface{})
	if !ok {
		t.Fatalf("hooks[%s] is not an array: %#v", event, hooksObj[event])
	}
	return groups
}

func groupCommand(t *testing.T, group interface{}, index int) string {
	t.Helper()
	gm, ok := group.(map[string]interface{})
	if !ok {
		t.Fatalf("group is not an object: %#v", group)
	}
	hooksArr, ok := gm["hooks"].([]interface{})
	if !ok || index >= len(hooksArr) {
		t.Fatalf("group.hooks[%d] missing: %#v", index, gm["hooks"])
	}
	hObj, ok := hooksArr[index].(map[string]interface{})
	if !ok {
		t.Fatalf("group.hooks[%d] is not an object: %#v", index, hooksArr[index])
	}
	cmd, _ := hObj["command"].(string)
	return cmd
}

func TestReadHookInstallState_NoManagedEventsWhenSettingsMissing(t *testing.T) {
	settingsPath := tempSettingsPath(t)
	state := ReadHookInstallState(settingsPath, scriptPath)
	if len(state.InstalledEvents) != 0 {
		t.Errorf("InstalledEvents = %v, want empty", state.InstalledEvents)
	}
}

func TestInstallHooks_AddsEntryToEveryManagedEvent_CreatesHooksIfAbsent(t *testing.T) {
	settingsPath := tempSettingsPathWithContent(t, "{}")
	result := InstallHooks(settingsPath, scriptPath)
	if !result.OK {
		t.Fatalf("InstallHooks failed: %s", result.Error)
	}

	written := readWritten(t, settingsPath)
	for _, eventName := range ManagedHookEvents {
		groups := hooksGroups(t, written, eventName)
		if len(groups) != 1 {
			t.Errorf("hooks[%s] length = %d, want 1", eventName, len(groups))
			continue
		}
		if cmd := groupCommand(t, groups[0], 0); !strings.Contains(cmd, scriptPath) {
			t.Errorf("hooks[%s][0] command = %q, want to contain scriptPath", eventName, cmd)
		}
	}
}

func TestInstallHooks_PreservesExistingUnrelatedHookEntryForManagedEvent(t *testing.T) {
	existing := `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"powershell -File some-other-script.ps1"}]}]}}`
	settingsPath := tempSettingsPathWithContent(t, existing)
	if result := InstallHooks(settingsPath, scriptPath); !result.OK {
		t.Fatalf("InstallHooks failed: %s", result.Error)
	}

	written := readWritten(t, settingsPath)
	groups := hooksGroups(t, written, "Stop")
	if len(groups) != 2 {
		t.Fatalf("hooks[Stop] length = %d, want 2", len(groups))
	}
	if cmd := groupCommand(t, groups[0], 0); !strings.Contains(cmd, "some-other-script.ps1") {
		t.Errorf("hooks[Stop][0] command = %q, want to contain some-other-script.ps1", cmd)
	}
	if cmd := groupCommand(t, groups[1], 0); !strings.Contains(cmd, scriptPath) {
		t.Errorf("hooks[Stop][1] command = %q, want to contain scriptPath", cmd)
	}
}

func TestInstallHooks_IsIdempotent(t *testing.T) {
	settingsPath := tempSettingsPathWithContent(t, "{}")
	if result := InstallHooks(settingsPath, scriptPath); !result.OK {
		t.Fatalf("first InstallHooks failed: %s", result.Error)
	}
	if result := InstallHooks(settingsPath, scriptPath); !result.OK {
		t.Fatalf("second InstallHooks failed: %s", result.Error)
	}

	written := readWritten(t, settingsPath)
	groups := hooksGroups(t, written, "Stop")
	if len(groups) != 1 {
		t.Errorf("hooks[Stop] length = %d, want 1 (no duplicate)", len(groups))
	}
}

func TestReadHookInstallState_ReportsAllManagedEventsInstalledAfterInstall(t *testing.T) {
	settingsPath := tempSettingsPathWithContent(t, "{}")
	if result := InstallHooks(settingsPath, scriptPath); !result.OK {
		t.Fatalf("InstallHooks failed: %s", result.Error)
	}
	state := ReadHookInstallState(settingsPath, scriptPath)

	got := append([]string{}, state.InstalledEvents...)
	want := append([]string{}, ManagedHookEvents...)
	sortStrings(got)
	sortStrings(want)
	if !equalStrings(got, want) {
		t.Errorf("InstalledEvents = %v, want %v", got, want)
	}
}

func TestUninstallHooks_RemovesOnlyOurOwnEntry_LeavesUnrelatedStopHookIntact(t *testing.T) {
	existing := `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"powershell -File some-other-script.ps1"}]}]}}`
	settingsPath := tempSettingsPathWithContent(t, existing)
	if result := InstallHooks(settingsPath, scriptPath); !result.OK {
		t.Fatalf("InstallHooks failed: %s", result.Error)
	}
	result := UninstallHooks(settingsPath)
	if !result.OK {
		t.Fatalf("UninstallHooks failed: %s", result.Error)
	}

	written := readWritten(t, settingsPath)
	groups := hooksGroups(t, written, "Stop")
	if len(groups) != 1 {
		t.Fatalf("hooks[Stop] length = %d, want 1", len(groups))
	}
	if cmd := groupCommand(t, groups[0], 0); !strings.Contains(cmd, "some-other-script.ps1") {
		t.Errorf("hooks[Stop][0] command = %q, want to contain some-other-script.ps1", cmd)
	}
}

func TestUninstallHooks_WritesTimestampedBackupBeforeModifying(t *testing.T) {
	settingsPath := tempSettingsPathWithContent(t, "{}")
	if result := InstallHooks(settingsPath, scriptPath); !result.OK {
		t.Fatalf("InstallHooks failed: %s", result.Error)
	}
	result := UninstallHooks(settingsPath)
	if result.BackupPath == nil || *result.BackupPath == "" {
		t.Fatalf("BackupPath = %v, want a non-empty path", result.BackupPath)
	}

	backedUp := readWritten(t, *result.BackupPath)
	groups := hooksGroups(t, backedUp, "Stop")
	found := false
	for i := range groups {
		if strings.Contains(groupCommand(t, groups[i], 0), scriptPath) {
			found = true
		}
	}
	if !found {
		t.Errorf("backup did not contain our scriptPath entry under hooks.Stop")
	}
}

func TestInstallHooks_RefusesToOverwriteUnparseableSettings(t *testing.T) {
	settingsPath := tempSettingsPathWithContent(t, "not valid json {{")
	result := InstallHooks(settingsPath, scriptPath)
	if result.OK {
		t.Errorf("result.OK = true, want false for unparseable settings.json")
	}
}

func TestInstallHooks_LeavesNonArrayHooksEventUntouched_StillInstallsOthers(t *testing.T) {
	existing := `{"hooks":{"Stop":{"someWeirdShape":true}}}`
	settingsPath := tempSettingsPathWithContent(t, existing)
	result := InstallHooks(settingsPath, scriptPath)
	if !result.OK {
		t.Fatalf("InstallHooks failed: %s", result.Error)
	}

	written := readWritten(t, settingsPath)
	hooksObj := written["hooks"].(map[string]interface{})
	stopVal, ok := hooksObj["Stop"].(map[string]interface{})
	if !ok {
		t.Fatalf("hooks.Stop is not an object: %#v", hooksObj["Stop"])
	}
	if weird, _ := stopVal["someWeirdShape"].(bool); !weird {
		t.Errorf("hooks.Stop.someWeirdShape = %v, want true (untouched)", stopVal["someWeirdShape"])
	}

	for _, eventName := range ManagedHookEvents {
		if eventName == "Stop" {
			continue
		}
		groups := hooksGroups(t, written, eventName)
		if len(groups) != 1 {
			t.Errorf("hooks[%s] length = %d, want 1", eventName, len(groups))
			continue
		}
		if cmd := groupCommand(t, groups[0], 0); !strings.Contains(cmd, scriptPath) {
			t.Errorf("hooks[%s][0] command = %q, want to contain scriptPath", eventName, cmd)
		}
	}
}

func TestUninstallHooks_LeavesNonArrayHooksEventCompletelyUntouched(t *testing.T) {
	existing := `{"hooks":{"Stop":{"someWeirdShape":true}}}`
	settingsPath := tempSettingsPathWithContent(t, existing)
	result := UninstallHooks(settingsPath)
	if !result.OK {
		t.Fatalf("UninstallHooks failed: %s", result.Error)
	}

	written := readWritten(t, settingsPath)
	hooksObj := written["hooks"].(map[string]interface{})
	stopVal, ok := hooksObj["Stop"].(map[string]interface{})
	if !ok {
		t.Fatalf("hooks.Stop is not an object: %#v", hooksObj["Stop"])
	}
	if weird, _ := stopVal["someWeirdShape"].(bool); !weird {
		t.Errorf("hooks.Stop.someWeirdShape = %v, want true (untouched)", stopVal["someWeirdShape"])
	}
}

func TestUninstallHooks_RemovesOnlyOurEntryFromMixedGroup_LeavesGroupIntact(t *testing.T) {
	existing := `{"hooks":{"Stop":[{"hooks":[` +
		`{"type":"command","command":"powershell -File some-other-script.ps1"},` +
		`{"type":"command","command":"node \"` + strings.ReplaceAll(scriptPath, `\`, `\\`) + `\" # aether-hook-emit.mjs marker"}` +
		`]}]}}`
	settingsPath := tempSettingsPathWithContent(t, existing)
	result := UninstallHooks(settingsPath)
	if !result.OK {
		t.Fatalf("UninstallHooks failed: %s", result.Error)
	}

	written := readWritten(t, settingsPath)
	groups := hooksGroups(t, written, "Stop")
	if len(groups) != 1 {
		t.Fatalf("hooks[Stop] length = %d, want 1", len(groups))
	}
	gm := groups[0].(map[string]interface{})
	hooksArr := gm["hooks"].([]interface{})
	if len(hooksArr) != 1 {
		t.Fatalf("hooks[Stop][0].hooks length = %d, want 1", len(hooksArr))
	}
	if cmd := groupCommand(t, groups[0], 0); !strings.Contains(cmd, "some-other-script.ps1") {
		t.Errorf("hooks[Stop][0].hooks[0].command = %q, want to contain some-other-script.ps1", cmd)
	}
}

func TestInstallPermissionHooks_AddsPermissionRequestPostToolUseNotification(t *testing.T) {
	settingsPath := tempSettingsPathWithContent(t, "{}")
	result := InstallPermissionHooks(settingsPath, permissionScriptPath)
	if !result.OK {
		t.Fatalf("InstallPermissionHooks failed: %s", result.Error)
	}

	written := readWritten(t, settingsPath)
	for _, eventName := range []string{"PermissionRequest", "PostToolUse", "Notification"} {
		groups := hooksGroups(t, written, eventName)
		if len(groups) != 1 {
			t.Errorf("hooks[%s] length = %d, want 1", eventName, len(groups))
			continue
		}
		if cmd := groupCommand(t, groups[0], 0); !strings.Contains(cmd, permissionScriptPath) {
			t.Errorf("hooks[%s][0] command = %q, want to contain permissionScriptPath", eventName, cmd)
		}
	}
}

func TestInstallPermissionHooks_CoexistsWithPreExistingManagedGroup(t *testing.T) {
	settingsPath := tempSettingsPathWithContent(t, "{}")
	if result := InstallHooks(settingsPath, scriptPath); !result.OK { // unrelated spool-ingestion group first
		t.Fatalf("InstallHooks failed: %s", result.Error)
	}
	result := InstallPermissionHooks(settingsPath, permissionScriptPath)
	if !result.OK {
		t.Fatalf("InstallPermissionHooks failed: %s", result.Error)
	}

	written := readWritten(t, settingsPath)

	postToolUse := hooksGroups(t, written, "PostToolUse")
	if len(postToolUse) != 2 {
		t.Fatalf("hooks[PostToolUse] length = %d, want 2", len(postToolUse))
	}
	if cmd := groupCommand(t, postToolUse[0], 0); !strings.Contains(cmd, scriptPath) {
		t.Errorf("hooks[PostToolUse][0] command = %q, want to contain scriptPath", cmd)
	}
	if cmd := groupCommand(t, postToolUse[1], 0); !strings.Contains(cmd, permissionScriptPath) {
		t.Errorf("hooks[PostToolUse][1] command = %q, want to contain permissionScriptPath", cmd)
	}

	notification := hooksGroups(t, written, "Notification")
	if len(notification) != 2 {
		t.Fatalf("hooks[Notification] length = %d, want 2", len(notification))
	}
	if cmd := groupCommand(t, notification[0], 0); !strings.Contains(cmd, scriptPath) {
		t.Errorf("hooks[Notification][0] command = %q, want to contain scriptPath", cmd)
	}
	if cmd := groupCommand(t, notification[1], 0); !strings.Contains(cmd, permissionScriptPath) {
		t.Errorf("hooks[Notification][1] command = %q, want to contain permissionScriptPath", cmd)
	}

	// The unrelated group's other managed events (Stop etc.) are untouched.
	stop := hooksGroups(t, written, "Stop")
	if len(stop) != 1 {
		t.Fatalf("hooks[Stop] length = %d, want 1", len(stop))
	}
	if cmd := groupCommand(t, stop[0], 0); !strings.Contains(cmd, scriptPath) {
		t.Errorf("hooks[Stop][0] command = %q, want to contain scriptPath", cmd)
	}

	// installPermissionHooks must not itself have added a Stop group entry beyond PermissionRequest.
	permissionRequest := hooksGroups(t, written, "PermissionRequest")
	if len(permissionRequest) != 1 {
		t.Errorf("hooks[PermissionRequest] length = %d, want 1", len(permissionRequest))
	}
}

func TestInstallPermissionHooks_IsIdempotent(t *testing.T) {
	settingsPath := tempSettingsPathWithContent(t, "{}")
	if result := InstallHooks(settingsPath, scriptPath); !result.OK {
		t.Fatalf("InstallHooks failed: %s", result.Error)
	}
	if result := InstallPermissionHooks(settingsPath, permissionScriptPath); !result.OK {
		t.Fatalf("first InstallPermissionHooks failed: %s", result.Error)
	}
	if result := InstallPermissionHooks(settingsPath, permissionScriptPath); !result.OK {
		t.Fatalf("second InstallPermissionHooks failed: %s", result.Error)
	}

	written := readWritten(t, settingsPath)
	if groups := hooksGroups(t, written, "PostToolUse"); len(groups) != 2 {
		t.Errorf("hooks[PostToolUse] length = %d, want 2", len(groups))
	}
	if groups := hooksGroups(t, written, "Notification"); len(groups) != 2 {
		t.Errorf("hooks[Notification] length = %d, want 2", len(groups))
	}
	if groups := hooksGroups(t, written, "PermissionRequest"); len(groups) != 1 {
		t.Errorf("hooks[PermissionRequest] length = %d, want 1", len(groups))
	}
}

func TestUninstallPermissionHooks_RemovesOnlyItsOwnEntries(t *testing.T) {
	settingsPath := tempSettingsPathWithContent(t, "{}")
	if result := InstallHooks(settingsPath, scriptPath); !result.OK {
		t.Fatalf("InstallHooks failed: %s", result.Error)
	}
	if result := InstallPermissionHooks(settingsPath, permissionScriptPath); !result.OK {
		t.Fatalf("InstallPermissionHooks failed: %s", result.Error)
	}

	result := UninstallPermissionHooks(settingsPath)
	if !result.OK {
		t.Fatalf("UninstallPermissionHooks failed: %s", result.Error)
	}

	written := readWritten(t, settingsPath)

	postToolUse := hooksGroups(t, written, "PostToolUse")
	if len(postToolUse) != 1 {
		t.Fatalf("hooks[PostToolUse] length = %d, want 1", len(postToolUse))
	}
	if cmd := groupCommand(t, postToolUse[0], 0); !strings.Contains(cmd, scriptPath) {
		t.Errorf("hooks[PostToolUse][0] command = %q, want to contain scriptPath", cmd)
	}

	notification := hooksGroups(t, written, "Notification")
	if len(notification) != 1 {
		t.Fatalf("hooks[Notification] length = %d, want 1", len(notification))
	}
	if cmd := groupCommand(t, notification[0], 0); !strings.Contains(cmd, scriptPath) {
		t.Errorf("hooks[Notification][0] command = %q, want to contain scriptPath", cmd)
	}

	hooksObj := written["hooks"].(map[string]interface{})
	if _, exists := hooksObj["PermissionRequest"]; exists {
		t.Errorf("hooks.PermissionRequest should be absent after uninstall, got %#v", hooksObj["PermissionRequest"])
	}

	stop := hooksGroups(t, written, "Stop")
	if len(stop) != 1 {
		t.Fatalf("hooks[Stop] length = %d, want 1", len(stop))
	}
	if cmd := groupCommand(t, stop[0], 0); !strings.Contains(cmd, scriptPath) {
		t.Errorf("hooks[Stop][0] command = %q, want to contain scriptPath", cmd)
	}
}

// Issue #58 (mirrors the TS tests of the same intent): a top-level `hooks`
// that is an array or a primitive is not a shape we can merge into without
// guessing. Installers refuse before writing anything; uninstallers have
// nothing of ours to remove there and no-op without touching the file.
var malformedTopLevelHooks = []struct {
	label   string
	content string
}{
	{"empty array", `{"hooks":[],"model":"opus"}`},
	{"array of groups", `{"hooks":[{"hooks":[{"type":"command","command":"other.ps1"}]}],"model":"opus"}`},
	{"string", `{"hooks":"user-string","model":"opus"}`},
	{"number", `{"hooks":42,"model":"opus"}`},
	{"boolean", `{"hooks":true,"model":"opus"}`},
}

func backupsBeside(t *testing.T, settingsPath string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Dir(settingsPath))
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	var out []string
	for _, e := range entries {
		if strings.Contains(e.Name(), ".aetherbak-") {
			out = append(out, e.Name())
		}
	}
	return out
}

func readRaw(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(raw)
}

func TestInstall_RefusesMalformedTopLevelHooks(t *testing.T) {
	installers := []struct {
		name string
		fn   func(string) InstallResult
	}{
		{"InstallHooks", func(p string) InstallResult { return InstallHooks(p, scriptPath) }},
		{"InstallPermissionHooks", func(p string) InstallResult { return InstallPermissionHooks(p, permissionScriptPath) }},
	}
	for _, in := range installers {
		for _, tc := range malformedTopLevelHooks {
			t.Run(in.name+"/"+tc.label, func(t *testing.T) {
				settingsPath := tempSettingsPathWithContent(t, tc.content)
				result := in.fn(settingsPath)
				if result.OK {
					t.Fatalf("OK = true, want refusal for hooks as %s", tc.label)
				}
				if !strings.Contains(result.Error, "not an object") {
					t.Errorf("Error = %q, want it to say the hooks value is not an object", result.Error)
				}
				if got := readRaw(t, settingsPath); got != tc.content {
					t.Errorf("settings.json bytes changed on refusal: %q", got)
				}
				if b := backupsBeside(t, settingsPath); len(b) != 0 {
					t.Errorf("backup written on refusal: %v", b)
				}
			})
		}
	}
}

func TestUninstall_NoOpsOnMalformedTopLevelHooks(t *testing.T) {
	uninstallers := []struct {
		name string
		fn   func(string) InstallResult
	}{
		{"UninstallHooks", UninstallHooks},
		{"UninstallPermissionHooks", UninstallPermissionHooks},
	}
	for _, un := range uninstallers {
		for _, tc := range malformedTopLevelHooks {
			t.Run(un.name+"/"+tc.label, func(t *testing.T) {
				settingsPath := tempSettingsPathWithContent(t, tc.content)
				result := un.fn(settingsPath)
				if !result.OK {
					t.Fatalf("OK = false (%s), want a no-op success for hooks as %s", result.Error, tc.label)
				}
				if result.BackupPath != nil {
					t.Errorf("BackupPath = %q, want nil (no-op must not back up)", *result.BackupPath)
				}
				if got := readRaw(t, settingsPath); got != tc.content {
					t.Errorf("settings.json bytes changed on no-op: %q", got)
				}
				if b := backupsBeside(t, settingsPath); len(b) != 0 {
					t.Errorf("backup written on no-op: %v", b)
				}
			})
		}
	}
}

func TestReadHookInstallState_ArrayShapedHooks_ReportsNothingInstalled(t *testing.T) {
	settingsPath := tempSettingsPathWithContent(t, `{"hooks":[{"hooks":[{"type":"command","command":"other.ps1"}]}]}`)
	state := ReadHookInstallState(settingsPath, scriptPath)
	if len(state.InstalledEvents) != 0 {
		t.Errorf("InstalledEvents = %v, want none", state.InstalledEvents)
	}
}

func TestInstallHooks_NullHooksTreatedAsAbsent(t *testing.T) {
	settingsPath := tempSettingsPathWithContent(t, `{"hooks":null,"model":"opus"}`)
	result := InstallHooks(settingsPath, scriptPath)
	if !result.OK {
		t.Fatalf("InstallHooks failed on hooks:null: %s", result.Error)
	}
	written := readWritten(t, settingsPath)
	if got, _ := written["model"].(string); got != "opus" {
		t.Errorf("model = %v, want opus preserved", written["model"])
	}
	for _, eventName := range ManagedHookEvents {
		if groups := hooksGroups(t, written, eventName); len(groups) != 1 {
			t.Errorf("hooks[%s] length = %d, want 1", eventName, len(groups))
		}
	}
}

func TestInstallHooks_DoesNotHTMLEscapeUnrelatedHookCommand(t *testing.T) {
	existing := `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"powershell -File x.ps1 && echo done > log.txt"}]}]}}`
	settingsPath := tempSettingsPathWithContent(t, existing)
	if result := InstallHooks(settingsPath, scriptPath); !result.OK {
		t.Fatalf("InstallHooks failed: %s", result.Error)
	}

	raw, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatalf("read settings.json: %v", err)
	}
	content := string(raw)
	// The literal substrings must survive unescaped ...
	if !strings.Contains(content, "&&") {
		t.Errorf("written settings.json does not contain literal &&; got HTML-escaped output:\n%s", content)
	}
	if !strings.Contains(content, "echo done > log.txt") {
		t.Errorf("written settings.json does not contain literal >; got HTML-escaped output:\n%s", content)
	}
	// ... and json.MarshalIndent's HTML-escaped forms must NOT appear.
	if strings.Contains(content, `\u0026`) {
		t.Errorf("written settings.json contains HTML-escaped &: \\u0026:\n%s", content)
	}
	if strings.Contains(content, `\u003e`) {
		t.Errorf("written settings.json contains HTML-escaped >: \\u003e:\n%s", content)
	}
}

func TestInstallHooks_PreservesUnrelatedTopLevelKeyByteIdentical(t *testing.T) {
	existing := `{"model":"sonnet","hooks":{"Stop":[{"hooks":[{"type":"command","command":"powershell -File some-other-script.ps1"}]}]}}`
	settingsPath := tempSettingsPathWithContent(t, existing)
	if result := InstallHooks(settingsPath, scriptPath); !result.OK {
		t.Fatalf("InstallHooks failed: %s", result.Error)
	}

	raw, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatalf("read settings.json: %v", err)
	}
	if !strings.Contains(string(raw), `"model": "sonnet"`) {
		t.Errorf("written settings.json does not contain the unrelated top-level key byte-identical:\n%s", raw)
	}
}

func TestUninstallHooks_PreservesUnrelatedTopLevelKeyByteIdentical(t *testing.T) {
	existing := `{"model":"sonnet","hooks":{"Stop":[{"hooks":[{"type":"command","command":"powershell -File some-other-script.ps1"}]}]}}`
	settingsPath := tempSettingsPathWithContent(t, existing)
	if result := InstallHooks(settingsPath, scriptPath); !result.OK {
		t.Fatalf("InstallHooks failed: %s", result.Error)
	}
	if result := UninstallHooks(settingsPath); !result.OK {
		t.Fatalf("UninstallHooks failed: %s", result.Error)
	}

	raw, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatalf("read settings.json: %v", err)
	}
	if !strings.Contains(string(raw), `"model": "sonnet"`) {
		t.Errorf("written settings.json does not contain the unrelated top-level key byte-identical:\n%s", raw)
	}
}

func TestManagedHookEvents_DoesNotContainPermissionRequest(t *testing.T) {
	for _, e := range ManagedHookEvents {
		if e == "PermissionRequest" {
			t.Errorf("ManagedHookEvents contains PermissionRequest, want it excluded")
		}
	}
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j-1] > s[j]; j-- {
			s[j-1], s[j] = s[j], s[j-1]
		}
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func tempFilesBeside(t *testing.T, settingsPath string) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Dir(settingsPath))
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	var out []string
	for _, e := range entries {
		if strings.Contains(e.Name(), ".aethertmp-") {
			out = append(out, e.Name())
		}
	}
	return out
}

// Issue #59: a failed atomic rename must report the error, leave
// settings.json byte-identical, and not leave its temp file behind.
func TestWriters_RenameFailure_ReportsErrorAndLeavesNoTempFile(t *testing.T) {
	writers := []struct {
		name    string
		content string
		fn      func(string) InstallResult
	}{
		{"InstallHooks", `{"model":"opus"}`, func(p string) InstallResult { return InstallHooks(p, scriptPath) }},
		{"InstallPermissionHooks", `{"model":"opus"}`, func(p string) InstallResult { return InstallPermissionHooks(p, permissionScriptPath) }},
		{"UninstallHooks", `{"hooks":{},"model":"opus"}`, UninstallHooks},
		{"UninstallPermissionHooks", `{"hooks":{},"model":"opus"}`, UninstallPermissionHooks},
	}
	for _, w := range writers {
		t.Run(w.name, func(t *testing.T) {
			settingsPath := tempSettingsPathWithContent(t, w.content)
			orig := renameFile
			renameFile = func(oldpath, newpath string) error { return os.ErrPermission }
			defer func() { renameFile = orig }()

			result := w.fn(settingsPath)
			if result.OK {
				t.Fatalf("OK = true, want failure when rename fails")
			}
			if !strings.Contains(result.Error, os.ErrPermission.Error()) {
				t.Errorf("Error = %q, want the rename error surfaced", result.Error)
			}
			if got := readRaw(t, settingsPath); got != w.content {
				t.Errorf("settings.json bytes changed: %q", got)
			}
			if tmp := tempFilesBeside(t, settingsPath); len(tmp) != 0 {
				t.Errorf("temp file leaked beside settings.json: %v", tmp)
			}
		})
	}
}

// Issue #59, second door: a temp-file write that fails after the file was
// created (ENOSPC is the realistic case) must not leave it behind either.
func TestWriters_TempWriteFailure_ReportsErrorAndLeavesNoTempFile(t *testing.T) {
	writers := []struct {
		name    string
		content string
		fn      func(string) InstallResult
	}{
		{"InstallHooks", `{"model":"opus"}`, func(p string) InstallResult { return InstallHooks(p, scriptPath) }},
		{"InstallPermissionHooks", `{"model":"opus"}`, func(p string) InstallResult { return InstallPermissionHooks(p, permissionScriptPath) }},
		{"UninstallHooks", `{"hooks":{},"model":"opus"}`, UninstallHooks},
		{"UninstallPermissionHooks", `{"hooks":{},"model":"opus"}`, UninstallPermissionHooks},
	}
	for _, w := range writers {
		t.Run(w.name, func(t *testing.T) {
			settingsPath := tempSettingsPathWithContent(t, w.content)
			orig := writeFileFn
			writeFileFn = func(name string, data []byte, perm os.FileMode) error {
				// Create the file with a partial payload, then fail, as a full disk does.
				_ = os.WriteFile(name, data[:len(data)/2], perm)
				return os.ErrClosed
			}
			defer func() { writeFileFn = orig }()

			result := w.fn(settingsPath)
			if result.OK {
				t.Fatalf("OK = true, want failure when the temp write fails")
			}
			if !strings.Contains(result.Error, os.ErrClosed.Error()) {
				t.Errorf("Error = %q, want the write error surfaced", result.Error)
			}
			if got := readRaw(t, settingsPath); got != w.content {
				t.Errorf("settings.json bytes changed: %q", got)
			}
			if tmp := tempFilesBeside(t, settingsPath); len(tmp) != 0 {
				t.Errorf("temp file leaked beside settings.json: %v", tmp)
			}
		})
	}
}

// Two writers in the same millisecond must never share a temp path, or one
// failing writer's cleanup could delete the other's pending file.
func TestTempPathFor_DistinctWithinSameMillisecond(t *testing.T) {
	settingsPath := tempSettingsPath(t)
	a := tempPathFor(settingsPath)
	b := tempPathFor(settingsPath)
	if a == b {
		t.Fatalf("two temp paths collided: %s", a)
	}
	for _, p := range []string{a, b} {
		if !strings.HasPrefix(p, settingsPath+".aethertmp-") {
			t.Errorf("temp path %q does not sit beside settings.json with the .aethertmp- marker", p)
		}
	}
}

func TestWriteFileExcl_RefusesToClobberAnExistingFile(t *testing.T) {
	settingsPath := tempSettingsPathWithContent(t, "pending")
	if err := writeFileExcl(settingsPath, []byte("clobber"), 0644); err == nil {
		t.Fatalf("writeFileExcl succeeded over an existing file, want an error")
	}
	if got := readRaw(t, settingsPath); got != "pending" {
		t.Errorf("existing file changed: %q", got)
	}
}

// Losing an exclusive-create race (ErrExist) means this invocation never
// owned the file, so cleanup must leave the other writer's file alone.
func TestWriters_ExclusiveCreateLoss_LeavesOtherWritersTempFile(t *testing.T) {
	settingsPath := tempSettingsPathWithContent(t, "{}")
	var contested string
	orig := writeFileFn
	writeFileFn = func(name string, data []byte, perm os.FileMode) error {
		contested = name
		if err := os.WriteFile(name, []byte("other writer"), perm); err != nil {
			t.Fatalf("stage other writer: %v", err)
		}
		return os.ErrExist
	}
	defer func() { writeFileFn = orig }()

	result := InstallHooks(settingsPath, scriptPath)
	if result.OK {
		t.Fatalf("OK = true, want failure on a lost exclusive create")
	}
	if contested == "" {
		t.Fatalf("temp write never attempted")
	}
	if got := readRaw(t, contested); got != "other writer" {
		t.Errorf("other writer's temp file was removed or changed: %q", got)
	}
	if got := readRaw(t, settingsPath); got != "{}" {
		t.Errorf("settings.json changed: %q", got)
	}
}

// ErrExist from the RENAME step is not a lost create: the temp file is ours
// and must still be removed.
func TestWriters_RenameErrExist_StillRemovesOwnTempFile(t *testing.T) {
	settingsPath := tempSettingsPathWithContent(t, "{}")
	orig := renameFile
	renameFile = func(oldpath, newpath string) error { return os.ErrExist }
	defer func() { renameFile = orig }()

	result := InstallHooks(settingsPath, scriptPath)
	if result.OK {
		t.Fatalf("OK = true, want failure")
	}
	if got := readRaw(t, settingsPath); got != "{}" {
		t.Errorf("settings.json changed: %q", got)
	}
	if tmp := tempFilesBeside(t, settingsPath); len(tmp) != 0 {
		t.Errorf("own temp file leaked after rename ErrExist: %v", tmp)
	}
}

// Issue #60: two backups taken in the same millisecond must both survive;
// the first one is the user's pristine pre-Aether file.
func TestBackupPathFor_DistinctWithinSameMillisecond(t *testing.T) {
	settingsPath := tempSettingsPath(t)
	a := backupPathFor(settingsPath)
	b := backupPathFor(settingsPath)
	if a == b {
		t.Fatalf("two backup paths collided: %s", a)
	}
	for _, p := range []string{a, b} {
		if !strings.HasPrefix(p, settingsPath+".aetherbak-") {
			t.Errorf("backup path %q does not sit beside settings.json with the .aetherbak- marker", p)
		}
	}
}

func TestWriteBackup_RefusesToClobberAnExistingBackup(t *testing.T) {
	settingsPath := tempSettingsPathWithContent(t, "{}")
	orig := backupPathFn
	fixed := settingsPath + ".aetherbak-fixed"
	backupPathFn = func(string) string { return fixed }
	defer func() { backupPathFn = orig }()
	if err := os.WriteFile(fixed, []byte("pristine"), 0644); err != nil {
		t.Fatalf("stage: %v", err)
	}
	if _, err := writeBackup(settingsPath, "newer"); err == nil {
		t.Fatalf("writeBackup overwrote an existing backup, want an error")
	}
	if got := readRaw(t, fixed); got != "pristine" {
		t.Errorf("existing backup changed: %q", got)
	}
}

// The write-path guarantees below mirror collector/src/atomicWrite.test.ts and
// electron/atomicWrite.test.ts case for case (#63). A rename gives a new inode,
// so each of these is something attached to the old one that must survive.

// symlinkSupported probes once: creating a symlink needs privilege on Windows,
// so these cases skip there and still run on the Linux CI lane.
func symlinkSupported(t *testing.T) bool {
	t.Helper()
	dir := t.TempDir()
	real := filepath.Join(dir, "real")
	if err := os.WriteFile(real, []byte("x"), 0644); err != nil {
		return false
	}
	return os.Symlink(real, filepath.Join(dir, "link")) == nil
}

func TestWriteSettingsAtomically_WritesThroughSymlinkKeepingTheLink(t *testing.T) {
	if !symlinkSupported(t) {
		t.Skip("symlink creation not permitted here")
	}
	realDir := t.TempDir()
	linkDir := t.TempDir()
	realFile := filepath.Join(realDir, "settings.json")
	link := filepath.Join(linkDir, "settings.json")
	if err := os.WriteFile(realFile, []byte("original"), 0644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := os.Symlink(realFile, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	if err := writeSettingsAtomically(link, "updated"); err != nil {
		t.Fatalf("write: %v", err)
	}

	info, err := os.Lstat(link)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Errorf("link was replaced instead of written through")
	}
	if got := readRaw(t, realFile); got != "updated" {
		t.Errorf("real file = %q, want the new content", got)
	}
	if tmp := tempFilesBeside(t, realFile); len(tmp) != 0 {
		t.Errorf("temp file left beside the real file: %v", tmp)
	}
	if tmp := tempFilesBeside(t, link); len(tmp) != 0 {
		t.Errorf("temp file left beside the link: %v", tmp)
	}
}

func TestWriteSettingsAtomically_DanglingSymlinkWritesItsDestination(t *testing.T) {
	if !symlinkSupported(t) {
		t.Skip("symlink creation not permitted here")
	}
	dir := t.TempDir()
	missing := filepath.Join(dir, "not-yet-there.json")
	link := filepath.Join(dir, "settings.json")
	if err := os.Symlink(missing, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	if err := writeSettingsAtomically(link, "created through the link"); err != nil {
		t.Fatalf("write: %v", err)
	}

	info, err := os.Lstat(link)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Errorf("dangling link was replaced instead of resolved")
	}
	if got := readRaw(t, missing); got != "created through the link" {
		t.Errorf("destination = %q, want the new content", got)
	}
}

func TestWriteSettingsAtomically_KeepsHardLinkedTargetAsOneInode(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "settings.json")
	other := filepath.Join(dir, "settings.json.hardlink")
	if err := os.WriteFile(target, []byte("shared"), 0644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := os.Link(target, other); err != nil {
		t.Skipf("hard links not available here: %v", err)
	}
	if linkCountOf(target) <= 1 {
		t.Skip("link count not reported on this platform")
	}

	if err := writeSettingsAtomically(target, "updated through one entry"); err != nil {
		t.Fatalf("write: %v", err)
	}

	// A rename would have left the other entry on the old inode.
	if got := readRaw(t, other); got != "updated through one entry" {
		t.Errorf("other entry = %q, want the new content (link was severed)", got)
	}
	if got := readRaw(t, target); got != "updated through one entry" {
		t.Errorf("target = %q, want the new content", got)
	}
	if tmp := tempFilesBeside(t, target); len(tmp) != 0 {
		t.Errorf("temp file left behind: %v", tmp)
	}
}

func TestWriteSettingsAtomically_RefusesAReadOnlyTarget(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(target, []byte("protected"), 0644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := os.Chmod(target, 0444); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	defer func() { _ = os.Chmod(target, 0644) }()

	err := writeSettingsAtomically(target, "overwritten")
	if err == nil {
		t.Fatalf("write succeeded against a read-only target, want EACCES")
	}
	if !strings.Contains(err.Error(), "EACCES") {
		t.Errorf("error = %q, want the EACCES shape Node also produces", err.Error())
	}
	if got := readRaw(t, target); got != "protected" {
		t.Errorf("target changed: %q", got)
	}
	if tmp := tempFilesBeside(t, target); len(tmp) != 0 {
		t.Errorf("temp file left behind: %v", tmp)
	}
}

func TestWriteSettingsAtomically_CarriesTheExistingModeOntoTheReplacement(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows reports 0666 for any writable file regardless of chmod")
	}
	dir := t.TempDir()
	target := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(target, []byte("secret"), 0600); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if err := writeSettingsAtomically(target, "still secret"); err != nil {
		t.Fatalf("write: %v", err)
	}

	info, err := os.Stat(target)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if got := info.Mode().Perm(); got != 0600 {
		t.Errorf("mode = %o, want 600 (a replace must not widen permissions)", got)
	}
	if got := readRaw(t, target); got != "still secret" {
		t.Errorf("content = %q", got)
	}
}

func TestWriteSettingsAtomically_CreatesTheTempFileWithTheTargetMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows reports 0666 for any writable file regardless of chmod")
	}
	dir := t.TempDir()
	target := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(target, []byte("secret"), 0600); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Creating under the umask and narrowing afterwards leaves a window where
	// another local user can open the temp file and keep the descriptor.
	var sawMode os.FileMode
	orig := writeFileFn
	writeFileFn = func(name string, data []byte, perm os.FileMode) error {
		sawMode = perm
		return writeFileExcl(name, data, perm)
	}
	defer func() { writeFileFn = orig }()

	if err := writeSettingsAtomically(target, "still secret"); err != nil {
		t.Fatalf("write: %v", err)
	}
	if sawMode.Perm() != 0600 {
		t.Errorf("temp file created with mode %o, want 600", sawMode.Perm())
	}
}
