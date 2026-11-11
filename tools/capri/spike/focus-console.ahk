; Click the "Orchestrator Console" browser tab, then screenshot. Args: <outdir>
out := A_Args[1]
DirCreate out
CoordMode("Mouse", "Screen")
Click(605, 322)
Sleep(1500)
ps := "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;$g=[System.Drawing.Graphics]::FromImage($bmp);$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);$bmp.Save('" out "\console.png')"
RunWait("powershell -NoProfile -Command `"" ps "`"",, "Hide")
