; AutoHotkey v2. Run in the owner's interactive session (scheduled task /IT).
; Usage: AutoHotkey64.exe send-hotkey.ahk <ptt|handsfree> <outdir>
mode := A_Args[1], out := A_Args[2]
DirCreate out
Shot(name) {
    global out
    ps := "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;"
        . "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;"
        . "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;"
        . "$g=[System.Drawing.Graphics]::FromImage($bmp);"
        . "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);"
        . "$bmp.Save('" out "\" name ".png')"
    RunWait("powershell -NoProfile -Command `"" ps "`"",, "Hide")
}
FileAppend(FormatTime(, "HH:mm:ss") " active window: " WinGetTitle("A") "`n", out "\log.txt")
Shot(mode "-0-before")
if (mode = "ptt") {
    Send("{LCtrl down}{LWin down}")
    Sleep(2500)
    Shot(mode "-1-held")
    Send("{LWin up}{LCtrl up}")
} else if (mode = "dictate") {
    ; start hands-free, leave 15s for speech, then send again to stop
    Send("{LCtrl down}{LWin down}{Space down}")
    Sleep(150)
    Send("{Space up}{LWin up}{LCtrl up}")
    Sleep(15000)
    Shot(mode "-1-speaking")
    Send("{LCtrl down}{LWin down}{Space down}")
    Sleep(150)
    Send("{Space up}{LWin up}{LCtrl up}")
    Sleep(4000)
    Shot(mode "-2-after")
    ExitApp
} else {
    Send("{LCtrl down}{LWin down}{Space down}")
    Sleep(150)
    Send("{Space up}{LWin up}{LCtrl up}")
    Sleep(2500)
    Shot(mode "-1-after")
    Send("{LCtrl down}{LWin down}{Space down}")
    Sleep(150)
    Send("{Space up}{LWin up}{LCtrl up}")
}
Sleep(1500)
Shot(mode "-2-end")
