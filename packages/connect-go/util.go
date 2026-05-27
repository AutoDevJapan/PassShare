package connect

import "strings"

func normalizeBaseURL(host string) string {
	base := strings.TrimRight(host, "/")
	if strings.HasSuffix(base, "/v1") {
		return base
	}
	return base + "/v1"
}
