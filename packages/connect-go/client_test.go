package connect

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestNormalizeBaseURL(t *testing.T) {
	if got := normalizeBaseURL("https://example.com"); got != "https://example.com/v1" {
		t.Fatalf("expected /v1 suffix, got %s", got)
	}
}

func TestIdentifiersRemainSinglePathSegments(t *testing.T) {
	for _, id := range []string{"box/child", "box?filter=other", "box#fragment", "box%2Fchild"} {
		t.Run(id, func(t *testing.T) {
			var got string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				got = r.RequestURI
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{}`))
			}))
			defer server.Close()
			client := New(server.URL, "test-token")
			calls := []struct {
				run  func() error
				want string
			}{
				{func() error { _, e := client.GetVault(id); return e }, "/v1/vaults/" + url.PathEscape(id)},
				{func() error { _, e := client.GetItem(id, id); return e }, "/v1/vaults/" + url.PathEscape(id) + "/items/" + url.PathEscape(id)},
				{func() error { return client.DeleteItem(id, id) }, "/v1/vaults/" + url.PathEscape(id) + "/items/" + url.PathEscape(id)},
			}
			for _, call := range calls {
				if err := call.run(); err != nil {
					t.Fatal(err)
				}
				if got != call.want {
					t.Errorf("request URI = %q, want %q", got, call.want)
				}
			}
		})
	}
}
