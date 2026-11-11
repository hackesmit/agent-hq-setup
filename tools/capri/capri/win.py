"""Windows side: the Flow hotkey, the Capri window, focus save and restore, chimes.

Runs inside the owner's desktop session (the logon task is /IT), where SendInput
reaches the desktop; from an ssh session it would not. The only keystroke it
sends is Flow's Ctrl+Win+Space; it never presses Enter (design change 2026-11-04).
"""
from __future__ import annotations

import ctypes
import threading
import time
from ctypes import wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)

# The only keys the listener ever sends: the Wispr Flow hands-free hotkey.
VK_LCONTROL, VK_LWIN, VK_SPACE = 0xA2, 0x5B, 0x20
KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP = 0x0001, 0x0002
INPUT_KEYBOARD = 1
SW_RESTORE = 9
ULONG_PTR = ctypes.c_size_t


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


EXTENDED = {VK_LWIN}  # Win is an extended key


def _key(vk: int, up: bool) -> INPUT:
    flags = (KEYEVENTF_KEYUP if up else 0) | (KEYEVENTF_EXTENDEDKEY if vk in EXTENDED else 0)
    return INPUT(type=INPUT_KEYBOARD, u=_U(ki=KEYBDINPUT(wVk=vk, wScan=0, dwFlags=flags, time=0, dwExtraInfo=0)))


def _send(*inputs: INPUT) -> None:
    arr = (INPUT * len(inputs))(*inputs)
    if user32.SendInput(len(inputs), arr, ctypes.sizeof(INPUT)) != len(inputs):
        raise OSError(ctypes.get_last_error(), "SendInput refused")


def hotkey() -> None:
    """Wispr Flow hands-free: Ctrl+Win+Space (Flow config shortcuts 162+32+91)."""
    _send(_key(VK_LCONTROL, False), _key(VK_LWIN, False), _key(VK_SPACE, False))
    time.sleep(0.15)
    _send(_key(VK_SPACE, True), _key(VK_LWIN, True), _key(VK_LCONTROL, True))


kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)


def foreground():
    """The window that has the focus now (to give it back later), or None."""
    return user32.GetForegroundWindow() or None


def bring(hwnd) -> bool:
    """Put hwnd in front with the keyboard focus, sending no key. True when it got it.

    Windows refuses SetForegroundWindow to a process that did not get the last
    input. Attaching this thread's input to the foreground window's thread for
    the call lifts that, with no keystroke on the desktop.
    """
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


class CapriWindow:
    """A small square always-on-top box in the corner, owned by the listener.

    During a dictation it holds the focus, so Wispr Flow's paste lands in its
    text box and never in the owner's windows. Tk runs on its own thread; the other
    threads only queue commands. The pasted text is cleared on every hide.
    """

    SIZE = 168
    LABELS = {"listening": "listening", "sending": "sending", "orchestrator not running": "orchestrator\nnot running"}

    def __init__(self):
        import queue

        self.q: "queue.Queue" = queue.Queue()
        self.ready = threading.Event()
        self.hwnd = None
        threading.Thread(target=self._run, daemon=True, name="capri-window").start()
        self.ready.wait(5)

    def _run(self):
        import tkinter as tk

        root = tk.Tk()
        root.withdraw()
        root.title("Capri")
        root.attributes("-toolwindow", True)  # a real top-level window: it can take the keyboard focus
        root.attributes("-topmost", True)
        root.resizable(False, False)
        root.configure(bg="#14141c", highlightthickness=2, highlightbackground="#e23c78")
        x = root.winfo_screenwidth() - self.SIZE - 24
        y = root.winfo_screenheight() - self.SIZE - 72
        root.geometry(f"{self.SIZE}x{self.SIZE}+{x}+{y}")
        tk.Label(root, text="Capri", fg="#e23c78", bg="#14141c", font=("Segoe UI Semibold", 18)).pack(pady=(18, 2))
        state = tk.Label(root, text="", fg="#d8d8e0", bg="#14141c", font=("Segoe UI", 11), justify="center")
        state.pack()
        box = tk.Text(root, height=2, width=16, bg="#1e1e28", fg="#14141c", insertbackground="#1e1e28", relief="flat", font=("Segoe UI", 7))
        box.pack(pady=(10, 0))  # Flow's paste lands here; drawn in the background colour
        self.hwnd = None

        def pump():
            while not self.q.empty():
                cmd, arg, done = self.q.get_nowait()
                if cmd == "show":
                    state.configure(text=self.LABELS.get(arg, arg))
                    root.deiconify()
                    root.lift()
                    box.focus_set()
                    root.update_idletasks()
                    self.hwnd = int(root.wm_frame(), 16)  # the outer window Windows gives the focus to
                elif cmd == "hide":
                    box.delete("1.0", "end")
                    root.withdraw()
                if done:
                    done.set()
            root.after(50, pump)

        root.after(50, pump)
        self.ready.set()
        root.mainloop()

    def _cmd(self, cmd, arg=None, wait=True):
        done = threading.Event() if wait else None
        self.q.put((cmd, arg, done))
        if done:
            done.wait(2)

    def show(self, state: str) -> None:
        self._cmd("show", state)

    def hide(self) -> None:
        self._cmd("hide")

    def focus(self, state: str):
        """Show the window with this state, give it the focus; return the window that had it."""
        prev = foreground()
        self.show(state)
        bring(self.hwnd)
        return prev

    def restore(self, prev) -> None:
        """Give the focus back, unless the owner already moved it himself."""
        if prev and self.hwnd and user32.GetForegroundWindow() == self.hwnd:
            bring(prev)


TONES = {"heard": [(880, 70), (1320, 90)], "none": [(330, 160), (262, 220)], "done": [(660, 90)]}


def chime(kind: str) -> None:
    import winsound

    def play():
        for hz, ms in TONES.get(kind, []):
            winsound.Beep(hz, ms)

    threading.Thread(target=play, daemon=True).start()
