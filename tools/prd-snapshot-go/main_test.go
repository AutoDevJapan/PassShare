package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fake struct {
	root                                             string
	failCapture, failDigest, failCleanup, wrongOwner bool
	lostCreateReply, emptyCreateID                   bool
	created, revoked, captures                       int
}

func (f *fake) run(_ context.Context, name string, args ...string) ([]byte, error) {
	switch name {
	case "git":
		return []byte(f.root), nil
	case "ssh-keygen":
		key := args[len(args)-1]
		if err := os.WriteFile(key, []byte("synthetic-private-key"), 0600); err != nil {
			return nil, err
		}
		return nil, os.WriteFile(key+".pub", []byte("ssh-ed25519 synthetic-public-key"), 0600)
	case "railway":
		if args[0] == "ssh" {
			f.captures++
			if f.failCapture {
				return nil, errors.New("synthetic capture failure")
			}
			archive := []byte("PGDMP-synthetic-complete-archive")
			digest := sha256.Sum256(archive)
			digestText := hex.EncodeToString(digest[:])
			if f.failDigest {
				digestText = strings.Repeat("0", 64)
			}
			return []byte("CLI metadata\n" + digestText + "  /tmp/passshare-prd-dump.fixture\n" + base64.StdEncoding.EncodeToString(archive) + "\n"), nil
		}
		query, err := os.ReadFile(args[2])
		if err != nil {
			return nil, err
		}
		if strings.Contains(string(query), "sshPublicKeyCreate") {
			f.created++
			if f.lostCreateReply {
				return nil, errors.New("registration succeeded but reply was lost")
			}
			if f.emptyCreateID {
				return []byte(`{"data":{"sshPublicKeyCreate":{"id":""}}}`), nil
			}
			return []byte(`{"data":{"sshPublicKeyCreate":{"id":"this-run-only-key"}}}`), nil
		}
		if strings.Contains(string(query), "sshPublicKeyDelete") {
			varsPath := strings.TrimPrefix(args[4], "@")
			vars, err := os.ReadFile(varsPath)
			if err != nil {
				return nil, err
			}
			var ids map[string]string
			if json.Unmarshal(vars, &ids) != nil || ids["id"] != "this-run-only-key" {
				return nil, errors.New("unowned cleanup target")
			}
			f.revoked++
			if f.failCleanup {
				return []byte(`{"data":{"sshPublicKeyDelete":false}}`), nil
			}
			return []byte(`{"data":{"sshPublicKeyDelete":true}}`), nil
		}
		owner := workspaceID
		if f.wrongOwner {
			owner = "other-workspace"
		}
		return []byte(`{"data":{"project":{"id":"` + projectID + `","workspaceId":"` + owner + `"}}}`), nil
	}
	return nil, errors.New("unexpected command")
}

func TestUnconfirmedRegistrationRetainsOnlyNonSecretRecoveryInformation(t *testing.T) {
	for _, lostReply := range []bool{true, false} {
		f := &fake{root: t.TempDir(), lostCreateReply: lostReply, emptyCreateID: !lostReply}
		out := filepath.Join(t.TempDir(), "snapshot.dump")
		err := snapshot(context.Background(), out, f.run, "")
		if err == nil || f.created != 1 || f.revoked != 0 || f.captures != 0 {
			t.Fatal("unknown registration outcome was treated as success or guessed for deletion")
		}
		info, readErr := os.ReadFile(out + ".ssh-key-recovery.json")
		if readErr != nil {
			t.Fatal(readErr)
		}
		var record map[string]string
		if json.Unmarshal(info, &record) != nil || record["workspace_id"] != workspaceID || !strings.HasPrefix(record["registration_name"], "PassShare-prd-snapshot-") || len(record["public_key_sha256"]) != 64 || record["key_id"] != "" {
			t.Fatal("recovery descriptor is incomplete")
		}
		if !strings.Contains(err.Error(), string(info)) || strings.Contains(string(info), "synthetic-private-key") || strings.Contains(string(info), "synthetic-public-key") {
			t.Fatal("recovery descriptor was lost from failure log or exposed key bytes")
		}
		dirs, _ := filepath.Glob(filepath.Join(filepath.Dir(out), "passshare-prd-ssh-*"))
		if len(dirs) != 0 {
			t.Fatal("private identity directory was retained")
		}
	}
}

func TestCancellationStillRevokesUsingIndependentCleanupContext(t *testing.T) {
	f := &fake{root: t.TempDir()}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	run := func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "railway" && args[0] == "ssh" {
			cancel()
			return nil, ctx.Err()
		}
		if name == "railway" && args[0] == "api" {
			if ctx.Err() != nil {
				t.Fatal("cleanup reused cancelled context")
			}
		}
		return f.run(ctx, name, args...)
	}
	out := filepath.Join(t.TempDir(), "snapshot.dump")
	if snapshot(ctx, out, run, "") == nil || f.created != 1 || f.revoked != 1 {
		t.Fatal("cancelled capture skipped key cleanup")
	}
	if _, err := os.Stat(out + ".ssh-key-recovery.json"); !os.IsNotExist(err) {
		t.Fatal("revoked key left a recovery descriptor")
	}
}

func TestPrivateCaptureRevokesOnlyItsKeyAndValidatesArchive(t *testing.T) {
	f := &fake{root: t.TempDir()}
	out := filepath.Join(t.TempDir(), "snapshot.dump")
	if err := snapshot(context.Background(), out, f.run, ""); err != nil {
		t.Fatal(err)
	}
	if f.created != 1 || f.revoked != 1 || f.captures != 1 {
		t.Fatalf("creation=%d cleanup=%d capture=%d", f.created, f.revoked, f.captures)
	}
	b, err := os.ReadFile(out)
	if err != nil || string(b) != "PGDMP-synthetic-complete-archive" {
		t.Fatal("snapshot differs")
	}
}

func TestFailuresStillRevokeTheNewKey(t *testing.T) {
	for _, phase := range []string{"capture", "digest", "cleanup"} {
		t.Run(phase, func(t *testing.T) {
			f := &fake{root: t.TempDir(), failCapture: phase == "capture", failDigest: phase == "digest", failCleanup: phase == "cleanup"}
			out := filepath.Join(t.TempDir(), "snapshot.dump")
			failure := snapshot(context.Background(), out, f.run, "")
			if failure == nil {
				t.Fatal("failure passed")
			}
			if f.created != 1 || f.revoked != 1 {
				t.Fatalf("temporary identity not cleaned: %+v", f)
			}
			if phase == "cleanup" {
				info, err := os.ReadFile(out + ".ssh-key-recovery.json")
				if err != nil || !strings.Contains(string(info), `"key_id":"this-run-only-key"`) || !strings.Contains(failure.Error(), string(info)) {
					t.Fatal("failed revocation lost its exact key recovery record")
				}
			}
		})
	}
}

func TestWrongOwnerStopsBeforeKeyRegistrationOrCapture(t *testing.T) {
	f := &fake{root: t.TempDir(), wrongOwner: true}
	if snapshot(context.Background(), filepath.Join(t.TempDir(), "snapshot.dump"), f.run, "") == nil {
		t.Fatal("wrong owner passed")
	}
	if f.created != 0 || f.captures != 0 {
		t.Fatal("provider mutation occurred after owner mismatch")
	}
}

func TestUploadTreeAndOverwriteAreRejectedBeforeProviderAccess(t *testing.T) {
	root := t.TempDir()
	f := &fake{root: root}
	if snapshot(context.Background(), filepath.Join(root, "snapshot.dump"), f.run, "") == nil {
		t.Fatal("dump inside source passed")
	}
	out := filepath.Join(t.TempDir(), "snapshot.dump")
	if err := os.WriteFile(out, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	if snapshot(context.Background(), out, f.run, "") == nil {
		t.Fatal("overwrite passed")
	}
	b, _ := os.ReadFile(out)
	if string(b) != "original" || f.created != 0 || f.captures != 0 {
		t.Fatal("existing output changed or capture ran")
	}
}

func TestExistingManualIdentityIsNotRegisteredOrRevoked(t *testing.T) {
	f := &fake{root: t.TempDir()}
	if err := snapshot(context.Background(), filepath.Join(t.TempDir(), "snapshot.dump"), f.run, "existing-registered-identity"); err != nil {
		t.Fatal(err)
	}
	if f.created != 0 || f.revoked != 0 || f.captures != 1 {
		t.Fatal("existing identity was changed")
	}
}

func TestTransportRejectsMissingOrAmbiguousArchives(t *testing.T) {
	valid := base64.StdEncoding.EncodeToString([]byte("PGDMP-synthetic-complete-archive"))
	for _, input := range []string{"error diagnostics", base64.StdEncoding.EncodeToString([]byte("not an archive")), valid + "\n" + valid} {
		if _, err := decodeArchive([]byte(input)); err == nil {
			t.Fatal("invalid transport accepted")
		}
	}
}
