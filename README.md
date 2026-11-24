# Controller Battery

A GNOME Shell extension that shows a separate, compact battery indicator for each connected controller. It has separate icons for DualSense and DualShock, and recognizes Xbox and Nintendo Switch Pro controllers and uses a generic icon for other gamepads. The indicator is hidden when no supported controller is available.

While charging, the battery turns blue and shows a lightning bolt. Otherwise, the vertical battery indicator is green above 50%, yellow from 26% to 50%, and red at 25% or below. Click the indicator to see each device's battery level. A short notification warns when a controller reaches 25% or less while discharging. Bluetooth connection status is used to hide disconnected devices promptly; other connections rely on UPower.

## Requirements

- GNOME Shell 51 (tested on 51.1).
- UPower, with battery information exposed by the controller and its Linux driver.
- BlueZ for prompt Bluetooth disconnect detection.

Battery reporting depends on the controller, connection mode and driver. To inspect the information available on your system, run `upower -d`.

## Installation

Download `controller-battery@farah.local.shell-extension.zip` from the [latest release](https://github.com/eliasfarah/gnome-controller-battery/releases/latest), then run:

```sh
gnome-extensions install --force controller-battery@farah.local.shell-extension.zip
```

Log out and back in if GNOME does not yet recognize the extension, then enable **Controller Battery** in Extensions or run:

```sh
gnome-extensions enable controller-battery@farah.local
```

GNOME Shell can retain extension code in memory during a session. After updating, log out and back in to ensure the new version is loaded.

## Building

From the repository directory:

```sh
gnome-extensions pack --force --extra-source=icons --extra-source=icon.svg
```

The generated ZIP can be installed with `gnome-extensions install --force`.
