#!/usr/bin/env python3
"""A scripted xdg-desktop-portal for the Wayland desktop test.

Serves the RemoteDesktop and ScreenCast interfaces on the session bus the
way xdg-desktop-portal does, without a dialog: Start answers at once with
one monitor stream, the PipeWire node named by --node-name, and a fresh
restore token. OpenPipeWireRemote hands out a connection to the real
PipeWire daemon. Every call is appended to --log as one JSON line, so the
test can check the input klex-machine sent and the token it restored.
"""

import argparse
import itertools
import json
import os
import socket
import subprocess
import sys
import time

import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

BUS_NAME = "org.freedesktop.portal.Desktop"
PATH = "/org/freedesktop/portal/desktop"
REMOTE_DESKTOP = "org.freedesktop.portal.RemoteDesktop"
SCREEN_CAST = "org.freedesktop.portal.ScreenCast"
REQUEST = "org.freedesktop.portal.Request"
SESSION = "org.freedesktop.portal.Session"
PROPERTIES = "org.freedesktop.DBus.Properties"

PROPERTY_VALUES = {
    REMOTE_DESKTOP: {
        "version": dbus.UInt32(2),
        "AvailableDeviceTypes": dbus.UInt32(3),
    },
    SCREEN_CAST: {
        "version": dbus.UInt32(5),
        "AvailableSourceTypes": dbus.UInt32(1),
        "AvailableCursorModes": dbus.UInt32(3),
    },
}


def plain(value):
    """D-Bus values as JSON."""
    if isinstance(value, dbus.Dictionary):
        return {str(key): plain(item) for key, item in value.items()}
    if isinstance(value, (dbus.Array, dbus.Struct, list, tuple)):
        return [plain(item) for item in value]
    if isinstance(value, dbus.Boolean):
        return bool(value)
    if isinstance(value, (dbus.String, dbus.ObjectPath)):
        return str(value)
    if isinstance(value, dbus.Double):
        return float(value)
    if isinstance(value, (int, dbus.Byte)):
        return int(value)
    return str(value)


def node_id(name, timeout=15.0):
    """The id of the PipeWire node called `name`, once it exists."""
    deadline = time.monotonic() + timeout
    while True:
        try:
            dump = json.loads(subprocess.check_output(["pw-dump"], timeout=5))
            for item in dump:
                props = item.get("info", {}).get("props", {})
                if item.get("type") == "PipeWire:Interface:Node" and props.get(
                    "node.name"
                ) == name:
                    return item["id"]
        except (subprocess.SubprocessError, ValueError):
            pass
        if time.monotonic() > deadline:
            raise RuntimeError(f"No PipeWire node named {name}")
        time.sleep(0.2)


class Request(dbus.service.Object):
    def __init__(self, bus, path):
        super().__init__(bus, path)

    @dbus.service.method(REQUEST)
    def Close(self):
        self.remove_from_connection()

    @dbus.service.signal(REQUEST, signature="ua{sv}")
    def Response(self, response, results):
        pass


class Session(dbus.service.Object):
    def __init__(self, portal, path):
        super().__init__(portal.bus, path)
        self.portal = portal
        self.path = path

    @dbus.service.method(SESSION)
    def Close(self):
        self.portal.log("Close", {})
        self.remove_from_connection()

    @dbus.service.signal(SESSION, signature="a{sv}")
    def Closed(self, details):
        pass


class Portal(dbus.service.Object):
    def __init__(self, bus, options):
        super().__init__(bus, PATH)
        self.bus = bus
        self.options = options
        self.sessions = {}
        self.tokens = itertools.count(1)

    def log(self, call, fields):
        with open(self.options.log, "a", encoding="utf-8") as log:
            log.write(json.dumps({"call": call, **fields}) + "\n")

    def respond(self, sender, options, response, results):
        token = str(options.get("handle_token", "t"))
        unique = sender.lstrip(":").replace(".", "_")
        path = f"{PATH}/request/{unique}/{token}"
        request = Request(self.bus, path)

        def answer():
            request.Response(dbus.UInt32(response), dbus.Dictionary(results, signature="sv"))
            request.remove_from_connection()
            return False

        # After the reply, so the caller is listening for the response.
        GLib.timeout_add(20, answer)
        return dbus.ObjectPath(path)

    # MARK: Properties

    @dbus.service.method(PROPERTIES, in_signature="ss", out_signature="v")
    def Get(self, interface, name):
        values = PROPERTY_VALUES.get(str(interface))
        if values is None or str(name) not in values:
            raise dbus.exceptions.DBusException(
                f"No such interface “{interface}”",
                name="org.freedesktop.DBus.Error.InvalidArgs",
            )
        return values[str(name)]

    @dbus.service.method(PROPERTIES, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        return dbus.Dictionary(PROPERTY_VALUES.get(str(interface), {}), signature="sv")

    # MARK: RemoteDesktop

    @dbus.service.method(
        REMOTE_DESKTOP, in_signature="a{sv}", out_signature="o", sender_keyword="sender"
    )
    def CreateSession(self, options, sender=None):
        unique = sender.lstrip(":").replace(".", "_")
        path = f"{PATH}/session/{unique}/{options['session_handle_token']}"
        self.sessions[path] = Session(self, path)
        self.log("CreateSession", {})
        return self.respond(sender, options, 0, {"session_handle": dbus.String(path)})

    @dbus.service.method(
        REMOTE_DESKTOP, in_signature="oa{sv}", out_signature="o", sender_keyword="sender"
    )
    def SelectDevices(self, session, options, sender=None):
        self.log("SelectDevices", {"options": plain(options)})
        return self.respond(sender, options, 0, {})

    @dbus.service.method(
        REMOTE_DESKTOP, in_signature="osa{sv}", out_signature="o", sender_keyword="sender"
    )
    def Start(self, session, parent, options, sender=None):
        self.log("Start", {})
        if self.options.deny:
            return self.respond(sender, options, 1, {})
        width, height = (int(part) for part in self.options.size.split("x"))
        stream = dbus.Struct(
            (
                dbus.UInt32(node_id(self.options.node_name)),
                dbus.Dictionary(
                    {
                        "position": dbus.Struct((dbus.Int32(0), dbus.Int32(0))),
                        "size": dbus.Struct((dbus.Int32(width), dbus.Int32(height))),
                        "source_type": dbus.UInt32(1),
                    },
                    signature="sv",
                ),
            ),
            signature="ua{sv}",
        )
        results = {
            "devices": dbus.UInt32(3),
            "streams": dbus.Array([stream], signature="(ua{sv})"),
            "restore_token": dbus.String(f"token-{next(self.tokens)}"),
        }
        return self.respond(sender, options, 0, results)

    def notify(name, signature):
        # dbus-python needs one named parameter per signature argument.
        if len(signature) - len("oa{sv}") == 3:

            def method(self, session, options, first, second, third):
                self.log(name, {"values": plain([first, second, third])})

        else:

            def method(self, session, options, first, second):
                self.log(name, {"values": plain([first, second])})

        method.__name__ = name
        return dbus.service.method(REMOTE_DESKTOP, in_signature=signature)(method)

    NotifyPointerMotionAbsolute = notify("NotifyPointerMotionAbsolute", "oa{sv}udd")
    NotifyPointerMotion = notify("NotifyPointerMotion", "oa{sv}dd")
    NotifyPointerButton = notify("NotifyPointerButton", "oa{sv}iu")
    NotifyPointerAxisDiscrete = notify("NotifyPointerAxisDiscrete", "oa{sv}ui")
    NotifyKeyboardKeycode = notify("NotifyKeyboardKeycode", "oa{sv}iu")
    NotifyKeyboardKeysym = notify("NotifyKeyboardKeysym", "oa{sv}iu")
    del notify

    # MARK: ScreenCast

    @dbus.service.method(
        SCREEN_CAST, in_signature="oa{sv}", out_signature="o", sender_keyword="sender"
    )
    def SelectSources(self, session, options, sender=None):
        self.log("SelectSources", {"options": plain(options)})
        return self.respond(sender, options, 0, {})

    @dbus.service.method(SCREEN_CAST, in_signature="oa{sv}", out_signature="h")
    def OpenPipeWireRemote(self, session, options):
        self.log("OpenPipeWireRemote", {})
        runtime = os.environ["XDG_RUNTIME_DIR"]
        remote = os.environ.get("PIPEWIRE_REMOTE", "pipewire-0")
        connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.connect(os.path.join(runtime, remote))
        fd = dbus.types.UnixFd(connection.fileno())
        connection.close()
        return fd

    @dbus.service.method("org.klex.FakePortal", in_signature="b")
    def SetDeny(self, deny):
        """Makes later Start calls decline, as if the user chose Cancel."""
        self.options.deny = bool(deny)

    @dbus.service.method("org.klex.FakePortal")
    def CloseSessions(self):
        """Ends every session as if the user stopped sharing."""
        for session in self.sessions.values():
            session.Closed(dbus.Dictionary({}, signature="sv"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--log", required=True)
    parser.add_argument("--node-name", required=True)
    parser.add_argument("--size", default="320x200")
    parser.add_argument("--deny", action="store_true")
    options = parser.parse_args()
    DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    portal = Portal(bus, options)
    name = dbus.service.BusName(BUS_NAME, bus, do_not_queue=True)
    print("ready", flush=True)
    try:
        GLib.MainLoop().run()
    finally:
        del name, portal
    return 0


if __name__ == "__main__":
    sys.exit(main())
