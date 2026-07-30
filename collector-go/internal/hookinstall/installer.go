// Package hookinstall is the Go port of collector/src/hookInstaller.ts:
// merging this collector's hook config into Claude Code's real settings.json
// -- install/uninstall for two independently-installable hook groups
// (ManagedHookEvents vs the unexported permissionHookEvents) -- and reading
// back which of the managed events currently have our group installed.
//
// This is the highest-risk port in the collector-go tree: a bug here can
// corrupt a real user's Claude Code settings.json. Every read/modify/write
// path below preserves unrelated top-level keys and unrelated hook groups
// byte-for-byte in VALUE (see installer_test.go's fixture-based tests, which
// exercise a settings.json with a pre-existing unrelated hook group already
// present, not just an empty file) and writes a timestamped backup before
// ever touching an existing file, exactly mirroring hookInstaller.ts. The
// byte-for-byte-in-VALUE claim depends on marshalSettingsJSON below using
// json.Encoder with SetEscapeHTML(false): Go's json.MarshalIndent HTML-escapes
// `<`, `>`, and `&` in every string by default (JSON.stringify does not), which
// would otherwise silently rewrite unrelated hook command strings containing
// shell redirection/`&&` on every install/uninstall write.
//
// Known, accepted divergence from the TS original: Go's encoding/json always
// emits object keys in sorted order when marshaling a map[string]interface{},
// whereas Node's JSON.stringify preserves insertion order. This package
// therefore does not reproduce the exact byte-for-byte key ORDER of a
// rewritten settings.json (though every key and value is preserved). JSON
// object key order carries no semantic meaning and Claude Code's own
// settings reader does not depend on it, so this is a cosmetic-only
// divergence, not a behavior change -- see this task's report for why this
// was accepted rather than pulled in an order-preserving JSON dependency.
package hookinstall

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// ManagedHookEvents mirrors hookInstaller.ts's exported MANAGED_HOOK_EVENTS.
var ManagedHookEvents = []string{"PreToolUse", "PostToolUse", "Notification", "Stop"}

// permissionHookEvents mirrors hookInstaller.ts's unexported
// PERMISSION_HOOK_EVENTS: a distinct, independently installable hook group
// that shares PostToolUse/Notification with ManagedHookEvents but is
// installed/uninstalled via its own marker, never touching the
// aether-hook-emit.mjs group occupying those same events.
var permissionHookEvents = []string{"PermissionRequest", "PostToolUse", "Notification"}

// permissionHookMarker mirrors hookInstaller.ts's PERMISSION_HOOK_MARKER.
const permissionHookMarker = "aether-permission-hook.mjs"

// managedHookMarker is the literal substring uninstallHooks in the TS source
// hardcodes for identifying "our" managed-event entries at uninstall time,
// when the caller may not have scriptPath handy.
const managedHookMarker = "aether-hook-emit.mjs"

// HookInstallState mirrors hookInstaller.ts's HookInstallState interface.
type HookInstallState struct {
	InstalledEvents []string
	SettingsPath    string
	ScriptPath      string
}

// InstallResult mirrors the `{ ok, backupPath?, error? }` object literal
// every install/uninstall function in hookInstaller.ts returns. BackupPath
// is nil when no backup was written (either an error occurred before one
// could be, or the file did not exist yet); it is non-nil (and points to an
// empty string only if that were ever a real path, which never happens in
// practice) whenever a backup was written.
type InstallResult struct {
	OK         bool
	BackupPath *string
	Error      string
}

func isOurGroup(group interface{}, scriptPath string) bool {
	obj, ok := group.(map[string]interface{})
	if !ok {
		return false
	}
	hooksVal, ok := obj["hooks"]
	if !ok {
		return false
	}
	hooksArr, ok := hooksVal.([]interface{})
	if !ok {
		return false
	}
	for _, h := range hooksArr {
		hObj, ok := h.(map[string]interface{})
		if !ok {
			continue
		}
		cmd, ok := hObj["command"].(string)
		if ok && strings.Contains(cmd, scriptPath) {
			return true
		}
	}
	return false
}

func ourGroup(scriptPath string) map[string]interface{} {
	return map[string]interface{}{
		"hooks": []interface{}{
			map[string]interface{}{
				"type":    "command",
				"command": fmt.Sprintf(`node "%s"`, scriptPath),
			},
		},
	}
}

type readSettingsResult struct {
	ok          bool
	fileExisted bool
	raw         string
	parsed      map[string]interface{}
	errMsg      string
}

// readSettings mirrors hookInstaller.ts's readSettings. A missing file is not
// an error (fileExisted: false, parsed: {}); a present-but-unparseable or
// present-but-non-object file is an error, and callers must refuse to
// proceed rather than risk overwriting data they can't safely merge into.
func readSettings(settingsPath string) readSettingsResult {
	raw, err := os.ReadFile(settingsPath)
	if err != nil {
		if os.IsNotExist(err) {
			return readSettingsResult{ok: true, fileExisted: false, raw: "", parsed: map[string]interface{}{}}
		}
		return readSettingsResult{ok: false, errMsg: err.Error()}
	}

	var parsed interface{}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return readSettingsResult{ok: false, errMsg: fmt.Sprintf("could not parse existing settings.json: %s", err.Error())}
	}
	obj, isObj := parsed.(map[string]interface{})
	if !isObj {
		return readSettingsResult{ok: false, errMsg: "existing settings.json is not a JSON object; refusing to overwrite"}
	}
	return readSettingsResult{ok: true, fileExisted: true, raw: string(raw), parsed: obj}
}

// normalizeHooksValue mirrors hookInstaller.ts's
// `parsed.hooks && typeof parsed.hooks === 'object' ? { ...parsed.hooks } : {}`
// spread pattern used at every install/uninstall call site. JS's typeof
// considers arrays 'object' too, so `{...arrayValue}` spreads array elements
// into a plain object keyed by numeric-string index ("0", "1", ...) rather
// than discarding them -- this normalizes a Go []interface{} the same way,
// and returns a shallow copy for an already-object value (never the original
// map, matching the TS spread's copy semantics) or an empty map for any other
// shape (missing key, nil/null, string, number, bool).
func normalizeHooksValue(v interface{}) map[string]interface{} {
	switch t := v.(type) {
	case map[string]interface{}:
		out := make(map[string]interface{}, len(t))
		for k, val := range t {
			out[k] = val
		}
		return out
	case []interface{}:
		out := make(map[string]interface{}, len(t))
		for i, val := range t {
			out[strconv.Itoa(i)] = val
		}
		return out
	default:
		return map[string]interface{}{}
	}
}

// marshalSettingsJSON mirrors JSON.stringify(merged, null, 2): 2-space
// indent, no HTML-escaping of <, >, & (Go's json.MarshalIndent HTML-escapes
// those by default; JSON.stringify never does). json.Encoder.Encode appends
// a trailing newline that MarshalIndent does not, so it is trimmed to keep
// the existing output shape (no trailing newline) unchanged.
func marshalSettingsJSON(v interface{}) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func writeBackup(settingsPath, raw string) (string, error) {
	backupPath := fmt.Sprintf("%s.aetherbak-%d", settingsPath, time.Now().UnixMilli())
	if err := os.WriteFile(backupPath, []byte(raw), 0644); err != nil {
		return "", err
	}
	return backupPath, nil
}

func writeSettingsAtomically(settingsPath, content string) error {
	tmpPath := fmt.Sprintf("%s.aethertmp-%d", settingsPath, time.Now().UnixMilli())
	if err := os.WriteFile(tmpPath, []byte(content), 0644); err != nil {
		return err
	}
	return os.Rename(tmpPath, settingsPath)
}

// ReadHookInstallState mirrors hookInstaller.ts's readHookInstallState.
func ReadHookInstallState(settingsPath, scriptPath string) HookInstallState {
	result := readSettings(settingsPath)
	installedEvents := []string{}
	if result.ok {
		hooksObj, _ := result.parsed["hooks"].(map[string]interface{})
		for _, eventName := range ManagedHookEvents {
			groupsArr, ok := hooksObj[eventName].([]interface{})
			if !ok {
				continue
			}
			for _, g := range groupsArr {
				if isOurGroup(g, scriptPath) {
					installedEvents = append(installedEvents, eventName)
					break
				}
			}
		}
	}
	return HookInstallState{InstalledEvents: installedEvents, SettingsPath: settingsPath, ScriptPath: scriptPath}
}

// installGroup is the shared body of installHooks and installPermissionHooks
// in the TS source, which are structurally identical aside from which event
// list they iterate. For each event in events: if hooks[event] already
// exists but is not an array, it is an unrecognized shape -- left completely
// untouched (not even copied differently), and only that event is skipped;
// otherwise our group is appended unless already present (idempotent).
func installGroup(settingsPath, scriptPath string, events []string) InstallResult {
	result := readSettings(settingsPath)
	if !result.ok {
		return InstallResult{OK: false, Error: result.errMsg}
	}

	var backupPath *string
	if result.fileExisted {
		bp, err := writeBackup(settingsPath, result.raw)
		if err != nil {
			return InstallResult{OK: false, Error: err.Error()}
		}
		backupPath = &bp
	}

	hooks := normalizeHooksValue(result.parsed["hooks"])

	for _, eventName := range events {
		current, exists := hooks[eventName]
		if exists {
			if _, isArr := current.([]interface{}); !isArr {
				// Unrecognized shape for this event -- we don't know how to
				// safely merge into it, so leave it exactly as-is rather
				// than risk discarding the user's data. Skip only this
				// event; keep processing others.
				continue
			}
		}
		existingGroups, _ := current.([]interface{})

		alreadyInstalled := false
		for _, g := range existingGroups {
			if isOurGroup(g, scriptPath) {
				alreadyInstalled = true
				break
			}
		}
		if alreadyInstalled {
			hooks[eventName] = existingGroups
		} else {
			newGroups := make([]interface{}, len(existingGroups), len(existingGroups)+1)
			copy(newGroups, existingGroups)
			hooks[eventName] = append(newGroups, ourGroup(scriptPath))
		}
	}

	merged := map[string]interface{}{}
	for k, v := range result.parsed {
		merged[k] = v
	}
	merged["hooks"] = hooks

	if err := os.MkdirAll(filepath.Dir(settingsPath), 0755); err != nil {
		return InstallResult{OK: false, Error: err.Error()}
	}
	body, err := marshalSettingsJSON(merged)
	if err != nil {
		return InstallResult{OK: false, Error: err.Error()}
	}
	if err := writeSettingsAtomically(settingsPath, string(body)); err != nil {
		return InstallResult{OK: false, Error: err.Error()}
	}
	return InstallResult{OK: true, BackupPath: backupPath}
}

// InstallHooks mirrors hookInstaller.ts's installHooks.
func InstallHooks(settingsPath, scriptPath string) InstallResult {
	return installGroup(settingsPath, scriptPath, ManagedHookEvents)
}

// InstallPermissionHooks mirrors hookInstaller.ts's installPermissionHooks.
func InstallPermissionHooks(settingsPath, scriptPath string) InstallResult {
	return installGroup(settingsPath, scriptPath, permissionHookEvents)
}

// filterGroupsByMarker mirrors the .map(...).filter(...) pipeline shared by
// uninstallHooks/uninstallPermissionHooks in the TS source EXACTLY, including
// its second-pass behavior: after removing our own marker entries from any
// group that has them, ANY group (ours or not) whose resulting `.hooks` is
// an array of length 0 is dropped entirely; a group whose `.hooks` isn't an
// array at all is always kept (pass-through, matching "!Array.isArray(...)
// || length > 0").
func filterGroupsByMarker(groups []interface{}, marker string) []interface{} {
	mapped := make([]interface{}, len(groups))
	for i, g := range groups {
		if !isOurGroup(g, marker) {
			mapped[i] = g
			continue
		}
		gm, ok := g.(map[string]interface{})
		if !ok {
			mapped[i] = g
			continue
		}
		groupHooksArr, isArr := gm["hooks"].([]interface{})
		if !isArr {
			mapped[i] = g
			continue
		}
		remaining := make([]interface{}, 0, len(groupHooksArr))
		for _, h := range groupHooksArr {
			hObj, isMap := h.(map[string]interface{})
			if isMap {
				if cmd, ok := hObj["command"].(string); ok && strings.Contains(cmd, marker) {
					continue
				}
			}
			remaining = append(remaining, h)
		}
		newGroup := map[string]interface{}{}
		for k, v := range gm {
			newGroup[k] = v
		}
		newGroup["hooks"] = remaining
		mapped[i] = newGroup
	}

	result := make([]interface{}, 0, len(mapped))
	for _, g := range mapped {
		gm, isMap := g.(map[string]interface{})
		if !isMap {
			result = append(result, g)
			continue
		}
		hooksArr, isArr := gm["hooks"].([]interface{})
		if !isArr {
			result = append(result, g)
			continue
		}
		if len(hooksArr) > 0 {
			result = append(result, g)
		}
	}
	return result
}

// uninstallByMarker is the shared body of uninstallHooks and
// uninstallPermissionHooks in the TS source.
func uninstallByMarker(settingsPath string, events []string, marker string) InstallResult {
	result := readSettings(settingsPath)
	if !result.ok {
		return InstallResult{OK: false, Error: result.errMsg}
	}
	if !result.fileExisted {
		return InstallResult{OK: true, BackupPath: nil}
	}
	// Mirrors TS's `typeof parsed.hooks !== 'object' || parsed.hooks === null`
	// early-return guard exactly: proceed (and write) only when hooks is a
	// JSON object OR array (JS's typeof array is 'object' too, so an
	// array-shaped hooks value must NOT early-return here -- it gets spread
	// into a numeric-keyed object below via normalizeHooksValue, matching
	// TS's `{ ...parsed.hooks }`). Anything else -- missing key, null,
	// string, number, bool -- is a true no-op: no backup, no write.
	switch result.parsed["hooks"].(type) {
	case map[string]interface{}, []interface{}:
		// proceed
	default:
		return InstallResult{OK: true, BackupPath: nil}
	}

	bp, err := writeBackup(settingsPath, result.raw)
	if err != nil {
		return InstallResult{OK: false, Error: err.Error()}
	}

	hooks := normalizeHooksValue(result.parsed["hooks"])

	for _, eventName := range events {
		current, exists := hooks[eventName]
		if exists {
			if _, isArr := current.([]interface{}); !isArr {
				// Unrecognized shape -- leave completely untouched rather
				// than risk deleting the user's data outright.
				continue
			}
		}
		groupsArr, _ := current.([]interface{})
		filtered := filterGroupsByMarker(groupsArr, marker)
		if len(filtered) > 0 {
			hooks[eventName] = filtered
		} else {
			delete(hooks, eventName)
		}
	}

	merged := map[string]interface{}{}
	for k, v := range result.parsed {
		merged[k] = v
	}
	merged["hooks"] = hooks

	body, err := marshalSettingsJSON(merged)
	if err != nil {
		return InstallResult{OK: false, Error: err.Error()}
	}
	if err := writeSettingsAtomically(settingsPath, string(body)); err != nil {
		return InstallResult{OK: false, Error: err.Error()}
	}
	bpCopy := bp
	return InstallResult{OK: true, BackupPath: &bpCopy}
}

// UninstallHooks mirrors hookInstaller.ts's uninstallHooks. scriptPath is not
// known at uninstall time in general (the caller may not have it handy) --
// every ManagedHookEvents entry this package would have added has a command
// containing the literal substring "aether-hook-emit.mjs", which is a
// stable, sufficiently specific marker for "ours" without requiring the
// caller to pass scriptPath through this call.
func UninstallHooks(settingsPath string) InstallResult {
	return uninstallByMarker(settingsPath, ManagedHookEvents, managedHookMarker)
}

// UninstallPermissionHooks mirrors hookInstaller.ts's
// uninstallPermissionHooks.
func UninstallPermissionHooks(settingsPath string) InstallResult {
	return uninstallByMarker(settingsPath, permissionHookEvents, permissionHookMarker)
}
