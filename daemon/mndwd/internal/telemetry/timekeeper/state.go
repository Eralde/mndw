package timekeeper

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
)

const (
	stateMagic     = "MNDWCLOK"
	stateVersion   = uint16(1)
	stateFixedSize = 8 + 2 + 16 + 8 + 8 + 2
	stateCRCSize   = 4
	maxStateServer = 255
)

// ErrInvalidState indicates clock.state has an invalid encoding.
var ErrInvalidState = errors.New("timekeeper: invalid clock state")

// State records the accepted time offset for one boot.
type State struct {
	BootID          [16]byte
	OffsetMs        int64
	Server          string
	SyncStartBootMs int64
}

// EncodeState encodes state using the clock.state binary format.
func EncodeState(s State) ([]byte, error) {
	if len([]byte(s.Server)) > maxStateServer {
		return nil, fmt.Errorf("timekeeper: server name exceeds %d bytes", maxStateServer)
	}

	body := make([]byte, stateFixedSize+len([]byte(s.Server))+stateCRCSize)

	copy(body[:8], stateMagic)
	binary.LittleEndian.PutUint16(body[8:10], stateVersion)
	copy(body[10:26], s.BootID[:])
	binary.LittleEndian.PutUint64(body[26:34], uint64(s.OffsetMs))
	binary.LittleEndian.PutUint64(body[34:42], uint64(s.SyncStartBootMs))
	binary.LittleEndian.PutUint16(body[42:44], uint16(len([]byte(s.Server))))
	copy(body[44:44+len([]byte(s.Server))], s.Server)
	binary.LittleEndian.PutUint32(body[len(body)-stateCRCSize:], crc32.ChecksumIEEE(body[:len(body)-stateCRCSize]))

	return body, nil
}

// DecodeState decodes clock.state and rejects invalid framing or checksum.
func DecodeState(body []byte) (State, error) {
	if len(body) < stateFixedSize+stateCRCSize {
		return State{}, fmt.Errorf("%w: truncated body", ErrInvalidState)
	}

	if string(body[:8]) != stateMagic {
		return State{}, fmt.Errorf("%w: bad magic", ErrInvalidState)
	}

	if binary.LittleEndian.Uint16(body[8:10]) != stateVersion {
		return State{}, fmt.Errorf("%w: unsupported version", ErrInvalidState)
	}

	serverLen := int(binary.LittleEndian.Uint16(body[42:44]))

	if serverLen > maxStateServer || len(body) != stateFixedSize+serverLen+stateCRCSize {
		return State{}, fmt.Errorf("%w: invalid length", ErrInvalidState)
	}

	wantCRC := binary.LittleEndian.Uint32(body[len(body)-stateCRCSize:])

	if gotCRC := crc32.ChecksumIEEE(body[:len(body)-stateCRCSize]); gotCRC != wantCRC {
		return State{}, fmt.Errorf("%w: checksum mismatch", ErrInvalidState)
	}

	var state State

	copy(state.BootID[:], body[10:26])

	state.OffsetMs = int64(binary.LittleEndian.Uint64(body[26:34]))
	state.SyncStartBootMs = int64(binary.LittleEndian.Uint64(body[34:42]))
	state.Server = string(body[44 : 44+serverLen])

	return state, nil
}
