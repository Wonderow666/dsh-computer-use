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
                case "find": Find(c); break;
                case "hit": Hit(c); break;
                case "move": Mouse(c, "move"); break;
                case "click": Mouse(c, "click"); break;
                case "scroll": Mouse(c, "scroll"); break;
                case "drag": Drag(c); break;
                case "type": TypeText(c); break;
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
"  shot --out FILE [--hwnd H] [--region l,t,r,b] [--nocursor] [--printwindow]\n" +
"  tree [--hwnd H] [--depth N] [--max N]   UI Automation control-view tree with element ids\n" +
"  find --name TEXT [--hwnd H]   search UIA elements by name/automationId\n" +
"  hit --x X --y Y               what is under a screen point\n" +
"  move --x X --y Y\n" +
"  click [--x X] [--y Y] [--button left|right|middle] [--count N] [--double]\n" +
"  scroll [--x X] [--y Y] [--amount N] [--horizontal]\n" +
"  drag --x1 X --y1 Y --x2 X --y2 Y [--ms 400]\n" +
"  type --text TEXT | --textfile FILE   (unicode via KEYEVENTF_UNICODE)\n" +
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
            if (!c.Has("nocursor"))
            {
                try
                {
                    Native.POINT pt; Native.GetCursorPos(out pt);
                    int cx = pt.X - rect.Left, cy = pt.Y - rect.Top;
                    if (cx >= 0 && cy >= 0 && cx < rect.Width && cy < rect.Height)
                        using (Graphics g = Graphics.FromImage(bmp))
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
            if (maxw > 0 && bmp.Width > maxw)
            {
                savedH = (int)Math.Round(bmp.Height * (maxw / (double)bmp.Width));
                savedW = maxw;
                using (Bitmap small = new Bitmap(savedW, savedH))
                {
                    using (Graphics g2 = Graphics.FromImage(small))
                    {
                        g2.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                        g2.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                        g2.DrawImage(bmp, 0, 0, savedW, savedH);
                    }
                    small.Save(outp, ImageFormat.Png);
                }
            }
            else bmp.Save(outp, ImageFormat.Png);
        }
        Native.POINT pc; Native.GetCursorPos(out pc);
        StringBuilder o = new StringBuilder();
        o.Append("{\"ok\":true,\"path\":").Append(J.S(Path.GetFullPath(outp)));
        o.Append(",\"x\":").Append(rect.Left).Append(",\"y\":").Append(rect.Top);
        o.Append(",\"w\":").Append(savedW).Append(",\"h\":").Append(savedH);
        o.Append(",\"srcW\":").Append(rect.Width).Append(",\"srcH\":").Append(rect.Height);
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
        if (mode == "click" || mode == "scroll") GuardPoint(c, mx, my);
        // Move the pointer absolutely first when coordinates are given.
        if (mx != int.MinValue && my != int.MinValue)
        {
            if (mode == "scroll") Native.SetCursorPos(mx, my);
            else AbsMove(mx, my);
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

    static void Drag(Cmd c)
    {
        int x1 = c.I("x1", int.MinValue), y1 = c.I("y1", int.MinValue), x2 = c.I("x2", int.MinValue), y2 = c.I("y2", int.MinValue);
        if (x1 == int.MinValue || y1 == int.MinValue || x2 == int.MinValue || y2 == int.MinValue)
        { Err("--x1 --y1 --x2 --y2 required"); return; }
        int ms = Math.Max(60, c.I("ms", 400));
        string btn = c.Get("button", "left");
        AbsMove(x1, y1); Thread.Sleep(60);
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
        a[0].u.ki.wScan = 0;
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
        Emit("{\"ok\":true,\"action\":\"type\",\"chars\":" + text.Length + "}");
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
