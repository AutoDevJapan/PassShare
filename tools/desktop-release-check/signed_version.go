package main

import "strings"

// Parse only the comment returned after minisign verifies the payload and its
// global comment signature. Candidate generation is stricter than legacy
// clients: exactly one canonical version is required, never a filename guess.
func updaterCheckForVersion(path, key, version string) (asset, error) {
	if !versionPattern.MatchString(version) {
		return asset{}, fail("invalid expected signed application version")
	}
	a, err := updaterCheck(path, key)
	if err != nil {
		return asset{}, err
	}
	count, signed := 0, ""
	for _, field := range strings.Split(a.verifiedComment, "\t") {
		if value, ok := strings.CutPrefix(field, "version:"); ok {
			count++
			signed = value
		}
	}
	if count != 1 || signed != version {
		return asset{}, fail("authenticated signature version missing or different from candidate")
	}
	a.verifiedVersion = signed
	return a, nil
}
