// Command prd-snapshot reads the existing production database over Railway SSH.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	projectID     = "82730a82-b4d4-47d0-b578-f951465465fc"
	environmentID = "c1a3cdfc-9aa3-420d-b101-e6497714ccb9"
	databaseID    = "4fdfda2d-ed50-4396-9797-25ea7720f720"
	workspaceID   = "3d4f692a-5353-4211-a82b-5b1f40a402b8"
	maxOutput     = 96 << 20
)

type runner func(context.Context, string, ...string) ([]byte, error)

// capBuffer prevents command output from consuming unbounded runner memory.
type capBuffer struct{ bytes.Buffer }

func (b *capBuffer) Write(p []byte) (int, error) {
	if len(p) > maxOutput-b.Len() {
		return 0, errors.New("command output exceeds snapshot transport limit")
	}
	return b.Buffer.Write(p)
}

func execute(ctx context.Context, name string, args ...string) ([]byte, error) {
	name = nativeCommand(name)
	cmd := exec.CommandContext(ctx, name, args...)
	hideWindow(cmd)
	cmd.WaitDelay = 3 * time.Second
	var stdout capBuffer
	var stderr capBuffer
	// Child stderr may include database diagnostics. Never copy it to CI logs.
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		code := -1
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		}
		class := failureClass(stderr.Bytes())
		if ctx.Err() != nil {
			class = "cancelled-or-deadline"
		}
		return nil, fmt.Errorf("%s command failed (exit=%d, class=%s)", filepath.Base(name), code, class)
	}
	return stdout.Bytes(), nil
}

// Return fixed diagnostic labels only, never command arguments or stderr.
func failureClass(stderr []byte) string {
	text := strings.ToLower(string(stderr))
	for _, entry := range []struct{ needle, class string }{
		{"host key verification failed", "host-key-verification"},
		{"remote host identification has changed", "host-key-changed"},
		{"permission denied (publickey)", "ssh-identity-rejected"},
		{"could not resolve hostname", "ssh-name-resolution"},
		{"connection timed out", "ssh-connect-timeout"},
		{"unauthorized", "provider-auth-rejected"},
	} {
		if strings.Contains(text, entry.needle) {
			return entry.class
		}
	}
	return "unclassified"
}

type client struct {
	run runner
	dir string
}

func (c client) query(ctx context.Context, query string, variables any, reply any) error {
	q, v := filepath.Join(c.dir, "query.graphql"), filepath.Join(c.dir, "variables.json")
	b, err := json.Marshal(variables)
	if err != nil {
		return errors.New("invalid query parameters")
	}
	if err = os.WriteFile(q, []byte(query), 0600); err != nil {
		return err
	}
	if err = os.WriteFile(v, b, 0600); err != nil {
		return err
	}
	out, err := c.run(ctx, "railway", "api", "--file", q, "--variables", "@"+v, "--compact")
	if err != nil {
		return errors.New("private snapshot provider request failed")
	}
	var envelope struct {
		Errors []json.RawMessage `json:"errors"`
		Data   json.RawMessage   `json:"data"`
	}
	if json.Unmarshal(out, &envelope) != nil || len(envelope.Errors) != 0 || len(envelope.Data) == 0 || string(envelope.Data) == "null" {
		return errors.New("private snapshot provider reply is invalid")
	}
	if err = json.Unmarshal(envelope.Data, reply); err != nil {
		return errors.New("private snapshot provider data is invalid")
	}
	return nil
}

func decodeArchive(output []byte) ([]byte, error) {
	var found []byte
	var sourceDigest string
	for _, line := range bytes.Split(output, []byte{'\n'}) {
		line = bytes.TrimSpace(line)
		parts := bytes.Fields(line)
		if len(parts) == 2 && len(parts[0]) == 64 && bytes.HasPrefix(parts[1], []byte("/tmp/passshare-prd-dump.")) {
			if _, err := hex.DecodeString(string(parts[0])); err == nil {
				if sourceDigest != "" {
					return nil, errors.New("snapshot returned multiple source digests")
				}
				sourceDigest = strings.ToLower(string(parts[0]))
				continue
			}
		}
		if len(line) < 12 {
			continue
		}
		decoded := make([]byte, base64.StdEncoding.DecodedLen(len(line)))
		n, err := base64.StdEncoding.Decode(decoded, line)
		if err != nil || n < 6 || !bytes.HasPrefix(decoded[:n], []byte("PGDMP")) {
			continue
		}
		if found != nil {
			return nil, errors.New("snapshot transport returned multiple archives")
		}
		found = decoded[:n]
	}
	if found == nil {
		return nil, errors.New("snapshot transport returned no valid archive")
	}
	digest := sha256.Sum256(found)
	if sourceDigest == "" || hex.EncodeToString(digest[:]) != sourceDigest {
		return nil, errors.New("snapshot bytes differ from the source archive digest")
	}
	return found, nil
}

func snapshot(ctx context.Context, output string, run runner, existingIdentity string) (returnErr error) {
	// Refuse any destination underneath the checkout, including an absent file.
	root, err := run(ctx, "git", "rev-parse", "--show-toplevel")
	if err != nil {
		return err
	}
	rootPath, err := filepath.EvalSymlinks(strings.TrimSpace(string(root)))
	if err != nil {
		return errors.New("cannot resolve source checkout")
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(output))
	if err != nil {
		return errors.New("snapshot directory must already exist")
	}
	rel, err := filepath.Rel(rootPath, parent)
	sameVolume := strings.EqualFold(filepath.VolumeName(rootPath), filepath.VolumeName(parent))
	if (err != nil && sameVolume) || (sameVolume && (rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))))) {
		return errors.New("snapshot must be outside the source upload tree")
	}
	if _, err = os.Lstat(output); !os.IsNotExist(err) {
		return errors.New("snapshot output must not already exist")
	}
	dir, err := os.MkdirTemp(parent, "passshare-prd-ssh-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	c := client{run: run, dir: dir}
	var scope struct {
		Project struct {
			ID          string `json:"id"`
			WorkspaceID string `json:"workspaceId"`
		} `json:"project"`
	}
	if err = c.query(ctx, `query($id:String!){project(id:$id){id workspaceId}}`, map[string]string{"id": projectID}, &scope); err != nil {
		return errors.New("production project scope verification failed")
	}
	if scope.Project.ID != projectID || scope.Project.WorkspaceID != workspaceID {
		return errors.New("production project owner differs from the reconciled workspace")
	}
	identity := existingIdentity
	keyID := ""
	if identity == "" {
		identity = filepath.Join(dir, "identity")
		name := "PassShare-prd-snapshot-" + filepath.Base(dir)
		if _, err = run(ctx, "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", name, "-f", identity); err != nil {
			return errors.New("temporary snapshot identity could not be generated")
		}
		pub, err := os.ReadFile(identity + ".pub")
		if err != nil {
			return errors.New("temporary public identity is absent")
		}
		pubDigest := sha256.Sum256(bytes.TrimSpace(pub))
		recovery := struct {
			Workspace    string `json:"workspace_id"`
			Name         string `json:"registration_name"`
			PublicDigest string `json:"public_key_sha256"`
			KeyID        string `json:"key_id,omitempty"`
		}{Workspace: workspaceID, Name: name, PublicDigest: hex.EncodeToString(pubDigest[:])}
		recoveryPath := output + ".ssh-key-recovery.json"
		info, _ := json.Marshal(recovery)
		journal, err := os.OpenFile(recoveryPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return errors.New("cannot create exclusive non-secret key recovery record")
		}
		_, journalErr := journal.Write(info)
		closeErr := journal.Close()
		if journalErr != nil || closeErr != nil {
			return errors.New("cannot persist key recovery record before registration")
		}
		// Register the failure handler before the mutation: a lost reply does not
		// mean registration failed. Never guess an ID or delete unrelated keys.
		defer func() {
			recovery.KeyID = keyID
			info, _ := json.Marshal(recovery)
			if keyID != "" {
				cleanupCtx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
				defer cancel()
				var deleted struct {
					Deleted bool `json:"sshPublicKeyDelete"`
				}
				cleanupErr := c.query(cleanupCtx, `mutation($id:String!){sshPublicKeyDelete(id:$id)}`, map[string]string{"id": keyID}, &deleted)
				if cleanupErr == nil && deleted.Deleted {
					if err := os.Remove(recoveryPath); err != nil {
						returnErr = errors.New("revoked key recovery record could not be removed")
					}
					return
				}
			}
			// This descriptor contains no credential or DB data. Retain it on disk
			// and in the failure log, including when an ephemeral CI runner is lost.
			persistErr := os.WriteFile(recoveryPath, info, 0600)
			returnErr = fmt.Errorf("temporary key recovery unconfirmed; descriptor=%s; previous failure=%v", info, returnErr)
			if persistErr != nil {
				returnErr = fmt.Errorf("%w; descriptor persistence failed", returnErr)
			}
		}()
		var created struct {
			Key struct {
				ID string `json:"id"`
			} `json:"sshPublicKeyCreate"`
		}
		if err = c.query(ctx, `mutation($input:SshPublicKeyCreateInput!){sshPublicKeyCreate(input:$input){id}}`, map[string]any{"input": map[string]string{"workspaceId": workspaceID, "name": name, "publicKey": strings.TrimSpace(string(pub))}}, &created); err != nil {
			return errors.New("temporary key registration reply failed")
		}
		keyID = created.Key.ID
		if keyID == "" {
			return errors.New("temporary snapshot key creation returned no identifier")
		}
		recovery.KeyID = keyID
		info, _ = json.Marshal(recovery)
		if err := os.WriteFile(recoveryPath, info, 0600); err != nil {
			return errors.New("cannot persist registered key identifier before capture")
		}
	}
	// Credentials are consumed inside the database's container only. No public
	// proxy, DB variables API, new service, or retained backup is provisioned.
	remote := `set -eu; umask 077; dump=$(mktemp /tmp/passshare-prd-dump.XXXXXX); trap 'rm -f -- "$dump"' EXIT; trap 'exit 1' HUP INT TERM; export PGPASSWORD="$POSTGRES_PASSWORD"; pg_dump -Fc --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB" --file "$dump"; pg_restore --list "$dump" >/dev/null; sha256sum "$dump"; base64 -w 0 "$dump"; printf '\n'; rm -f -- "$dump"; test ! -e "$dump"; trap - EXIT HUP INT TERM`
	data, err := run(ctx, "railway", "ssh", "--project", projectID, "--environment", environmentID, "--service", databaseID, "--identity-file", identity, "--", "sh", "-lc", remote)
	if err != nil {
		return fmt.Errorf("private production archive capture failed: %w", err)
	}
	archive, err := decodeArchive(data)
	if err != nil {
		return err
	}
	defer clear(archive)
	f, err := os.OpenFile(output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return errors.New("snapshot file cannot be created without overwrite")
	}
	_, writeErr := f.Write(archive)
	closeErr := f.Close()
	if writeErr != nil || closeErr != nil {
		return errors.New("snapshot file could not be written completely")
	}
	return nil
}

func terminationContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}

func main() {
	output := flag.String("output", "", "existing private temporary directory, outside the upload tree")
	identity := flag.String("identity-file", "", "existing registered identity for manual OAuth use; never copied")
	flag.Parse()
	if *output == "" || flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "--output is required")
		os.Exit(2)
	}
	requestCtx, stop := terminationContext()
	defer stop()
	ctx, cancel := context.WithTimeout(requestCtx, 4*time.Minute)
	defer cancel()
	if err := snapshot(ctx, *output, execute, *identity); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println("Private production archive validated; temporary identity cleanup succeeded.")
}
