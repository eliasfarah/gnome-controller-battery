import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS = 'org.freedesktop.UPower';
const ROOT = '/org/freedesktop/UPower';
const DEVICE = 'org.freedesktop.UPower.Device';
const GAMEPAD = 12;

function value(proxy, property, fallback = null) {
    return proxy.get_cached_property(property)?.deep_unpack() ?? fallback;
}

function controllerKind(name, modalias = '') {
    const n = name.toLowerCase();
    const sony = modalias.toLowerCase().match(/v054cp([0-9a-f]{4})/);
    if (sony && ['05c4', '09cc', '0ba0'].includes(sony[1])) return 'dualshock';
    if (sony && ['0ce6', '0df2'].includes(sony[1])) return 'dualsense';
    if (/dual\s*shock|wireless controller.*ps4|playstation\s*4|ps4 controller/.test(n))
        return 'dualshock';
    if (/dualsense|dual\s*sense|playstation\s*5|ps5 controller/.test(n))
        return 'dualsense';
    if (/playstation|sony.*controller|ps[34] controller/.test(n))
        return 'dualshock';
    if (/xbox|x-box|microsoft.*controller/.test(n))
        return 'xbox';
    if (/switch.*pro|pro controller|nintendo.*controller/.test(n))
        return 'switch';
    return 'generic';
}

function batteryDescription(proxy) {
    const percentage = value(proxy, 'Percentage', -1);
    const level = value(proxy, 'BatteryLevel', 0);
    // UPower uses coarse battery levels for devices that cannot report a percentage.
    if (level > 1) {
        const levels = {3: ['Baixa', 20], 4: ['Crítica', 5], 6: ['Média', 50], 7: ['Alta', 80], 8: ['Cheia', 100]};
        const entry = levels[level];
        return entry ? {label: entry[0], amount: entry[1]} : {label: 'Desconhecida', amount: null};
    }
    if (Number.isFinite(percentage) && percentage >= 0 && percentage <= 100)
        return {label: `${Math.round(percentage)}%`, amount: percentage};
    return {label: 'Desconhecida', amount: null};
}

export default class ControllerBattery extends Extension {
    enable() {
        this._devices = new Map();
        this._generation = 0;
        this._poll = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            for (const [path, entry] of this._devices) {
                if (!entry.actor) continue;
                const status = this._driverCharging(entry.proxy);
                if (status !== entry.driverCharging) {
                    entry.driverCharging = status;
                    this._update(path);
                }
            }
            return GLib.SOURCE_CONTINUE;
        });
        this._bluetooth = new Map();
        this._bluetoothModels = new Map();
        this._bluezGeneration = 0;
        this._watchBluetooth();
        this._indicator = new PanelMenu.Button(0.0, 'Controller Battery', false);
        this._indicator.add_style_class_name('controller-battery-indicator');
        this._box = new St.BoxLayout({style_class: 'controller-battery-list', y_align: Clutter.ActorAlign.CENTER});
        this._indicator.add_child(this._box);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._indicator.hide();
        this._watch = Gio.bus_watch_name(Gio.BusType.SYSTEM, BUS, Gio.BusNameWatcherFlags.NONE,
            () => this._connect(), () => this._clear());
    }

    _watchBluetooth() {
        const bus = Gio.DBus.system;
        this._bluezSignal = bus.signal_subscribe('org.bluez', 'org.freedesktop.DBus.Properties', 'PropertiesChanged', null,
            'org.bluez.Device1', Gio.DBusSignalFlags.NONE, (_connection, _sender, path, _iface, _signal, params) => {
                const [iface, changes] = params.deep_unpack();
                if (iface !== 'org.bluez.Device1' || !Object.hasOwn(changes, 'Connected')) return;
                const address = this._addressFromPath(path);
                if (address) {
                    this._bluetooth.set(address, changes.Connected.deep_unpack());
                    this._refreshDevices();
                    this._loadBluetooth();
                }
            });
        this._bluezManagerSignal = bus.signal_subscribe('org.bluez', 'org.freedesktop.DBus.ObjectManager', null, '/', null,
            Gio.DBusSignalFlags.NONE, () => this._loadBluetooth());
        this._bluezWatch = Gio.bus_watch_name(Gio.BusType.SYSTEM, 'org.bluez', Gio.BusNameWatcherFlags.NONE,
            () => this._loadBluetooth(), () => { this._bluezGeneration++; this._bluetooth.clear(); this._bluetoothModels.clear(); this._refreshDevices(); });
    }

    _addressFromPath(path) {
        const match = path.match(/\/dev_([0-9A-Fa-f]{2}(?:_[0-9A-Fa-f]{2}){5})$/);
        return match ? match[1].replaceAll('_', ':').toUpperCase() : null;
    }

    _loadBluetooth() {
        const generation = ++this._bluezGeneration;
        Gio.DBus.system.call('org.bluez', '/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects', null,
            new GLib.VariantType('(a{oa{sa{sv}}})'), Gio.DBusCallFlags.NONE, 5000, null, (bus, result) => {
                if (generation !== this._bluezGeneration || !this._devices) return;
                try {
                    const [objects] = bus.call_finish(result).deep_unpack();
                    const states = new Map();
                    const models = new Map();
                    for (const [path, interfaces] of Object.entries(objects)) {
                        const device = interfaces['org.bluez.Device1'];
                        const address = this._addressFromPath(path);
                        if (device && address && device.Connected) {
                            states.set(address, device.Connected.deep_unpack());
                            if (device.Modalias) models.set(address, device.Modalias.deep_unpack());
                        }
                    }
                    this._bluetooth = states;
                    this._bluetoothModels = models;
                    this._refreshDevices();
                } catch (e) { console.debug(`Controller Battery: Bluetooth: ${e.message}`); }
            });
    }

    _refreshDevices() { if (this._devices) for (const path of this._devices.keys()) this._update(path); }

    _connect() {
        this._clear();
        const generation = this._generation;
        try {
            this._root = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE,
                null, BUS, ROOT, BUS, null);
            this._rootSignal = this._root.connect('g-signal', (_proxy, _sender, signal, params) => {
                const [path] = params.deep_unpack();
                if (signal === 'DeviceAdded') this._add(path);
                else if (signal === 'DeviceRemoved') this._remove(path);
            });
            this._root.call('EnumerateDevices', null, Gio.DBusCallFlags.NONE, -1, null, (proxy, result) => {
                if (generation !== this._generation) return;
                try {
                    const [paths] = proxy.call_finish(result).deep_unpack();
                    for (const path of paths) this._add(path);
                } catch (e) { console.error(`Controller Battery: ${e.message}`); }
            });
        } catch (e) { console.error(`Controller Battery: ${e.message}`); }
    }

    _add(path) {
        if (this._devices.has(path)) return;
        try {
            const proxy = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE,
                null, BUS, path, DEVICE, null);
            const entry = {proxy, signal: 0, actor: null};
            this._devices.set(path, entry);
            entry.signal = proxy.connect('g-properties-changed', () => this._update(path));
            this._update(path);
        } catch (e) { console.error(`Controller Battery: ${e.message}`); }
    }

    _driverCharging(proxy) {
        const native = value(proxy, 'NativePath', '');
        if (!native || native !== GLib.path_get_basename(native) || native === '.' || native === '..')
            return null;
        try {
            const [ok, bytes] = GLib.file_get_contents(`/sys/class/power_supply/${native}/status`);
            if (!ok) return null;
            const status = new TextDecoder().decode(bytes).trim().toLowerCase();
            if (status === 'charging') return true;
            if (['discharging', 'not charging', 'full'].includes(status)) return false;
        } catch (_) { /* Some devices do not expose a power_supply status. */ }
        return null;
    }

    _update(path) {
        const entry = this._devices.get(path);
        if (!entry) return;
        const proxy = entry.proxy;
        const serial = String(value(proxy, 'Serial', '')).toUpperCase();
        const disconnected = this._bluetooth.get(serial) === false;
        if (value(proxy, 'Type', 0) !== GAMEPAD || !value(proxy, 'IsPresent', true) || disconnected) {
            if (entry.actor) { entry.actor.destroy(); entry.actor = null; }
            if (entry.menuItem) { entry.menuItem.destroy(); entry.menuItem = null; }
            this._visibility();
            return;
        }
        if (!entry.actor) {
            entry.actor = new St.BoxLayout({style_class: 'controller-battery-device', y_align: Clutter.ActorAlign.CENTER});
            entry.icon = new St.Icon({style_class: 'controller-battery-controller', icon_size: 24});
            entry.batteryGroup = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, y_align: Clutter.ActorAlign.CENTER});
            entry.tip = new St.Widget({style_class: 'controller-battery-tip', x_align: Clutter.ActorAlign.CENTER});
            entry.tip.set_size(4, 2);
            entry.battery = new St.Widget({style_class: 'controller-battery-outline', layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER});
            entry.battery.set_size(9, 14);
            entry.fill = new St.Widget({style_class: 'controller-battery-fill', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.END});
            entry.battery.add_child(entry.fill);
            entry.batteryGroup.add_child(entry.tip);
            entry.batteryGroup.add_child(entry.battery);
            entry.actor.add_child(entry.icon);
            entry.actor.add_child(entry.batteryGroup);
            entry.chargeIcon = new St.Icon({gicon: new Gio.FileIcon({file: this.dir.get_child('icons').get_child('charging.svg')}), icon_size: 12, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            entry.battery.add_child(entry.chargeIcon);
            entry.menuItem = new PopupMenu.PopupMenuItem('', {reactive: false});
            this._indicator.menu.addMenuItem(entry.menuItem);
            this._box.add_child(entry.actor);
        }
        const name = value(proxy, 'Model', '') || value(proxy, 'NativePath', '') || 'Controle';
        const kind = controllerKind(`${name} ${value(proxy, 'NativePath', '')}`, this._bluetoothModels.get(serial) || '');
        entry.icon.gicon = new Gio.FileIcon({file: this.dir.get_child('icons').get_child(`${kind}.svg`)});
        const {label, amount} = batteryDescription(proxy);
        const state = value(proxy, 'State', 0);
        entry.driverCharging = this._driverCharging(proxy);
        const charging = entry.driverCharging ?? (state === 1 || state === 5);
        entry.chargeIcon.visible = charging;
        const isLow = amount !== null && amount <= 25;
        const shouldWarn = isLow;
        if (shouldWarn && !entry.lowNotified && !charging) {
            Main.notify('Bateria baixa', `${name}: ${label}`);
            entry.lowNotified = true;
        } else if (!shouldWarn && amount !== null) {
            entry.lowNotified = false;
        }
        const color = amount === null ? 'unknown' : isLow ? 'low' : amount <= 50 ? 'medium' : 'high';
        const colors = {high: '#6ee7a0', medium: '#f6cf65', low: '#ff727b', unknown: 'transparent'};
        entry.fill.set_style(`background-color: ${charging ? '#62b5ff' : colors[color]};`);
        entry.fill.set_size(5, amount === null ? 0 : Math.max(1, Math.round(10 * amount / 100)));
        const suffix = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(serial) ? ` (${serial.slice(-5)})` : '';
        entry.menuItem.label.text = `${name}${suffix}  •  ${label}${charging ? '  •  Carregando' : ''}`;
        entry.actor.accessible_name = `${name}, bateria ${label}${charging ? ', carregando' : ''}`;
        this._visibility();
    }

    _visibility() { this._indicator.visible = [...this._devices.values()].some(entry => entry.actor); }
    _remove(path) {
        const entry = this._devices.get(path);
        if (!entry) return;
        if (entry.signal) entry.proxy.disconnect(entry.signal);
        entry.actor?.destroy();
        entry.menuItem?.destroy();
        this._devices.delete(path);
        this._visibility();
    }
    _clear() {
        this._generation++;
        for (const path of [...this._devices.keys()]) this._remove(path);
        if (this._rootSignal) this._root?.disconnect(this._rootSignal);
        this._rootSignal = 0;
        this._root = null;
    }
    disable() {
        GLib.source_remove(this._poll);
        Gio.bus_unwatch_name(this._watch);
        Gio.bus_unwatch_name(this._bluezWatch);
        Gio.DBus.system.signal_unsubscribe(this._bluezSignal);
        Gio.DBus.system.signal_unsubscribe(this._bluezManagerSignal);
        this._bluezGeneration++;
        this._clear();
        this._indicator.destroy();
        this._indicator = null;
    }
}
