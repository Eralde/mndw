# Journal format v1 (`MNDWJNL1`)

Frozen encoding for retained telemetry journals. Every integer is
little-endian. Every checksum is CRC32C (Castagnoli polynomial, reflected
table as implemented by Go's `hash/crc32` with `crc32.Castagnoli`). There is no
alternative framing: a file that does not match this document byte for byte is
either unsupported or corrupt, and is never reinterpreted by scanning for
candidate record boundaries.

## File header (56 bytes)

| Offset | Size | Field | Notes |
| --- | --- | --- | --- |
| 0 | 8 | magic | ASCII `MNDWJNL1` |
| 8 | 2 | version | `1` |
| 10 | 2 | headerBytes | `56`, including the checksum |
| 12 | 16 | bootID | boot owning this segment |
| 28 | 8 | segmentID | monotonic segment identity within the boot |
| 36 | 8 | bootOrder | allocated sequence of this boot's `BootStart` record |
| 44 | 8 | firstSequence | first sequence allocated in this segment (`0` when empty) |
| 52 | 4 | headerCRC32C | CRC32C of bytes 0..51 |

## Record framing

```text
uint32 bodyBytes   // 10..65536, counts kind + sequence + kindData
uint16 kind        // 1 sample, 2 anchor, 3 clock transition, 4 publication, 5 loss, 6 boot start
uint64 sequence    // positive; assigned by the store, never zero on disk
byte   kindData[bodyBytes-10]
uint32 crc32c      // over the 4 bodyBytes bytes followed by the body
```

`bodyBytes` is validated before any allocation. `sequence` belongs to the
common body and is never duplicated inside `kindData`. Kind IDs are
`sample=1`, `anchor=2`, `clockTransition=3`, `publication=4`, `loss=5`,
`bootStart=6`. Clock-transition state IDs are `unanchored=1`, `anchored=2`,
`suspect=3`. Loss reasons are `age=1`, `budget=2`, `sessionLimit=3`,
`corruption=4`, `queueOverflow=5`.

Bounded strings are `uint16` byte length followed by UTF-8 bytes: evidence IDs
are at most 256 bytes, evidence sources at most 128 bytes. Optional fields use
a presence byte that must be `0` or `1`. Samples carry at most 16 values.

## kindData layouts

### 1 sample

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 16 | bootID |
| 16 | 8 | clockSegment |
| 24 | 2 | series (`1` load, `2` temperature) |
| 26 | 8 | elapsedMs |
| 34 | 2 | valueCount |
| 36 | 9·n | `uint8 known` + `float64` bits per value |

An unknown value encodes `known=0` and eight zero bytes. A known value must be
finite; `NaN` and infinities are rejected at preparation time.

### 2 anchor

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 16 | bootID |
| 16 | 8 | clockSegment |
| 24 | 8 | elapsedMs |
| 32 | 8 | utcMs |
| 40 | 8 | uncertaintyMs |
| 48 | 2+len | evidenceID (<= 256 bytes) |
|  | 2+len | evidenceSource (<= 128 bytes) |

### 3 clock transition

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 16 | bootID |
| 16 | 8 | clockSegment |
| 24 | 1 | state |
| 25 | 1 | suspectPresent (`0` or `1`) |
| 26 | 8 | suspectElapsedMs (only when suspectPresent=1) |
|  | 2+len | consumedEvidenceID (<= 256 bytes) |

### 4 publication

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 8 | sampleThrough |
| 8 | 8 | anchorThrough |
| 16 | 8 | cutoffElapsedMs |
| 24 | 2 | frontierCount |
| 26 | 10·n | `uint16 series` + `int64 slotMs` per frontier |

### 5 loss

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 1 | reason |
| 1 | 8 | count |
| 9 | 1 | allocatedPresent (`0` or `1`) |
| 10 | 16 | `uint64 first` + `uint64 last` (only when allocatedPresent=1) |

### 6 boot start

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 16 | bootID |
| 16 | 8 | firstAcquireElapsedMs |

## Golden fixtures

`testdata/golden/*.hex` contain one complete record per file, lowercase
hexadecimal, no whitespace: framing, body, and checksum exactly as defined
above. They are the freeze point: any change to a layout requires regenerating
these files and reviewing the diff.
