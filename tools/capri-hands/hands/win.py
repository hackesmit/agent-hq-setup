"""Windows backend: the desktop actions, with ctypes only (no pywinauto, no AutoHotkey).

Must run inside the owner's interactive session (the logon task); SendInput from an
ssh session never reaches the desktop (tools/capri/spike/RESULTS.md).
"""
from __future__ import annotations

import ctypes
import json
import ntpath
import os
import subprocess
import threading
import time
from ctypes import wintypes
from pathlib import Path

from . import audio, core, spotify

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
dwmapi = ctypes.WinDLL("dwmapi")

ULONG_PTR = ctypes.c_size_t
INPUT_MOUSE, INPUT_KEYBOARD = 0, 1
KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE = 0x0001, 0x0002, 0x0004
MOUSE = {"left": (0x0002, 0x0004), "right": (0x0008, 0x0010), "middle": (0x0020, 0x0040)}
SW_RESTORE = 9
CREATE_NO_WINDOW = 0x08000000

user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
# 64-bit handles: without argtypes ctypes passes them as 32-bit ints and overflows.
user32.GetDC.argtypes = [wintypes.HWND]
user32.GetDC.restype = wintypes.HDC
user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
gdi32.CreateCompatibleDC.argtypes = [wintypes.HDC]
gdi32.CreateCompatibleDC.restype = wintypes.HDC
gdi32.CreateDIBSection.argtypes = [wintypes.HDC, ctypes.c_void_p, wintypes.UINT, ctypes.POINTER(ctypes.c_void_p),
                                   wintypes.HANDLE, wintypes.DWORD]
gdi32.CreateDIBSection.restype = wintypes.HBITMAP
gdi32.SelectObject.argtypes = [wintypes.HDC, wintypes.HGDIOBJ]
gdi32.SelectObject.restype = wintypes.HGDIOBJ
gdi32.BitBlt.argtypes = [wintypes.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.HDC,
                         ctypes.c_int, ctypes.c_int, wintypes.DWORD]
gdi32.DeleteObject.argtypes = [wintypes.HGDIOBJ]
gdi32.DeleteDC.argtypes = [wintypes.HDC]
for _f in ("IsWindow", "IsIconic", "IsWindowVisible", "BringWindowToTop", "SetForegroundWindow",
           "GetWindowTextLengthW"):
    getattr(user32, _f).argtypes = [wintypes.HWND]
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
user32.GetWindow.restype = wintypes.HWND
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.SendMessageTimeoutW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
                                       wintypes.UINT, wintypes.UINT, ctypes.POINTER(ULONG_PTR)]
user32.SendMessageTimeoutW.restype = wintypes.LPARAM
WM_APPCOMMAND, SMTO_ABORTIFHUNG = 0x0319, 0x0002

# Job object for the powershell action: every descendant dies with it, even one that
# outlives powershell and keeps the stdout pipe (Start-Process -NoNewWindow).
ntdll = ctypes.WinDLL("ntdll")
CREATE_SUSPENDED = 0x00000004
JobObjectExtendedLimitInformation = 9
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
DRAIN_S = 2.0  # after the kill, how long to wait for the pipes to close


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [(n, ctypes.c_ulonglong) for n in ("ReadOps", "WriteOps", "OtherOps", "ReadBytes",
                                                  "WriteBytes", "OtherBytes")]


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ULONG_PTR), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION), ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]


kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
kernel32.CreateJobObjectW.restype = wintypes.HANDLE
kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
kernel32.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]
ntdll.NtResumeProcess.restype = ctypes.c_long


def _job_limits(job, flags: int) -> bool:
    info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = flags
    return bool(kernel32.SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                                 ctypes.byref(info), ctypes.sizeof(info)))


def _new_job():
    """A job that kills everything in it when its last handle closes (also if hands dies)."""
    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        raise core.Refused(500, f"job object not created (error {ctypes.get_last_error()})")
    if not _job_limits(job, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE):
        kernel32.CloseHandle(job)
        raise core.Refused(500, f"job object limits not set (error {ctypes.get_last_error()})")
    return job


def _join_job(job, p) -> None:
    """Put the suspended child in the job, then let it run; on failure kill it unstarted."""
    if kernel32.AssignProcessToJobObject(job, int(p._handle)):
        if ntdll.NtResumeProcess(int(p._handle)) == 0:
            return
        why = "child not resumed"
    else:
        why = f"child not put in the job object (error {ctypes.get_last_error()})"
    kernel32.TerminateProcess(int(p._handle), 1)
    p.wait()
    raise core.Refused(500, why)


class _Tail:
    """Reads one pipe on its own thread from the start of the run and keeps only the last
    `limit` bytes, so the daemon's memory stays bounded whatever the script prints. The thread
    closes its pipe at EOF; one blocked on a pipe that never closes is a daemon thread and
    never holds the reply."""
    CHUNK = 64 * 1024

    def __init__(self, f, limit: int = core.PS_CLIP):
        self.f, self.limit, self.buf, self.cut = f, limit, bytearray(), False
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self) -> None:
        read = getattr(self.f, "read1", self.f.read)  # read1: one OS read, returns what is there
        try:
            while chunk := read(self.CHUNK):
                self.buf += chunk
                if len(self.buf) > self.limit:
                    del self.buf[:len(self.buf) - self.limit]
                    self.cut = True
        except (OSError, ValueError):  # pipe broken or closed under us: keep what was read
            pass
        finally:
            try:
                self.f.close()
            except Exception:
                pass

    def join(self, until: float) -> bool:
        """Wait for EOF until the monotonic time `until`; True when the pipe is done."""
        self.thread.join(max(0.0, until - time.monotonic()))
        return not self.thread.is_alive()

    def text(self) -> tuple[str, bool]:
        out, cut = core.clip(bytes(self.buf).decode("utf-8", "replace"))
        return out, cut or self.cut


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ULONG_PTR)]


class _U(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _U)]


def _vk(vk: int, up: bool) -> INPUT:
    flags = (KEYEVENTF_KEYUP if up else 0) | (KEYEVENTF_EXTENDEDKEY if vk in core.EXTENDED else 0)
    return INPUT(type=INPUT_KEYBOARD, u=_U(ki=KEYBDINPUT(wVk=vk, wScan=0, dwFlags=flags, time=0, dwExtraInfo=0)))


def _uni(unit: int, up: bool) -> INPUT:
    flags = KEYEVENTF_UNICODE | (KEYEVENTF_KEYUP if up else 0)
    return INPUT(type=INPUT_KEYBOARD, u=_U(ki=KEYBDINPUT(wVk=0, wScan=unit, dwFlags=flags, time=0, dwExtraInfo=0)))


def _mouse(flags: int) -> INPUT:
    return INPUT(type=INPUT_MOUSE, u=_U(mi=MOUSEINPUT(dx=0, dy=0, mouseData=0, dwFlags=flags, time=0, dwExtraInfo=0)))


def _send(inputs: list[INPUT]) -> None:
    if not inputs:
        return
    arr = (INPUT * len(inputs))(*inputs)
    if user32.SendInput(len(inputs), arr, ctypes.sizeof(INPUT)) != len(inputs):
        raise OSError(ctypes.get_last_error(), "SendInput refused (not in the desktop session?)")


def press(vks: list[int], aimed=lambda: True) -> None:
    """Key down, short hold, key up. aimed() is checked right before the key-down, so a
    focus change after _aim() still refuses before anything is sent; a change between that
    check and the key-down is not caught (best effort, see Backend._aim)."""
    if not aimed():
        raise core.Refused(409, "target window lost the focus before the key was sent")
    _send([_vk(k, False) for k in vks])
    time.sleep(0.03)
    _send([_vk(k, True) for k in reversed(vks)])


def _char_inputs(ch: str) -> list[INPUT]:
    if ch == "\n":
        return [_vk(0x0D, False), _vk(0x0D, True)]
    if ch == "\t":
        return [_vk(0x09, False), _vk(0x09, True)]
    data = ch.encode("utf-16-le")
    units = [int.from_bytes(data[i:i + 2], "little") for i in range(0, len(data), 2)]  # surrogate pair: 2
    return [x for u in units for x in (_uni(u, False), _uni(u, True))]


def type_text(text: str, aimed=lambda: True, pause: float = 0.006) -> int:
    """Unicode keystrokes, one character per SendInput: Windows 11 Notepad dropped 16 of
    31 characters sent as one burst (live probe 2026-11-04). Newline is Enter, tab is Tab.
    aimed() is rechecked before every character (core.send_guarded): focus loss stops the
    rest with a 409 that says how many went out. Best effort: the character sent right as
    the owner switches windows can land in the new one."""
    chars = text.replace("\r\n", "\n").replace("\r", "\n")
    return core.send_guarded((_char_inputs(c) for c in chars), _send, aimed, len(chars), pause)


# ---- windows -------------------------------------------------------------

WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def _title(hwnd) -> str:
    n = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def _cloaked(hwnd) -> bool:
    val = wintypes.DWORD()
    dwmapi.DwmGetWindowAttribute(wintypes.HWND(hwnd), 14, ctypes.byref(val), ctypes.sizeof(val))  # DWMWA_CLOAKED
    return bool(val.value)


def _exe(pid: int) -> str:
    h = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(1024)
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return Path(buf.value).name
        return ""
    finally:
        kernel32.CloseHandle(h)


def list_windows() -> list[dict]:
    out: list[dict] = []
    fg = user32.GetForegroundWindow()

    def cb(hwnd, _):
        if user32.IsWindowVisible(hwnd) and not _cloaked(hwnd) and not user32.GetWindow(hwnd, 4):  # GW_OWNER
            title = _title(hwnd)
            if title:
                pid = wintypes.DWORD()
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                out.append({"hwnd": int(hwnd), "title": title, "pid": pid.value, "exe": _exe(pid.value),
                            "foreground": hwnd == fg})
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return out


def player_windows() -> list[dict]:
    """Every top-level window of the media player process, hidden ones too (Spotify closed
    to the tray keeps its main window hidden), for core.pick_player."""
    out: list[dict] = []

    def cb(hwnd, _):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if _exe(pid.value).lower() == core.PLAYER_EXE:
            cls = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, cls, 256)
            out.append({"hwnd": int(hwnd), "exe": core.PLAYER_EXE, "cls": cls.value, "title": _title(hwnd),
                        "visible": bool(user32.IsWindowVisible(hwnd)), "owned": bool(user32.GetWindow(hwnd, 4))})
        return True

    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return out


def appcommand(hwnd: int, command: int) -> None:
    """WM_APPCOMMAND to one window: no focus change, no keystroke reaches the owner's window.
    Raises unless the window handled it (a hung or closing player is an error, never a success)."""
    res = ULONG_PTR(0)
    if not user32.SendMessageTimeoutW(hwnd, WM_APPCOMMAND, hwnd, command << 16, SMTO_ABORTIFHUNG, 2000,
                                      ctypes.byref(res)):
        raise OSError(ctypes.get_last_error(), "media player did not answer WM_APPCOMMAND")
    if not res.value:
        raise RuntimeError("media player did not handle the command")


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.UINT), ("dwTime", wintypes.DWORD)]


def idle_seconds() -> float:
    """Seconds since the owner last touched the keyboard or mouse (callers wait before acting)."""
    info = LASTINPUTINFO(cbSize=ctypes.sizeof(LASTINPUTINFO))
    if not user32.GetLastInputInfo(ctypes.byref(info)):
        return -1.0
    return round(((kernel32.GetTickCount() - info.dwTime) & 0xFFFFFFFF) / 1000, 1)


def bring(hwnd: int) -> bool:
    """Same idiom as the listener (tools/capri/capri/win.py): AttachThreadInput, no keystroke."""
    if not hwnd or not user32.IsWindow(hwnd):
        return False
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
    fg = user32.GetForegroundWindow()
    if fg != hwnd:
        me = kernel32.GetCurrentThreadId()
        other = user32.GetWindowThreadProcessId(fg, None) if fg else 0
        attached = bool(other and other != me and user32.AttachThreadInput(me, other, True))
        try:
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
        finally:
            if attached:
                user32.AttachThreadInput(me, other, False)
    time.sleep(0.15)
    return user32.GetForegroundWindow() == hwnd


# ---- monitors and placement (hq-63nvj.13) ----------------------------------

class MONITORINFOEXW(ctypes.Structure):
    _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT), ("rcWork", wintypes.RECT),
                ("dwFlags", wintypes.DWORD), ("szDevice", wintypes.WCHAR * 32)]


MONITORENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HMONITOR, wintypes.HDC, ctypes.POINTER(wintypes.RECT),
                                     wintypes.LPARAM)
user32.EnumDisplayMonitors.argtypes = [wintypes.HDC, ctypes.c_void_p, MONITORENUMPROC, wintypes.LPARAM]
user32.GetMonitorInfoW.argtypes = [wintypes.HMONITOR, ctypes.POINTER(MONITORINFOEXW)]
user32.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
                                wintypes.UINT]
user32.IsZoomed.argtypes = [wintypes.HWND]
SW_MAXIMIZE = 3
SWP_NOZORDER, SWP_NOACTIVATE = 0x0004, 0x0010


def _rect(r) -> list[int]:
    return [r.left, r.top, r.right, r.bottom]


def monitors() -> list[dict]:
    """Every monitor in physical pixels (the process is per-monitor DPI aware), numbered by
    core.order_monitors: index, device, bounds and work [left, top, right, bottom], primary."""
    raw: list[dict] = []

    def cb(hmon, _hdc, _r, _):
        info = MONITORINFOEXW(cbSize=ctypes.sizeof(MONITORINFOEXW))
        if user32.GetMonitorInfoW(hmon, ctypes.byref(info)):
            raw.append({"device": info.szDevice, "bounds": _rect(info.rcMonitor), "work": _rect(info.rcWork),
                        "primary": bool(info.dwFlags & 1)})
        return True

    user32.EnumDisplayMonitors(None, None, MONITORENUMPROC(cb), 0)
    return core.order_monitors(raw)


def move_to(hwnd: int, mon: dict, maximize: bool) -> None:
    """Restore, center at the same size in the monitor's work area, then maximize if asked.
    SetWindowPos runs twice: crossing to a monitor with another scale makes the window resize
    itself on arrival (WM_DPICHANGED), and the second call puts the size back."""
    if not user32.IsWindow(hwnd):
        raise core.Refused(404, "no such window")
    if user32.IsIconic(hwnd) or user32.IsZoomed(hwnd):
        user32.ShowWindow(hwnd, SW_RESTORE)
    r = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    x, y, w, h = core.place(tuple(_rect(r)), tuple(mon["work"]))
    for _ in range(2):
        if not user32.SetWindowPos(hwnd, None, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE):
            raise OSError(ctypes.get_last_error(), "SetWindowPos failed")
    if maximize:
        user32.ShowWindow(hwnd, SW_MAXIMIZE)


def default_browser() -> str:
    """The exe the shell opens https links with. AssocQueryStringW resolves it the way Explorer
    does; reading UserChoice by hand is wrong on Windows 11, which keeps the live choice under
    UserChoiceLatest (on George UserChoice still said Edge while Brave was the default)."""
    shlwapi = ctypes.WinDLL("shlwapi")
    buf = ctypes.create_unicode_buffer(1024)
    n = wintypes.DWORD(1024)
    hr = shlwapi.AssocQueryStringW(0, 2, "https", "open", buf, ctypes.byref(n))  # ASSOCSTR_EXECUTABLE
    if hr != 0 or not buf.value:
        raise OSError(hr & 0xFFFFFFFF, "no default browser for https")
    return buf.value


def find_window(a: dict) -> int:
    """hwnd from an action's hwnd or title (substring, topmost match first)."""
    if a.get("hwnd") is not None:
        return a["hwnd"]
    q = a["title"].lower()
    hits = [w for w in list_windows() if q in w["title"].lower()]
    if not hits:
        raise core.Refused(404, "no window with that title")
    return hits[0]["hwnd"]


# ---- screenshot ----------------------------------------------------------

class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
                ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD)]


user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.PrintWindow.argtypes = [wintypes.HWND, wintypes.HDC, wintypes.UINT]


def grab(hwnd: int | None = None) -> tuple[bytes, int, int]:
    """The whole virtual screen (every monitor), or one window even when covered
    (PrintWindow, PW_RENDERFULLCONTENT), as top-down BGRA."""
    if hwnd is None:
        x, y = user32.GetSystemMetrics(76), user32.GetSystemMetrics(77)
        w, h = user32.GetSystemMetrics(78), user32.GetSystemMetrics(79)
    else:
        if not user32.IsWindow(hwnd):
            raise core.Refused(404, "no such window")
        r = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        x, y, w, h = 0, 0, r.right - r.left, r.bottom - r.top
        if w <= 0 or h <= 0:
            raise core.Refused(409, "window has no area (minimized?)")
    src = user32.GetDC(None)
    mem = gdi32.CreateCompatibleDC(src)
    bmi = BITMAPINFOHEADER(biSize=ctypes.sizeof(BITMAPINFOHEADER), biWidth=w, biHeight=-h, biPlanes=1,
                           biBitCount=32, biCompression=0)
    bits = ctypes.c_void_p()
    bmp = gdi32.CreateDIBSection(src, ctypes.byref(bmi), 0, ctypes.byref(bits), None, 0)
    old = gdi32.SelectObject(mem, bmp)
    try:
        if hwnd is not None:
            if not user32.PrintWindow(hwnd, mem, 2):
                raise OSError(ctypes.get_last_error(), "PrintWindow failed")
        elif not gdi32.BitBlt(mem, 0, 0, w, h, src, x, y, 0x00CC0020 | 0x40000000):  # SRCCOPY | CAPTUREBLT
            raise OSError(ctypes.get_last_error(), "BitBlt failed")
        data = ctypes.string_at(bits, w * h * 4)
    finally:
        gdi32.SelectObject(mem, old)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mem)
        user32.ReleaseDC(None, src)
    return data, w, h


# ---- backend -------------------------------------------------------------

class Backend:
    APPS_TTL = 300
    KEEP_SHOTS = 50

    def __init__(self, cfg: core.Config):
        self.cfg = cfg
        self._apps: list[tuple[str, str]] = []
        self._apps_at = 0.0
        try:  # physical pixels, so click coordinates match the screenshot
            user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        except AttributeError:
            pass

    def run(self, a: dict) -> dict:
        return getattr(self, "do_" + a["action"])(a)

    def do_open_url(self, a):
        """Plain: the default browser decides (often a new tab). With new_window or monitor:
        start the default browser with --new-window, wait for the window that was not there
        before, and move it (maximized unless maximize is false)."""
        if not a.get("new_window") and "monitor" not in a:
            os.startfile(a["url"].strip())
            return {}
        exe = default_browser()
        name = ntpath.basename(exe).lower()
        before = {w["hwnd"] for w in list_windows() if w["exe"].lower() == name}
        subprocess.Popen(core.browser_argv(exe, a["url"]), creationflags=CREATE_NO_WINDOW)
        hwnd = None
        deadline = time.monotonic() + 10
        while hwnd is None and time.monotonic() < deadline:
            time.sleep(0.1)
            new = [w["hwnd"] for w in list_windows() if w["exe"].lower() == name and w["hwnd"] not in before]
            hwnd = new[0] if new else None
        if hwnd is None:
            raise core.Refused(504, f"opened in {name}, but no new window appeared to move")
        out = {"browser": name, "hwnd": hwnd}
        if "monitor" in a:
            mon, fell_back = core.pick_monitor(monitors(), a["monitor"])
            move_to(hwnd, mon, a.get("maximize", True))
            out.update(monitor=mon["index"], fallback=fell_back)
        # A browser started from this background process may open behind the owner's window.
        out["front"] = bring(hwnd)
        return out

    def do_monitors(self, a):
        return {"monitors": monitors()}

    def do_move_window(self, a):
        hwnd = find_window(a)
        mon, fell_back = core.pick_monitor(monitors(), a["monitor"])
        move_to(hwnd, mon, a.get("maximize", False))
        return {"hwnd": hwnd, "title": _title(hwnd), "monitor": mon["index"], "fallback": fell_back,
                "front": bring(hwnd)}

    def do_settings(self, a):
        os.startfile(a["uri"])
        return {"uri": a["uri"]}

    def do_audio_devices(self, a):
        return audio.devices()

    def _set_audio(self, a, kind: str):
        """Make the match the default for one role (`role` 0 to 2) or, without it, all three."""
        found = audio.devices()
        listed = found[kind + "s"]
        dev, matches = core.match_device(a["name"], listed, a.get("fuzzy", True))
        if dev is None:
            raise core.Refused(404, f"no {kind} device matches; have: " + "; ".join(d["name"] for d in listed))
        roles = (a["role"],) if "role" in a else audio.ROLES
        prev_id = found.get("defaults", {}).get(kind, {}).get(audio.ROLE_NAMES[roles[0]])
        if prev_id is None and roles[0] == 0:
            prev_id = next((d["id"] for d in listed if d["default"]), None)
        previous = next((d["name"] for d in listed if d["id"] == prev_id), None)
        audio.set_default(dev["id"], roles=roles)
        return {"device": dev["name"], "id": dev["id"], "previous": previous, "matches": matches,
                "roles": [audio.ROLE_NAMES[r] for r in roles]}

    def do_audio_output(self, a):
        return self._set_audio(a, "output")

    def do_audio_input(self, a):
        return self._set_audio(a, "input")

    def do_volume(self, a):
        now = audio.volume()
        level, mute = core.volume_target(now["level"], a)
        if level is None and mute is None:
            return now
        return {**audio.volume(level, mute), "previous": now["level"], "was_muted": now["muted"]}

    def do_powershell(self, a):
        """Run a script as the owner in his session (Windows PowerShell 5.1, no profile). The
        reply carries stdout, stderr and exit_code; a run past timeout_s is killed with every
        descendant (job object) and answers timed_out with exit_code null within timeout_s
        plus DRAIN_S, whatever the children do with the pipes."""
        job = _new_job()  # no job, no run
        work = self.cfg.home / "ps"
        path = work / f"run-{os.getpid()}-{time.monotonic_ns()}.ps1"
        try:
            work.mkdir(parents=True, exist_ok=True)
            path.write_text(core.PS_PRELUDE + a["script"], encoding="utf-8-sig")  # 5.1 reads non-ASCII only with a BOM
            p = subprocess.Popen(
                ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(path)],
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                creationflags=CREATE_NO_WINDOW | CREATE_SUSPENDED)
            _join_job(job, p)
            tails = [_Tail(p.stdout), _Tail(p.stderr)]
            deadline = time.monotonic() + a["timeout_s"]
            try:  # done means powershell exited AND both pipes closed, before the deadline
                p.wait(timeout=a["timeout_s"])
                timed_out = not all(t.join(deadline) for t in tails)
            except subprocess.TimeoutExpired:
                timed_out = True
            if timed_out:
                kernel32.TerminateJobObject(job, 1)  # powershell and every descendant, pipes close
                end = time.monotonic() + DRAIN_S
                for t in tails:
                    t.join(end)  # a pipe still open after DRAIN_S is left to its daemon thread
            else:
                _job_limits(job, 0)  # a finished run keeps what it started (Start-Process notepad)
        finally:
            kernel32.CloseHandle(job)
            path.unlink(missing_ok=True)
        (stdout, cut_out), (stderr, cut_err) = (t.text() for t in tails)
        return {"exit_code": None if timed_out else p.returncode, "timed_out": timed_out,
                "stdout": stdout, "stderr": stderr, "truncated": cut_out or cut_err}

    def start_apps(self) -> list[tuple[str, str]]:
        if not self._apps or time.monotonic() - self._apps_at > self.APPS_TTL:
            out = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command",
                 "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress"],
                capture_output=True, text=True, timeout=20, creationflags=CREATE_NO_WINDOW,
            ).stdout
            rows = json.loads(out or "[]")
            rows = [rows] if isinstance(rows, dict) else rows
            self._apps = [(r["Name"], r["AppID"]) for r in rows if r.get("Name") and r.get("AppID")]
            self._apps_at = time.monotonic()
        return self._apps

    def do_open_app(self, a):
        hit = core.match_app(a["name"], self.start_apps())
        if not hit:
            raise core.Refused(404, "no app by that name")
        name, appid = hit
        subprocess.Popen(["explorer.exe", "shell:AppsFolder\\" + appid], creationflags=CREATE_NO_WINDOW)
        return {"app": name}

    def do_list_windows(self, a):
        return {"windows": list_windows(), "idle_s": idle_seconds()}

    def do_focus_window(self, a):
        hwnd = find_window(a)  # EnumWindows is z-order: the topmost match
        if not bring(hwnd):
            raise core.Refused(409, "window did not take the focus")
        return {"hwnd": hwnd, "title": _title(hwnd)}

    def _aim(self, a):
        """With hwnd: focus it and refuse unless it is in front right now. Returns the check
        the senders repeat before every character or key. Best effort: SendInput is global
        and the check and the send are not atomic, so a window the owner switches to in that
        instant can get about one character (or the key); the next check then stops the rest."""
        hwnd = a.get("hwnd")
        if hwnd is None:
            return lambda: True
        bring(hwnd)
        if user32.GetForegroundWindow() != hwnd:
            raise core.Refused(409, "target window is not in front")
        return lambda: user32.GetForegroundWindow() == hwnd

    def do_type_text(self, a):
        aimed = self._aim(a)
        return {"chars": type_text(a["text"], aimed)}

    def do_key(self, a):
        press(core.parse_combo(a["combo"]), self._aim(a))
        return {}

    def do_media(self, a):
        cmd = a["command"]
        if cmd in core.APPCOMMAND:
            hwnd = core.pick_player(player_windows())
            if hwnd is None:
                raise core.Refused(404, "no media player: Spotify is not running")
            appcommand(hwnd, core.APPCOMMAND[cmd])
            return {"player": "Spotify", "hwnd": hwnd}
        press([core.MEDIA[cmd]])
        return {}

    def do_media_status(self, a):
        """Windows media sessions (GSMTC) as seen in the owner's session: which app the media
        keys reach (current) and each session's playback status. Empty from ssh."""
        script = Path(__file__).with_name("media_status.ps1")
        if not script.is_file():
            raise RuntimeError(f"media_status helper missing: {script.name} not installed")
        p = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script)],
            capture_output=True, text=True, timeout=20, creationflags=CREATE_NO_WINDOW,
        )
        return core.parse_media_status(p.returncode, p.stdout, p.stderr)

    def do_spotify_play(self, a):
        return spotify.play(a["query"], spotify.runner())

    def do_click(self, a):
        if not user32.SetCursorPos(a["x"], a["y"]):
            raise OSError(ctypes.get_last_error(), "SetCursorPos failed")
        down, up = MOUSE[a.get("button", "left")]
        for _ in range(2 if a.get("double") else 1):
            _send([_mouse(down), _mouse(up)])
            time.sleep(0.05)
        return {}

    def do_screenshot(self, a):
        bgra, w, h = grab(a.get("hwnd"))
        self.cfg.shots.mkdir(parents=True, exist_ok=True)
        t = time.time()
        name = time.strftime("shot-%Y%m%d-%H%M%S-", time.localtime(t)) + f"{int(t * 1000) % 1000:03d}.png"
        path = self.cfg.shots / name
        path.write_bytes(core.bgra_to_png(bgra, w, h))
        for old in sorted(self.cfg.shots.glob("shot-*.png"))[:-self.KEEP_SHOTS]:
            old.unlink(missing_ok=True)
        return {"name": name, "path": str(path), "width": w, "height": h}
