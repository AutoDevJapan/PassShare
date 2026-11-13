package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const repositoryID int64 = 1131498455
const repositoryOwnerID int64 = 246834983
const signingOwnerID int64 = 88025750

// This is an explicit local administrative entry, not an alternate CI identity.
// Its API reads use gh's existing keyring, never token overrides or a new login.
// A public repository is not evidence of authority to sign its contents.
func checkOwnerSource(root, sha string) error {
	return checkOwnerSourceWith(root, sha, runtime.GOOS, os.Getenv, ownerAPI, command, inspectSource)
}

type apiRead func(string, any) error
type localRead func(string, []string, string, ...string) ([]byte, error)

func checkOwnerSourceWith(root, sha, platform string, env func(string) string, api apiRead, local localRead, inspect func(string, string) (source, error)) error {
	for _, key := range []string{"GITHUB_ACTIONS", "GITHUB_EVENT_NAME", "GITHUB_WORKFLOW_REF", "GITHUB_WORKFLOW_SHA", "GITHUB_RUN_ID", "GITHUB_SHA"} {
		if env(key) != "" {
			return fail("owner local signing is not permitted inside a workflow")
		}
	}
	for _, key := range []string{"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"} {
		if env(key) != "" {
			return fail("owner signing requires the documented source and build environment")
		}
	}
	if platform != "windows" || !shaPattern.MatchString(sha) || root == "" {
		return fail("owner signing requires Windows and an exact main source SHA")
	}
	var account struct {
		ID int64 `json:"id"`
	}
	if api("user", &account) != nil || account.ID != signingOwnerID {
		return fail("existing GitHub owner authentication is required")
	}
	var repo struct {
		ID            int64  `json:"id"`
		FullName      string `json:"full_name"`
		DefaultBranch string `json:"default_branch"`
		Owner         struct {
			ID int64 `json:"id"`
		} `json:"owner"`
		Permissions struct {
			Admin bool `json:"admin"`
		} `json:"permissions"`
	}
	if api("repos/"+repository, &repo) != nil || repo.ID != repositoryID || repo.FullName != repository || repo.Owner.ID != repositoryOwnerID || repo.DefaultBranch != "main" || !repo.Permissions.Admin {
		return fail("owner repository identity and administration must be verified")
	}
	var main struct {
		Commit struct {
			SHA string `json:"sha"`
		} `json:"commit"`
	}
	if api("repos/"+repository+"/branches/main", &main) != nil || main.Commit.SHA != sha {
		return fail("owner source must equal current official main")
	}
	branch, err := local(root, nil, "git", "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil || strings.TrimSpace(string(branch)) != "main" {
		return fail("owner source checkout must be on main")
	}
	remote, err := local(root, nil, "git", "remote", "get-url", "origin")
	if err != nil || !ownerRemote(strings.TrimSpace(string(remote))) {
		return fail("owner source origin must be the official repository")
	}
	untracked, err := local(root, nil, "git", "ls-files", "--others", "--exclude-standard", "--")
	if err != nil || len(bytes.TrimSpace(untracked)) != 0 {
		return fail("untracked build source is not allowed in an owner signing checkout")
	}
	ignoredEnv, err := local(root, nil, "git", "ls-files", "--others", "--ignored", "--exclude-standard", "--", ".env", ".env.*", "apps/desktop/.env", "apps/desktop/.env.*")
	if err != nil || len(bytes.TrimSpace(ignoredEnv)) != 0 {
		return fail("local environment files are not permitted in an owner signing checkout")
	}
	_, err = inspect(root, sha)
	return err
}

// Check caller overrides only at the owner entry. Tauri legitimately sets its
// own configuration in descendants; signer children still recheck Git and API.
func checkOwnerBuildEnvironment(env func(string) string) error {
	for _, key := range []string{"CARGO_TARGET_DIR", "CARGO_BUILD_TARGET", "RUSTFLAGS", "TAURI_CONFIG", "VITE_API_BASE_URL"} {
		if env(key) != "" {
			return fail("owner build requires the documented build environment")
		}
	}
	return nil
}

func ownerRemote(remote string) bool {
	return remote == "git@github.com:"+repository+".git" || remote == "https://github.com/"+repository+".git" || remote == "https://github.com/"+repository
}

func ownerAPI(endpoint string, value any) error {
	data, err := commandWithin(15*time.Second, "", nil, "gh", "api", "--hostname", "github.com", "--method", "GET", endpoint)
	if err != nil || len(data) == 0 || len(data) > 64*1024 {
		return fail("official GitHub metadata could not be verified")
	}
	if json.Unmarshal(data, value) != nil {
		return fail("invalid official GitHub metadata")
	}
	return nil
}

// A new clean signing clone is documented as a prerequisite. Reinstall frozen
// dependencies and rebuild the shared SDK instead of trusting a previous dist.
func prepareOwnerDependencies(root string) error {
	for _, dir := range []string{"packages/connect-js", "apps/desktop"} {
		if _, err := commandWithin(15*time.Minute, filepath.Join(root, filepath.FromSlash(dir)), nil,
			"powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `& pnpm install --frozen-lockfile --force; exit $LASTEXITCODE`); err != nil {
			return fail("cannot prepare locked owner build dependencies")
		}
		if dir == "packages/connect-js" {
			if _, err := commandWithin(3*time.Minute, filepath.Join(root, filepath.FromSlash(dir)), nil,
				"powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `& pnpm run build; exit $LASTEXITCODE`); err != nil {
				return fail("cannot rebuild the owner Connect SDK")
			}
		}
	}
	return nil
}

func replaceEnvironment(base []string, values map[string]string) []string {
	result := make([]string, 0, len(base)+len(values))
	for _, item := range base {
		if _, replaced := values[strings.ToUpper(strings.SplitN(item, "=", 2)[0])]; !replaced {
			result = append(result, item)
		}
	}
	for key, value := range values {
		result = append(result, key+"="+value)
	}
	return result
}
