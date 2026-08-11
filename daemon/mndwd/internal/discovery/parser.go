// Package discovery parses the controller's mesh-member listing (the RCI
// "known host" / CID records) into Member values. It normalizes each member's
// MAC and derives a stable Identity (CID, else normalized MAC) so the RCI
// session subsystem can address extenders consistently.
package discovery

import (
	"encoding/json"
	"fmt"
	"strings"
)

type Member struct {
	CID      string         `json:"cid"`
	Model    string         `json:"model"`
	MAC      string         `json:"mac"`
	Name     string         `json:"known-host"`
	IP       string         `json:"ip"`
	FQDN     string         `json:"fqdn"`
	Firmware string         `json:"fw"`
	System   map[string]any `json:"system"`
	Backhaul map[string]any `json:"backhaul"`
	Online   bool           `json:"-"`
	LastPeer string         `json:"-"`
}

type statusReply struct {
	Status []struct {
		Status  string `json:"status"`
		Message string `json:"message"`
	} `json:"status"`
}

func ParseMembers(data []byte) ([]Member, error) {
	var members []Member
	if err := json.Unmarshal(data, &members); err == nil {
		seen := make(map[string]struct{}, len(members))
		for index := range members {
			members[index].MAC = NormalizeMAC(members[index].MAC)
			identity := members[index].Identity()
			if identity == "" {
				return nil, fmt.Errorf("controller member has no identity")
			}
			if _, exists := seen[identity]; exists {
				return nil, fmt.Errorf("controller member identity is ambiguous")
			}
			seen[identity] = struct{}{}
			members[index].Online = members[index].IP != ""
		}
		return members, nil
	}
	var status statusReply
	if err := json.Unmarshal(data, &status); err == nil && len(status.Status) > 0 {
		return nil, fmt.Errorf("controller discovery unsupported: %s", status.Status[0].Message)
	}
	return nil, fmt.Errorf("invalid controller member response")
}

func NormalizeMAC(value string) string {
	return strings.ToLower(strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(value), "-", ":"), ".", ":"))
}

func (m Member) Identity() string {
	if m.CID != "" {
		return m.CID
	}
	return NormalizeMAC(m.MAC)
}
