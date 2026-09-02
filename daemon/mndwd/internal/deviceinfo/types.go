package deviceinfo

type Switchport struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Index       int    `json:"index"`
	Type        string `json:"type"`
	Group       string `json:"group"`
	Color       string `json:"color"`
	InterfaceID string `json:"interfaceId"`
}

type Switchports struct {
	List         []Switchport `json:"list"`
	Layout       [][]string   `json:"layout"`
	HasPortStats bool         `json:"hasPortStats"`
}

// Snapshot is the device-hardware payload: the switchport inventory plus the raw
// USB port count. USB version is derived host-side from show.version features.
type Snapshot struct {
	Switchports  Switchports `json:"switchports"`
	USBPortCount int         `json:"usbPortCount"`
}

func emptySnapshot() Snapshot {
	return Snapshot{
		Switchports: Switchports{
			List:   []Switchport{},
			Layout: [][]string{},
		},
	}
}
