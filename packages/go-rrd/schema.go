package rrd

import (
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	ErrFileMissing = errors.New("rrd: active file missing")
	ErrChronology  = errors.New("rrd: update timestamp is not strictly chronological")
)

type Value struct {
	Known bool
	V     float64
}

var Unknown = Value{}

func Known(value float64) Value {
	if value != value || value > 1.7976931348623157e+308 || value < -1.7976931348623157e+308 {
		panic("rrd: Known requires finite value")
	}

	return Value{Known: true, V: value}
}

type CreateSpec struct {
	Step time.Duration
	DS   []DSSpec
	RRA  []RRASpec
}

type DSSpec struct {
	Name      string
	Type      string
	Heartbeat time.Duration
	Min       *float64
	Max       *float64
}

type RRASpec struct {
	CF    string
	XFF   float64
	Steps int
	Rows  int
}

type Tier struct {
	Every time.Duration
	Keep  time.Duration
}

type UpdatePoint struct {
	Timestamp time.Time
	Values    []Value
}

// FileOps is the injectable filesystem surface used by Ensure. It exists so a
// caller can own scratch allocation, install, rename, and directory sync while
// this package owns RRDtool arguments and schema validation only.
type FileOps interface {
	MkdirAll(string, os.FileMode) error
	Stat(string) (os.FileInfo, error)
	CreateTemp(string, string) (string, error)
	Link(string, string) error
	Rename(string, string) error
	Remove(string) error
}

// OSFileOps is the default FileOps implementation, backed by the os package.
type OSFileOps struct{}

// MkdirAll creates directories.
func (OSFileOps) MkdirAll(path string, perm os.FileMode) error { return os.MkdirAll(path, perm) }

// Stat stats a path.
func (OSFileOps) Stat(path string) (os.FileInfo, error) { return os.Stat(path) }

// CreateTemp creates a temporary file and returns its name.
func (OSFileOps) CreateTemp(dir, pattern string) (string, error) {
	file, err := os.CreateTemp(dir, pattern)
	if err != nil {
		return "", err
	}
	name := file.Name()
	if err := file.Close(); err != nil {
		return "", err
	}
	return name, nil
}

// Link creates a hard link.
func (OSFileOps) Link(oldPath, newPath string) error { return os.Link(oldPath, newPath) }

// Rename renames a path.
func (OSFileOps) Rename(oldPath, newPath string) error { return os.Rename(oldPath, newPath) }

// Remove removes a path.
func (OSFileOps) Remove(path string) error { return os.Remove(path) }

// FileOption customizes a File.
type FileOption func(*File)

// WithFileOps injects the filesystem operations used by Ensure. The default is
// OSFileOps, so existing callers behave exactly as before.
func WithFileOps(ops FileOps) FileOption {
	return func(file *File) {
		if ops != nil {
			file.ops = ops
		}
	}
}

type File struct {
	executor Executor
	path     string
	spec     CreateSpec
	lock     *sync.Mutex
	ops      FileOps
}

var fileLocks sync.Map

func NewFile(executor Executor, activePath string, spec CreateSpec, opts ...FileOption) (*File, error) {
	if executor == nil {
		return nil, errors.New("rrd: nil executor")
	}

	path, err := filepath.Abs(filepath.Clean(activePath))
	if err != nil {
		return nil, fmt.Errorf("rrd: resolve active path: %w", err)
	}

	lockValue, _ := fileLocks.LoadOrStore(path, &sync.Mutex{})

	file := &File{executor: executor, path: path, spec: spec, lock: lockValue.(*sync.Mutex), ops: OSFileOps{}}
	for _, opt := range opts {
		opt(file)
	}

	return file, nil
}

func (f *File) Ensure(ctx context.Context, enableTime time.Time) error {
	f.lock.Lock()

	defer f.lock.Unlock()

	if err := validateSpec(f.spec); err != nil {
		return err
	}

	info, err := f.ops.Stat(f.path)
	if err == nil {
		if !info.Mode().IsRegular() {
			return fmt.Errorf("rrd: active path is not a regular file: %s", f.path)
		}

		return f.validateInfoLocked(ctx, f.path)
	}

	if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("rrd: stat active file: %w", err)
	}

	if err := f.ops.MkdirAll(filepath.Dir(f.path), 0o755); err != nil {
		return fmt.Errorf("rrd: create parent directory: %w", err)
	}

	tempPath, err := f.ops.CreateTemp(filepath.Dir(f.path), "."+filepath.Base(f.path)+".tmp-")
	if err != nil {
		return fmt.Errorf("rrd: create temporary file: %w", err)
	}

	defer func() { _ = f.ops.Remove(tempPath) }()

	stepSeconds := int64(f.spec.Step / time.Second)
	start := (enableTime.Unix()/stepSeconds)*stepSeconds - stepSeconds
	args := []string{"create", tempPath, "--start", strconv.FormatInt(start, 10), "--step", strconv.FormatInt(stepSeconds, 10)}

	for _, ds := range f.spec.DS {
		minimum, maximum := "U", "U"

		if ds.Min != nil {
			minimum = strconv.FormatFloat(*ds.Min, 'g', -1, 64)
		}

		if ds.Max != nil {
			maximum = strconv.FormatFloat(*ds.Max, 'g', -1, 64)
		}

		args = append(args, fmt.Sprintf("DS:%s:%s:%d:%s:%s", ds.Name, ds.Type, int64(ds.Heartbeat/time.Second), minimum, maximum))
	}

	for _, rra := range f.spec.RRA {
		args = append(args, fmt.Sprintf("RRA:%s:%.12g:%d:%d", rra.CF, rra.XFF, rra.Steps, rra.Rows))
	}

	if _, err := f.executor.Run(ctx, args...); err != nil {
		return err
	}

	if err := f.validateInfoLocked(ctx, tempPath); err != nil {
		return fmt.Errorf("rrd: validate newly created file: %w", err)
	}

	if err := f.ops.Link(tempPath, f.path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return f.validateInfoLocked(ctx, f.path)
		}

		return fmt.Errorf("rrd: install RRD file: %w", err)
	}

	return nil
}

func (f *File) LastUpdate(ctx context.Context) (time.Time, error) {
	f.lock.Lock()

	defer f.lock.Unlock()

	return f.lastUpdateLocked(ctx)
}

func (f *File) lastUpdateLocked(ctx context.Context) (time.Time, error) {
	if _, err := os.Stat(f.path); errors.Is(err, os.ErrNotExist) {
		return time.Time{}, ErrFileMissing
	} else if err != nil {
		return time.Time{}, fmt.Errorf("rrd: stat active file: %w", err)
	}

	result, err := f.executor.Run(ctx, "lastupdate", f.path)
	if err != nil {
		return time.Time{}, err
	}

	return parseLastUpdate(result.Stdout)
}

func (f *File) Update(ctx context.Context, points []UpdatePoint) error {
	if len(points) == 0 {
		return errors.New("rrd: update batch must not be empty")
	}

	f.lock.Lock()

	defer f.lock.Unlock()

	if len(points) > 32 {
		return errors.New("rrd: update batch too large")
	}

	for index, point := range points {
		if len(point.Values) != len(f.spec.DS) {
			return fmt.Errorf("rrd: update %d has %d values, want %d", index, len(point.Values), len(f.spec.DS))
		}

		if point.Timestamp.Unix() <= 0 || point.Timestamp.Nanosecond() != 0 {
			return fmt.Errorf("rrd: update %d timestamp must be positive whole seconds", index)
		}

		if index > 0 && !point.Timestamp.After(points[index-1].Timestamp) {
			return ErrChronology
		}
	}

	last, err := f.lastUpdateLocked(ctx)
	if err != nil {
		return err
	}

	args := []string{"update", f.path}

	for _, point := range points {
		if !point.Timestamp.After(last) {
			return ErrChronology
		}

		values := make([]string, len(point.Values))

		for valueIndex, value := range point.Values {
			if !value.Known {
				values[valueIndex] = "U"

				continue
			}

			values[valueIndex] = strconv.FormatFloat(value.V, 'g', -1, 64)
		}

		args = append(args, strconv.FormatInt(point.Timestamp.Unix(), 10)+":"+strings.Join(values, ":"))
		last = point.Timestamp
	}

	_, err = f.executor.Run(ctx, args...)

	return err
}

func (f *File) validateInfoLocked(ctx context.Context, path string) error {
	result, err := f.executor.Run(ctx, "info", path)
	if err != nil {
		return err
	}

	return validateInfo(result.Stdout, f.spec)
}

func validateSpec(spec CreateSpec) error {
	if spec.Step <= 0 || spec.Step%time.Second != 0 {
		return errors.New("rrd: schema step must be a positive whole second duration")
	}

	if len(spec.DS) == 0 || len(spec.DS) > 16 {
		return errors.New("rrd: schema must define between 1 and 16 data sources")
	}

	seen := make(map[string]struct{}, len(spec.DS))

	for _, ds := range spec.DS {
		if ds.Name == "" || strings.ContainsAny(ds.Name, " :") || ds.Type != "GAUGE" || ds.Heartbeat <= 0 || ds.Heartbeat%time.Second != 0 {
			return fmt.Errorf("rrd: invalid data source %q", ds.Name)
		}

		if ds.Min != nil && (math.IsNaN(*ds.Min) || math.IsInf(*ds.Min, 0)) {
			return fmt.Errorf("rrd: invalid minimum for data source %q", ds.Name)
		}

		if ds.Max != nil && (math.IsNaN(*ds.Max) || math.IsInf(*ds.Max, 0)) {
			return fmt.Errorf("rrd: invalid maximum for data source %q", ds.Name)
		}

		if ds.Min != nil && ds.Max != nil && *ds.Min > *ds.Max {
			return fmt.Errorf("rrd: minimum exceeds maximum for data source %q", ds.Name)
		}

		if _, ok := seen[ds.Name]; ok {
			return fmt.Errorf("rrd: duplicate data source %q", ds.Name)
		}

		seen[ds.Name] = struct{}{}
	}

	if len(spec.RRA) == 0 {
		return errors.New("rrd: schema must define at least one archive")
	}

	for _, rra := range spec.RRA {
		if rra.CF != "AVERAGE" && rra.CF != "MIN" && rra.CF != "MAX" {
			return fmt.Errorf("rrd: unsupported consolidation function %q", rra.CF)
		}

		if rra.XFF < 0 || rra.XFF >= 1 || rra.Steps <= 0 || rra.Rows <= 0 || math.IsNaN(rra.XFF) || math.IsInf(rra.XFF, 0) {
			return fmt.Errorf("rrd: invalid archive %#v", rra)
		}
	}

	return nil
}

func validateInfo(output []byte, spec CreateSpec) error {
	text := string(output)
	step, ok := infoValue(text, "step")

	if !ok || strings.Trim(step, "\"") != strconv.FormatInt(int64(spec.Step/time.Second), 10) {
		return fmt.Errorf("rrd: incompatible step: got %q want %d", step, int64(spec.Step/time.Second))
	}

	dsRefs := infoDataSourceRefs(text)

	if len(dsRefs) != len(spec.DS) {
		return fmt.Errorf("rrd: incompatible data-source count: got %d want %d", len(dsRefs), len(spec.DS))
	}

	if countInfoIndexes(text, "rra[") != len(spec.RRA) {
		return fmt.Errorf("rrd: incompatible archive count: got %d want %d", countInfoIndexes(text, "rra["), len(spec.RRA))
	}

	numericDSRefs := true

	for index, ref := range dsRefs {
		if ref != strconv.Itoa(index) {
			numericDSRefs = false

			break
		}
	}

	for index, expected := range spec.DS {
		ref := expected.Name

		if numericDSRefs {
			ref = strconv.Itoa(index)
		} else {
			if dsRefs[index] != expected.Name {
				return fmt.Errorf("rrd: incompatible data-source order at %d: got %q want %q", index, dsRefs[index], expected.Name)
			}
		}

		prefix := fmt.Sprintf("ds[%s].", ref)

		for key, want := range map[string]string{
			"type":              expected.Type,
			"minimal_heartbeat": strconv.FormatInt(int64(expected.Heartbeat/time.Second), 10),
		} {
			got, ok := infoValue(text, prefix+key)

			if !ok || strings.Trim(got, "\"") != want {
				return fmt.Errorf("rrd: incompatible schema %s%s: got %q want %q", prefix, key, got, want)
			}
		}

		if got, ok := infoValue(text, prefix+"name"); numericDSRefs && (!ok || strings.Trim(got, "\"") != expected.Name) {
			return fmt.Errorf("rrd: incompatible schema %sname: got %q want %q", prefix, got, expected.Name)
		}

		if got, ok := infoValue(text, prefix+"name"); !numericDSRefs && ok && strings.Trim(got, "\"") != expected.Name {
			return fmt.Errorf("rrd: incompatible schema %sname: got %q want %q", prefix, got, expected.Name)
		}

		for key, bound := range map[string]*float64{"min": expected.Min, "max": expected.Max} {
			got, ok := infoValue(text, prefix+key)

			if bound == nil {
				if !ok || strings.Trim(got, "\"") != "U" {
					return fmt.Errorf("rrd: incompatible schema %s%s: got %q want U", prefix, key, got)
				}

				continue
			}

			parsed, parseErr := strconv.ParseFloat(strings.Trim(got, "\""), 64)

			if !ok || parseErr != nil || parsed != *bound {
				return fmt.Errorf("rrd: incompatible schema %s%s: got %q want %g", prefix, key, got, *bound)
			}
		}
	}

	for index, expected := range spec.RRA {
		prefix := fmt.Sprintf("rra[%d].", index)
		got, ok := infoValue(text, prefix+"cf")

		if !ok || strings.Trim(got, "\"") != expected.CF {
			return fmt.Errorf("rrd: incompatible schema %scf: got %q want %q", prefix, got, expected.CF)
		}

		got, ok = infoValue(text, prefix+"xff")
		parsedXFF, parseErr := strconv.ParseFloat(strings.Trim(got, "\""), 64)

		if !ok || parseErr != nil || parsedXFF != expected.XFF {
			return fmt.Errorf("rrd: incompatible schema %sxff: got %q want %g", prefix, got, expected.XFF)
		}

		got, ok = infoValue(text, prefix+"pdp_per_row")
		parsedSteps, parseErr := strconv.Atoi(strings.Trim(got, "\""))

		if !ok || parseErr != nil || parsedSteps != expected.Steps {
			return fmt.Errorf("rrd: incompatible schema %spdp_per_row: got %q want %d", prefix, got, expected.Steps)
		}

		got, ok = infoValue(text, prefix+"rows")
		parsedRows, parseErr := strconv.Atoi(strings.Trim(got, "\""))

		if !ok || parseErr != nil || parsedRows != expected.Rows {
			return fmt.Errorf("rrd: incompatible schema %srows: got %q want %d", prefix, got, expected.Rows)
		}
	}

	return nil
}

func infoDataSourceRefs(text string) []string {
	refs := make([]string, 0)
	seen := make(map[string]struct{})

	for _, line := range strings.Split(text, "\n") {
		keyValue := strings.SplitN(strings.TrimSpace(line), "=", 2)

		if len(keyValue) != 2 {
			continue
		}

		key := strings.TrimSpace(keyValue[0])

		if !strings.HasPrefix(key, "ds[") {
			continue
		}

		end := strings.IndexByte(key[len("ds["):], ']')

		if end < 0 {
			continue
		}

		ref := key[len("ds[") : len("ds[")+end]

		if _, ok := seen[ref]; ok {
			continue
		}

		seen[ref] = struct{}{}
		refs = append(refs, ref)
	}

	return refs
}

func countInfoIndexes(text, prefix string) int {
	indexes := make(map[int]struct{})

	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)

		if !strings.HasPrefix(line, prefix) {
			continue
		}

		end := strings.IndexByte(line[len(prefix):], ']')

		if end < 0 {
			continue
		}

		index, err := strconv.Atoi(line[len(prefix) : len(prefix)+end])
		if err == nil && index >= 0 {
			indexes[index] = struct{}{}
		}
	}

	return len(indexes)
}

func infoValue(text, key string) (string, bool) {
	for _, line := range strings.Split(text, "\n") {
		fields := strings.SplitN(strings.TrimSpace(line), "=", 2)

		if len(fields) == 2 && strings.TrimSpace(fields[0]) == key {
			return strings.TrimSpace(fields[1]), true
		}
	}

	return "", false
}

func parseLastUpdate(output []byte) (time.Time, error) {
	headerSeen := false

	for _, rawLine := range strings.Split(string(output), "\n") {
		line := strings.TrimSpace(rawLine)

		if line == "" {
			continue
		}

		if !headerSeen {
			headerSeen = true

			continue
		}

		fields := strings.Fields(line)

		if len(fields) == 0 || !strings.HasSuffix(fields[0], ":") {
			return time.Time{}, fmt.Errorf("rrd: invalid lastupdate row %q", line)
		}

		seconds, err := strconv.ParseInt(strings.TrimSuffix(fields[0], ":"), 10, 64)
		if err != nil || seconds < 0 {
			return time.Time{}, fmt.Errorf("rrd: invalid lastupdate timestamp %q", fields[0])
		}

		return time.Unix(seconds, 0), nil
	}

	return time.Time{}, errors.New("rrd: lastupdate output missing data row")
}
