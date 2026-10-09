package connect

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"reflect"
	"testing"
	"time"
)

// This test is driven only by the Rust Core acceptance process. Credentials
// arrive in one bounded stdin fixture, never arguments, files or environment.
type formalPhase string

const (
	formalRoundtrip formalPhase = "roundtrip"
	formalDenied    formalPhase = "denied"
	formalInputMax              = 128 * 1024
)

type formalAuxiliary struct {
	Session     string          `json:"session"`
	BoxOwnerCtx OwnerKeyContext `json:"boxOwnerCtx"`
	Bundle      OwnerKeyBundle  `json:"bundle"`
}

type formalDenial struct {
	Status       uint32         `json:"status"`
	Code         string         `json:"code"`
	CallerBundle OwnerKeyBundle `json:"callerBundle"`
}

type formalFixture struct {
	Phase                  formalPhase      `json:"phase"`
	Host                   string           `json:"host"`
	Session                string           `json:"session"`
	BoxOwnerCtx            OwnerKeyContext  `json:"boxOwnerCtx"`
	Bundle1                OwnerKeyBundle   `json:"bundle1"`
	Bundle2                OwnerKeyBundle   `json:"bundle2"`
	SyntheticLoginPassword string           `json:"syntheticLoginPassword"`
	Context1               ItemContext      `json:"context1"`
	Context2               ItemContext      `json:"context2"`
	Envelope1              EncryptedItem    `json:"envelope1"`
	Envelope2              EncryptedItem    `json:"envelope2"`
	LiveContext            ItemContext      `json:"liveContext"`
	LiveEnvelope           EncryptedItem    `json:"liveEnvelope"`
	Auxiliary              *formalAuxiliary `json:"auxiliary"`
	Denial                 *formalDenial    `json:"denial"`
}

// Every returned value was observed over HTTP. No credentials, plaintext,
// error bodies or diagnostics are included in the result marker.
type formalResult struct {
	Items     []EncryptedItem  `json:"items"`
	OwnerKeys []OwnerKeyRecord `json:"ownerKeys"`
}

func formalOK(t *testing.T, step string, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(step + " failed (details suppressed)")
	}
}

func formalRequire(t *testing.T, step string, ok bool) {
	t.Helper()
	if !ok {
		t.Fatal(step + " mismatch (details suppressed)")
	}
}

func formalHTTP(t *testing.T, step string, err error, status int, code string) {
	t.Helper()
	var remote *EncryptedSessionError
	formalRequire(t, step, errors.As(err, &remote) && remote.HTTPStatus() == status && remote.Code() == code)
}

func formalEmpty(t *testing.T, ctx context.Context, c *EncryptedSessionClient, box string) {
	t.Helper()
	page, err := c.List(ctx, box, nil)
	formalOK(t, "empty list", err)
	formalRequire(t, "empty list", len(page.Items) == 0 && page.NextCursor == nil)
}

func TestEncryptedSessionFormal(t *testing.T) {
	if os.Getenv("PASSSHARE_GO_SESSION_FORMAL") != "1" {
		t.Skip("requires explicit Rust Core formal fixture")
	}
	defer func() {
		if recover() != nil {
			t.Fatal("formal session panic (details suppressed)")
		}
	}()
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, formalInputMax+1))
	formalOK(t, "fixture read", err)
	formalRequire(t, "fixture bound", len(raw) <= formalInputMax)
	var f formalFixture
	// Reuse the SDK's exact shape decoder: unknown/duplicate fields, trailing
	// JSON, absent fields and unsafe integers are rejected before any HTTP.
	err = encryptedDecode(raw, &f)
	for i := range raw {
		raw[i] = 0
	}
	formalOK(t, "fixture decode", err)
	formalRequire(t, "fixture phase", f.Phase == formalRoundtrip || f.Phase == formalDenied)
	box := f.BoxOwnerCtx.PasswordBoxID
	formalRequire(t, "owner binding", f.BoxOwnerCtx.valid(box) && f.BoxOwnerCtx.KeyEpoch == 1 &&
		f.Bundle1.Wrapped.Context == f.BoxOwnerCtx && f.Bundle2.Wrapped.Context == f.BoxOwnerCtx)
	formalOK(t, "first bundle", f.Bundle1.Validate())
	formalOK(t, "second bundle", f.Bundle2.Validate())
	formalRequire(t, "revision binding", f.Context1.PasswordBoxID == box &&
		f.Context1.ItemVersion == 1 && f.Context1.KeyEpoch == 1 &&
		f.Context2 == (ItemContext{box, f.Context1.ItemID, 2, 1}) &&
		f.LiveContext.PasswordBoxID == box && f.LiveContext.ItemID != f.Context1.ItemID &&
		f.LiveContext.ItemVersion == 1 && f.LiveContext.KeyEpoch == 1)
	formalOK(t, "first independent context", f.Envelope1.ValidateContext(f.Context1))
	formalOK(t, "second independent context", f.Envelope2.ValidateContext(f.Context2))
	formalOK(t, "live independent context", f.LiveEnvelope.ValidateContext(f.LiveContext))
	c, err := NewEncryptedSessionClient(f.Host, f.Session)
	formalOK(t, "session client", err)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	result := formalResult{Items: []EncryptedItem{}, OwnerKeys: []OwnerKeyRecord{}}
	if f.Phase == formalDenied {
		formalRequire(t, "denial fixture", f.Auxiliary == nil && f.Denial != nil &&
			(f.Denial.Status == 403 && f.Denial.Code == "PS016" || f.Denial.Status == 401 && f.Denial.Code == "PS024"))
		formalOK(t, "denied caller bundle", f.Denial.CallerBundle.Validate())
		formalRequire(t, "denied caller binding", f.Denial.CallerBundle.Wrapped.Context.PasswordBoxID == box && f.Denial.CallerBundle.Wrapped.Context.KeyEpoch == 1)
		formalDeniedCalls(t, ctx, c, &f)
	} else {
		formalRequire(t, "roundtrip fixture", f.Denial == nil && f.Auxiliary != nil && f.SyntheticLoginPassword != "")
		result = formalRoundtripCalls(t, ctx, c, &f)
	}
	encoded, err := json.Marshal(result)
	formalOK(t, "public result encode", err)
	_, err = fmt.Fprintf(os.Stdout, "PASSSHARE_GO_RESULT=%s\n", encoded)
	formalOK(t, "public result write", err)
}

func formalRoundtripCalls(t *testing.T, ctx context.Context, c *EncryptedSessionClient, f *formalFixture) formalResult {
	t.Helper()
	box, id := f.BoxOwnerCtx.PasswordBoxID, f.Context1.ItemID
	state, err := c.State(ctx, box)
	formalOK(t, "compatibility state", err)
	formalRequire(t, "compatibility state", state.Mode == "compatibility" && state.KeyEpoch == nil)
	for i := 0; i < 2; i++ {
		setup, err := c.SetupEmptyBox(ctx, box, f.Bundle1)
		formalOK(t, "setup exact replay", err)
		formalRequire(t, "setup result", setup == (SetupResult{"encrypted", 1, 1, f.Bundle1}))
	}
	state, err = c.State(ctx, box)
	formalOK(t, "encrypted state", err)
	formalRequire(t, "encrypted state", state.Mode == "encrypted" && state.KeyEpoch != nil && *state.KeyEpoch == 1)
	owner1, err := c.GetOwnerKey(ctx, box, f.BoxOwnerCtx)
	formalOK(t, "first owner fetch", err)
	formalRequire(t, "first owner fetch", owner1 == (OwnerKeyRecord{1, f.Bundle1}))
	formalEmpty(t, ctx, c, box)
	put1, err := c.PutItem(ctx, box, id, 0, f.Envelope1)
	formalOK(t, "first item put", err)
	formalRequire(t, "first item put", put1 == f.Envelope1)
	got1, err := c.GetItem(ctx, box, id)
	formalOK(t, "first item get", err)
	formalOK(t, "first observed independent context", got1.ValidateContext(f.Context1))
	formalRequire(t, "first item get", got1 == f.Envelope1)
	page, err := c.List(ctx, box, nil)
	formalOK(t, "exact first list", err)
	formalRequire(t, "exact first list", reflect.DeepEqual(page.Items, []ItemSummary{{id, 1, 1}}) && page.NextCursor == nil)
	for i := 0; i < 2; i++ {
		put2, err := c.PutItem(ctx, box, id, 1, f.Envelope2)
		formalOK(t, "second item exact replay", err)
		formalRequire(t, "second item put", put2 == f.Envelope2)
	}
	_, err = c.PutItem(ctx, box, id, 0, f.Envelope1)
	formalHTTP(t, "stale item put", err, 409, "PS015")
	got2, err := c.GetItem(ctx, box, id)
	formalOK(t, "second item get", err)
	formalOK(t, "second observed independent context", got2.ValidateContext(f.Context2))
	formalRequire(t, "second item get", got2 == f.Envelope2)
	wrongPassword := f.SyntheticLoginPassword + "-wrong"
	_, err = c.PutOwnerKey(ctx, box, 1, f.Bundle2, &wrongPassword)
	formalHTTP(t, "owner replacement reauthentication", err, 401, "PS026")
	unchanged, err := c.GetOwnerKey(ctx, box, f.BoxOwnerCtx)
	formalOK(t, "owner after denied replacement", err)
	formalRequire(t, "owner after denied replacement", unchanged == owner1)
	owner2, err := c.PutOwnerKey(ctx, box, 1, f.Bundle2, &f.SyntheticLoginPassword)
	formalOK(t, "owner replacement", err)
	formalRequire(t, "owner replacement", owner2 == (OwnerKeyRecord{2, f.Bundle2}))
	owner2, err = c.GetOwnerKey(ctx, box, f.BoxOwnerCtx)
	formalOK(t, "second owner fetch", err)
	formalRequire(t, "second owner fetch", owner2 == (OwnerKeyRecord{2, f.Bundle2}))
	for i := 0; i < 2; i++ {
		formalOK(t, "delete exact replay", c.DeleteItem(ctx, box, id, 2, 1))
	}
	_, err = c.GetItem(ctx, box, id)
	// The actual encrypted GET contract is PS012, not the legacy PS002.
	formalHTTP(t, "deleted item get", err, 404, "PS012")
	formalEmpty(t, ctx, c, box)
	_, err = c.PutItem(ctx, box, id, 1, f.Envelope2)
	formalHTTP(t, "deleted identifier reservation", err, 409, "PS015")
	// A distinct live row lets the parent prove denial/revocation preservation.
	_, err = c.PutItem(ctx, box, f.LiveContext.ItemID, 0, f.LiveEnvelope)
	formalOK(t, "live preservation item put", err)
	live, err := c.GetItem(ctx, box, f.LiveContext.ItemID)
	formalOK(t, "live preservation item get", err)
	formalOK(t, "live observed independent context", live.ValidateContext(f.LiveContext))
	formalRequire(t, "live preservation item get", live == f.LiveEnvelope)
	aux := f.Auxiliary
	auxBox := aux.BoxOwnerCtx.PasswordBoxID
	formalRequire(t, "auxiliary binding", auxBox != box && aux.Bundle.Wrapped.Context == aux.BoxOwnerCtx)
	auxClient, err := NewEncryptedSessionClient(f.Host, aux.Session)
	formalOK(t, "auxiliary client", err)
	auxState, err := auxClient.State(ctx, auxBox)
	formalOK(t, "auxiliary compatibility state", err)
	formalRequire(t, "auxiliary compatibility state", auxState.Mode == "compatibility" && auxState.KeyEpoch == nil)
	epoch, err := auxClient.EnableEmptyBox(ctx, auxBox)
	formalOK(t, "auxiliary enable", err)
	formalRequire(t, "auxiliary enable", epoch == 1)
	auxOwner, err := auxClient.PutOwnerKey(ctx, auxBox, 0, aux.Bundle, nil)
	formalOK(t, "initial owner put", err)
	formalRequire(t, "initial owner put", auxOwner == (OwnerKeyRecord{1, aux.Bundle}))
	auxOwner, err = auxClient.GetOwnerKey(ctx, auxBox, aux.BoxOwnerCtx)
	formalOK(t, "initial owner get", err)
	formalRequire(t, "initial owner get", auxOwner == (OwnerKeyRecord{1, aux.Bundle}))
	formalEmpty(t, ctx, auxClient, auxBox)
	return formalResult{[]EncryptedItem{got1, got2, live}, []OwnerKeyRecord{owner1, owner2, auxOwner}}
}

func formalDeniedCalls(t *testing.T, ctx context.Context, c *EncryptedSessionClient, f *formalFixture) {
	t.Helper()
	box, id := f.BoxOwnerCtx.PasswordBoxID, f.LiveContext.ItemID
	check := func(step string, err error) { formalHTTP(t, step, err, int(f.Denial.Status), f.Denial.Code) }
	_, err := c.State(ctx, box)
	check("denied state", err)
	_, err = c.EnableEmptyBox(ctx, box)
	check("denied enable", err)
	_, err = c.SetupEmptyBox(ctx, box, f.Denial.CallerBundle)
	check("denied setup", err)
	_, err = c.List(ctx, box, nil)
	check("denied list", err)
	_, err = c.GetItem(ctx, box, id)
	check("denied get", err)
	_, err = c.PutItem(ctx, box, id, 0, f.LiveEnvelope)
	check("denied put", err)
	check("denied delete", c.DeleteItem(ctx, box, id, 1, 1))
	_, err = c.GetOwnerKey(ctx, box, f.BoxOwnerCtx)
	check("denied owner get", err)
	// Initial creation avoids reauthentication masking the scope denial.
	_, err = c.PutOwnerKey(ctx, box, 0, f.Denial.CallerBundle, nil)
	check("denied owner put", err)
}
