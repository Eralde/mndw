package discovery

import mwsmembers "mndw.local/mws-members"

type Member = mwsmembers.Member

func ParseMembers(data []byte) ([]Member, error) {
	return mwsmembers.ParseMembers(data)
}

func NormalizeMAC(value string) string {
	return mwsmembers.NormalizeMAC(value)
}
