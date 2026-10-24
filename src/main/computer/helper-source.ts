// The native helper, as C# source (compiled once with the csc.exe that ships with Windows, see helper.ts).
// It speaks JSON lines on stdin / stdout. Input is injected with SendInput, the clock is a spin-wait on a
// Stopwatch, and two low level hooks tell real hardware input from injected input. C# 5 only: that is what csc has.
// Keep this free of backticks and dollar-brace sequences, it lives in a template string.
export const HELPER_VERSION = 3

export const HELPER_SOURCE = String.raw`
using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

static class Win
{
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }
    [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
    [StructLayout(LayoutKind.Sequential)] public struct KBDLLHOOKSTRUCT { public uint vkCode, scanCode, flags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData, flags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    public delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);

    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint thread);
    [DllImport("user32.dll")] public static extern short VkKeyScanEx(char c, IntPtr layout);
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll")] public static extern short GetKeyState(int vk);
    [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr d);
    [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr mod, uint thread);
    [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder sb, ref int size);
    [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint ms);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
}

class Helper
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 64 };
    static readonly object OutLock = new object();
    static TextWriter Stdout;
    static long lastPhys = 0;
    static volatile int abortSeq = 0;
    static int killVk = 0, killMods = 0;
    static Win.HookProc kbProc, mouseProc;
    static Win.POINT lastInj;
    static bool haveInj = false;

    static void Emit(object o)
    {
        string line = Json.Serialize(o);
        lock (OutLock) { Stdout.WriteLine(line); Stdout.Flush(); }
    }

    static Dictionary<string, object> D(params object[] kv)
    {
        var d = new Dictionary<string, object>();
        for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
        return d;
    }

    static double Num(object o) { return o == null ? 0 : Convert.ToDouble(o); }
    static string Str(object o) { return o == null ? "" : o.ToString(); }

    static void Main()
    {
        try { Win.SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
        try { Win.timeBeginPeriod(1); } catch { }
        Stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        var hooks = new Thread(HookThread);
        hooks.IsBackground = true;
        hooks.Start();
        var queue = new BlockingCollection<Dictionary<string, object>>();
        var worker = new Thread(delegate ()
        {
            Thread.CurrentThread.Priority = ThreadPriority.AboveNormal;
            foreach (var req in queue.GetConsumingEnumerable()) Handle(req);
        });
        worker.IsBackground = true;
        worker.Start();
        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        string line;
        while ((line = stdin.ReadLine()) != null)
        {
            if (line.Length == 0) continue;
            Dictionary<string, object> req;
            try { req = (Dictionary<string, object>)Json.DeserializeObject(line); } catch { continue; }
            string cmd = Str(req.ContainsKey("cmd") ? req["cmd"] : null);
            // these must work while a long play is running
            if (cmd == "abort") { abortSeq++; Emit(D("id", req["id"], "ok", true)); continue; }
            if (cmd == "idle") { Emit(D("id", req["id"], "ok", true, "idleMs", IdleMs())); continue; }
            if (cmd == "killkey") { killVk = (int)Num(req["vk"]); killMods = (int)Num(req["mods"]); Emit(D("id", req["id"], "ok", true)); continue; }
            if (cmd == "quit") break;
            queue.Add(req);
        }
        Environment.Exit(0);
    }

    static double IdleMs()
    {
        if (lastPhys == 0) return 1e9;
        return (Stopwatch.GetTimestamp() - lastPhys) * 1000.0 / Stopwatch.Frequency;
    }

    // ---------------------------------------------------------------- hooks: real hardware input vs injected input
    static void HookThread()
    {
        kbProc = KbHook;
        mouseProc = MouseHook;
        IntPtr mod = Win.GetModuleHandle(null);
        Win.SetWindowsHookEx(13, kbProc, mod, 0);
        Win.SetWindowsHookEx(14, mouseProc, mod, 0);
        Win.MSG m;
        while (Win.GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { }
    }

    static IntPtr KbHook(int code, IntPtr w, IntPtr l)
    {
        if (code >= 0)
        {
            var k = (Win.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(Win.KBDLLHOOKSTRUCT));
            if ((k.flags & 0x10) == 0)
            {
                lastPhys = Stopwatch.GetTimestamp();
                int msg = w.ToInt32();
                if ((msg == 0x100 || msg == 0x104) && killVk != 0 && (int)k.vkCode == killVk && KillModsHeld())
                {
                    abortSeq++;
                    Emit(D("event", "kill"));
                }
            }
        }
        return Win.CallNextHookEx(IntPtr.Zero, code, w, l);
    }

    static bool KillModsHeld()
    {
        if ((killMods & 1) != 0 && (Win.GetAsyncKeyState(0x11) & 0x8000) == 0) return false;
        if ((killMods & 2) != 0 && (Win.GetAsyncKeyState(0x12) & 0x8000) == 0) return false;
        if ((killMods & 4) != 0 && (Win.GetAsyncKeyState(0x10) & 0x8000) == 0) return false;
        if ((killMods & 8) != 0 && (Win.GetAsyncKeyState(0x5B) & 0x8000) == 0 && (Win.GetAsyncKeyState(0x5C) & 0x8000) == 0) return false;
        return true;
    }

    static IntPtr MouseHook(int code, IntPtr w, IntPtr l)
    {
        if (code >= 0)
        {
            var s = (Win.MSLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(Win.MSLLHOOKSTRUCT));
            if ((s.flags & 0x03) == 0) lastPhys = Stopwatch.GetTimestamp();
        }
        return Win.CallNextHookEx(IntPtr.Zero, code, w, l);
    }

    // ---------------------------------------------------------------- commands
    static void Handle(Dictionary<string, object> req)
    {
        object id = req["id"];
        try
        {
            string cmd = Str(req["cmd"]);
            object r;
            switch (cmd)
            {
                case "hello": r = D("version", 3, "virtual", Virtual(), "pid", Process.GetCurrentProcess().Id); break;
                case "state": r = State(); break;
                case "windows": r = Windows(); break;
                case "windowAt": r = WindowAt((int)Num(req["x"]), (int)Num(req["y"])); break;
                case "focus": r = Focus(new IntPtr((long)Num(req["hwnd"]))); break;
                case "play": r = Play((ArrayList)ToList(req["events"]), req.ContainsKey("guard") ? new IntPtr((long)Num(req["guard"])) : IntPtr.Zero, req.ContainsKey("allowUser") && Convert.ToBoolean(req["allowUser"])); break;
                case "focused": r = FocusedElement(); break;
                case "uitree": r = UiTree(new IntPtr((long)Num(req["hwnd"])), (int)Num(req["maxNodes"]), (int)Num(req["maxDepth"])); break;
                case "launch": r = Launch(Str(req["target"])); break;
                case "cursor": { Win.POINT p; Win.GetCursorPos(out p); r = D("x", p.x, "y", p.y); break; }
                case "setcursor": { Win.SetCursorPos((int)Num(req["x"]), (int)Num(req["y"])); r = D("ok", true); break; }
                default: throw new Exception("unknown command " + cmd);
            }
            var d = r as Dictionary<string, object>;
            if (d == null) d = D("value", r);
            d["id"] = id;
            d["ok"] = true;
            Emit(d);
        }
        catch (Exception e)
        {
            Emit(D("id", id, "ok", false, "error", e.GetType().Name + ": " + e.Message));
        }
    }

    static IList ToList(object o) { var a = o as ArrayList; if (a != null) return a; var arr = o as object[]; return new ArrayList(arr); }

    static Dictionary<string, object> Virtual()
    {
        return D("x", Win.GetSystemMetrics(76), "y", Win.GetSystemMetrics(77), "w", Win.GetSystemMetrics(78), "h", Win.GetSystemMetrics(79));
    }

    static string Title(IntPtr h)
    {
        var sb = new StringBuilder(512);
        Win.GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    static string ClassOf(IntPtr h)
    {
        var sb = new StringBuilder(256);
        Win.GetClassName(h, sb, sb.Capacity);
        return sb.ToString();
    }

    static string ExeOf(uint pid)
    {
        IntPtr p = Win.OpenProcess(0x1000, false, pid);
        if (p == IntPtr.Zero) return "";
        try
        {
            var sb = new StringBuilder(1024);
            int n = sb.Capacity;
            return Win.QueryFullProcessImageName(p, 0, sb, ref n) ? sb.ToString() : "";
        }
        finally { Win.CloseHandle(p); }
    }

    static Dictionary<string, object> Describe(IntPtr h, int z, IntPtr fg)
    {
        uint pid;
        Win.GetWindowThreadProcessId(h, out pid);
        string path = ExeOf(pid);
        Win.RECT r;
        if (Win.DwmGetWindowAttribute(h, 9, out r, 16) != 0) Win.GetWindowRect(h, out r);
        return D("hwnd", h.ToInt64(), "title", Title(h), "cls", ClassOf(h), "pid", (int)pid,
            "exe", string.IsNullOrEmpty(path) ? "" : Path.GetFileName(path), "path", path,
            "x", r.left, "y", r.top, "w", r.right - r.left, "h", r.bottom - r.top,
            "minimized", Win.IsIconic(h), "maximized", Win.IsZoomed(h), "focused", h == fg, "z", z);
    }

    static Dictionary<string, object> State()
    {
        Win.POINT p;
        Win.GetCursorPos(out p);
        IntPtr fg = Win.GetForegroundWindow();
        IntPtr desk = Win.OpenInputDesktop(0, false, 0x100);
        bool secure = desk == IntPtr.Zero;
        if (!secure) Win.CloseDesktop(desk);
        object f = null;
        if (fg != IntPtr.Zero) f = Describe(fg, 0, fg);
        return D("x", p.x, "y", p.y, "foreground", f, "secure", secure, "idleMs", IdleMs(), "virtual", Virtual());
    }

    static ArrayList Windows()
    {
        var list = new ArrayList();
        IntPtr fg = Win.GetForegroundWindow();
        int z = 0;
        Win.EnumWindows(delegate (IntPtr h, IntPtr l)
        {
            z++;
            if (!Win.IsWindowVisible(h)) return true;
            int cloaked;
            if (Win.DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
            string title = Title(h);
            int ex = Win.GetWindowLong(h, -20);
            bool tool = (ex & 0x80) != 0 && (ex & 0x40000) == 0;
            if (title.Length == 0 || tool) return true;
            string cls = ClassOf(h);
            if (cls == "Progman" || cls == "WorkerW") return true;
            list.Add(Describe(h, z, fg));
            return list.Count < 80;
        }, IntPtr.Zero);
        return list;
    }

    static object WindowAt(int x, int y)
    {
        Win.POINT p; p.x = x; p.y = y;
        IntPtr h = Win.WindowFromPoint(p);
        if (h == IntPtr.Zero) return D("window", null);
        IntPtr root = Win.GetAncestor(h, 2);
        if (root != IntPtr.Zero) h = root;
        return D("window", Describe(h, 0, Win.GetForegroundWindow()));
    }

    static object Focus(IntPtr h)
    {
        if (!Win.IsWindow(h)) throw new Exception("that window no longer exists");
        if (Win.IsIconic(h)) Win.ShowWindow(h, 9);
        IntPtr fg = Win.GetForegroundWindow();
        uint dummy;
        uint fgThread = Win.GetWindowThreadProcessId(fg, out dummy);
        uint me = Win.GetCurrentThreadId();
        bool attached = fgThread != 0 && fgThread != me && Win.AttachThreadInput(me, fgThread, true);
        Win.BringWindowToTop(h);
        Win.SetForegroundWindow(h);
        if (attached) Win.AttachThreadInput(me, fgThread, false);
        Thread.Sleep(120);
        return D("focused", Win.GetForegroundWindow() == h);
    }

    static object Launch(string target)
    {
        var psi = new ProcessStartInfo(target);
        psi.UseShellExecute = true;
        var p = Process.Start(psi);
        return D("pid", p == null ? -1 : p.Id);
    }

    // ---------------------------------------------------------------- playing events
    static void Send(Win.INPUT i)
    {
        var arr = new Win.INPUT[] { i };
        Win.SendInput(1, arr, Marshal.SizeOf(typeof(Win.INPUT)));
    }

    static void MouseEv(uint flags, int dx, int dy, uint data)
    {
        var i = new Win.INPUT();
        i.type = 0;
        i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = data; i.u.mi.dwFlags = flags;
        Send(i);
    }

    static void KeyEv(ushort vk, ushort scan, uint flags)
    {
        var i = new Win.INPUT();
        i.type = 1;
        i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags;
        Send(i);
    }

    static void MoveTo(int x, int y)
    {
        int vx = Win.GetSystemMetrics(76), vy = Win.GetSystemMetrics(77), vw = Win.GetSystemMetrics(78), vh = Win.GetSystemMetrics(79);
        int nx = (int)Math.Round((x - vx) * 65535.0 / Math.Max(1, vw - 1));
        int ny = (int)Math.Round((y - vy) * 65535.0 / Math.Max(1, vh - 1));
        MouseEv(0x8000 | 0x4000 | 0x0001, nx, ny, 0);
        lastInj.x = x; lastInj.y = y; haveInj = true;
    }

    static bool IsPlain(int code)
    {
        return (code >= 'a' && code <= 'z') || (code >= 'A' && code <= 'Z') || (code >= '0' && code <= '9') || code == ' ';
    }

    static void CharTap(int code, int hold, IntPtr layoutOwner)
    {
        if (IsPlain(code))
        {
            uint pid;
            uint th = Win.GetWindowThreadProcessId(layoutOwner, out pid);
            short vks = Win.VkKeyScanEx((char)code, Win.GetKeyboardLayout(th));
            if (vks != -1 && ((vks >> 8) & 0xFF) <= 1)
            {
                ushort vk = (ushort)(vks & 0xFF);
                bool shift = ((vks >> 8) & 1) != 0;
                if (code >= 'A' && code <= 'Z' || code >= 'a' && code <= 'z') { if ((Win.GetKeyState(0x14) & 1) != 0) shift = !shift; }
                if (shift) { KeyEv(0x10, (ushort)Win.MapVirtualKey(0x10, 0), 0); Thread.Sleep(14); }
                KeyEv(vk, (ushort)Win.MapVirtualKey(vk, 0), 0);
                Thread.Sleep(hold);
                KeyEv(vk, (ushort)Win.MapVirtualKey(vk, 0), 2);
                if (shift) { Thread.Sleep(12); KeyEv(0x10, (ushort)Win.MapVirtualKey(0x10, 0), 2); }
                return;
            }
        }
        string s = char.ConvertFromUtf32(code);
        foreach (char c in s) KeyEv(0, c, 4);
        Thread.Sleep(hold);
        foreach (char c in s) KeyEv(0, c, 4 | 2);
    }

    static Dictionary<string, object> Fin(int done, int total, string reason, double late, double lateMax, Win.POINT? at)
    {
        Win.POINT p;
        Win.GetCursorPos(out p);
        IntPtr fg = Win.GetForegroundWindow();
        return D("done", done, "total", total, "reason", reason, "lateAvgMs", Math.Round(late, 2), "lateMaxMs", Math.Round(lateMax, 2), "x", p.x, "y", p.y, "fg", fg.ToInt64());
    }

    static object Play(ArrayList events, IntPtr guard, bool allowUser)
    {
        int seq = abortSeq;
        long start = Stopwatch.GetTimestamp();
        long physAtStart = lastPhys;
        var sw = Stopwatch.StartNew();
        Win.POINT cur;
        Win.GetCursorPos(out cur);
        lastInj = cur; haveInj = true;
        double lateSum = 0, lateMax = 0;
        int n = events.Count;
        for (int i = 0; i < n; i++)
        {
            var e = (IList)events[i];
            double t = Num(e[1]);
            string kind = Str(e[0]);
            while (true)
            {
                double rem = t - sw.Elapsed.TotalMilliseconds;
                if (rem <= 0) break;
                if (abortSeq != seq) return Fin(i, n, "abort", lateSum / Math.Max(1, i), lateMax, null);
                if (rem > 2.5) Thread.Sleep(1); else Thread.SpinWait(40);
            }
            if (abortSeq != seq) return Fin(i, n, "abort", lateSum / Math.Max(1, i), lateMax, null);
            if (!allowUser)
            {
                if (lastPhys != 0 && lastPhys > start && lastPhys != physAtStart) return Fin(i, n, "user", lateSum / Math.Max(1, i), lateMax, null);
                Win.GetCursorPos(out cur);
                if (haveInj && (Math.Abs(cur.x - lastInj.x) > 4 || Math.Abs(cur.y - lastInj.y) > 4)) return Fin(i, n, "user", lateSum / Math.Max(1, i), lateMax, null);
            }
            if (guard != IntPtr.Zero && (kind == "k" || kind == "c") && Win.GetForegroundWindow() != guard) return Fin(i, n, "foreground", lateSum / Math.Max(1, i), lateMax, null);
            double late = sw.Elapsed.TotalMilliseconds - t;
            if (late < 0) late = 0;
            lateSum += late; if (late > lateMax) lateMax = late;
            switch (kind)
            {
                case "m": MoveTo((int)Num(e[2]), (int)Num(e[3])); break;
                case "b":
                    {
                        string b = Str(e[2]);
                        bool down = Num(e[3]) != 0;
                        uint f = b == "l" ? (down ? 0x2u : 0x4u) : b == "r" ? (down ? 0x8u : 0x10u) : (down ? 0x20u : 0x40u);
                        MouseEv(f, 0, 0, 0);
                        break;
                    }
                case "w": MouseEv(Num(e[3]) != 0 ? 0x1000u : 0x0800u, 0, 0, unchecked((uint)(int)Num(e[2]))); break;
                case "k":
                    {
                        ushort vk = (ushort)Num(e[2]);
                        uint f = (Num(e[3]) == 0 ? 2u : 0u) | (Num(e[4]) != 0 ? 1u : 0u);
                        KeyEv(vk, (ushort)Win.MapVirtualKey(vk, 0), f);
                        break;
                    }
                case "c": CharTap((int)Num(e[2]), (int)Num(e[3]), guard != IntPtr.Zero ? guard : Win.GetForegroundWindow()); break;
            }
        }
        // the last integer rounding of SendInput may leave the pointer a pixel away
        if (haveInj)
        {
            Win.GetCursorPos(out cur);
            if (cur.x != lastInj.x || cur.y != lastInj.y) { if (Math.Abs(cur.x - lastInj.x) <= 3 && Math.Abs(cur.y - lastInj.y) <= 3) Win.SetCursorPos(lastInj.x, lastInj.y); }
        }
        return Fin(n, n, "ok", lateSum / Math.Max(1, n), lateMax, null);
    }

    // ---------------------------------------------------------------- UI Automation
    static string TypeName(AutomationElement e)
    {
        try { return e.Cached.ControlType.ProgrammaticName.Replace("ControlType.", ""); } catch { return ""; }
    }

    static Dictionary<string, object> Node(AutomationElement e, int depth)
    {
        var c = e.Cached;
        var r = c.BoundingRectangle;
        bool pwd = false;
        try { pwd = c.IsPassword; } catch { }
        return D("d", depth, "type", TypeName(e), "name", c.Name, "id", c.AutomationId, "cls", c.ClassName,
            "x", double.IsInfinity(r.X) ? 0 : (int)r.X, "y", double.IsInfinity(r.Y) ? 0 : (int)r.Y,
            "w", double.IsInfinity(r.Width) ? 0 : (int)r.Width, "h", double.IsInfinity(r.Height) ? 0 : (int)r.Height,
            "enabled", c.IsEnabled, "focus", c.HasKeyboardFocus, "offscreen", c.IsOffscreen, "password", pwd);
    }

    static object FocusedElement()
    {
        object result = null;
        var t = new Thread(delegate ()
        {
            try
            {
                var e = AutomationElement.FocusedElement;
                if (e == null) return;
                var c = e.Current;
                var d = D("type", c.ControlType.ProgrammaticName.Replace("ControlType.", ""), "name", c.Name, "id", c.AutomationId, "cls", c.ClassName, "pid", c.ProcessId, "password", c.IsPassword);
                result = d;
            }
            catch { }
        });
        t.IsBackground = true;
        t.SetApartmentState(ApartmentState.MTA);
        t.Start();
        if (!t.Join(2500)) return D("element", null, "timeout", true);
        return D("element", result);
    }

    static object UiTree(IntPtr hwnd, int maxNodes, int maxDepth)
    {
        var nodes = new ArrayList();
        string error = null;
        bool cut = false;
        var t = new Thread(delegate ()
        {
            try
            {
                if (hwnd == IntPtr.Zero) hwnd = Win.GetForegroundWindow();
                var cr = new CacheRequest();
                cr.Add(AutomationElement.NameProperty);
                cr.Add(AutomationElement.ControlTypeProperty);
                cr.Add(AutomationElement.BoundingRectangleProperty);
                cr.Add(AutomationElement.IsPasswordProperty);
                cr.Add(AutomationElement.IsEnabledProperty);
                cr.Add(AutomationElement.IsOffscreenProperty);
                cr.Add(AutomationElement.AutomationIdProperty);
                cr.Add(AutomationElement.ClassNameProperty);
                cr.Add(AutomationElement.HasKeyboardFocusProperty);
                cr.TreeScope = TreeScope.Element;
                var walker = TreeWalker.ControlViewWalker;
                var sw = Stopwatch.StartNew();
                var q = new Queue<KeyValuePair<AutomationElement, int>>();
                using (cr.Activate())
                {
                    q.Enqueue(new KeyValuePair<AutomationElement, int>(AutomationElement.FromHandle(hwnd), 0));
                    int visited = 0;
                    while (q.Count > 0)
                    {
                        var cur = q.Dequeue();
                        visited++;
                        if (visited > 4000 || sw.ElapsedMilliseconds > 6000) { cut = true; break; }
                        AutomationElement el = cur.Key;
                        Dictionary<string, object> node = null;
                        try { node = Node(el, cur.Value); } catch { continue; }
                        string type = (string)node["type"];
                        string name = (string)node["name"];
                        bool off = (bool)node["offscreen"];
                        int w = (int)node["w"], h = (int)node["h"];
                        bool useful = !off && w > 0 && h > 0 && (name.Length > 0 || type == "Edit" || type == "Document" || type == "CheckBox" || type == "RadioButton" || type == "ComboBox" || type == "Button");
                        if (useful && !(bool)node["password"] && (type == "Edit" || type == "ComboBox" || type == "Document"))
                        {
                            try
                            {
                                object p;
                                if (el.TryGetCurrentPattern(ValuePattern.Pattern, out p))
                                {
                                    string v = ((ValuePattern)p).Current.Value;
                                    if (v != null) node["value"] = v.Length > 120 ? v.Substring(0, 120) : v;
                                }
                            }
                            catch { }
                        }
                        if (useful) { nodes.Add(node); if (nodes.Count >= maxNodes) { cut = true; break; } }
                        if (cur.Value >= maxDepth) continue;
                        try
                        {
                            AutomationElement ch = walker.GetFirstChild(el, cr);
                            while (ch != null)
                            {
                                q.Enqueue(new KeyValuePair<AutomationElement, int>(ch, cur.Value + 1));
                                ch = walker.GetNextSibling(ch, cr);
                                if (q.Count > 6000) { cut = true; break; }
                            }
                        }
                        catch { }
                    }
                }
            }
            catch (Exception e) { error = e.Message; }
        });
        t.IsBackground = true;
        t.SetApartmentState(ApartmentState.MTA);
        t.Start();
        if (!t.Join(9000)) { cut = true; error = "the application did not answer in time"; }
        return D("nodes", nodes, "truncated", cut, "error", error);
    }
}
`
