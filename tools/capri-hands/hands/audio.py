"""Audio endpoints through Core Audio COM with ctypes (hq-63nvj.13): list outputs and inputs,
set the default device, read and set the master volume and mute. No PowerShell, no module.

The default endpoint is per user, so this works from the owner's session (and from ssh as owner).
IPolicyConfig is the undocumented interface the Sound control panel uses; its vtable has been
stable since Windows 7 (SetDefaultEndpoint is slot 13).
"""
from __future__ import annotations

import ctypes
import uuid
from contextlib import contextmanager
from ctypes import wintypes

ole32 = ctypes.WinDLL("ole32")
ole32.CoTaskMemFree.argtypes = [ctypes.c_void_p]
ole32.PropVariantClear.argtypes = [ctypes.c_void_p]

E_RENDER, E_CAPTURE = 0, 1
FLOWS = {"output": E_RENDER, "input": E_CAPTURE}
ROLES = (0, 1, 2)  # eConsole, eMultimedia, eCommunications: the Sound panel sets all three
ROLE_NAMES = {0: "console", 1: "multimedia", 2: "communications"}
DEVICE_STATE_ACTIVE = 1
CLSCTX_ALL = 23
VT_LPWSTR = 31


class GUID(ctypes.Structure):
    _fields_ = [("data", ctypes.c_ubyte * 16)]

    @classmethod
    def of(cls, text: str) -> "GUID":
        g = cls()
        ctypes.memmove(g.data, uuid.UUID(text).bytes_le, 16)
        return g


class PROPERTYKEY(ctypes.Structure):
    _fields_ = [("fmtid", GUID), ("pid", wintypes.DWORD)]


class PROPVARIANT(ctypes.Structure):  # 24 bytes on x64; only the VT_LPWSTR case is read
    _fields_ = [("vt", ctypes.c_ushort), ("r1", ctypes.c_ushort), ("r2", ctypes.c_ushort),
                ("r3", ctypes.c_ushort), ("ptr", ctypes.c_void_p), ("pad", ctypes.c_void_p)]


CLSID_ENUMERATOR = GUID.of("BCDE0395-E52F-467C-8E3D-C4579291692E")
IID_ENUMERATOR = GUID.of("A95664D2-9614-4F35-A746-DE8DB63617E6")
CLSID_POLICY = GUID.of("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")
IID_POLICY = GUID.of("F8679F50-850A-41CF-9C72-430F290290C8")
IID_VOLUME = GUID.of("5CDF2C82-841E-4546-9722-0CF74078229A")
PKEY_NAME = PROPERTYKEY(GUID.of("A45C254E-DF1C-4EFD-8020-67D146A850E0"), 14)  # "Speakers (Realtek(R) Audio)"


def _vcall(obj: ctypes.c_void_p, slot: int, *args, argtypes=()):
    """Call vtable slot `slot` of a COM object; a failed HRESULT raises OSError."""
    vtbl = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)))[0]
    proto = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, *argtypes)
    return proto(vtbl[slot])(obj, *args)


def _release(obj) -> None:
    if obj:
        vtbl = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)))[0]
        ctypes.WINFUNCTYPE(wintypes.ULONG, ctypes.c_void_p)(vtbl[2])(obj)


@contextmanager
def _com():
    hr = ole32.CoInitializeEx(None, 0)  # COINIT_MULTITHREADED; each server thread joins the MTA
    try:
        yield
    finally:
        if hr in (0, 1):  # S_OK, S_FALSE: this call owns one init
            ole32.CoUninitialize()


def _create(clsid: GUID, iid: GUID) -> ctypes.c_void_p:
    out = ctypes.c_void_p()
    hr = ole32.CoCreateInstance(ctypes.byref(clsid), None, CLSCTX_ALL, ctypes.byref(iid), ctypes.byref(out))
    if hr != 0:
        raise OSError(hr & 0xFFFFFFFF, "CoCreateInstance failed")
    return out


def _device_id(dev) -> str:
    p = ctypes.c_void_p()
    _vcall(dev, 5, ctypes.byref(p), argtypes=(ctypes.POINTER(ctypes.c_void_p),))  # IMMDevice::GetId
    try:
        return ctypes.wstring_at(p.value)
    finally:
        ole32.CoTaskMemFree(p)


def _device_name(dev) -> str:
    store = ctypes.c_void_p()
    _vcall(dev, 4, 0, ctypes.byref(store), argtypes=(wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)))  # OpenPropertyStore(STGM_READ)
    try:
        pv = PROPVARIANT()
        _vcall(store, 5, ctypes.byref(PKEY_NAME), ctypes.byref(pv),
               argtypes=(ctypes.POINTER(PROPERTYKEY), ctypes.POINTER(PROPVARIANT)))  # IPropertyStore::GetValue
        try:
            return ctypes.wstring_at(pv.ptr) if pv.vt == VT_LPWSTR and pv.ptr else ""
        finally:
            ole32.PropVariantClear(ctypes.byref(pv))
    finally:
        _release(store)


def _default_id(enum, flow: int, role: int = 0) -> str | None:
    dev = ctypes.c_void_p()
    try:
        _vcall(enum, 4, flow, role, ctypes.byref(dev),
               argtypes=(ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)))  # GetDefaultAudioEndpoint
    except OSError:  # no device of that kind at all
        return None
    try:
        return _device_id(dev)
    finally:
        _release(dev)


def _list(enum, flow: int) -> list[dict]:
    coll = ctypes.c_void_p()
    _vcall(enum, 3, flow, DEVICE_STATE_ACTIVE, ctypes.byref(coll),
           argtypes=(ctypes.c_int, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)))  # EnumAudioEndpoints
    try:
        n = wintypes.UINT()
        _vcall(coll, 3, ctypes.byref(n), argtypes=(ctypes.POINTER(wintypes.UINT),))
        default = _default_id(enum, flow)
        out = []
        for i in range(n.value):
            dev = ctypes.c_void_p()
            _vcall(coll, 4, i, ctypes.byref(dev), argtypes=(wintypes.UINT, ctypes.POINTER(ctypes.c_void_p)))
            try:
                did = _device_id(dev)
                out.append({"name": _device_name(dev), "id": did, "default": did == default})
            finally:
                _release(dev)
        return out
    finally:
        _release(coll)


def devices() -> dict:
    """{"outputs": [...], "inputs": [...], "defaults": {...}}; each device {name, id, default}
    where default means the console role (0); defaults holds the endpoint id per role,
    {"output": {"console": id, "multimedia": id, "communications": id}, "input": {...}}, an id
    null when no device of that kind exists. Active devices only."""
    with _com():
        enum = _create(CLSID_ENUMERATOR, IID_ENUMERATOR)
        try:
            return {"outputs": _list(enum, E_RENDER), "inputs": _list(enum, E_CAPTURE),
                    "defaults": {kind: {ROLE_NAMES[r]: _default_id(enum, flow, r) for r in ROLES}
                                 for kind, flow in FLOWS.items()}}
        finally:
            _release(enum)


def set_default(device_id: str, roles=ROLES) -> None:
    """Make one endpoint the default for the given roles (all three by default, what the
    Sound panel does)."""
    with _com():
        policy = _create(CLSID_POLICY, IID_POLICY)
        try:
            for role in roles:
                _vcall(policy, 13, device_id, role, argtypes=(wintypes.LPCWSTR, ctypes.c_int))
        finally:
            _release(policy)


@contextmanager
def _endpoint_volume():
    with _com():
        enum = _create(CLSID_ENUMERATOR, IID_ENUMERATOR)
        dev = ctypes.c_void_p()
        vol = ctypes.c_void_p()
        try:
            _vcall(enum, 4, E_RENDER, 0, ctypes.byref(dev),
                   argtypes=(ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)))
            _vcall(dev, 3, ctypes.byref(IID_VOLUME), CLSCTX_ALL, None, ctypes.byref(vol),
                   argtypes=(ctypes.POINTER(GUID), wintypes.DWORD, ctypes.c_void_p,
                             ctypes.POINTER(ctypes.c_void_p)))  # IMMDevice::Activate
            yield vol, _device_name(dev)
        finally:
            _release(vol)
            _release(dev)
            _release(enum)


def _read(vol) -> tuple[int, bool]:
    level = ctypes.c_float()
    _vcall(vol, 9, ctypes.byref(level), argtypes=(ctypes.POINTER(ctypes.c_float),))  # GetMasterVolumeLevelScalar
    muted = wintypes.BOOL()
    _vcall(vol, 15, ctypes.byref(muted), argtypes=(ctypes.POINTER(wintypes.BOOL),))  # GetMute
    return round(level.value * 100), bool(muted.value)


def volume(level: int | None = None, mute: bool | None = None) -> dict:
    """Set the default output's master level (0-100) and/or mute, then read both back."""
    with _endpoint_volume() as (vol, name):
        if level is not None:
            _vcall(vol, 7, ctypes.c_float(level / 100), None,
                   argtypes=(ctypes.c_float, ctypes.c_void_p))  # SetMasterVolumeLevelScalar
        if mute is not None:
            _vcall(vol, 14, bool(mute), None, argtypes=(wintypes.BOOL, ctypes.c_void_p))  # SetMute
        lvl, muted = _read(vol)
        return {"level": lvl, "muted": muted, "device": name}
