package devices

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const maxSysfsValueBytes = 4096

type sysfsBinding struct {
	devicePath string
	size       string
	usbBridge  string
	usbVendor  sysfsValue
	usbProduct sysfsValue
	usbSerial  sysfsValue
}

type sysfsValue struct {
	value  string
	status string
}

func inspectSysfs(sysRoot string, majorMinor string) (sysfsBinding, error) {
	if !validMajorMinor(majorMinor) {
		return sysfsBinding{}, fmt.Errorf("invalid device number")
	}

	root, err := filepath.EvalSymlinks(sysRoot)
	if err != nil {
		return sysfsBinding{}, fmt.Errorf("resolve sysfs root: %w", err)
	}

	link := filepath.Join(root, "dev", "block", majorMinor)
	devicePath, err := filepath.EvalSymlinks(link)
	if err != nil {
		return sysfsBinding{}, fmt.Errorf("resolve sysfs device: %w", err)
	}

	devicePath, err = filepath.Abs(devicePath)
	if err != nil || !insidePath(root, devicePath) {
		return sysfsBinding{}, fmt.Errorf("sysfs device escaped root")
	}

	if _, err := os.Stat(filepath.Join(devicePath, "partition")); err == nil {
		return sysfsBinding{}, fmt.Errorf("partition is not a whole disk")
	} else if !os.IsNotExist(err) {
		return sysfsBinding{}, fmt.Errorf("inspect partition marker: %w", err)
	}

	blockName := filepath.Base(devicePath)

	if blockName == "." || blockName == string(filepath.Separator) || blockName == "" {
		return sysfsBinding{}, fmt.Errorf("invalid block device path")
	}

	size, err := readSysfsValue(filepath.Join(root, "block", blockName, "size"))
	if err != nil {
		return sysfsBinding{}, fmt.Errorf("read whole-device size: %w", err)
	}

	if size == "" {
		return sysfsBinding{}, fmt.Errorf("whole-device size is empty")
	}

	bridge, vendor, product, serial := readUSBIdentity(root, devicePath)

	return sysfsBinding{
		devicePath: devicePath,
		size:       size,
		usbBridge:  bridge,
		usbVendor:  vendor,
		usbProduct: product,
		usbSerial:  serial,
	}, nil
}

func readUSBIdentity(root string, devicePath string) (string, sysfsValue, sysfsValue, sysfsValue) {
	for path := devicePath; insidePath(root, path); path = filepath.Dir(path) {
		vendor := readUSBValue(filepath.Join(path, "idVendor"))
		product := readUSBValue(filepath.Join(path, "idProduct"))
		serial := readUSBValue(filepath.Join(path, "serial"))

		if vendor.status == "missing" && product.status == "missing" && serial.status == "missing" {
			if path == root {
				break
			}

			continue
		}

		bridge := ""

		if vendor.status == "present" && product.status == "present" {
			normalizedVendor := strings.ToLower(vendor.value)
			normalizedProduct := strings.ToLower(product.value)

			if validUSBIdentifier(normalizedVendor) && validUSBIdentifier(normalizedProduct) {
				bridge = normalizedVendor + ":" + normalizedProduct
			}
		}

		return bridge, vendor, product, serial
	}

	return "", sysfsValue{status: "missing"}, sysfsValue{status: "missing"}, sysfsValue{status: "missing"}
}

func readUSBValue(path string) sysfsValue {
	value, err := readSysfsValue(path)
	if err == nil {
		return sysfsValue{value: value, status: "present"}
	}

	if os.IsNotExist(err) {
		return sysfsValue{status: "missing"}
	}

	return sysfsValue{status: "unreadable"}
}

func validUSBIdentifier(value string) bool {
	if len(value) != 4 {
		return false
	}

	for _, character := range value {
		if character < '0' || character > '9' {
			if character < 'a' || character > 'f' {
				return false
			}
		}
	}

	return true
}

func readSysfsValue(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}

	defer file.Close()

	value, err := io.ReadAll(io.LimitReader(file, maxSysfsValueBytes+1))
	if err != nil {
		return "", err
	}

	if len(value) > maxSysfsValueBytes {
		return "", fmt.Errorf("sysfs value exceeds limit")
	}

	return strings.TrimRight(string(value), "\r\n"), nil
}

func validMajorMinor(value string) bool {
	parts := strings.Split(value, ":")

	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return false
	}

	for _, part := range parts {
		for _, digit := range part {
			if digit < '0' || digit > '9' {
				return false
			}
		}
	}

	return true
}

func insidePath(root string, path string) bool {
	relative, err := filepath.Rel(root, path)
	if err != nil || relative == ".." {
		return false
	}

	return !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}
