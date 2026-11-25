# SMART Page device acceptance

## Status

SSH hardware observations and sanitized command fixtures are recorded below. The service-level API run remains
`not-run: pending owner run after M1 (Task 11)`. Until that run, these observations do not verify that the
supervised service can access the device.

## Hardware observations

On the Keenetic aarch64 device, Entware provided smartmontools 7.5 r5714 at `/opt/sbin/smartctl`. The daemon and
its services ran with effective UID/GID 0 and no supplementary groups. `smartd` was not installed.

The plain JSON scan found no devices. The SCSI scan found the USB disk, so discovery must run both fixed scans and
merge results by canonical device path. The USB bridge type is an explicit user choice. On the Samsung T7, the
ASMedia type returned the full NVMe log with exit status 0; the generic SCSI type returned a reduced SCSI view
with exit status 4 and a zero temperature. A wrong bridge type can also produce plausible values unrelated to
the device and cause a false health failure. The plugin must not guess or cycle through bridge types; decoding
must assess data plausibility.

The WD hard drive returned usable JSON through both SAT and SCSI. Its standby check with
`-n standby,3,5` returned status 3 and a standby result, confirming the command profile for that drive. This is
fixture evidence for Task 8 and the separate M4 gate; it does not enable standby polling by itself.

The kernel device path was identical after a disk swap. A path is therefore a current OS binding, not proof of
device identity. The user-selected bridge type and a later accepted manual read remain necessary checks.

## Service-level API run

`not-run: pending owner run after M1 (Task 11)`

When the owner runs this check, build the production backend with the normal build command for the device
architecture, pack it with the CLI, install it, and approve it through the normal UI. Do not use build tags or an
observer process. Installation and SSH commands must run only on the owner's supplied device.

Open the authorized mndw session and its same-origin DevTools Console. The browser supplies the session cookie.
Confirm the possible wake warning before issuing one POST. Use the fixed manifest routes and same-origin CSRF
header:

```js
const smartRequest = async (path, body) => {
  const response = await fetch(`/api/plugins/smart-page/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? {} : {'Content-Type': 'application/json', 'X-Mndw-Csrf': '1'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  const value = await response.json();
  if (!response.ok) { throw new Error(JSON.stringify({status: response.status, value})); }
  return value;
};
const scan = await smartRequest('discover', {acknowledgeWake: true});
await smartRequest(`operation?id=${encodeURIComponent(scan.operationId)}`);
const snapshot = await smartRequest('snapshot');
```

Poll only the operation GET, at intervals of at least one second, until it reaches a terminal state. Select the
device by its snapshot `deviceId`, not by supplying a raw path. After a separate wake confirmation, submit one
refresh:

```js
// Replace with a deviceId from snapshot.devices after checking its path/type in the authorized UI.
const deviceId = '<selected snapshot deviceId>';
const read = await smartRequest('refresh', {deviceId, acknowledgeWake: true});
await smartRequest(`operation?id=${encodeURIComponent(read.operationId)}`);
```

Poll the refresh operation the same way. Record snapshot UID/GID/groups, utility path/version/availability, and
command exit/collection result. Do not elevate permissions automatically. Until Decode lands, refresh only
confirms child execution and collection, not SMART health.

For SSH capture checks, record `id`, utility version, and the type/path returned by discovery. Run only the type
and path confirmed by that scan; do not probe other bridge types. The fixed argv forms are:

```sh
/opt/sbin/smartctl --scan -j > smart-scan.json
scan_exit=$?
/opt/sbin/smartctl --scan -d scsi -j > smart-scan-scsi.json
scsi_scan_exit=$?
confirmed_type='<type from confirmed scan>'
confirmed_path='<path from confirmed scan>'
/opt/sbin/smartctl -a --json=v -d "$confirmed_type" "$confirmed_path" > smart-read.json
read_exit=$?
```

Use `/opt/bin/smartctl` only when the primary fixed path is unavailable. Record exit statuses immediately;
smartctl statuses are bitmasks and a nonzero status does not by itself mean the JSON is unusable. Compare SSH
effective IDs/groups with the supervised service. If they differ, SSH captures prove output format only. Never
return raw JSON through the API or logs. Sanitize identifiers before moving captures into fixtures. Standby/no-wake
and hourly-write effects remain separate M4/M3 checks.

## Sanitized fixtures

Five sanitized captures are stored under `backend/testdata/`: `ata-hdd.json` (SAT, status 0),
`scsi-usb-hdd.json` (SCSI, status 0), `nvme-usb-asmedia.json` (ASMedia, status 0),
`scsi-usb-nvme.json` (SCSI, status 4), and `standby.json` (standby, status 3). Serial numbers, device-specific
WWN components, logical unit identifiers, and capture times were replaced. Other JSON content and status
bitmasks were retained. The Realtek capture was excluded because it can contain data read from disk content.

Gate decision: continue fixtures-first. The API run and final service-access acceptance remain pending; these
results are not a claim of complete device verification.
