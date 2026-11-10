package main

import (
	"bytes"
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
	"time"
)

type fake struct {
	root                                             string
	failCapture, failDigest, failCleanup, wrongOwner bool
	lostCreateReply, emptyCreateID                   bool
	created, revoked, captures                       int
	readinessErrors                                  []error
	wrongReadinessReply                              bool
	probes                                           int
	sshCalls                                         [][]string
	captureError                                     error
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
			f.sshCalls = append(f.sshCalls, append([]string(nil), args...))
			if args[len(args)-1] == "printf 'passshare-private-snapshot-ssh-ready-v1\\n'" {
				f.probes++
				if f.probes <= len(f.readinessErrors) && f.readinessErrors[f.probes-1] != nil {
					return nil, f.readinessErrors[f.probes-1]
				}
				if f.wrongReadinessReply {
					return []byte("unexpected service reply"), nil
				}
				return []byte("passshare-private-snapshot-ssh-ready-v1\n"), nil
			}
			f.captures++
			if f.captureError != nil {
				return nil, f.captureError
			}
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

func TestReadinessPrecedesSingleArchiveUsingTheSameRegisteredIdentity(t *testing.T) {
	f := &fake{root: t.TempDir()}
	if err := snapshot(context.Background(), filepath.Join(t.TempDir(), "snapshot.dump"), f.run, ""); err != nil {
		t.Fatal(err)
	}
	if f.probes != 1 || f.captures != 1 || f.created != 1 || f.revoked != 1 || len(f.sshCalls) != 2 {
		t.Fatalf("readiness/capture/key lifecycle differs: %+v", f)
	}
	probe, capture := f.sshCalls[0], f.sshCalls[1]
	if strings.Join(probe[:len(probe)-1], "\x00") != strings.Join(capture[:len(capture)-1], "\x00") {
		t.Fatal("readiness and capture changed project, environment, service or identity")
	}
}

func TestReadinessConnectTimeoutRetriesBeforeOneArchive(t *testing.T) {
	f := &fake{root: t.TempDir(), readinessErrors: []error{&commandFailure{command: "railway", code: 255, class: "ssh-connect-timeout"}}}
	if err := snapshot(context.Background(), filepath.Join(t.TempDir(), "snapshot.dump"), f.run, ""); err != nil {
		t.Fatal(err)
	}
	if f.probes != 2 || f.captures != 1 || f.created != 1 || f.revoked != 1 {
		t.Fatalf("transport retry repeated the archive or identity mutation: %+v", f)
	}
}

func TestReadinessFailureNeverStartsArchiveAndStillRevokesItsKey(t *testing.T) {
	for _, class := range []string{"ssh-connect-timeout", "ssh-identity-rejected", "host-key-verification", "host-key-changed", "provider-access-denied", "unclassified", "invalid-ready-reply"} {
		t.Run(class, func(t *testing.T) {
			failure := &commandFailure{command: "railway", code: 255, class: class}
			f := &fake{root: t.TempDir(), readinessErrors: []error{failure, failure, failure}, wrongReadinessReply: class == "invalid-ready-reply"}
			if f.wrongReadinessReply {
				f.readinessErrors = nil
			}
			out := filepath.Join(t.TempDir(), "snapshot.dump")
			err := snapshot(context.Background(), out, f.run, "")
			wantProbes := 1
			if class == "ssh-connect-timeout" {
				wantProbes = 3
			}
			if err == nil || f.probes != wantProbes || f.captures != 0 || f.created != 1 || f.revoked != 1 {
				t.Fatalf("failed readiness was accepted or cleanup/retry bound differs: err=%v fake=%+v", err, f)
			}
			if _, statErr := os.Stat(out); !os.IsNotExist(statErr) {
				t.Fatal("failed readiness created an archive")
			}
		})
	}
}

func TestArchiveFailureIsNotRetriedAfterReadiness(t *testing.T) {
	f := &fake{root: t.TempDir(), captureError: &commandFailure{command: "railway", code: 255, class: "ssh-connect-timeout"}}
	if snapshot(context.Background(), filepath.Join(t.TempDir(), "snapshot.dump"), f.run, "") == nil || f.probes != 1 || f.captures != 1 || f.revoked != 1 {
		t.Fatalf("archive failure retried or skipped key cleanup: %+v", f)
	}
}

type writerFunc func([]byte) (int, error)

func (w writerFunc) Write(b []byte) (int, error) { return w(b) }

func TestCancelledReadinessBackoffDoesNotConnectAgain(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f := &fake{root: t.TempDir(), readinessErrors: []error{&commandFailure{command: "railway", code: 255, class: "ssh-connect-timeout"}}}
	var log bytes.Buffer
	w := writerFunc(func(b []byte) (int, error) {
		if bytes.Contains(b, []byte("Private SSH readiness failed")) {
			cancel()
		}
		return log.Write(b)
	})
	err := snapshotWithDiagnostics(ctx, filepath.Join(t.TempDir(), "snapshot.dump"), f.run, "", w)
	if err == nil || !strings.Contains(err.Error(), "cancelled during backoff") || f.probes != 1 || f.captures != 0 || f.revoked != 1 {
		t.Fatalf("cancelled backoff continued or leaked identity: err=%v probes=%d captures=%d revoked=%d", err, f.probes, f.captures, f.revoked)
	}
}

func TestReadinessHasOwnDeadlineAndNeverExtendsWholeRequest(t *testing.T) {
	for _, budget := range []time.Duration{time.Minute, 5 * time.Second} {
		t.Run(budget.String(), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), budget)
			defer cancel()
			parentDeadline, _ := ctx.Deadline()
			f := &fake{root: t.TempDir()}
			observed := false
			run := func(probeCtx context.Context, name string, args ...string) ([]byte, error) {
				if name == "railway" && args[0] == "ssh" {
					deadline, ok := probeCtx.Deadline()
					if !ok || deadline.After(parentDeadline) || time.Until(deadline) > 25*time.Second {
						t.Fatal("readiness lost its own limit or extended the whole request")
					}
					if budget > 25*time.Second && !deadline.Before(parentDeadline) {
						t.Fatal("readiness limit is not independently bounded")
					}
					observed = true
					cancel()
					return nil, probeCtx.Err()
				}
				if probeCtx.Err() != nil {
					t.Fatal("revocation used the cancelled whole-request context")
				}
				return f.run(probeCtx, name, args...)
			}
			if snapshot(ctx, filepath.Join(t.TempDir(), "snapshot.dump"), run, "") == nil || !observed || f.captures != 0 || f.revoked != 1 {
				t.Fatal("cancelled readiness accepted output, ran an archive, or skipped revocation")
			}
		})
	}
}

func TestReadinessDiagnosticsNeverCopyCommandErrorsOrReplies(t *testing.T) {
	f := &fake{root: t.TempDir(), readinessErrors: []error{errors.New("credential=private-diagnostic-value")}}
	var log bytes.Buffer
	err := snapshotWithDiagnostics(context.Background(), filepath.Join(t.TempDir(), "snapshot.dump"), f.run, "", &log)
	if err == nil || !strings.Contains(log.String(), "class=unclassified") || strings.Contains(log.String()+err.Error(), "private-diagnostic-value") || f.probes != 1 || f.captures != 0 || f.revoked != 1 {
		t.Fatal("readiness leaked diagnostics or accepted an unclassified failure")
	}
}

func TestReadinessFailurePreservesUnconfirmedRevocationDescriptor(t *testing.T) {
	f := &fake{root: t.TempDir(), failCleanup: true, readinessErrors: []error{&commandFailure{command: "railway", code: 255, class: "ssh-identity-rejected"}}}
	out := filepath.Join(t.TempDir(), "snapshot.dump")
	err := snapshot(context.Background(), out, f.run, "")
	info, readErr := os.ReadFile(out + ".ssh-key-recovery.json")
	if err == nil || readErr != nil || !strings.Contains(err.Error(), "temporary key recovery unconfirmed") || !strings.Contains(err.Error(), "ssh-identity-rejected") || !strings.Contains(string(info), `"key_id":"this-run-only-key"`) || f.probes != 1 || f.captures != 0 || f.revoked != 1 {
		t.Fatal("failed readiness hid unconfirmed revocation or lost its recovery scope")
	}
}

func TestCapturePhaseUsesOnlyFixedRemoteMarkers(t *testing.T) {
	for _, sample := range []struct{ input, want string }{
		{"connection timed out credential=private-value", "before-archive-marker"},
		{captureStartedMarker + "\npg_dump: private database failure", "archive-started"},
		{captureStartedMarker + "\n" + archiveValidatedMarker + "\ntransfer failed", "archive-validated"},
		{"not-a-marker " + archiveValidatedMarker, "before-archive-marker"},
	} {
		if got := capturePhase([]byte(sample.input)); got != sample.want || strings.Contains(got, "private") {
			t.Fatalf("phase=%s want=%s", got, sample.want)
		}
	}
}

func TestDeploymentBoundsOnlyVerifiedRailwayHostConnection(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", ".github", "workflows", "deploy-prd.yml"))
	if err != nil {
		t.Fatal(err)
	}
	text := strings.ReplaceAll(string(b), "\r\n", "\n")
	for _, expected := range []string{"Host ssh.railway.com\n", "StrictHostKeyChecking yes", "BatchMode yes", "IdentitiesOnly yes", "ConnectTimeout 15", "ConnectionAttempts 1"} {
		if !strings.Contains(text, expected) {
			t.Fatalf("production SSH connection scope/trust/limit missing: %s", expected)
		}
	}
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
		if name == "railway" && args[0] == "ssh" && strings.Contains(args[len(args)-1], captureStartedMarker) {
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

func TestDiagnosticsAreFixedLabelsAndDoNotExposePrivateStderr(t *testing.T) {
	for _, sample := range []struct{ input, want string }{
		{"Host key verification failed. private database contents", "host-key-verification"},
		{"WARNING REMOTE HOST IDENTIFICATION HAS CHANGED! secret connection", "host-key-changed"},
		{"Permission denied (publickey). token=value", "ssh-identity-rejected"},
		{"password and database rows", "unclassified"},
	} {
		if got := failureClass([]byte(sample.input)); got != sample.want {
			t.Fatalf("class=%s want=%s", got, sample.want)
		}
	}
}

func TestPinnedRailwayHostMatchesPreviouslyTrustedPublicKey(t *testing.T) {
	b, err := os.ReadFile("railway_known_hosts")
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Fields(string(b))
	if len(parts) != 3 || parts[0] != "ssh.railway.com" || parts[1] != "ssh-ed25519" {
		t.Fatal("host trust scope or algorithm changed")
	}
	key, err := base64.StdEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(key)
	if "SHA256:"+strings.TrimRight(base64.StdEncoding.EncodeToString(digest[:]), "=") != "SHA256:+S1xg92FrnHz6pY3bpkmh1OGtWQGNANXilPzlxA7B1g" {
		t.Fatal("trusted host key fingerprint changed")
	}
}

func TestScopeDiagnosticKeepsFixedClassWithoutPrivateError(t *testing.T) {
	for _, sample := range []struct {
		err  error
		want string
	}{
		{&commandFailure{command: "railway", code: 1, class: "provider-access-denied"}, "provider-access-denied"},
		{errors.New("credential=private-value"), "unclassified"},
	} {
		c := client{dir: t.TempDir(), run: func(context.Context, string, ...string) ([]byte, error) { return nil, sample.err }}
		err := c.query(context.Background(), "query{project{id}}", nil, &struct{}{})
		if err == nil || !strings.Contains(err.Error(), sample.want) || strings.Contains(err.Error(), "private-value") {
			t.Fatalf("unexpected fixed diagnostic: %v", err)
		}
	}
}

func TestGraphQLRejectionIsNeverSuccessAndNeverLogsDetails(t *testing.T) {
	for _, sample := range []struct{ body, want string }{
		{`{"errors":[{"message":"Not Authorized credential=private-value"}],"data":null}`, "provider-access-denied"},
		{`{"errors":[{"message":"private-value"}],"data":{"project":{"id":"expected"}}}`, "unclassified"},
	} {
		c := client{dir: t.TempDir(), run: func(_ context.Context, _ string, args ...string) ([]byte, error) {
			if args[len(args)-1] != "--allow-errors" {
				t.Fatal("CLI must return the GraphQL envelope for local rejection")
			}
			return []byte(sample.body), nil
		}}
		err := c.query(context.Background(), "query{project{id}}", nil, &struct{}{})
		if err == nil || !strings.Contains(err.Error(), sample.want) || strings.Contains(err.Error(), "private-value") {
			t.Fatalf("unsafe rejection: %v", err)
		}
	}
}
