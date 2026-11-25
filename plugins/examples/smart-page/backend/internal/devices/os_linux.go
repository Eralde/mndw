//go:build linux

package devices

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

type linuxOS struct {
	devRoot string
	sysRoot string
}

func NewOS() OS {
	return linuxOS{devRoot: "/dev", sysRoot: "/sys"}
}

func (operatingSystem linuxOS) Inspect(path string) (Binding, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || !strings.HasPrefix(path, operatingSystem.devRoot+string(filepath.Separator)) {
		return Binding{}, fmt.Errorf("device path is outside /dev")
	}

	canonical, err := filepath.EvalSymlinks(path)
	if err != nil {
		return Binding{}, fmt.Errorf("resolve device path: %w", err)
	}

	canonical, err = filepath.Abs(canonical)
	if err != nil || !insidePath(operatingSystem.devRoot, canonical) || canonical == operatingSystem.devRoot {
		return Binding{}, fmt.Errorf("canonical device path is outside /dev")
	}

	info, err := os.Stat(canonical)
	if err != nil {
		return Binding{}, fmt.Errorf("stat device: %w", err)
	}

	if info.Mode()&os.ModeDevice == 0 || info.Mode()&os.ModeCharDevice != 0 {
		return Binding{}, fmt.Errorf("path is not a block device")
	}

	stat, ok := info.Sys().(*syscall.Stat_t)

	if !ok {
		return Binding{}, fmt.Errorf("device stat has no Linux device number")
	}

	major, minor := linuxMajorMinor(uint64(stat.Rdev))
	majorMinor := fmt.Sprintf("%d:%d", major, minor)

	sysfs, err := inspectSysfs(operatingSystem.sysRoot, majorMinor)
	if err != nil {
		return Binding{}, err
	}

	token := strings.Join([]string{
		majorMinor,
		sysfs.devicePath,
		sysfs.size,
		sysfs.usbVendor.status,
		sysfs.usbVendor.value,
		sysfs.usbProduct.status,
		sysfs.usbProduct.value,
		sysfs.usbSerial.status,
		sysfs.usbSerial.value,
	}, "\x00")

	return Binding{Path: canonical, Token: token, USBBridge: sysfs.usbBridge}, nil
}

func linuxMajorMinor(device uint64) (uint64, uint64) {
	major := (device >> 8) & 0xfff
	major |= (device >> 32) & 0xfffff000
	minor := device & 0xff
	minor |= (device >> 12) & 0xffffff00

	return major, minor
}
