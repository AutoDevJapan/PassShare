package main

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
)

// Exercise authority and source gates without a signing key, account override,
// API request or product build. Native signature tests remain separate.
func TestOwnerLocalSourceContract(t *testing.T) {
	sha := strings.Repeat("a", 40)
	for _, tc := range []struct {
		name, change string
		want         bool
	}{
		{"public owner main", "", true},
		{"different owner", "owner", false},
		{"fork repository ID", "repo", false},
		{"lookalike repository name", "name", false},
		{"organization transfer", "organization", false},
		{"not repository admin", "permission", false},
		{"wrong default branch", "default", false},
		{"main advanced", "main", false},
		{"not authenticated", "auth", false},
		{"PR workflow", "workflow", false},
		{"local feature branch", "branch", false},
		{"unknown origin", "remote", false},
		{"untracked build source", "untracked", false},
		{"dirty source", "dirty", false},
		{"wrong local platform", "platform", false},
		{"no source SHA", "sha", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := map[string]string{}
			if tc.change == "workflow" {
				env["GITHUB_ACTIONS"] = "true"
			}
			id, repoID, ownerID := signingOwnerID, repositoryID, repositoryOwnerID
			name, mainSHA, defaultBranch := repository, sha, "main"
			admin, platform, candidateSHA := true, "windows", sha
			switch tc.change {
			case "owner":
				id++
			case "repo":
				repoID++
			case "organization":
				ownerID++
			case "name":
				name += "-fork"
			case "permission":
				admin = false
			case "default":
				defaultBranch = "develop"
			case "main":
				mainSHA = strings.Repeat("b", 40)
			case "platform":
				platform = "linux"
			case "sha":
				candidateSHA = ""
			}
			calls, inspected := 0, 0
			api := func(endpoint string, out any) error {
				calls++
				if tc.change == "auth" {
					return errors.New("unavailable")
				}
				var value any
				switch endpoint {
				case "user":
					value = map[string]any{"id": id}
				case "repos/" + repository:
					value = map[string]any{"id": repoID, "full_name": name, "default_branch": defaultBranch, "private": false, "owner": map[string]any{"id": ownerID}, "permissions": map[string]any{"admin": admin}}
				case "repos/" + repository + "/branches/main":
					value = map[string]any{"commit": map[string]any{"sha": mainSHA}}
				default:
					t.Fatalf("unexpected API endpoint %q", endpoint)
				}
				b, _ := json.Marshal(value)
				return json.Unmarshal(b, out)
			}
			local := func(root string, extra []string, program string, args ...string) ([]byte, error) {
				if root != "owned-source" || program != "git" || len(extra) != 0 {
					t.Fatal("unexpected source invocation")
				}
				switch strings.Join(args, " ") {
				case "symbolic-ref --quiet --short HEAD":
					if tc.change == "branch" {
						return []byte("feature\n"), nil
					}
					return []byte("main\n"), nil
				case "remote get-url origin":
					if tc.change == "remote" {
						return []byte("https://example.invalid/PassShare.git\n"), nil
					}
					return []byte("git@github.com:" + repository + ".git\n"), nil
				case "ls-files --others --exclude-standard -- apps/desktop packages/connect-js crates scripts tools/desktop-release-check":
					if tc.change == "untracked" {
						return []byte("tools/desktop-release-check/extra.go\n"), nil
					}
					return nil, nil
				default:
					t.Fatalf("unexpected git arguments %q", args)
					return nil, nil
				}
			}
			inspect := func(root, s string) (source, error) {
				inspected++
				if root != "owned-source" || s != sha {
					t.Fatal("source identity changed")
				}
				if tc.change == "dirty" {
					return source{}, errors.New("dirty")
				}
				return source{SHA: s}, nil
			}
			err := checkOwnerSourceWith("owned-source", candidateSHA, platform, func(k string) string { return env[k] }, api, local, inspect)
			if (err == nil) != tc.want {
				t.Fatalf("accepted=%v want %v: %v", err == nil, tc.want, err)
			}
			if tc.want && (calls != 3 || inspected != 1) {
				t.Fatalf("positive did not reach all trust checks: API=%d inspect=%d", calls, inspected)
			}
			if tc.change == "workflow" && calls != 0 {
				t.Fatal("CI reached local owner API")
			}
		})
	}
}

func TestOwnerRemoteRejectsCredentialAndHostAmbiguity(t *testing.T) {
	for _, remote := range []string{"https://github.com/" + repository, "https://github.com/" + repository + ".git", "git@github.com:" + repository + ".git"} {
		if !ownerRemote(remote) {
			t.Fatal("official origin rejected")
		}
	}
	for _, remote := range []string{"https://token@github.com/" + repository + ".git", "https://github.com.evil.invalid/" + repository + ".git", "git@github.com:someone/PassShare.git", "file:///PassShare", "https://github.com/" + repository + ".git?x"} {
		if ownerRemote(remote) {
			t.Fatal("ambiguous origin accepted")
		}
	}
}

func TestOwnerSigningContextDoesNotLeakToUnrelatedChildren(t *testing.T) {
	t.Setenv("PASSSHARE_OWNER_SIGNING_ROOT", "owned-source")
	t.Setenv("PASSSHARE_OWNER_SIGNING_SHA", strings.Repeat("a", 40))
	for _, signing := range []bool{false, true} {
		for _, value := range cleanEnv(signing) {
			if strings.HasPrefix(value, "PASSSHARE_OWNER_SIGNING_") {
				t.Fatal("owner signing context inherited outside exact build child")
			}
		}
	}
}

func TestOwnerBuildWithoutKeyStopsBeforeAnyChild(t *testing.T) {
	t.Setenv("TAURI_SIGNING_PRIVATE_KEY", "")
	root := scratch(t)
	if err := buildCandidate(root, source{SHA: strings.Repeat("a", 40)}, true); err == nil || !strings.Contains(err.Error(), "signing key is required") {
		t.Fatal("missing key was not refused before build")
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatal("keyless owner build created output")
	}
}

func TestOwnerEntryDoesNotReuseWorkflowTrustOrSignOnUnknownCommand(t *testing.T) {
	t.Setenv("GITHUB_ACTIONS", "true")
	root := scratch(t)
	for _, operation := range []string{"owner-preflight", "owner-build", "owner-verify"} {
		if err := run([]string{operation, "--repo", root, "--source-sha", strings.Repeat("a", 40)}); err == nil || !strings.Contains(err.Error(), "not permitted inside a workflow") {
			t.Fatalf("%s did not refuse workflow context: %v", operation, err)
		}
	}
	if err := run([]string{"owner-sign-anything", "--repo", root, "--source-sha", strings.Repeat("a", 40)}); err == nil || err.Error() != "unknown owner command" {
		t.Fatal("unknown owner operation reached signing")
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatal("rejected owner operation created output")
	}
}
