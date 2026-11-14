// cu.exe - Win32 + UI Automation bridge for DSH computer control.
// Single-file C# 5 (compiled with the in-box .NET Framework 4 csc.exe).
// Protocol: argv -> JSON on stdout. Every command is one process invocation.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;

static class Native
{
    // ---------- DPI ----------
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern int GetDpiForWindow(IntPtr hwnd);
    [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmon, int type, out uint dpiX, out uint dpiY);

    // ---------- Message queue ----------
    [StructLayout(LayoutKind.Sequential)]
    public struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int x;
        public int y;
    }
    [DllImport("user32.dll", EntryPoint = "PeekMessageW")]
    public static extern bool PeekMessage(out MSG m, IntPtr hwnd, uint min, uint max, uint remove);

    public static void EnsureMessageQueue()
    {
        MSG m;
        PeekMessage(out m, IntPtr.Zero, 0, 0, 0);
    }

    // ---------- Windows ----------
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out int pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint action, uint param, ref uint winIni, uint flags);
    // Undocumented but long-exported: force-activates a window without going
    // through the foreground-lock heuristics SetForegroundWindow enforces.
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);

    // ---------- Toolhelp ----------
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W pe);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W pe);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool QueryFullProcessImageNameW(IntPtr h, uint flags, StringBuilder buf, ref int size);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    // ---------- Monitors ----------
    [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, EnumProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMon, ref MONITORINFO mi);
    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

    // ---------- Cursor / metrics ----------
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

    // ---------- SendInput ----------
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int cb);
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint uCode, uint uMapType);
    [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint idThread);
    [DllImport("user32.dll")] public static extern IntPtr LoadKeyboardLayout(string pwszKLID, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    // WM_GETTEXT needs a mutable buffer as lParam; this overload is the one that
    // reads win32 edit controls without touching their selection or caret.
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageText(IntPtr hWnd, uint msg, IntPtr wParam, StringBuilder lParam);
    [DllImport("user32.dll")] public static extern int GetKeyboardLayoutList(int nBuff, IntPtr[] lpList);
    [DllImport("imm32.dll")] public static extern IntPtr ImmAssociateContext(IntPtr hWnd, IntPtr hIMC);
    [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO { public int cbSize; public uint flags; public IntPtr hwndActive; public IntPtr hwndFocus; public IntPtr hwndCapture; public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret; public int rcLeft; public int rcTop; public int rcRight; public int rcBottom; }
    [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO pgui);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    public const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    public const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004,
        MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010, MOUSEEVENTF_MIDDLEDOWN = 0x0020,
        MOUSEEVENTF_MIDDLEUP = 0x0040, MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000,
        MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004,
        KEYEVENTF_SCANCODE = 0x0008;

    // ---------- Shell ----------
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int SendMessageW(IntPtr h, int msg, IntPtr w, string l);

    // ---------- geometry ----------
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lp);

    // ---------- integrity / input health ----------
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr proc, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr token, int cls, out uint buf, int len, out int ret);
    [DllImport("advapi32.dll", SetLastError = true, EntryPoint = "GetTokenInformation")] public static extern bool GetTokenInformationBuf(IntPtr token, int cls, IntPtr buf, int len, out int ret);
    [DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
    [DllImport("advapi32.dll")] public static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
    [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetUserObjectInformationW(IntPtr h, int index, StringBuilder buf, int len, out int needed);
}

static class J
{
    public static string Esc(string s)
    {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder(s.Length + 16);
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': b.Append("\\\""); break;
                case '\\': b.Append("\\\\"); break;
                case '\n': b.Append("\\n"); break;
                case '\r': b.Append("\\r"); break;
                case '\t': b.Append("\\t"); break;
                default:
                    if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
                    else b.Append(c);
                    break;
            }
        }
        return b.ToString();
    }
    public static string S(string s) { return s == null ? "null" : "\"" + Esc(s) + "\""; }
    public static string N(int v) { return v.ToString(CultureInfo.InvariantCulture); }
    public static string B(bool v) { return v ? "true" : "false"; }
}

sealed class Cmd
{
    public string Name;
    public Dictionary<string, string> Opt = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    public HashSet<string> Flag = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

    public static Cmd Parse(string[] a)
    {
        Cmd c = new Cmd();
        if (a.Length == 0) { c.Name = "help"; return c; }
        c.Name = a[0].ToLowerInvariant();
        for (int i = 1; i < a.Length; i++)
        {
            string s = a[i];
            if (!s.StartsWith("--")) continue;
            string key = s.Substring(2);
            int eq = key.IndexOf('=');
            if (eq >= 0) { c.Opt[key.Substring(0, eq)] = key.Substring(eq + 1); continue; }
            if (i + 1 < a.Length && !a[i + 1].StartsWith("--")) c.Opt[key] = a[++i];
            else c.Flag.Add(key);
        }
        return c;
    }
    public string Get(string k, string dflt)
    {
        string v; return Opt.TryGetValue(k, out v) ? v : dflt;
    }
    public int I(string k, int dflt)
    {
        string v; int r;
        return Opt.TryGetValue(k, out v) && int.TryParse(v, NumberStyles.Integer, CultureInfo.InvariantCulture, out r) ? r : dflt;
    }
    public bool Has(string k) { return Opt.ContainsKey(k) || Flag.Contains(k); }
}

static class Program
{
    const int MAX_NODES_DEFAULT = 350;
    const int MAX_DEPTH_DEFAULT = 9;

    [STAThread]
    static int Main(string[] args)
    {
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
        try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch { try { Native.SetProcessDPIAware(); } catch { } }
        // SetForegroundWindow / the ALT release trick only take effect for a
        // thread that owns a message queue, so force one into existence before
        // anything else runs (PeekMessage creates it as a side effect).
        Native.EnsureMessageQueue();

        Cmd c = Cmd.Parse(args);
        try
        {
            switch (c.Name)
            {
                case "help": Help(); return 0;
                case "info": Info(); break;
                case "windows": Windows(c); break;
                case "shot": Shot(c); break;
                case "tree": Tree(c); break;
                case "ui": Ui(c); break;
                case "find": Find(c); break;
                case "hit": Hit(c); break;
            case "inputcheck": InputCheck(); break;
            case "hover": Hover(c); break;
            case "geom": Geom(c); break;
            case "modals": Modals(c); break;
                case "readtext": ReadText(c); break;
                case "waittext": WaitText(c); break;
                case "move": Mouse(c, "move"); break;
                case "click": Mouse(c, "click"); break;
                case "scroll": Mouse(c, "scroll"); break;
                case "drag": Drag(c); break;
                case "type": TypeText(c); break;
                case "typekeys": TypeKeys(c); break;
                case "ime": Ime(c); break;
                case "typepost": TypePost(c); break;
                case "key": KeyCombo(c); break;
                case "focus": Focus(c); break;
                case "launch": Launch(c); break;
                case "kill": Kill(c); break;
                case "procs": Procs(c); break;
                case "clip": Clip(c); break;
                case "invoke": Invoke(c); break;
                case "wait": Thread.Sleep(Math.Max(0, c.I("ms", 500))); break;
                default: Err("unknown command: " + c.Name); return 2;
            }
            return 0;
        }
        catch (Exception ex)
        {
            Err(ex.GetType().Name + ": " + ex.Message);
            return 1;
        }
    }

    // stdout must be UTF-8 bytes no matter what: this is a WINEXE, so when the
    // caller redirects stdout (a pipe from the DSH plugin, or `> file` in a
    // shell) there is no console to carry an OutputEncoding and .NET falls back
    // to the ANSI code page (CP936 here), which turned every Chinese window
    // title into mojibake. Writing to the raw standard-output stream with an
    // explicit UTF-8 encoder sidesteps the console stack entirely.
    static readonly TextWriter Out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false), 65536) { AutoFlush = true };

    static void Err(string msg)
    {
        Out.Write("{\"ok\":false,\"error\":" + J.S(msg) + "}\n");
        Out.Flush();
    }

    static void Emit(string json)
    {
        Out.Write(json + "\n");
        Out.Flush();
    }

    static void Help()
    {
        string h =
"cu.exe - Windows GUI bridge for DSH\n" +
"commands:\n" +
"  info                          monitors, dpi, cursor, foreground window\n" +
"  windows [--all]               list top-level windows\n" +
"  shot --out FILE [--hwnd H] [--region l,t,r,b] [--trim] [--tol N] [--pad N] [--min-bytes N] [--nocursor] [--printwindow]\n" +
"  readtext [--hwnd H] [--chars N]   read the window's text back (UIA text/value, else win32)\n" +
"  waittext --regex R [--hwnd H] [--timeout MS]   poll readtext until the text matches\n" +
"  tree [--hwnd H] [--depth N] [--max N]   UI Automation control-view tree with element ids\n" +
"  ui [--hwnd H] [--depth N] [--max N]   compact inventory: named/actionable controls only\n" +
"  find --name TEXT [--hwnd H]   search UIA elements by name/automationId\n" +
"  hit --x X --y Y               what is under a screen point\n" +
"  inputcheck                    prove that synthetic input actually lands (do this first)\n" +
"  hover --x X --y Y [--ms 1000] move, dwell, then read what the pointer rests on\n" +
"  geom [--hwnd H]               window/client rectangles, client origin, dpi\n" +
"  modals [--pid N]              dialog-like / disabled windows that swallow input\n" +
"  move --x X --y Y [--relx N --rely N]\n" +
"  click [--x X] [--y Y] [--relx N --rely N] [--hwnd H] [--button left|right|middle] [--count N] [--double]\n" +
"  scroll [--x X] [--y Y] [--amount N] [--horizontal]\n" +
"  drag --x1 X --y1 Y --x2 X --y2 Y [--ms 400]\n" +
"  type --text TEXT | --textfile FILE [--verify]   (unicode via KEYEVENTF_UNICODE)\n" +
"  typekeys --text TEXT [--verify]   real virtual keys (for Qt/secure fields that drop VK_PACKET)\n" +
"  typepost --text TEXT   WM_CHAR to the focused window (last resort)\n" +
"  ime [--list] [--hwnd H] [--disable]   switch to the en-US layout / detach IME contexts\n" +
"  key --combo ctrl+shift+s | --text \"{ENTER}\" style combos comma separated\n" +
"  focus --hwnd H\n" +
"  launch --path P [--args A] [--cwd D]\n" +
"  kill --pid N | --name NAME\n" +
"  procs [--name FILTER]\n" +
"  clip --get | --text TEXT | --textfile FILE\n" +
"  invoke --hwnd H --path 0.1.2   UIA invoke/toggle/setvalue/click fallback\n" +
"  wait --ms N\n";
        Out.Write(h);
    }

    // ---------------- info / windows ----------------

    sealed class Mon { public int L, T, R, B, WL, WT, WR, WB; public uint DpiX, DpiY; public bool Primary; }

    static List<Mon> Monitors()
    {
        List<Mon> list = new List<Mon>();
        Native.EnumProc cb = delegate(IntPtr h, IntPtr lp)
        {
            Native.MONITORINFO mi = new Native.MONITORINFO();
            mi.cbSize = Marshal.SizeOf(typeof(Native.MONITORINFO));
            if (!Native.GetMonitorInfo(h, ref mi)) return true;
            Mon m = new Mon();
            m.L = mi.rcMonitor.Left; m.T = mi.rcMonitor.Top; m.R = mi.rcMonitor.Right; m.B = mi.rcMonitor.Bottom;
            m.WL = mi.rcWork.Left; m.WT = mi.rcWork.Top; m.WR = mi.rcWork.Right; m.WB = mi.rcWork.Bottom;
            m.Primary = (mi.dwFlags & 1) != 0;
            uint dx = 96, dy = 96;
            try { Native.GetDpiForMonitor(h, 0, out dx, out dy); } catch { }
            m.DpiX = dx; m.DpiY = dy;
            list.Add(m);
            return true;
        };
        Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
        return list;
    }

    static void Info()
    {
        StringBuilder o = new StringBuilder();
        o.Append("{\"ok\":true");
        o.Append(",\"screenW\":").Append(Native.GetSystemMetrics(0));
        o.Append(",\"screenH\":").Append(Native.GetSystemMetrics(1));
        o.Append(",\"virtualX\":").Append(Native.GetSystemMetrics(76));
        o.Append(",\"virtualY\":").Append(Native.GetSystemMetrics(77));
        o.Append(",\"virtualW\":").Append(Native.GetSystemMetrics(78));
        o.Append(",\"virtualH\":").Append(Native.GetSystemMetrics(79));
        Native.POINT p; Native.GetCursorPos(out p);
        o.Append(",\"cursor\":{\"x\":").Append(p.X).Append(",\"y\":").Append(p.Y).Append('}');
        List<Mon> ms = Monitors();
        o.Append(",\"monitors\":[");
        for (int i = 0; i < ms.Count; i++)
        {
            if (i > 0) o.Append(',');
            Mon m = ms[i];
            o.Append("{\"index\":").Append(i);
            o.Append(",\"x\":").Append(m.L).Append(",\"y\":").Append(m.T);
            o.Append(",\"w\":").Append(m.R - m.L).Append(",\"h\":").Append(m.B - m.T);
            o.Append(",\"workX\":").Append(m.WL).Append(",\"workY\":").Append(m.WT);
            o.Append(",\"workW\":").Append(m.WR - m.WL).Append(",\"workH\":").Append(m.WB - m.WT);
            o.Append(",\"dpi\":").Append(m.DpiX);
            o.Append(",\"scale\":").Append((m.DpiX / 96.0).ToString("0.##", CultureInfo.InvariantCulture));
            o.Append(",\"primary\":").Append(J.B(m.Primary)).Append('}');
        }
        o.Append(']');
        o.Append(",\"privileged\":").Append(J.B(Privileged()));
        o.Append(",\"uiRestrictions\":").Append(UiRestrictions());
        string desk;
        bool locked = SessionLocked(out desk);
        o.Append(",\"locked\":").Append(J.B(locked));
        o.Append(",\"lockAppRunning\":").Append(J.B(LockAppRunning()));
        if (desk != null) o.Append(",\"inputDesktopName\":").Append(J.S(desk));
        o.Append(",\"foreground\":").Append(WinJson(Native.GetForegroundWindow()));
        o.Append('}');
        Emit(o.ToString());
    }

    static Dictionary<int, string> procCache;

    static Dictionary<int, string> ProcMap()
    {
        if (procCache != null) return procCache;
        Dictionary<int, string> d = new Dictionary<int, string>();
        IntPtr snap = Native.CreateToolhelp32Snapshot(2, 0);
        if (snap == IntPtr.Zero || snap == new IntPtr(-1)) { procCache = d; return d; }
        try
        {
            Native.PROCESSENTRY32W pe = new Native.PROCESSENTRY32W();
            pe.dwSize = (uint)Marshal.SizeOf(typeof(Native.PROCESSENTRY32W));
            if (Native.Process32FirstW(snap, ref pe))
            {
                do { d[(int)pe.th32ProcessID] = (pe.szExeFile == null ? "" : pe.szExeFile); }
                while (Native.Process32NextW(snap, ref pe));
            }
        }
        finally { Native.CloseHandle(snap); }
        procCache = d;
        return d;
    }

    static string ProcNameOf(int pid)
    {
        string s;
        if (ProcMap().TryGetValue(pid, out s)) return s;
        // A sandboxed caller sees a filtered Toolhelp list; ask the kernel about
        // this pid directly so window.owner stays useful and the safety guard works.
        IntPtr h = Native.OpenProcess(0x1000 /* QUERY_LIMITED_INFORMATION */, false, pid);
        if (h == IntPtr.Zero) return "";
        try
        {
            int size = 1024;
            StringBuilder sb = new StringBuilder(size);
            if (!Native.QueryFullProcessImageNameW(h, 0, sb, ref size)) return "";
            string full = sb.ToString(0, size);
            int cut = full.LastIndexOf('\\');
            return cut >= 0 ? full.Substring(cut + 1) : full;
        }
        finally { Native.CloseHandle(h); }
    }

    static Dictionary<int, IntPtr> MainWindows()
    {
        Dictionary<int, IntPtr> d = new Dictionary<int, IntPtr>();
        Native.EnumWindows(delegate(IntPtr h, IntPtr lp)
        {
            if (!Native.IsWindowVisible(h)) return true;
            int pid; Native.GetWindowThreadProcessId(h, out pid);
            if (pid == 0) return true;
            if (d.ContainsKey(pid)) return true;
            if (WindowTitle(h).Length == 0) return true;
            d[pid] = h;
            return true;
        }, IntPtr.Zero);
        return d;
    }

    static string WindowTitle(IntPtr h)
    {
        StringBuilder t = new StringBuilder(512);
        Native.GetWindowTextW(h, t, t.Capacity);
        return t.ToString();
    }

    // DSH's shell sandbox puts child processes in a job object with UI
    // restrictions (JOB_OBJECT_UILIMIT_*). In that state the window manager
    // refuses SetForegroundWindow for other processes' windows and silently
    // drops injected input aimed at them - a very confusing failure mode, so
    // measure it directly and report it.
    [StructLayout(LayoutKind.Sequential)]
    public struct UI_RESTRICTIONS { public uint Class; }
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr job, int infoClass, ref UI_RESTRICTIONS info, int len, IntPtr ret);

    public static int UiRestrictions()
    {
        UI_RESTRICTIONS r;
        r.Class = 0;
        // job handle NULL => the job the calling process belongs to
        if (!QueryInformationJobObject(IntPtr.Zero, 4 /*JobObjectBasicUIRestrictions*/, ref r, Marshal.SizeOf(typeof(UI_RESTRICTIONS)), IntPtr.Zero)) return 0;
        return (int)r.Class;
    }

    static bool Privileged()
    {
        return UiRestrictions() == 0;
    }

    const string SandboxHint =
        " (this process is running with a restricted token - e.g. inside DSH's shell sandbox - which cannot drive other applications; the DSH plugin runs in the app process without that limit)";

    static string WinJson(IntPtr h)
    {
        if (h == IntPtr.Zero) return "null";
        StringBuilder t = new StringBuilder(512), cl = new StringBuilder(256);
        Native.GetWindowTextW(h, t, t.Capacity);
        Native.GetClassNameW(h, cl, cl.Capacity);
        Native.RECT r; Native.GetWindowRect(h, out r);
        Native.RECT fr; fr = r;
        try { Native.DwmGetWindowAttribute(h, 9, out fr, Marshal.SizeOf(typeof(Native.RECT))); } catch { }
        int pid; Native.GetWindowThreadProcessId(h, out pid);
        string pname = ProcNameOf(pid);
        StringBuilder b = new StringBuilder();
        b.Append("{\"hwnd\":").Append(h.ToInt64());
        b.Append(",\"title\":").Append(J.S(t.ToString()));
        b.Append(",\"class\":").Append(J.S(cl.ToString()));
        b.Append(",\"process\":").Append(J.S(pname));
        b.Append(",\"pid\":").Append(pid);
        b.Append(",\"visible\":").Append(J.B(Native.IsWindowVisible(h)));
        b.Append(",\"minimized\":").Append(J.B(Native.IsIconic(h)));
        b.Append(",\"maximized\":").Append(J.B(Native.IsZoomed(h)));
        b.Append(",\"foreground\":").Append(J.B(Native.GetForegroundWindow() == h));
        b.Append(",\"rect\":{\"x\":").Append(fr.Left).Append(",\"y\":").Append(fr.Top)
            .Append(",\"w\":").Append(fr.Right - fr.Left).Append(",\"h\":").Append(fr.Bottom - fr.Top).Append('}');
        b.Append('}');
        return b.ToString();
    }

    static void Windows(Cmd c)
    {
        bool all = c.Has("all");
        IntPtr fg = Native.GetForegroundWindow();
        StringBuilder arr = new StringBuilder("[");
        int n = 0;
        Native.EnumWindows(delegate(IntPtr h, IntPtr lp)
        {
            if (h == IntPtr.Zero) return true;
            bool vis = Native.IsWindowVisible(h);
            StringBuilder t = new StringBuilder(512);
            Native.GetWindowTextW(h, t, t.Capacity);
            if (!all)
            {
                if (!vis) return true;
                if (t.Length == 0) return true;
            }
            if (n > 0) arr.Append(',');
            arr.Append(WinJson(h));
            n++;
            return true;
        }, IntPtr.Zero);
        arr.Append(']');
        StringBuilder o = new StringBuilder();
        o.Append("{\"ok\":true,\"count\":").Append(n);
        o.Append(",\"foreground\":").Append(WinJson(fg));
        o.Append(",\"windows\":").Append(arr);
        o.Append('}');
        Emit(o.ToString());
    }

    // ---------------- screenshot ----------------

    static void Shot(Cmd c)
    {
        string outp = c.Get("out", null);
        if (outp == null) { Err("--out is required"); return; }
        Rectangle rect;
        string hwndStr = c.Get("hwnd", null);
        string region = c.Get("region", null);
        bool printWindow = c.Has("printwindow");
        IntPtr hwnd = IntPtr.Zero;
        if (region != null)
        {
            string[] p = region.Split(',');
            if (p.Length != 4) { Err("--region needs l,t,r,b"); return; }
            int l = int.Parse(p[0], CultureInfo.InvariantCulture), t = int.Parse(p[1], CultureInfo.InvariantCulture);
            rect = new Rectangle(l, t, int.Parse(p[2], CultureInfo.InvariantCulture) - l, int.Parse(p[3], CultureInfo.InvariantCulture) - t);
        }
        else if (hwndStr != null)
        {
            long hv;
            if (!long.TryParse(hwndStr, NumberStyles.Integer, CultureInfo.InvariantCulture, out hv)) { Err("bad --hwnd"); return; }
            hwnd = new IntPtr(hv);
            Native.RECT r; Native.GetWindowRect(hwnd, out r);
            Native.RECT fr = r;
            try { Native.DwmGetWindowAttribute(hwnd, 9, out fr, Marshal.SizeOf(typeof(Native.RECT))); } catch { fr = r; }
            rect = new Rectangle(fr.Left, fr.Top, Math.Max(1, fr.Right - fr.Left), Math.Max(1, fr.Bottom - fr.Top));
        }
        else
        {
            rect = new Rectangle(Native.GetSystemMetrics(76), Native.GetSystemMetrics(77), Native.GetSystemMetrics(78), Native.GetSystemMetrics(79));
        }
        if (rect.Width <= 0 || rect.Height <= 0) { Err("empty capture rect"); return; }

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outp)));
        int savedW = rect.Width, savedH = rect.Height;
        int trimX = 0, trimY = 0, trimW = 0, trimH = 0;
        using (Bitmap bmp = new Bitmap(rect.Width, rect.Height, PixelFormat.Format32bppArgb))
        {
            bool captured = false;
            if (printWindow && hwnd != IntPtr.Zero)
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    IntPtr hdc = g.GetHdc();
                    try { captured = PrintWindow(hwnd, hdc, 2); }
                    finally { g.ReleaseHdc(hdc); }
                }
            }
            if (!captured)
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.CopyFromScreen(rect.Left, rect.Top, 0, 0, rect.Size, CopyPixelOperation.SourceCopy);
                }
            }
            Bitmap work = bmp;
            int offX = 0, offY = 0;
            if (c.Has("trim"))
            {
                Rectangle box = ContentBox(bmp, Math.Max(0, c.I("tol", 12)), Math.Max(0, c.I("pad", 6)));
                if ((box.Width < bmp.Width || box.Height < bmp.Height) && box.Width >= 16 && box.Height >= 16)
                {
                    work = bmp.Clone(box, PixelFormat.Format32bppArgb);
                    offX = box.Left;
                    offY = box.Top;
                }
            }
            if (!c.Has("nocursor"))
            {
                try
                {
                    Native.POINT pt; Native.GetCursorPos(out pt);
                    int cx = pt.X - rect.Left - offX, cy = pt.Y - rect.Top - offY;
                    if (cx >= 0 && cy >= 0 && cx < work.Width && cy < work.Height)
                        using (Graphics g = Graphics.FromImage(work))
                            using (Pen pen = new Pen(Color.FromArgb(255, 30, 200, 255), 2))
                            {
                                g.DrawEllipse(pen, cx - 7, cy - 7, 14, 14);
                                g.DrawLine(pen, cx - 14, cy, cx + 14, cy);
                                g.DrawLine(pen, cx, cy - 14, cx, cy + 14);
                            }
                }
                catch { }
            }
            int maxw = c.I("maxw", 1600);
            if (maxw > 0 && work.Width > maxw)
            {
                savedH = (int)Math.Round(work.Height * (maxw / (double)work.Width));
                savedW = maxw;
                using (Bitmap small = new Bitmap(savedW, savedH))
                {
                    using (Graphics g2 = Graphics.FromImage(small))
                    {
                        g2.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                        g2.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                        g2.DrawImage(work, 0, 0, savedW, savedH);
                    }
                    small.Save(outp, ImageFormat.Png);
                }
            }
            else
            {
                savedW = work.Width;
                savedH = work.Height;
                work.Save(outp, ImageFormat.Png);
            }
            if (!ReferenceEquals(work, bmp))
            {
                trimX = offX;
                trimY = offY;
                trimW = work.Width;
                trimH = work.Height;
                work.Dispose();
            }
        }
        Native.POINT pc; Native.GetCursorPos(out pc);
        long bytes = 0;
        try { bytes = new FileInfo(outp).Length; } catch { }
        // A blank capture (hidden window, screen asleep, all-black frame) compresses
        // to a few thousand bytes. Callers that need a real picture can demand a
        // floor instead of shipping an empty image into a report.
        int minBytes = c.I("min-bytes", 0);
        if (minBytes > 0 && bytes < minBytes)
        {
            Err("the screenshot is only " + bytes + " bytes (< --min-bytes " + minBytes + "), so it is blank or the window was not visible; bring it to the foreground (focus) and retry");
            return;
        }
        StringBuilder o = new StringBuilder();
        o.Append("{\"ok\":true,\"path\":").Append(J.S(Path.GetFullPath(outp)));
        o.Append(",\"bytes\":").Append(bytes);
        o.Append(",\"x\":").Append(rect.Left).Append(",\"y\":").Append(rect.Top);
        o.Append(",\"w\":").Append(savedW).Append(",\"h\":").Append(savedH);
        o.Append(",\"srcW\":").Append(rect.Width).Append(",\"srcH\":").Append(rect.Height);
        if (trimW > 0)
            o.Append(",\"trim\":{\"x\":").Append(trimX).Append(",\"y\":").Append(trimY)
             .Append(",\"w\":").Append(trimW).Append(",\"h\":").Append(trimH).Append('}');
        o.Append(",\"cursor\":{\"x\":").Append(pc.X).Append(",\"y\":").Append(pc.Y).Append('}');
        o.Append(",\"foreground\":").Append(WinJson(Native.GetForegroundWindow()));
        o.Append('}');
        Emit(o.ToString());
    }

    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);

    // ---------------- UIA tree ----------------

    static string RectOf(AutomationElement e)
    {
        try
        {
            System.Windows.Rect r = e.Current.BoundingRectangle;
            if (double.IsInfinity(r.X) || double.IsNaN(r.Width)) return "null";
            if (r.Width <= 0 || r.Height <= 0) return "null";
            return "{\"x\":" + ((int)r.X) + ",\"y\":" + ((int)r.Y) + ",\"w\":" + ((int)r.Width) + ",\"h\":" + ((int)r.Height) + "}";
        }
        catch { return "null"; }
    }

    static string Safe(string s)
    {
        if (s == null) return "";
        s = s.Replace("\r", " ").Replace("\n", " ").Trim();
        if (s.Length > 120) s = s.Substring(0, 117) + "...";
        return s;
    }

    static AutomationElement RootOf(Cmd c)
    {
        string h = c.Get("hwnd", null);
        if (h == null) return AutomationElement.RootElement;
        long hv;
        if (!long.TryParse(h, NumberStyles.Integer, CultureInfo.InvariantCulture, out hv)) throw new Exception("bad --hwnd");
        AutomationElement e = AutomationElement.FromHandle(new IntPtr(hv));
        if (e == null) throw new Exception("FromHandle returned null for hwnd " + hv);
        return e;
    }

    sealed class Ctx { public int Nodes, Max; public StringBuilder B = new StringBuilder(); public bool First = true; }

    static void Walk(AutomationElement e, string path, int depth, int maxDepth, Ctx ctx)
    {
        if (depth > maxDepth || ctx.Nodes >= ctx.Max) return;
        TreeWalker w = TreeWalker.ControlViewWalker;
        AutomationElement child = w.GetFirstChild(e);
        int i = 0;
        while (child != null && ctx.Nodes < ctx.Max)
        {
            AddNode(child, path + "." + i, depth + 1, maxDepth, ctx);
            child = w.GetNextSibling(child);
            i++;
        }
    }

    static void AddNode(AutomationElement el, string id, int depth, int maxDepth, Ctx ctx)
    {
        ctx.Nodes++;
        try
        {
            AutomationElement.AutomationElementInformation cur = el.Current;
            string ct = cur.ControlType == null ? "?" : cur.ControlType.ProgrammaticName.Replace("ControlType.", "");
            if (!ctx.First) ctx.B.Append(',');
            ctx.First = false;
            ctx.B.Append("{\"id\":").Append(J.S(id));
            ctx.B.Append(",\"role\":").Append(J.S(ct));
            ctx.B.Append(",\"name\":").Append(J.S(Safe(cur.Name)));
            string aid = Safe(cur.AutomationId);
            if (aid.Length > 0) ctx.B.Append(",\"automationId\":").Append(J.S(aid));
            ctx.B.Append(",\"rect\":").Append(RectOf(el));
            ctx.B.Append(",\"enabled\":").Append(J.B(cur.IsEnabled));
            if (cur.IsOffscreen) ctx.B.Append(",\"offscreen\":true");
            if (cur.IsPassword) ctx.B.Append(",\"password\":true");
            ctx.B.Append('}');
        }
        catch { }
        if (depth < maxDepth && ctx.Nodes < ctx.Max) Walk(el, id, depth, maxDepth, ctx);
    }

    static void Tree(Cmd c)
    {
        AutomationElement root = RootOf(c);
        int maxDepth = c.I("depth", MAX_DEPTH_DEFAULT);
        int maxNodes = c.I("max", MAX_NODES_DEFAULT);
        Ctx ctx = new Ctx(); ctx.Max = maxNodes;
        ctx.B.Append('[');
        if (root == AutomationElement.RootElement)
        {
            AutomationElementCollection kids = root.FindAll(TreeScope.Children, Condition.TrueCondition);
            int i = 0;
            foreach (AutomationElement k in kids)
            {
                if (ctx.Nodes >= maxNodes) break;
                AddNode(k, i.ToString(CultureInfo.InvariantCulture), 0, maxDepth, ctx);
                i++;
            }
        }
        else AddNode(root, "0", 0, maxDepth, ctx);
        ctx.B.Append(']');
        string truncated = ctx.Nodes >= maxNodes ? "true" : "false";
        IntPtr hwnd = IntPtr.Zero;
        string hs = c.Get("hwnd", null);
        if (hs != null) hwnd = new IntPtr(long.Parse(hs, CultureInfo.InvariantCulture));
        StringBuilder o = new StringBuilder();
        o.Append("{\"ok\":true,\"count\":").Append(ctx.Nodes).Append(",\"truncated\":").Append(truncated);
        o.Append(",\"root\":").Append(hwnd == IntPtr.Zero ? "null" : WinJson(hwnd));
        o.Append(",\"nodes\":").Append(ctx.B.ToString()).Append('}');
        Emit(o.ToString());
    }

    // ---------------------------------------------------------------- ui ----
    // A tree dump answers "what is in this window" but costs thousands of tokens
    // and is mostly containers with no name. `ui` answers the question an agent
    // actually asks - "what can I touch, and what is it called" - and stays small
    // enough to read every turn.
    class UiCtx
    {
        public StringBuilder B = new StringBuilder();
        public bool First = true;
        public int Count;
        public int Max = 60;
        public int Texts;
        public int Scanned;
        public int ScanCap = 4000;
        public bool Truncated;
    }

    static bool UiActionable(string role)
    {
        switch (role)
        {
            case "Button": case "Edit": case "ComboBox": case "CheckBox": case "RadioButton":
            case "TabItem": case "MenuItem": case "ListItem": case "Hyperlink": case "Slider":
            case "Spinner": case "TreeItem": case "DataItem": case "SplitButton": case "ToolBar":
            case "Menu": case "Tree": case "Table": case "List":
                return true;
        }
        return false;
    }

    static void UiAdd(AutomationElement el, string id, int depth, int maxDepth, UiCtx ctx)
    {
        TreeWalker w = TreeWalker.ControlViewWalker;
        ctx.Scanned++;
        if (ctx.Count >= ctx.Max || ctx.Scanned > ctx.ScanCap) { ctx.Truncated = true; return; }
        bool descend = depth < maxDepth;
        try
        {
            AutomationElement.AutomationElementInformation cur = el.Current;
            string ct = cur.ControlType == null ? "?" : cur.ControlType.ProgrammaticName.Replace("ControlType.", "");
            string name = Safe(cur.Name);
            if (name.Length > 120) name = name.Substring(0, 120) + "\u2026";
            bool actionable = UiActionable(ct);
            bool label = ct == "Text" && name.Length > 0 && name.Length <= 40 && ctx.Texts < 12;
            bool emit = actionable ? (name.Length > 0 || cur.IsEnabled) : label;
            if (cur.IsOffscreen) { descend = false; emit = false; }
            if (emit)
            {
                string value = "";
                if (ct == "Edit" || ct == "Document")
                {
                    try
                    {
                        object pat;
                        if (el.TryGetCurrentPattern(ValuePattern.Pattern, out pat))
                            value = Safe(((ValuePattern)pat).Current.Value);
                    }
                    catch { }
                }
                if (!ctx.First) ctx.B.Append(',');
                ctx.First = false;
                ctx.Count++;
                if (label && !actionable) ctx.Texts++;
                ctx.B.Append("{\"id\":").Append(J.S(id));
                ctx.B.Append(",\"role\":").Append(J.S(ct));
                if (name.Length > 0) ctx.B.Append(",\"name\":").Append(J.S(name));
                if (value.Length > 0 && value != name) ctx.B.Append(",\"value\":").Append(J.S(value.Length > 60 ? value.Substring(0, 60) + "\u2026" : value));
                ctx.B.Append(",\"rect\":").Append(RectOf(el));
                if (!cur.IsEnabled) ctx.B.Append(",\"disabled\":true");
                ctx.B.Append('}');
            }
        }
        catch { }
        if (!descend || ctx.Count >= ctx.Max || ctx.Scanned > ctx.ScanCap) { if (ctx.Count >= ctx.Max) ctx.Truncated = true; return; }
        AutomationElement ch = null;
        try { ch = w.GetFirstChild(el); } catch { }
        int i = 0;
        while (ch != null)
        {
            UiAdd(ch, id + "." + i, depth + 1, maxDepth, ctx);
            try { ch = w.GetNextSibling(ch); } catch { ch = null; }
            i++;
        }
    }

    static void Ui(Cmd c)
    {
        AutomationElement root = RootOf(c);
        int maxDepth = c.I("depth", 10);
        UiCtx ctx = new UiCtx();
        ctx.Max = c.I("max", 60);
        ctx.B.Append('[');
        AutomationElementCollection kids = root.FindAll(TreeScope.Children, Condition.TrueCondition);
        int i = 0;
        foreach (AutomationElement k in kids)
        {
            UiAdd(k, i.ToString(CultureInfo.InvariantCulture), 0, maxDepth, ctx);
            i++;
        }
        ctx.B.Append(']');
        IntPtr hwnd = IntPtr.Zero;
        string hs = c.Get("hwnd", null);
        if (hs != null) hwnd = new IntPtr(long.Parse(hs, CultureInfo.InvariantCulture));
        StringBuilder o = new StringBuilder();
        o.Append("{\"ok\":true,\"count\":").Append(ctx.Count);
        o.Append(",\"scanned\":").Append(ctx.Scanned);
        o.Append(",\"truncated\":").Append(J.B(ctx.Truncated));
        o.Append(",\"root\":").Append(hwnd == IntPtr.Zero ? "null" : WinJson(hwnd));
        o.Append(",\"items\":").Append(ctx.B.ToString());
        if (ctx.Count == 0)
            o.Append(",\"hint\":\"no named controls: this window is custom-drawn or hides accessibility; use screenshot, or readtext for its text\"");
        o.Append('}');
        Emit(o.ToString());
    }

    static AutomationElement Resolve(AutomationElement root, string path)
    {
        string[] parts = path.Split('.');
        AutomationElement cur = root;
        int start = 0;
        if (parts.Length > 0 && (parts[0] == "0")) start = 1;
        for (int k = start; k < parts.Length; k++)
        {
            int idx = int.Parse(parts[k], CultureInfo.InvariantCulture);
            TreeWalker w = TreeWalker.ControlViewWalker;
            AutomationElement ch = w.GetFirstChild(cur);
            int i = 0;
            while (ch != null && i < idx) { ch = w.GetNextSibling(ch); i++; }
            if (ch == null) throw new Exception("path element " + idx + " not found at depth " + k);
            cur = ch;
        }
        return cur;
    }

    // Control-view path of an element, in the same numbering that Walk/AddNode
    // produce, so `find` results can be fed straight back into `invoke`.
    static string PathOf(AutomationElement el, AutomationElement root)
    {
        List<string> parts = new List<string>();
        TreeWalker w = TreeWalker.ControlViewWalker;
        AutomationElement cur = el;
        int guard = 0;
        while (cur != null && guard++ < 64)
        {
            try { if (root != AutomationElement.RootElement && Automation.Compare(cur, root)) break; } catch { }
            AutomationElement parent = null;
            try { parent = w.GetParent(cur); } catch { }
            if (parent == null) break;
            int idx = 0;
            AutomationElement sib = null;
            try { sib = w.GetFirstChild(parent); } catch { }
            while (sib != null)
            {
                bool same = false;
                try { same = Automation.Compare(sib, cur); } catch { }
                if (same) break;
                try { sib = w.GetNextSibling(sib); } catch { sib = null; }
                idx++;
            }
            parts.Add(idx.ToString(CultureInfo.InvariantCulture));
            cur = parent;
        }
        parts.Reverse();
        if (root != AutomationElement.RootElement) parts.Insert(0, "0");
        return string.Join(".", parts.ToArray());
    }

    static void Find(Cmd c)
    {
        string needle = c.Get("name", null);
        if (needle == null) { Err("--name is required"); return; }
        AutomationElement root = RootOf(c);
        AutomationElementCollection all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
        StringBuilder b = new StringBuilder("[");
        int n = 0;
        string low = needle.ToLowerInvariant();
        foreach (AutomationElement e in all)
        {
            if (n >= 40) break;
            try
            {
                string nm = Safe(e.Current.Name), aid = Safe(e.Current.AutomationId);
                if (nm.ToLowerInvariant().IndexOf(low) < 0 && aid.ToLowerInvariant().IndexOf(low) < 0) continue;
                if (n > 0) b.Append(',');
                b.Append("{\"id\":").Append(J.S(PathOf(e, root)));
                b.Append(",\"role\":").Append(J.S(e.Current.ControlType.ProgrammaticName.Replace("ControlType.", "")));
                b.Append(",\"name\":").Append(J.S(nm));
                b.Append(",\"automationId\":").Append(J.S(aid));
                b.Append(",\"rect\":").Append(RectOf(e));
                b.Append('}');
                n++;
            }
            catch { }
        }
        b.Append(']');
        Emit("{\"ok\":true,\"count\":" + n + ",\"matches\":" + b + "}");
    }



    static void Hit(Cmd c)
    {
        int x = c.I("x", int.MinValue), y = c.I("y", int.MinValue);
        if (x == int.MinValue || y == int.MinValue) { Err("--x and --y are required"); return; }
        StringBuilder o = new StringBuilder();
        o.Append("{\"ok\":true,\"x\":").Append(x).Append(",\"y\":").Append(y);
        IntPtr h = IntPtr.Zero;
        try
        {
            AutomationElement e = AutomationElement.FromPoint(new System.Windows.Point(x, y));
            if (e != null)
            {
                o.Append(",\"element\":{\"role\":").Append(J.S(e.Current.ControlType.ProgrammaticName.Replace("ControlType.", "")));
                o.Append(",\"name\":").Append(J.S(Safe(e.Current.Name)));
                o.Append(",\"automationId\":").Append(J.S(Safe(e.Current.AutomationId)));
                o.Append(",\"rect\":").Append(RectOf(e)).Append('}');
                try
                {
                    AutomationElement top = e;
                    while (true)
                    {
                        AutomationElement p = TreeWalker.ControlViewWalker.GetParent(top);
                        if (p == null || p == AutomationElement.RootElement) break;
                        top = p;
                    }
                }
                catch { }
            }
        }
        catch { }
        Native.POINT pt; Native.GetCursorPos(out pt);
        IntPtr wnd = WindowFromPoint(pt.X, pt.Y);
        o.Append(",\"window\":").Append(WinJson(WindowFromPoint(x, y)));
        o.Append(",\"cursor\":{\"x\":").Append(pt.X).Append(",\"y\":").Append(pt.Y).Append('}');
        o.Append('}');
        Emit(o.ToString());
    }

    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(int x, int y);

    // ---------------- input ----------------

    static int PidOfRoot(IntPtr h)
    {
        if (h == IntPtr.Zero) return 0;
        int pid = 0;
        Native.GetWindowThreadProcessId(RootWindow(h), out pid);
        return pid;
    }

    // UI Automation's hit test answers "which control is logically at this
    // point" and is DPI- and composition-aware, while WindowFromPoint answers
    // "which window is topmost here". They normally agree. When they disagree
    // (cloaked or virtualized windows, a window owned by another input queue)
    // either answer is acceptable evidence for the caller's own target.
    static int UiaPidAt(int x, int y)
    {
        try
        {
            AutomationElement e = AutomationElement.FromPoint(new System.Windows.Point(x, y));
            if (e == null) return 0;
            AutomationElement cur = e;
            for (int i = 0; i < 64; i++)
            {
                AutomationElement parent = TreeWalker.RawViewWalker.GetParent(cur);
                if (parent == null || parent == AutomationElement.RootElement) break;
                cur = parent;
            }
            return cur.Current.ProcessId;
        }
        catch { return 0; }
    }

    // A mouse event also has no destination: whatever sits under the point gets
    // it. When the caller named a target window, refuse to click on a point
    // that belongs to a different process.
    static void GuardPoint(Cmd c, int x, int y)
    {
        string hs = c.Get("hwnd", null);
        if (hs == null || x == int.MinValue || y == int.MinValue) return;
        IntPtr h = new IntPtr(long.Parse(hs, NumberStyles.Integer, CultureInfo.InvariantCulture));
        int pidTarget = PidOfRoot(h);
        if (pidTarget == 0) return;
        IntPtr under = WindowFromPoint(x, y);
        int pidUnder = PidOfRoot(under);
        if (pidUnder == pidTarget) return;
        int pidUia = UiaPidAt(x, y);
        if (pidUia == pidTarget) return;
        StringBuilder t = new StringBuilder(260);
        if (under != IntPtr.Zero) Native.GetWindowTextW(under, t, t.Capacity);
        throw new Exception("refusing to click at " + x + "," + y + ": that point belongs to \"" + t.ToString() + "\" (window owner pid " + pidUnder + ", UI Automation pid " + pidUia + "), not to the target window (pid " + pidTarget + "); raise the window first" + (Privileged() ? "" : SandboxHint));
    }

    static void SendMouse(uint flags, int dx, int dy, uint data)
    {
        Native.INPUT[] a = new Native.INPUT[1];
        a[0].type = Native.INPUT_MOUSE;
        a[0].u.mi.dx = dx; a[0].u.mi.dy = dy; a[0].u.mi.dwFlags = flags; a[0].u.mi.mouseData = data;
        if (Native.SendInput(1, a, Marshal.SizeOf(typeof(Native.INPUT))) == 0)
            throw new Exception("SendInput failed: " + Marshal.GetLastWin32Error());
    }

    static void AbsMove(int x, int y)
    {
        int vx = Native.GetSystemMetrics(76), vy = Native.GetSystemMetrics(77);
        int vw = Math.Max(1, Native.GetSystemMetrics(78) - 1), vh = Math.Max(1, Native.GetSystemMetrics(79) - 1);
        int nx = (int)Math.Round((x - vx) * 65535.0 / vw);
        int ny = (int)Math.Round((y - vy) * 65535.0 / vh);
        SendMouse(Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK, nx, ny, 0);
        Native.SetCursorPos(x, y);
    }

    static uint ButtonFlag(string b, bool down)
    {
        switch (b.ToLowerInvariant())
        {
            case "right": return down ? Native.MOUSEEVENTF_RIGHTDOWN : Native.MOUSEEVENTF_RIGHTUP;
            case "middle": return down ? Native.MOUSEEVENTF_MIDDLEDOWN : Native.MOUSEEVENTF_MIDDLEUP;
            default: return down ? Native.MOUSEEVENTF_LEFTDOWN : Native.MOUSEEVENTF_LEFTUP;
        }
    }

    static void Mouse(Cmd c, string mode)
    {
        int mx = c.I("x", int.MinValue), my = c.I("y", int.MinValue);
        if (c.Has("relx") || c.Has("rely"))
        {
            if (mx == int.MinValue) mx = 0;
            if (my == int.MinValue) my = 0;
            ResolveRelative(c, ref mx, ref my);
        }
        if (mode == "click" || mode == "scroll") GuardPoint(c, mx, my);
        // Move the pointer absolutely first when coordinates are given.
        if (mx != int.MinValue && my != int.MinValue)
        {
            if (mode == "scroll") Native.SetCursorPos(mx, my);
            else
            {
                AbsMove(mx, my);
                Thread.Sleep(30);
                VerifyPointer(mx, my, c);
            }
            Thread.Sleep(30);
        }
        if (mode == "click")
        {
            int count = c.I("count", 0);
            if (c.Has("double")) count = 2;
            if (count <= 0) count = 1;
            string btn = c.Get("button", "left");
            for (int i = 0; i < count; i++)
            {
                SendMouse(ButtonFlag(btn, true), 0, 0, 0);
                Thread.Sleep(20);
                SendMouse(ButtonFlag(btn, false), 0, 0, 0);
                if (i + 1 < count) Thread.Sleep(60);
            }
        }
        else if (mode == "scroll")
        {
            int amount = c.I("amount", 3);
            uint data = (uint)(this_scrollish(amount));
            if (c.Has("horizontal")) SendMouse(Native.MOUSEEVENTF_HWHEEL, 0, 0, data);
            else SendMouse(Native.MOUSEEVENTF_WHEEL, 0, 0, data);
        }
        Native.POINT p; Native.GetCursorPos(out p);
        Emit("{\"ok\":true,\"cursor\":{\"x\":" + p.X + ",\"y\":" + p.Y + "},\"action\":\"" + mode + "\"}");
    }

    static int this_scrollish(int notches) { return notches * 120; }

    // An active CJK IME swallows injected ASCII: "hhh666" is composed into Chinese text and
    // never reaches the application (Packet Tracer's telnet prompt showed exactly this -
    // a password field that received only the Enter keys). Point the window at an English
    // keyboard layout, or detach its IME context entirely, before typing ASCII.
    static int DetachImeRecursive(IntPtr root)    {
        int n = 0;
        if (Native.ImmAssociateContext(root, IntPtr.Zero) != IntPtr.Zero) n++;
        for (IntPtr child = Native.GetWindow(root, 5 /* GW_CHILD */); child != IntPtr.Zero; child = Native.GetWindow(child, 2 /* GW_HWNDNEXT */))
            n += DetachImeRecursive(child);
        return n;
    }

    static void Ime(Cmd c)
    {
        IntPtr h = TargetWindow(c);
        if (h == IntPtr.Zero) h = Native.GetForegroundWindow();
        IntPtr en = Native.LoadKeyboardLayout("00000409", 0x00000001 /* KLF_ACTIVATE */);
        if (c.Has("list"))
        {
            IntPtr[] list = new IntPtr[16];
            int n = Native.GetKeyboardLayoutList(list.Length, list);
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"ok\":true,\"count\":").Append(n).Append(",\"layouts\":[");
            for (int i = 0; i < n; i++)
            {
                if (i > 0) sb.Append(",");
                sb.Append("\"").Append(list[i].ToInt64().ToString("x")).Append("\"");
            }
            sb.Append("],\"enLoaded\":").Append(en != IntPtr.Zero ? "true" : "false").Append("}");
            Emit(sb.ToString());
            return;
        }
        bool had = false;
        if (c.Has("disable"))
        {
            int detached = DetachImeRecursive(h);
            had = detached > 0;
        }
        int tid = 0;
        int fpid = 0;
        tid = (int)Native.GetWindowThreadProcessId(h, out fpid);
        Native.GUITHREADINFO gi = new Native.GUITHREADINFO();
        gi.cbSize = Marshal.SizeOf(typeof(Native.GUITHREADINFO));
        bool haveGi = Native.GetGUIThreadInfo((uint)tid, ref gi);
        IntPtr focus = haveGi ? gi.hwndFocus : IntPtr.Zero;
        if (focus != IntPtr.Zero && en != IntPtr.Zero)
            Native.SendMessage(focus, 0x0050 /* WM_INPUTLANGCHANGEREQUEST */, IntPtr.Zero, en);
        if (en != IntPtr.Zero) Native.SendMessage(h, 0x0050 /* WM_INPUTLANGCHANGEREQUEST */, IntPtr.Zero, en);
        Thread.Sleep(150);
        Emit("{\"ok\":true,\"action\":\"ime\",\"hwnd\":" + h.ToInt64()
            + ",\"detached\":" + (had ? "yes" : "no")
            + ",\"thread\":" + tid
            + ",\"focusHwnd\":" + focus.ToInt64()
            + ",\"layoutSwitched\":" + (en != IntPtr.Zero ? "true" : "false") + "}");
    }

    static IntPtr TargetWindow(Cmd c)
    {
        string hs = c.Get("hwnd", null);
        if (hs == null) return IntPtr.Zero;
        long v;
        if (!long.TryParse(hs, NumberStyles.Integer, CultureInfo.InvariantCulture, out v)) return IntPtr.Zero;
        return new IntPtr(v);
    }

    // Absolute screen coordinates break the moment a window moves or resizes -
    // which happens all the time (maximize, splitter drag, monitor change). A
    // caller that knows the window can ask for a client-area point instead and
    // the engine resolves it against the live client origin.
    static void ResolveRelative(Cmd c, ref int x, ref int y)
    {
        int rx = c.I("relx", int.MinValue), ry = c.I("rely", int.MinValue);
        if (rx == int.MinValue && ry == int.MinValue) return;
        IntPtr h = TargetWindow(c);
        if (h == IntPtr.Zero) throw new Exception("--relx/--rely need --hwnd: they are client-area coordinates of that window");
        Native.POINT org; org.X = 0; org.Y = 0;
        if (!Native.ClientToScreen(h, ref org)) throw new Exception("ClientToScreen failed for hwnd " + h.ToInt64());
        x = org.X + (rx == int.MinValue ? 0 : rx);
        y = org.Y + (ry == int.MinValue ? 0 : ry);
    }

    // 1 = elevated, 0 = not, -1 = unknown (cannot open the token)
    static int ElevatedOf(int pid)
    {
        if (pid <= 0) return -1;
        IntPtr proc = Native.OpenProcess(0x1000 /* QUERY_LIMITED_INFORMATION */, false, pid);
        if (proc == IntPtr.Zero) return -1;
        IntPtr tok = IntPtr.Zero;
        try
        {
            if (!Native.OpenProcessToken(proc, 0x0008 /* TOKEN_QUERY */, out tok)) return -1;
            uint v; int size;
            if (!Native.GetTokenInformation(tok, 20 /* TokenElevation */, out v, 4, out size)) return -1;
            return v != 0 ? 1 : 0;
        }
        finally
        {
            if (tok != IntPtr.Zero) Native.CloseHandle(tok);
            Native.CloseHandle(proc);
        }
    }

    static int SelfElevated()
    {
        return ElevatedOf(Process.GetCurrentProcess().Id);
    }

    // Name of the desktop that currently receives physical input ("Default" when
    // the session is unlocked, "Winlogon" while the workstation is locked).
    static string InputDesktopName(out bool opened)
    {
        opened = false;
        IntPtr d = Native.OpenInputDesktop(0, false, 0x0001 /* DESKTOP_READOBJECTS */);
        if (d == IntPtr.Zero) return null;
        try
        {
            opened = true;
            StringBuilder sb = new StringBuilder(128); int need;
            if (!Native.GetUserObjectInformationW(d, 2 /* UOI_NAME */, sb, 256, out need)) return null;
            return sb.ToString();
        }
        finally { Native.CloseDesktop(d); }
    }

    // Modern Windows renders the lock screen on the Default desktop, so the input
    // desktop name alone says "unlocked" while every synthetic event is thrown
    // away. The lock/logon processes are the reliable second witness.
    static bool LockAppRunning()
    {
        try
        {
            string[] names = { "LockApp", "LogonUI" };
            for (int i = 0; i < names.Length; i++)
            {
                Process[] ps = Process.GetProcessesByName(names[i]);
                if (ps == null) continue;
                bool any = ps.Length > 0;
                for (int k = 0; k < ps.Length; k++) ps[k].Dispose();
                if (any) return true;
            }
        }
        catch { }
        return false;
    }

    // A locked workstation switches the input desktop to the secure one: every
    // synthetic event is dropped and SetCursorPos returns FALSE. This is the
    // single most confusing state to debug, so name it explicitly.
    static bool SessionLocked(out string inputDesktop)
    {
        bool opened;
        inputDesktop = InputDesktopName(out opened);
        if (!opened) return true; // access denied: the secure desktop is up
        if (inputDesktop != null && !String.Equals(inputDesktop, "Default", StringComparison.OrdinalIgnoreCase)) return true;
        return LockAppRunning();
    }

    static string LockHint()
    {
        string desk;
        if (!SessionLocked(out desk)) return null;
        return "; the workstation is locked (input desktop: " + (desk ?? "unknown") + ") - no synthetic input can reach it; unlock the screen and retry";
    }

    // The single most expensive failure mode seen in practice: input that is
    // silently discarded (UIPI against an elevated window, a non-input desktop,
    // a locked session). Say what to check instead of looking like a no-op.
    static string InputDiagnosis(int pid)
    {
        string lockHint = LockHint();
        if (lockHint != null) return lockHint;
        StringBuilder s = new StringBuilder();
        string il = IntegrityName() ?? "?null";
        if (il == "LOW") s.Append("; this engine runs at LOW integrity (it was started from a low-integrity file such as one inside DSH's workspace), so Windows discards its input - run the engine from a normal-integrity location like %LOCALAPPDATA%");
        bool inputDesktop = true;
        IntPtr d = Native.OpenInputDesktop(0, false, 0x0100 /* DESKTOP_SWITCHDESKTOP */);
        if (d != IntPtr.Zero) Native.CloseDesktop(d); else inputDesktop = false;
        if (!inputDesktop) s.Append("; this process cannot open the current input desktop");
        int self = SelfElevated();
        if (pid > 0)
        {
            int tgt = ElevatedOf(pid);
            if (tgt == 1 && self == 0) s.Append("; the target (pid " + pid + ") is elevated while this process is not, so UIPI discards the injected input - run the caller elevated, or run the application un-elevated");
            if (tgt == -1) s.Append("; could not read the target's token (pid " + pid + ")");
        }
        if (s.Length == 0) s.Append("; run `inputcheck` to test the channel");
        return s.ToString();
    }

    static void VerifyPointer(int x, int y, Cmd c)
    {
        int vx = Native.GetSystemMetrics(76), vy = Native.GetSystemMetrics(77);
        int vw = Native.GetSystemMetrics(78), vh = Native.GetSystemMetrics(79);
        if (x < vx || y < vy || x >= vx + vw || y >= vy + vh) return; // clamped by the OS
        Native.POINT q; Native.GetCursorPos(out q);
        if (Math.Abs(q.X - x) <= 2 && Math.Abs(q.Y - y) <= 2) return;
        throw new Exception("the pointer did not move to " + x + "," + y + " (it is at " + q.X + "," + q.Y + ") - the injected event never reached the screen" + (PointerDrifting() ? "; the pointer was moving on its own during the check (someone is using the mouse), so retry with the mouse left alone" : "") + InputDiagnosis(PidOfRoot(TargetWindow(c))));    }

    static void InputCheck()
    {
        Native.POINT p0; Native.GetCursorPos(out p0);
        int vx = Native.GetSystemMetrics(76), vy = Native.GetSystemMetrics(77);
        int vw = Math.Max(4, Native.GetSystemMetrics(78)), vh = Math.Max(4, Native.GetSystemMetrics(79));
        int px = Math.Min(vx + vw - 2, Math.Max(vx + 1, p0.X + 40));
        int py = Math.Min(vy + vh - 2, Math.Max(vy + 1, p0.Y + 25));
        bool drifting = PointerDrifting();
        bool sendOk = true;
        string sendErr = null;
        // A human moving the mouse at the same moment can beat us to the pixel,
        // so try a few times before calling the channel dead.
        bool landed = false;
        for (int attempt = 0; attempt < 3 && !landed; attempt++)
        {
            Native.POINT a; Native.GetCursorPos(out a);
            try { AbsMove(px, py); }
            catch (Exception ex) { sendOk = false; sendErr = ex.Message; break; }
            Thread.Sleep(70);
            Native.POINT p1; Native.GetCursorPos(out p1);
            landed = Math.Abs(p1.X - px) <= 2 && Math.Abs(p1.Y - py) <= 2;
            if (!landed) { Thread.Sleep(40); }
        }
        Native.POINT back; Native.GetCursorPos(out back);
        try { AbsMove(p0.X, p0.Y); } catch { }
        bool inputDesktop = true;
        IntPtr d = Native.OpenInputDesktop(0, false, 0x0100);
        if (d != IntPtr.Zero) Native.CloseDesktop(d); else inputDesktop = false;
        string desk;
        bool locked = SessionLocked(out desk);
        string il = IntegrityName() ?? "?null";
        StringBuilder o = new StringBuilder();
        o.Append("{\"ok\":true,\"landed\":").Append(J.B(landed));
        o.Append(",\"sendInput\":").Append(J.B(sendOk));
        if (sendErr != null) o.Append(",\"sendInputError\":").Append(J.S(sendErr));
        o.Append(",\"from\":{\"x\":").Append(p0.X).Append(",\"y\":").Append(p0.Y).Append('}');
        o.Append(",\"to\":{\"x\":").Append(px).Append(",\"y\":").Append(py).Append('}');
        o.Append(",\"got\":{\"x\":").Append(back.X).Append(",\"y\":").Append(back.Y).Append('}');
        o.Append(",\"pointerDrifting\":").Append(J.B(drifting));
        o.Append(",\"inputDesktop\":").Append(J.B(inputDesktop));
        o.Append(",\"locked\":").Append(J.B(locked));
        o.Append(",\"lockAppRunning\":").Append(J.B(LockAppRunning()));
        if (desk != null) o.Append(",\"inputDesktopName\":").Append(J.S(desk));
        if (il != null) o.Append(",\"integrity\":").Append(J.S(il));
        o.Append(",\"selfElevated\":").Append(SelfElevated() == 1 ? "true" : "false");
        o.Append(",\"foreground\":").Append(WinJson(Native.GetForegroundWindow()));
        string verdict;
        if (landed) verdict = "input channel healthy: synthetic pointer movement reached the screen";
        else if (locked) verdict = "the workstation is locked, so no synthetic input can reach the screen; unlock it and run inputcheck again - nothing you do before that can succeed";
        else if (il == "LOW") verdict = "this engine runs at LOW integrity (it was started from a low-integrity file, e.g. inside DSH's workspace), so Windows discards its synthetic input; run the engine from a normal-integrity location such as %LOCALAPPDATA%";
        else if (drifting) verdict = "inconclusive: the pointer was moving on its own while the check ran (someone is using the mouse); leave the mouse alone and run inputcheck again";
        else verdict = "synthetic input is NOT reaching the desktop; do not interpret anything the screen shows before input as a click - check elevation of the target, the input desktop, and whether a UAC prompt is up";
        o.Append(",\"verdict\":").Append(J.S(verdict));
        o.Append('}');
        Emit(o.ToString());
    }

    // The pointer moves on its own if a human is at the machine; that is not the
    // engine failing, and the caller deserves to know the difference.
    static bool PointerDrifting()
    {
        Native.POINT a; Native.GetCursorPos(out a);
        Thread.Sleep(30);
        Native.POINT b; Native.GetCursorPos(out b);
        return a.X != b.X || a.Y != b.Y;
    }

    static string IntegrityName()
    {
        IntPtr tok;
        if (!Native.OpenProcessToken(Process.GetCurrentProcess().Handle, 0x0008 /* TOKEN_QUERY */, out tok)) return "?opentoken";
        IntPtr buf = Marshal.AllocHGlobal(512);
        try
        {
            int need;
            if (!Native.GetTokenInformationBuf(tok, 25 /* TokenIntegrityLevel */, buf, 512, out need)) return "?til" + Marshal.GetLastWin32Error();
            IntPtr sid = Marshal.ReadIntPtr(buf);
            byte count = Marshal.ReadByte(Native.GetSidSubAuthorityCount(sid));
            int rid = Marshal.ReadInt32(Native.GetSidSubAuthority(sid, (uint)(count - 1)));
            if (rid == 0x1000) return "LOW";
            if (rid == 0x2000) return "MEDIUM";
            if (rid == 0x3000) return "HIGH";
            if (rid == 0x4000) return "SYSTEM";
            return "0x" + rid.ToString("x");
        }
        catch { return null; }
        finally { Marshal.FreeHGlobal(buf); Native.CloseHandle(tok); }
    }

    static string ElementInfoAt(int x, int y)
    {
        try
        {
            AutomationElement e = AutomationElement.FromPoint(new System.Windows.Point(x, y));
            if (e == null) return "null";
            StringBuilder b = new StringBuilder();
            b.Append("{\"role\":").Append(J.S(e.Current.ControlType.ProgrammaticName.Replace("ControlType.", "")));
            b.Append(",\"name\":").Append(J.S(Safe(e.Current.Name)));
            b.Append(",\"automationId\":").Append(J.S(Safe(e.Current.AutomationId)));
            b.Append(",\"helpText\":").Append(J.S(Safe(e.Current.HelpText)));
            b.Append(",\"acceleratorKey\":").Append(J.S(Safe(e.Current.AcceleratorKey)));
            b.Append(",\"pid\":").Append(e.Current.ProcessId);
            b.Append(",\"rect\":").Append(RectOf(e)).Append('}');
            return b.ToString();
        }
        catch { return "null"; }
    }

    // Toolbars and icon strips are unreadable from pixels but they answer
    // immediately to a hover: the tooltip carries the authoritative label and
    // often the accelerator. Pointing is cheaper than guessing from diffs.
    static string TooltipsOf(int pid)
    {
        StringBuilder b = new StringBuilder();
        int n = 0;
        Native.EnumWindows(delegate(IntPtr h, IntPtr lp)
        {
            if (!Native.IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            if (!cls.ToLowerInvariant().Contains("tooltip")) return true;
            int ownerPid; Native.GetWindowThreadProcessId(h, out ownerPid);
            if (pid > 0 && ownerPid != pid) return true;
            List<string> texts = new List<string>();
            string own = WindowTitle(h);
            if (own.Length > 0) texts.Add(own);
            Native.EnumChildWindows(h, delegate(IntPtr ch, IntPtr lp2)
            {
                string t = WindowTitle(ch);
                if (t.Length > 0 && !texts.Contains(t)) texts.Add(t);
                return true;
            }, IntPtr.Zero);
            if (texts.Count == 0) return true;
            if (n++ > 0) b.Append(',');
            b.Append("{\"hwnd\":").Append(h.ToInt64()).Append(",\"text\":");
            StringBuilder joined = new StringBuilder();
            for (int i = 0; i < texts.Count; i++)
            {
                if (i > 0) joined.Append(' ');
                joined.Append(texts[i]);
            }
            b.Append(J.S(joined.ToString())).Append('}');
            return true;
        }, IntPtr.Zero);
        return "[" + b.ToString() + "]";
    }

    static void Hover(Cmd c)
    {
        int x = c.I("x", int.MinValue), y = c.I("y", int.MinValue);
        if (x == int.MinValue || y == int.MinValue) { Err("--x and --y are required"); return; }
        int ms = Math.Max(150, c.I("ms", 1000));
        AbsMove(x, y);
        Thread.Sleep(ms);
        int pid = UiaPidAt(x, y);
        StringBuilder o = new StringBuilder();
        o.Append("{\"ok\":true,\"x\":").Append(x).Append(",\"y\":").Append(y);
        o.Append(",\"heldMs\":").Append(ms);
        o.Append(",\"element\":").Append(ElementInfoAt(x, y));
        o.Append(",\"tooltips\":").Append(TooltipsOf(pid));
        o.Append('}');
        Emit(o.ToString());
    }

    static string ClassOf(IntPtr h)
    {
        StringBuilder cl = new StringBuilder(256);
        Native.GetClassNameW(h, cl, cl.Capacity);
        return cl.ToString();
    }

    static void Modals(Cmd c)
    {
        int wantPid = c.I("pid", 0);
        StringBuilder b = new StringBuilder();
        int n = 0;
        Native.EnumWindows(delegate(IntPtr h, IntPtr lp)
        {
            int pid; Native.GetWindowThreadProcessId(h, out pid);
            if (wantPid != 0 && pid != wantPid) return true;
            string title = WindowTitle(h);
            bool visible = Native.IsWindowVisible(h);
            // The question this command answers is "is something on screen eating my
            // clicks", so hidden helpers and disabled ghosts are noise: leave them out
            // unless --all is given.
            if (!visible && !c.Has("all")) return true;
            if (!visible && title.Length == 0) return true;
            bool enabled = Native.IsWindowEnabled(h);
            string cls = ClassOf(h);
            IntPtr owner = Native.GetWindow(h, 4 /* GW_OWNER */);
            bool dialog = string.Equals(cls, "#32770", StringComparison.OrdinalIgnoreCase);
            bool disabled = !enabled;
            bool ownedPopup = owner != IntPtr.Zero && visible;
            if (wantPid == 0) { if (!dialog && !disabled) return true; }
            else { if (!dialog && !disabled && !ownedPopup) return true; }
            if (n++ > 0) b.Append(',');
            b.Append("{\"hwnd\":").Append(h.ToInt64());
            b.Append(",\"title\":").Append(J.S(title));
            b.Append(",\"class\":").Append(J.S(cls));
            b.Append(",\"pid\":").Append(pid);
            b.Append(",\"process\":").Append(J.S(ProcNameOf(pid)));
            b.Append(",\"visible\":").Append(J.B(visible));
            b.Append(",\"enabled\":").Append(J.B(enabled));
            b.Append(",\"dialogClass\":").Append(J.B(dialog));
            IntPtr own = TargetWindow(c);
            if (own != IntPtr.Zero) b.Append(",\"isTarget\":").Append(J.B(h == own));
            if (owner != IntPtr.Zero) b.Append(",\"owner\":{\"hwnd\":").Append(owner.ToInt64()).Append(",\"title\":").Append(J.S(WindowTitle(owner))).Append('}');
            b.Append('}');
            return true;
        }, IntPtr.Zero);
        StringBuilder o = new StringBuilder();
        o.Append("{\"ok\":true");
        if (wantPid != 0) o.Append(",\"pid\":").Append(wantPid);
        o.Append(",\"count\":").Append(n);
        o.Append(",\"modals\":[").Append(b.ToString()).Append(']');
        o.Append(",\"foreground\":").Append(WinJson(Native.GetForegroundWindow()));
        o.Append(",\"note\":").Append(J.S(n == 0
            ? "no dialog-like or disabled windows; if the application ignores input anyway, look at the window's own state (maximized? wrong monitor?) before blaming the application"
            : "close or answer these dialogs first - while an owned dialog is up, the owner window is disabled and every click or keystroke aimed at it is discarded"));
        o.Append('}');
        Emit(o.ToString());
    }

    static void Geom(Cmd c)
    {
        IntPtr h = TargetWindow(c);
        if (h == IntPtr.Zero) h = Native.GetForegroundWindow();
        if (h == IntPtr.Zero) { Err("no window (pass --hwnd or foreground is empty)"); return; }
        Native.RECT r; Native.GetWindowRect(h, out r);
        Native.RECT cl; Native.GetClientRect(h, out cl);
        Native.POINT org; org.X = 0; org.Y = 0;
        Native.ClientToScreen(h, ref org);
        int pid; Native.GetWindowThreadProcessId(h, out pid);
        int dpi = 96;
        try { int d = Native.GetDpiForWindow(h); if (d > 0) dpi = d; } catch { }
        StringBuilder o = new StringBuilder();
        o.Append("{\"ok\":true,\"hwnd\":").Append(h.ToInt64());
        o.Append(",\"title\":").Append(J.S(WindowTitle(h)));
        o.Append(",\"class\":").Append(J.S(ClassOf(h)));
        o.Append(",\"pid\":").Append(pid);
        o.Append(",\"process\":").Append(J.S(ProcNameOf(pid)));
        o.Append(",\"window\":{\"x\":").Append(r.Left).Append(",\"y\":").Append(r.Top).Append(",\"w\":").Append(r.Right - r.Left).Append(",\"h\":").Append(r.Bottom - r.Top).Append('}');
        o.Append(",\"client\":{\"x\":0,\"y\":0,\"w\":").Append(cl.Right - cl.Left).Append(",\"h\":").Append(cl.Bottom - cl.Top).Append('}');
        o.Append(",\"clientOrigin\":{\"x\":").Append(org.X).Append(",\"y\":").Append(org.Y).Append('}');
        o.Append(",\"dpi\":").Append(dpi);
        o.Append(",\"scale\":").Append((dpi / 96.0).ToString("0.##", CultureInfo.InvariantCulture));
        o.Append(",\"maximized\":").Append(J.B(Native.IsZoomed(h)));
        o.Append(",\"minimized\":").Append(J.B(Native.IsIconic(h)));
        o.Append(",\"foreground\":").Append(J.B(Native.GetForegroundWindow() == h));
        o.Append(",\"note\":").Append(J.S("click with --relx/--rely to address this window's client area, so the point survives moves and resizes"));
        o.Append('}');
        Emit(o.ToString());
    }

    static void Drag(Cmd c)
    {
        int x1 = c.I("x1", int.MinValue), y1 = c.I("y1", int.MinValue), x2 = c.I("x2", int.MinValue), y2 = c.I("y2", int.MinValue);
        if (x1 == int.MinValue || y1 == int.MinValue || x2 == int.MinValue || y2 == int.MinValue)
        { Err("--x1 --y1 --x2 --y2 required"); return; }
        if (c.Has("relx") || c.Has("rely")) ResolveRelative(c, ref x1, ref y1);
        int ms = Math.Max(60, c.I("ms", 400));
        string btn = c.Get("button", "left");
        AbsMove(x1, y1); Thread.Sleep(60);
        VerifyPointer(x1, y1, c);
        SendMouse(ButtonFlag(btn, true), 0, 0, 0); Thread.Sleep(60);
        int steps = Math.Min(40, Math.Max(8, ms / 20));
        for (int i = 1; i <= steps; i++)
        {
            int xi = x1 + (x2 - x1) * i / steps, yi = y1 + (y2 - y1) * i / steps;
            Native.SetCursorPos(xi, yi);
            Thread.Sleep(ms / steps);
        }
        SendMouse(ButtonFlag(btn, false), 0, 0, 0);
        Emit("{\"ok\":true,\"action\":\"drag\",\"from\":{\"x\":" + x1 + ",\"y\":" + y1 + "},\"to\":{\"x\":" + x2 + ",\"y\":" + y2 + "}}");
    }

    static readonly Dictionary<string, ushort> VK = BuildVk();

    static Dictionary<string, ushort> BuildVk()
    {
        Dictionary<string, ushort> d = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase);
        d["ctrl"] = 0x11; d["control"] = 0x11; d["shift"] = 0x10; d["alt"] = 0x12; d["win"] = 0x5B; d["lwin"] = 0x5B; d["rwin"] = 0x5C;
        d["enter"] = 0x0D; d["return"] = 0x0D; d["tab"] = 0x09; d["esc"] = 0x1B; d["escape"] = 0x1B; d["space"] = 0x20;
        d["backspace"] = 0x08; d["back"] = 0x08; d["delete"] = 0x2E; d["del"] = 0x2E; d["insert"] = 0x2D; d["ins"] = 0x2D;
        d["home"] = 0x24; d["end"] = 0x23; d["pageup"] = 0x21; d["pgup"] = 0x21; d["pagedown"] = 0x22; d["pgdn"] = 0x22;
        d["up"] = 0x26; d["down"] = 0x28; d["left"] = 0x25; d["right"] = 0x27;
        d["capslock"] = 0x14; d["numlock"] = 0x90; d["scrolllock"] = 0x91; d["printscreen"] = 0x2C; d["pause"] = 0x13;
        d["apps"] = 0x5D; d["menu"] = 0x5D;
        for (int i = 1; i <= 24; i++) d["f" + i] = (ushort)(0x6F + i);
        for (char ch = 'a'; ch <= 'z'; ch++) d[ch.ToString()] = (ushort)char.ToUpperInvariant(ch);
        for (char ch = '0'; ch <= '9'; ch++) d[ch.ToString()] = (ushort)ch;
        d[";"] = 0xBA; d["="] = 0xBB; d[","] = 0xBC; d["-"] = 0xBD; d["."] = 0xBE; d["/"] = 0xBF; d["`"] = 0xC0;
        d["["] = 0xDB; d["\\"] = 0xDC; d["]"] = 0xDD; d["'"] = 0xDE;
        d["plus"] = 0xBB; d["minus"] = 0xBD; d["comma"] = 0xBC; d["period"] = 0xBE; d["slash"] = 0xBF;
        d["semicolon"] = 0xBA; d["backtick"] = 0xC0; d["lshift"] = 0xA0; d["rshift"] = 0xA1; d["lctrl"] = 0xA2; d["rctrl"] = 0xA3;
        d["lalt"] = 0xA4; d["ralt"] = 0xA5;
        return d;
    }

    static void KeyDownUp(ushort vk, bool down)
    {
        Native.INPUT[] a = new Native.INPUT[1];
        a[0].type = Native.INPUT_KEYBOARD;
        a[0].u.ki.wVk = vk;
        // A real keyboard always reports a scan code; Qt widgets that read raw key events
        // (Packet Tracer's telnet password prompt does) ignore synthesized keys without one.
        a[0].u.ki.wScan = (ushort)Native.MapVirtualKey(vk, 0);
        a[0].u.ki.dwFlags = down ? 0 : Native.KEYEVENTF_KEYUP;
        bool ext = vk >= 0x21 && vk <= 0x2E && vk != 0x20 && vk != 0x09 && vk != 0x0D && vk != 0x1B;
        if (vk == 0x2E || vk == 0x2D || vk == 0x24 || vk == 0x23 || vk == 0x21 || vk == 0x22 || vk == 0x25 || vk == 0x26 || vk == 0x27 || vk == 0x5B || vk == 0x5C || vk == 0x5D)
            ext = true;
        if (ext) a[0].u.ki.dwFlags |= Native.KEYEVENTF_EXTENDEDKEY;
        Native.SendInput(1, a, Marshal.SizeOf(typeof(Native.INPUT)));
    }

    static void UnicodeChar(char ch)
    {
        Native.INPUT[] a = new Native.INPUT[2];
        a[0].type = Native.INPUT_KEYBOARD; a[0].u.ki.wVk = 0; a[0].u.ki.wScan = ch; a[0].u.ki.dwFlags = Native.KEYEVENTF_UNICODE;
        a[1].type = Native.INPUT_KEYBOARD; a[1].u.ki.wVk = 0; a[1].u.ki.wScan = ch; a[1].u.ki.dwFlags = Native.KEYEVENTF_UNICODE | Native.KEYEVENTF_KEYUP;
        Native.SendInput(2, a, Marshal.SizeOf(typeof(Native.INPUT)));
    }

    // ---------------- reading text back ----------------
    //
    // Screenshots + OCR are the expensive way to answer "what does this window
    // say". Most windows answer directly: UIA exposes TextPattern (documents,
    // terminals, Qt labels) and ValuePattern (edit boxes), and classic win32
    // controls answer WM_GETTEXT. Try both channels and keep whichever yields
    // more text, so one command works for Notepad, a WinForms app and a Qt app
    // without per-app code.

    static IntPtr TargetHwndOrForeground(Cmd c)
    {
        string s = c.Get("hwnd", null);
        if (s != null)
        {
            long v;
            if (long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out v)) return new IntPtr(v);
        }
        return Native.GetForegroundWindow();
    }

    static string Normalize(string s)
    {
        if (s == null) return "";
        return Regex.Replace(s, "\\s+", " ").Trim();
    }

    static string Win32Text(IntPtr hwnd, out string sources)
    {
        List<string> parts = new List<string>();
        StringBuilder src = new StringBuilder();
        Native.EnumChildWindows(hwnd, delegate(IntPtr ch, IntPtr lp)
        {
            if (!Native.IsWindowVisible(ch)) return true;
            StringBuilder sb = new StringBuilder(8192);
            try { Native.SendMessageText(ch, 0x000D /* WM_GETTEXT */, new IntPtr(8192), sb); }
            catch { }
            string t = sb.ToString();
            if (t.Trim().Length == 0) return true;
            if (parts.Contains(t)) return true;
            parts.Add(t);
            if (src.Length > 0) src.Append(',');
            src.Append("{\"source\":\"win32\",\"hwnd\":").Append(ch.ToInt64());
            src.Append(",\"class\":").Append(J.S(ClassOf(ch))).Append(",\"chars\":").Append(t.Length).Append('}');
            return true;
        }, IntPtr.Zero);
        sources = "[" + src.ToString() + "]";
        return string.Join("\n", parts.ToArray());
    }

    static void WalkText(AutomationElement el, TreeWalker walker, int depth, ref int nodes, int maxNodes, int maxChars, ref int chars, List<string> parts, StringBuilder src)
    {
        if (el == null || depth > 24 || nodes > maxNodes || chars >= maxChars) return;
        nodes++;
        string got = null;
        string via = null;
        try
        {
            object tp;
            if (el.TryGetCurrentPattern(TextPattern.Pattern, out tp))
            {
                string s = ((TextPattern)tp).DocumentRange.GetText(Math.Min(8192, Math.Max(64, maxChars - chars)));
                if (s != null && s.Trim().Length > 0) { got = s; via = "text"; }
            }
        }
        catch { }
        if (got == null)
        {
            try
            {
                object vp;
                if (el.TryGetCurrentPattern(ValuePattern.Pattern, out vp))
                {
                    string s = ((ValuePattern)vp).Current.Value;
                    if (s != null && s.Trim().Length > 0) { got = s; via = "value"; }
                }
            }
            catch { }
        }
        if (got != null && !parts.Contains(got))
        {
            parts.Add(got);
            chars += got.Length;
            if (src.Length > 0) src.Append(',');
            string role = "";
            try { role = Safe(el.Current.ControlType.ProgrammaticName.Replace("ControlType.", "")); } catch { }
            src.Append("{\"source\":\"uia\",\"role\":").Append(J.S(role)).Append(",\"via\":").Append(J.S(via));
            src.Append(",\"chars\":").Append(got.Length).Append('}');
        }
        AutomationElement child = null;
        try { child = walker.GetFirstChild(el); } catch { }
        while (child != null)
        {
            WalkText(child, walker, depth + 1, ref nodes, maxNodes, maxChars, ref chars, parts, src);
            try { child = walker.GetNextSibling(child); } catch { child = null; }
        }
    }

    static string UiaText(IntPtr hwnd, int maxChars, out string sources)
    {
        List<string> parts = new List<string>();
        StringBuilder src = new StringBuilder();
        int nodes = 0, chars = 0;
        try
        {
            AutomationElement root = AutomationElement.FromHandle(hwnd);
            if (root != null) WalkText(root, TreeWalker.ControlViewWalker, 0, ref nodes, 800, maxChars, ref chars, parts, src);
            // Some toolkits hide text from the control view but expose it in the
            // raw view (WPF popups, Java/Swing, custom Qt widgets), so retry once.
            if (chars == 0)
            {
                nodes = 0;
                WalkText(root, TreeWalker.RawViewWalker, 0, ref nodes, 400, maxChars, ref chars, parts, src);
            }
        }
        catch { }
        sources = "[" + src.ToString() + "]";
        return string.Join("\n", parts.ToArray());
    }

    static string GatherText(IntPtr hwnd, int maxChars, out string strategy, out string sources)
    {
        string uiaSrc, winSrc;
        string uia = UiaText(hwnd, maxChars, out uiaSrc);
        string win = Win32Text(hwnd, out winSrc);
        if (uia.Length >= win.Length)
        {
            strategy = uia.Length > 0 ? "uia" : "none";
            sources = uiaSrc;
            return uia;
        }
        strategy = "win32";
        sources = winSrc;
        return win;
    }

    static void ReadText(Cmd c)
    {
        IntPtr hwnd = TargetHwndOrForeground(c);
        int maxChars = Math.Max(200, c.I("chars", 20000));
        string strategy, sources;
        string text = GatherText(hwnd, maxChars, out strategy, out sources);
        if (text.Length > maxChars) text = text.Substring(0, maxChars);
        StringBuilder o = new StringBuilder();
        o.Append("{\"ok\":true,\"hwnd\":").Append(hwnd.ToInt64());
        o.Append(",\"title\":").Append(J.S(WindowTitle(hwnd)));
        o.Append(",\"chars\":").Append(text.Length);
        o.Append(",\"strategy\":").Append(J.S(strategy));
        o.Append(",\"sources\":").Append(sources);
        if (text.Length == 0)
            o.Append(",\"hint\":\"this window exposes no text (Chromium without renderer accessibility, custom-drawn UI); take a screenshot instead\"");
        o.Append(",\"text\":").Append(J.S(text)).Append('}');
        Emit(o.ToString());
    }

    static void WaitText(Cmd c)
    {
        string pattern = c.Get("regex", null);
        if (pattern == null) { Err("--regex is required"); return; }
        Regex rx;
        try { rx = new Regex(pattern, RegexOptions.CultureInvariant); }
        catch (Exception ex) { Err("bad --regex: " + ex.Message); return; }
        IntPtr hwnd = TargetHwndOrForeground(c);
        int timeout = Math.Max(50, c.I("timeout", 8000));
        int interval = Math.Max(50, c.I("interval", 150));
        int maxChars = Math.Max(200, c.I("chars", 20000));
        int tail = Math.Max(0, c.I("tail", 2000));
        Stopwatch sw = Stopwatch.StartNew();
        string text = "", strategy = "none", sources = "[]";
        bool matched = false;
        while (true)
        {
            text = GatherText(hwnd, maxChars, out strategy, out sources);
            if (text.Length > maxChars) text = text.Substring(0, maxChars);
            if (rx.IsMatch(text)) { matched = true; break; }
            if (sw.ElapsedMilliseconds >= timeout) break;
            Thread.Sleep(interval);
        }
        string shown = tail > 0 && text.Length > tail ? text.Substring(text.Length - tail) : text;
        StringBuilder o = new StringBuilder();
        o.Append("{\"ok\":").Append(matched ? "true" : "false");
        if (!matched)
            o.Append(",\"error\":").Append(J.S("text did not match /" + pattern + "/ within " + sw.ElapsedMilliseconds +
                "ms (strategy " + strategy + ", " + text.Length + " chars read)"));
        o.Append(",\"matched\":").Append(matched ? "true" : "false");
        o.Append(",\"waitedMs\":").Append(sw.ElapsedMilliseconds);
        o.Append(",\"hwnd\":").Append(hwnd.ToInt64());
        o.Append(",\"strategy\":").Append(J.S(strategy));
        o.Append(",\"chars\":").Append(text.Length);
        o.Append(",\"text\":").Append(J.S(shown)).Append('}');
        Emit(o.ToString());
    }

    // ---------------- trimming captures ----------------

    static void Bump(Dictionary<int, int> d, int v)
    {
        int n;
        d.TryGetValue(v, out n);
        d[v] = n + 1;
    }

    // A screenshot of a dialog is mostly background: cropping to the ink bbox
    // makes the evidence legible when it lands in a report and stops "the crop
    // missed the window" from shipping as a blank figure.
    static Rectangle ContentBox(Bitmap bmp, int tol, int pad)
    {
        int w = bmp.Width, h = bmp.Height;
        Rectangle full = new Rectangle(0, 0, w, h);
        if (w < 8 || h < 8) return full;
        int[] px = new int[w * h];
        BitmapData bd = null;
        try
        {
            bd = bmp.LockBits(full, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            if (bd.Stride == w * 4) Marshal.Copy(bd.Scan0, px, 0, px.Length);
            else
            {
                for (int y = 0; y < h; y++)
                    Marshal.Copy(new IntPtr(bd.Scan0.ToInt64() + (long)y * bd.Stride), px, y * w, w);
            }
        }
        catch { return full; }
        finally { if (bd != null) { try { bmp.UnlockBits(bd); } catch { } } }

        Dictionary<int, int> hist = new Dictionary<int, int>();
        int stepX = Math.Max(1, w / 200), stepY = Math.Max(1, h / 200);
        for (int x = 0; x < w; x += stepX) { Bump(hist, px[x]); Bump(hist, px[(h - 1) * w + x]); }
        for (int y = 0; y < h; y += stepY) { Bump(hist, px[y * w]); Bump(hist, px[y * w + w - 1]); }
        int bg = 0, best = -1;
        foreach (KeyValuePair<int, int> kv in hist) if (kv.Value > best) { best = kv.Value; bg = kv.Key; }
        int br = (bg >> 16) & 0xFF, bgg = (bg >> 8) & 0xFF, bb = bg & 0xFF;

        int minX = w, minY = h, maxX = -1, maxY = -1;
        for (int y = 0; y < h; y++)
        {
            int row = y * w;
            for (int x = 0; x < w; x++)
            {
                int p = px[row + x];
                if (Math.Abs(((p >> 16) & 0xFF) - br) > tol ||
                    Math.Abs(((p >> 8) & 0xFF) - bgg) > tol ||
                    Math.Abs((p & 0xFF) - bb) > tol)
                {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX < 0) return full;
        minX = Math.Max(0, minX - pad);
        minY = Math.Max(0, minY - pad);
        maxX = Math.Min(w - 1, maxX + pad);
        maxY = Math.Min(h - 1, maxY + pad);
        Rectangle box = new Rectangle(minX, minY, maxX - minX + 1, maxY - minY + 1);
        if (box.Width < 16 || box.Height < 16) return full;
        return box;
    }

    static void TypeText(Cmd c)
    {
        string text = c.Get("text", null);
        string file = c.Get("textfile", null);
        if (file != null) text = File.ReadAllText(file, Encoding.UTF8);
        if (text == null) { Err("--text or --textfile is required"); return; }
        RequireForeground(c);
        foreach (char ch in text)
        {
            if (ch == '\n') { KeyDownUp(0x0D, true); KeyDownUp(0x0D, false); }
            else if (ch == '\r') continue;
            else if (ch == '\t') { KeyDownUp(0x09, true); KeyDownUp(0x09, false); }
            else UnicodeChar(ch);
            Thread.Sleep(2);
        }
        // --verify closes the loop the app cannot: keystrokes can be swallowed by
        // an IME composition, a secure field or a lost focus, and the only honest
        // answer is whether the text actually showed up in the window.
        if (c.Has("verify"))
        {
            IntPtr hwnd = TargetHwndOrForeground(c);
            int maxChars = Math.Max(4000, text.Length * 8);
            string strategy, sources;
            string seen = GatherText(hwnd, maxChars, out strategy, out sources);
            if (seen.Trim().Length == 0)
            {
                Emit("{\"ok\":true,\"action\":\"type\",\"chars\":" + text.Length +
                     ",\"verified\":\"unavailable\",\"strategy\":\"none\"," +
                     "\"hint\":\"this window exposes no text channel; verify the result visually\"}");
                return;
            }
            string want = Normalize(text);
            string have = Normalize(seen);
            bool hit = want.Length > 0 && have.IndexOf(want, StringComparison.OrdinalIgnoreCase) >= 0;
            if (hit)
            {
                Emit("{\"ok\":true,\"action\":\"type\",\"chars\":" + text.Length +
                     ",\"verified\":true,\"strategy\":" + J.S(strategy) + "}");
                return;
            }
            string tail = want.Length > 60 ? want.Substring(want.Length - 60) : want;
            Err("typed text did not show up in the window (strategy " + strategy + ", " + seen.Length +
                " chars read). The app may have swallowed the keystrokes - IME composition, a secure field, " +
                "or lost focus. Wanted the last part: \"" + tail + "\"; read back: \"" +
                (have.Length > 200 ? have.Substring(have.Length - 200) : have) + "\"");
            return;
        }
        Emit("{\"ok\":true,\"action\":\"type\",\"chars\":" + text.Length + "}");
    }

    // Map a printable ASCII character to the virtual-key that a real keyboard would send.
    // Some Qt/UIA apps ignore KEYEVENTF_UNICODE (VK_PACKET) for secure fields such as a
    // telnet password prompt, so the driver needs a genuine key event path as well.
    static ushort VkOfChar(char ch, out bool needShift)
    {
        needShift = false;
        if (ch >= 'a' && ch <= 'z') return (ushort)char.ToUpperInvariant(ch);
        if (ch >= 'A' && ch <= 'Z') { needShift = true; return (ushort)ch; }
        if (ch >= '0' && ch <= '9') return (ushort)ch;
        switch (ch)
        {
            case ' ': return 0x20;
            case '.': return 0xBE;
            case ',': return 0xBC;
            case '-': return 0xBD;
            case '_': needShift = true; return 0xBD;
            case '/': return 0xBF;
            case ';': return 0xBA;
            case ':': needShift = true; return 0xBA;
            case '=': return 0xBB;
            case '+': needShift = true; return 0xBB;
            case '[': return 0xDB;
            case ']': return 0xDD;
            case '\\': return 0xDC;
            case '\'': return 0xDE;
            case '`': return 0xC0;
            case '\t': return 0x09;
            case '!': needShift = true; return 0x31;
            case '@': needShift = true; return 0x32;
            case '#': needShift = true; return 0x33;
            case '$': needShift = true; return 0x34;
            case '%': needShift = true; return 0x35;
            case '^': needShift = true; return 0x36;
            case '&': needShift = true; return 0x37;
            case '*': needShift = true; return 0x38;
            case '(': needShift = true; return 0x39;
            case ')': needShift = true; return 0x30;
            case '?': needShift = true; return 0xBF;
            case '<': needShift = true; return 0xBC;
            case '>': needShift = true; return 0xBE;
            case '"': needShift = true; return 0xDE;
        }
        return 0;
    }

    // Last-resort text path: post WM_CHAR straight into the window's queue. Some Qt widgets
    // (Packet Tracer's telnet password box among them) reject synthesized key events but still
    // honour character messages, which is what this uses.
    static void TypePost(Cmd c)
    {
        string text = c.Get("text", null);
        string file = c.Get("textfile", null);
        if (file != null) text = File.ReadAllText(file, Encoding.UTF8);
        if (text == null) { Err("--text or --textfile is required"); return; }
        IntPtr h = TargetWindow(c);
        if (h == IntPtr.Zero) h = Native.GetForegroundWindow();
        if (h == IntPtr.Zero) throw new Exception("no target window");
        int n = 0;
        foreach (char ch in text)
        {
            if (ch == '\r') continue;
            uint msg = ch == '\n' ? 0x0100u : 0x0102u; // WM_KEYDOWN for Enter, WM_CHAR otherwise
            if (ch == '\n')
            {
                Native.PostMessage(h, 0x0100, (IntPtr)0x0D, (IntPtr)0x001C0001);
                Native.PostMessage(h, 0x0102, (IntPtr)0x0D, (IntPtr)0x001C0001);
                Native.PostMessage(h, 0x0101, (IntPtr)0x0D, (IntPtr)0xC01C0001);
            }
            else
            {
                Native.PostMessage(h, msg, (IntPtr)ch, (IntPtr)1);
            }
            n++;
            Thread.Sleep(12);
        }
        Emit("{\"ok\":true,\"action\":\"typepost\",\"chars\":" + n + "}");
    }

    static void TypeKeys(Cmd c)
    {
        string text = c.Get("text", null);
        string file = c.Get("textfile", null);
        if (file != null) text = File.ReadAllText(file, Encoding.UTF8);
        if (text == null) { Err("--text or --textfile is required"); return; }
        RequireForeground(c);
        const ushort VK_SHIFT = 0x10;
        int typed = 0;
        foreach (char ch in text)
        {
            if (ch == '\r') continue;
            if (ch == '\n') { KeyDownUp(0x0D, true); KeyDownUp(0x0D, false); typed++; Thread.Sleep(6); continue; }
            bool shift;
            ushort vk = VkOfChar(ch, out shift);
            if (vk == 0) { UnicodeChar(ch); typed++; Thread.Sleep(6); continue; }
            if (shift) KeyDownUp(VK_SHIFT, true);
            KeyDownUp(vk, true);
            KeyDownUp(vk, false);
            if (shift) KeyDownUp(VK_SHIFT, false);
            typed++;
            Thread.Sleep(6);
        }
        Emit("{\"ok\":true,\"action\":\"typekeys\",\"chars\":" + typed + "}");
    }

    static void KeyCombo(Cmd c)
    {
        string combo = c.Get("combo", null);
        if (combo == null) { Err("--combo is required, e.g. ctrl+shift+s"); return; }
        RequireForeground(c);
        string[] seqs = combo.Split(',');
        int sent = 0;
        foreach (string seqRaw in seqs)
        {
            string seq = seqRaw.Trim();
            if (seq.Length == 0) continue;
            string[] parts = seq.Split('+');
            List<ushort> mods = new List<ushort>();
            ushort main = 0; bool hasMain = false;
            foreach (string pRaw in parts)
            {
                string p = pRaw.Trim();
                if (p.Length == 0) continue;
                if (p.Length == 1 && !VK.ContainsKey(p)) { main = (ushort)char.ToUpperInvariant(p[0]); hasMain = true; continue; }
                ushort vk;
                if (!VK.TryGetValue(p, out vk)) throw new Exception("unknown key: " + p);
                bool isMod = p.Equals("ctrl", StringComparison.OrdinalIgnoreCase) || p.Equals("control", StringComparison.OrdinalIgnoreCase)
                    || p.Equals("shift", StringComparison.OrdinalIgnoreCase) || p.Equals("alt", StringComparison.OrdinalIgnoreCase)
                    || p.Equals("win", StringComparison.OrdinalIgnoreCase) || p.Equals("lwin", StringComparison.OrdinalIgnoreCase)
                    || p.Equals("rwin", StringComparison.OrdinalIgnoreCase) || p.Equals("lshift", StringComparison.OrdinalIgnoreCase)
                    || p.Equals("rshift", StringComparison.OrdinalIgnoreCase) || p.Equals("lctrl", StringComparison.OrdinalIgnoreCase)
                    || p.Equals("rctrl", StringComparison.OrdinalIgnoreCase) || p.Equals("lalt", StringComparison.OrdinalIgnoreCase)
                    || p.Equals("ralt", StringComparison.OrdinalIgnoreCase);
                if (isMod) mods.Add(vk);
                else { main = vk; hasMain = true; }
            }
            foreach (ushort m in mods) KeyDownUp(m, true);
            if (hasMain) { KeyDownUp(main, true); KeyDownUp(main, false); }
            for (int i = mods.Count - 1; i >= 0; i--) KeyDownUp(mods[i], false);
            sent++;
            Thread.Sleep(40);
        }
        Emit("{\"ok\":true,\"action\":\"key\",\"sequences\":" + sent + "}");
    }

    // ---------------- window / process ----------------

    const uint GA_ROOT = 2;

    static IntPtr RootWindow(IntPtr h)
    {
        if (h == IntPtr.Zero) return IntPtr.Zero;
        IntPtr r = Native.GetAncestor(h, GA_ROOT);
        return r == IntPtr.Zero ? h : r;
    }

    // True when the given window (or a child of it) currently owns keyboard
    // focus. SendInput has no destination, so every key event must be guarded
    // by this check -- otherwise a mistyped command lands in whatever the user
    // happens to have in front.
    static bool OwnsForeground(IntPtr h)
    {
        IntPtr fg = Native.GetForegroundWindow();
        if (fg == IntPtr.Zero || h == IntPtr.Zero) return false;
        return RootWindow(fg) == RootWindow(h);
    }

    static string ForegroundDesc()
    {
        IntPtr fg = Native.GetForegroundWindow();
        if (fg == IntPtr.Zero) return "none";
        StringBuilder t = new StringBuilder(260);
        Native.GetWindowTextW(fg, t, t.Capacity);
        return "\"" + t.ToString() + "\" (hwnd " + fg.ToInt64() + ")";
    }

    static void RequireForeground(Cmd c)
    {
        string hs = c.Get("hwnd", null);
        if (hs == null) return;
        IntPtr h = new IntPtr(long.Parse(hs, NumberStyles.Integer, CultureInfo.InvariantCulture));
        if (!OwnsForeground(h))
            throw new Exception("refusing to send input: window " + hs + " is not in the foreground (foreground is " + ForegroundDesc() + "); call focus first" + (Privileged() ? "" : SandboxHint));
    }

    static void Focus(Cmd c)
    {
        IntPtr h = MustHwnd(c);
        // SWP_SHOWWINDOW instead of ShowWindow: a parent that spawns this engine
        // with STARTUPINFO.wShowWindow = SW_HIDE (windowsHide) has its value
        // substituted into the first ShowWindow call on that window - which
        // would silently turn "show the target" into "hide the target".
        Native.SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0040);
        if (Native.IsIconic(h))
        {
            Native.ShowWindow(h, 9 /*SW_RESTORE*/);
            Native.SetWindowPos(h, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0040);
        }
        if (!OwnsForeground(h)) Activate(h, c.Has("force"));
        Thread.Sleep(120);
        bool ok = OwnsForeground(h);
        StringBuilder o = new StringBuilder();
        o.Append("{\"ok\":").Append(J.B(ok));
        if (!ok) o.Append(",\"error\":").Append(J.S("could not raise window " + h.ToInt64() + "; foreground is " + ForegroundDesc() + " (Windows blocks background apps from stealing focus)" + (Privileged() ? "" : SandboxHint)));
        o.Append(",\"window\":").Append(WinJson(h)).Append('}');
        Emit(o.ToString());
    }

    // Foreground activation, escalating. Measured on Windows 10/11: a plain
    // SetForegroundWindow from a background process is refused, and
    // AttachThreadInput to the foreground thread fails outright
    // (ERROR_ACCESS_DENIED / ERROR_INVALID_PARAMETER), so the ladder is:
    //  1. ask politely (succeeds when we already own the foreground);
    //  2. hold ALT down across the call - an outstanding ALT press releases the
    //     foreground lock, which is the only thing that reliably lets a
    //     background process raise a window. Released immediately after;
    //  3. SwitchToThisWindow (bypasses the SetForegroundWindow heuristics);
    //  4. only with --force: minimize + restore, because the shell grants the
    //     foreground on a restore. Visibly disruptive, so never automatic.
    static void Activate(IntPtr h, bool force)
    {
        Native.SetForegroundWindow(h);
        WaitOwns(h, 80);
        if (OwnsForeground(h)) return;

        for (int i = 0; i < 2; i++)
        {
            KeyDownUp(0x12 /*VK_MENU*/, true);
            Thread.Sleep(25);
            Native.SetForegroundWindow(h);
            Thread.Sleep(60);
            KeyDownUp(0x12, false);
            WaitOwns(h, 140);
            if (OwnsForeground(h)) return;
        }

        Native.SwitchToThisWindow(h, false);
        WaitOwns(h, 120);
        if (OwnsForeground(h)) return;
        if (!force) return;

        Native.ShowWindow(h, 6 /*SW_MINIMIZE*/);
        Thread.Sleep(160);
        Native.ShowWindow(h, 9 /*SW_RESTORE*/);
        WaitOwns(h, 260);
    }

    static void WaitOwns(IntPtr h, int ms)
    {
        int waited = 0;
        while (waited < ms && !OwnsForeground(h))
        {
            Thread.Sleep(20);
            waited += 20;
        }
    }

    static IntPtr MustHwnd(Cmd c)
    {
        string s = c.Get("hwnd", null);
        if (s == null) throw new Exception("--hwnd is required");
        return new IntPtr(long.Parse(s, NumberStyles.Integer, CultureInfo.InvariantCulture));
    }

    static void Launch(Cmd c)
    {
        string path = c.Get("path", null);
        if (path == null) { Err("--path is required"); return; }
        string args = c.Get("args", "");
        string cwd = c.Get("cwd", null);
        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = path;
        psi.Arguments = args;
        if (cwd != null) psi.WorkingDirectory = cwd;
        psi.UseShellExecute = true;
        Process p = null;
        try { p = Process.Start(psi); }
        catch (Exception ex)
        {
            // 1223 (ERROR_CANCELLED) here means Windows itself vetoed the new
            // process -- Smart App Control / an ASR rule for a freshly built
            // unsigned exe, or a sandbox job that forbids desktop access.
            // Signed, installed applications launch normally.
            Err("launch failed: " + ex.Message + " (Windows blocked the new process; unsigned freshly built exes need Smart App Control / ASR attention)");
            return;
        }
        int pid = 0; string title = ""; long hwnd = 0;
        if (p != null)
        {
            pid = p.Id;
            int waited = 0;
            while (waited < c.I("wait", 2500))
            {
                try { p.Refresh(); }
                catch { break; }
                if (p.HasExited) break;
                if (p.MainWindowHandle != IntPtr.Zero) { hwnd = p.MainWindowHandle.ToInt64(); title = p.MainWindowTitle; break; }
                Thread.Sleep(100); waited += 100;
            }
            // Console hosts (conhost / Windows Terminal) do not always surface a
            // MainWindowHandle for the launched process even though a window is
            // clearly on screen, so fall back to our own top-level enumeration.
            if (hwnd == 0)
            {
                Dictionary<int, IntPtr> wins = MainWindows();
                IntPtr h;
                if (wins.TryGetValue(pid, out h) && h != IntPtr.Zero)
                {
                    hwnd = h.ToInt64();
                    title = WindowTitle(h);
                }
            }
        }
        Emit("{\"ok\":true,\"path\":" + J.S(path) + ",\"pid\":" + pid + ",\"hwnd\":" + hwnd + ",\"title\":" + J.S(title) + "}");
    }

    static void Kill(Cmd c)
    {
        string name = c.Get("name", null);
        int pid = c.I("pid", 0);
        int n = 0;
        if (pid != 0) { Process.GetProcessById(pid).Kill(); n = 1; }
        else if (name != null)
        {
            if (name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) name = name.Substring(0, name.Length - 4);
            foreach (Process p in Process.GetProcessesByName(name)) { p.Kill(); n++; }
        }
        else { Err("--pid or --name required"); return; }
        Emit("{\"ok\":true,\"killed\":" + n + "}");
    }

    static void Procs(Cmd c)
    {
        string filter = c.Get("name", null);
        Dictionary<int, string> map = ProcMap();
        Dictionary<int, IntPtr> wins = MainWindows();
        List<int> ids = new List<int>(map.Keys);
        ids.Sort();
        StringBuilder b = new StringBuilder("[");
        int n = 0;
        foreach (int pid in ids)
        {
            string nm = map[pid];
            if (filter != null && nm.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0) continue;
            if (n > 0) b.Append(',');
            b.Append("{\"pid\":").Append(pid).Append(",\"name\":").Append(J.S(nm));
            IntPtr mw;
            if (wins.TryGetValue(pid, out mw) && mw != IntPtr.Zero)
            {
                b.Append(",\"hwnd\":").Append(mw.ToInt64());
                b.Append(",\"title\":").Append(J.S(Safe(WindowTitle(mw))));
            }
            b.Append('}');
            n++;
            if (n >= 400) break;
        }
        b.Append(']');
        Emit("{\"ok\":true,\"count\":" + n + ",\"processes\":" + b + "}");
    }

    static void Clip(Cmd c)
    {
        if (c.Has("get") || (!c.Has("text") && !c.Has("textfile")))
        {
            string t = "";
            try { t = System.Windows.Forms.Clipboard.GetText(); } catch (Exception ex) { Err("clipboard get failed: " + ex.Message); return; }
            Emit("{\"ok\":true,\"text\":" + J.S(t) + "}");
            return;
        }
        string text = c.Get("text", null);
        string file = c.Get("textfile", null);
        if (file != null) text = File.ReadAllText(file, Encoding.UTF8);
        try
        {
            if (text == null || text.Length == 0) System.Windows.Forms.Clipboard.Clear();
            else System.Windows.Forms.Clipboard.SetText(text);
        }
        catch (Exception ex) { Err("clipboard set failed: " + ex.Message); return; }
        Emit("{\"ok\":true,\"chars\":" + (text == null ? 0 : text.Length) + "}");
    }

    static void Invoke(Cmd c)
    {
        AutomationElement root = RootOf(c);
        string path = c.Get("path", null);
        if (path == null) { Err("--path is required"); return; }
        AutomationElement el = Resolve(root, path);
        string used = "";
        object pat;
        if (el.TryGetCurrentPattern(InvokePattern.Pattern, out pat)) { ((InvokePattern)pat).Invoke(); used = "invoke"; }
        else if (el.TryGetCurrentPattern(TogglePattern.Pattern, out pat)) { ((TogglePattern)pat).Toggle(); used = "toggle"; }
        else if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pat)) { ((SelectionItemPattern)pat).Select(); used = "select"; }
        else if (el.TryGetCurrentPattern(ValuePattern.Pattern, out pat))
        {
            string v = c.Get("value", null);
            if (v != null) { ((ValuePattern)pat).SetValue(v); used = "setvalue"; }
        }
        if (used.Length == 0)
        {
            System.Windows.Rect r = el.Current.BoundingRectangle;
            if (r.Width <= 0) { Err("element has no pattern and no bounding rect"); return; }
            AbsMove((int)(r.X + r.Width / 2), (int)(r.Y + r.Height / 2));
            Thread.Sleep(40);
            SendMouse(Native.MOUSEEVENTF_LEFTDOWN, 0, 0, 0); Thread.Sleep(20);
            SendMouse(Native.MOUSEEVENTF_LEFTUP, 0, 0, 0);
            used = "click-center";
        }
        Thread.Sleep(80);
        Emit("{\"ok\":true,\"pattern\":" + J.S(used) + ",\"element\":{\"role\":" + J.S(el.Current.ControlType.ProgrammaticName.Replace("ControlType.", "")) + ",\"name\":" + J.S(Safe(el.Current.Name)) + "}}");
    }
}
