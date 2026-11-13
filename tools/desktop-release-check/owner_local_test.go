package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
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
		{"root Cargo configuration", ".cargo/config.toml", false},
		{"root Rust toolchain", "rust-toolchain.toml", false},
		{"root package configuration", ".npmrc", false},
		{"ignored frontend environment", "ignored-env", false},
		{"Git environment override", "git-env", false},
		{"dirty source", "dirty", false},
		{"wrong local platform", "platform", false},
		{"no source SHA", "sha", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			env := map[string]string{}
			if tc.change == "workflow" {
				env["GITHUB_ACTIONS"] = "true"
			}
			if tc.change == "git-env" {
				env["GIT_DIR"] = "unrelated"
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
				case "ls-files --others --exclude-standard --":
					if tc.change == "untracked" {
						return []byte("tools/desktop-release-check/extra.go\n"), nil
					}
					if tc.change == ".cargo/config.toml" || tc.change == "rust-toolchain.toml" || tc.change == ".npmrc" {
						return []byte(tc.change + "\n"), nil
					}
					return nil, nil
				case "ls-files --others --ignored --exclude-standard -- .env .env.* apps/desktop/.env apps/desktop/.env.*":
					if tc.change == "ignored-env" {
						return []byte("apps/desktop/.env.production\n"), nil
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

func TestSignWindowsRechecksOwnerSourceFirst(t *testing.T) {
	t.Setenv("PASSSHARE_OWNER_SIGNING_ROOT", "untrusted-source")
	t.Setenv("PASSSHARE_OWNER_SIGNING_SHA", strings.Repeat("a", 40))
	t.Setenv("GITHUB_ACTIONS", "true")
	err := signWindows("unrelated.exe")
	if err == nil || err.Error() != "owner local signing is not permitted inside a workflow" {
		t.Fatalf("signer did not recheck owner context first: %v", err)
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

func TestOwnerWorkflowRefusedBeforePlatformOrAPI(t *testing.T) {
	for _, platform := range []string{"windows", "linux", "darwin"} {
		t.Run(platform, func(t *testing.T) {
			err := checkOwnerSourceWith("owned-source", strings.Repeat("a", 40), platform,
				func(k string) string {
					if k == "GITHUB_ACTIONS" {
						return "true"
					}
					return ""
				},
				func(string, any) error { t.Fatal("workflow reached local API"); return nil },
				func(string, []string, string, ...string) ([]byte, error) {
					t.Fatal("workflow reached local Git")
					return nil, nil
				},
				func(string, string) (source, error) { t.Fatal("workflow reached source"); return source{}, nil })
			if err == nil || err.Error() != "owner local signing is not permitted inside a workflow" {
				t.Fatalf("wrong workflow rejection: %v", err)
			}
		})
	}
}

func TestWindowsSigningAllowsOnlyProductCallbacks(t *testing.T) {
	root := filepath.Join(scratch(t), "repo")
	owned := scratch(t)
	t.Setenv("RUNNER_TEMP", owned)
	temporary := filepath.Join(owned, "candidate-config-1234", "nsis-temp")
	for _, name := range []string{"target/release/bundle/nsis/PassShare_0.1.0_x64-setup.exe", "target/release/nsis/x64/Plugins/x86-unicode/NSISdl.dll", "target/release/nsis/x64/Plugins/x86-unicode/StartMenu.dll", "target/release/nsis/x64/Plugins/x86-unicode/System.dll", "target/release/nsis/x64/Plugins/x86-unicode/nsDialogs.dll", "target/release/nsis/x64/Plugins/x86-unicode/additional/nsis_tauri_utils.dll"} {
		if !allowedWindowsBundlerPath(root, filepath.Join(root, filepath.FromSlash(name)), "0.1.0", temporary) {
			t.Fatalf("official callback rejected: %s", name)
		}
	}
	if !allowedWindowsBundlerPath(root, filepath.Join(temporary, "nstA12F.tmp"), "0.1.0", temporary) {
		t.Fatal("owned NSIS uninstaller callback rejected")
	}
	for _, name := range []string{"target/release/arbitrary.exe", "target/release/deps/evil.exe", "target/release/bundle/nsis/PassShare_0.2.0_x64-setup.exe", "target/release/bundle/nsis/evil-setup.exe", "target/release/nsis/x64/Plugins/x86-unicode/evil.dll", "target/release/nsis/arm64/Plugins/x86-unicode/System.dll"} {
		p := filepath.Join(root, filepath.FromSlash(name))
		if allowedWindowsSigningPath(root, p) || allowedWindowsBundlerPath(root, p, "0.1.0", temporary) {
			t.Fatalf("unknown callback accepted: %s", name)
		}
	}
	for _, p := range []string{filepath.Join(temporary, "evil.tmp"), filepath.Join(temporary, "nst12345.tmp"), filepath.Join(temporary, "nested/nst123.tmp"), filepath.Join(filepath.Dir(temporary), "nst123.tmp")} {
		if allowedWindowsBundlerPath(root, p, "0.1.0", temporary) {
			t.Fatal("unknown temporary signing target accepted")
		}
	}
	if allowedWindowsBundlerPath(root, filepath.Join(temporary, "nst123.tmp"), "0.1.0", "") || allowedWindowsBundlerPath(root, filepath.Join(temporary, "nst123.tmp"), "bad", temporary) {
		t.Fatal("temporary signing without bound build accepted")
	}
	for _, other := range []string{filepath.Join(owned, "other", "nsis-temp"), filepath.Join(filepath.Dir(owned), "candidate-config-1234", "nsis-temp"), owned} {
		if allowedWindowsBundlerPath(root, filepath.Join(other, "nst123.tmp"), "0.1.0", other) {
			t.Fatal("temporary target outside owned build context accepted")
		}
	}
}

func TestOwnerSourceRealGitRejectsExtraInputs(t *testing.T) {
	for _, extra := range []string{".cargo/config.toml", "rust-toolchain.toml", ".npmrc", "apps/desktop/.env.production"} {
		t.Run(strings.ReplaceAll(extra, "/", "_"), func(t *testing.T) {
			root := scratch(t)
			write(t, filepath.Join(root, ".gitignore"), []byte(".env*\n"))
			for _, args := range [][]string{{"init", "--quiet", "--initial-branch=main"}, {"add", ".gitignore"}, {"-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "owned metadata fixture"}, {"remote", "add", "origin", "git@github.com:" + repository + ".git"}} {
				if _, err := command(root, nil, "git", args...); err != nil {
					t.Fatal(err)
				}
			}
			shaBytes, err := command(root, nil, "git", "rev-parse", "HEAD")
			if err != nil {
				t.Fatal(err)
			}
			sha := strings.TrimSpace(string(shaBytes))
			api := func(endpoint string, out any) error {
				var data string
				switch endpoint {
				case "user":
					data = `{"id":88025750}`
				case "repos/" + repository:
					data = `{"id":1131498455,"full_name":"AutoDevJapan/PassShare","owner":{"id":246834983},"default_branch":"main","permissions":{"admin":true}}`
				case "repos/" + repository + "/branches/main":
					data = `{"commit":{"sha":"` + sha + `"}}`
				default:
					t.Fatal("unexpected endpoint")
				}
				return json.Unmarshal([]byte(data), out)
			}
			inspect := func(r, s string) (source, error) {
				if r != root || s != sha {
					t.Fatal("source mismatched")
				}
				return source{SHA: s}, nil
			}
			env := func(string) string { return "" }
			if err := checkOwnerSourceWith(root, sha, "windows", env, api, command, inspect); err != nil {
				t.Fatalf("clean positive rejected: %v", err)
			}
			write(t, filepath.Join(root, filepath.FromSlash(extra)), []byte("fixture=not-production\n"))
			if err := checkOwnerSourceWith(root, sha, "windows", env, api, command, inspect); err == nil {
				t.Fatalf("extra build input accepted: %s", extra)
			}
		})
	}
}

func TestSigningTemporaryEnvironmentIsReplaced(t *testing.T) {
	values := map[string]string{"TEMP": "owned", "TMP": "owned", "PASSSHARE_SIGNING_TEMP": "owned"}
	got := replaceEnvironment([]string{"temp=outside", "TMP=elsewhere", "PASSSHARE_SIGNING_TEMP=bad", "PATH=retained"}, values)
	counts := map[string]int{}
	for _, item := range got {
		pair := strings.SplitN(item, "=", 2)
		key := strings.ToUpper(pair[0])
		counts[key]++
		if expected, ok := values[key]; ok && pair[1] != expected {
			t.Fatal("old temp inherited")
		}
	}
	for key := range values {
		if counts[key] != 1 {
			t.Fatalf("temporary context count %s=%d", key, counts[key])
		}
	}
}

func TestOwnerEntryBuildEnvironmentIsNotInheritedAuthority(t *testing.T) {
	if err := checkOwnerBuildEnvironment(func(string) string { return "" }); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"CARGO_TARGET_DIR", "CARGO_BUILD_TARGET", "RUSTFLAGS", "TAURI_CONFIG", "VITE_API_BASE_URL"} {
		t.Run(key, func(t *testing.T) {
			if checkOwnerBuildEnvironment(func(k string) string {
				if k == key {
					return "override"
				}
				return ""
			}) == nil {
				t.Fatal("build override accepted")
			}
		})
	}
}
