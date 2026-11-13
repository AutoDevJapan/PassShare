package main

import (
	"bytes"
	"encoding/json"
	"os"
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
	if platform != "windows" || !shaPattern.MatchString(sha) || root == "" {
		return fail("owner signing requires Windows and an exact main source SHA")
	}
	for _, key := range []string{"GITHUB_ACTIONS", "GITHUB_EVENT_NAME", "GITHUB_WORKFLOW_REF", "GITHUB_WORKFLOW_SHA", "GITHUB_RUN_ID", "GITHUB_SHA"} {
		if env(key) != "" {
			return fail("owner local signing is not permitted inside a workflow")
		}
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
	untracked, err := local(root, nil, "git", "ls-files", "--others", "--exclude-standard", "--", "apps/desktop", "packages/connect-js", "crates", "scripts", "tools/desktop-release-check")
	if err != nil || len(bytes.TrimSpace(untracked)) != 0 {
		return fail("untracked build source is not allowed in an owner signing checkout")
	}
	_, err = inspect(root, sha)
	return err
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
