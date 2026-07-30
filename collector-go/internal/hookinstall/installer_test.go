package hookinstall

import (
	"encoding/json"
	"os"
	"path/filepath"
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
