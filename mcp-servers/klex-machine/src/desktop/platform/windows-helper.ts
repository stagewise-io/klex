/**
 * C# for the persistent Windows PowerShell desktop helper. Windows PowerShell
 * 5.1 compiles it with the .NET Framework CodeDom compiler, so it must stay
 * C# 5: no string interpolation, `?.`, `nameof` or expression-bodied members.
 *
 * Protocol, one ASCII line each way: `request\targ...` in, `ok\tpayload` or
 * `err\tbase64(utf8 message)` out. Text arguments, titles and images are
 * base64. Every call runs on the one thread that made itself DPI aware, so
 * all coordinates are physical pixels of the primary monitor.
 */
export const WINDOWS_HELPER_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace KlexMachine
{
    public static class DesktopHost
    {
        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Explicit)]
        struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

        [StructLayout(LayoutKind.Sequential)]
        struct INPUT { public uint type; public INPUTUNION u; }

        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        struct USEROBJECTFLAGS { public int fInherit; public int fReserved; public uint dwFlags; }

        delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll", SetLastError = true)] static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] static extern short VkKeyScanW(char ch);
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
        [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint mapType);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextLengthW(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int max);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] static extern int GetWindowLong(IntPtr hWnd, int index);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int command);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool doAttach);
        [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
        [DllImport("user32.dll", SetLastError = true)] static extern bool GetUserObjectInformationW(IntPtr handle, int index, ref USEROBJECTFLAGS info, int length, out int needed);
        [DllImport("user32.dll", SetLastError = true, EntryPoint = "GetUserObjectInformationW")] static extern bool GetUserObjectName(IntPtr handle, int index, byte[] info, int length, out int needed);
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int value);
        [DllImport("shcore.dll")] static extern int GetProcessDpiAwareness(IntPtr process, out int value);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT value, int size);
        [DllImport("dwmapi.dll", EntryPoint = "DwmGetWindowAttribute")] static extern int DwmGetWindowAttributeInt(IntPtr hWnd, int attribute, out int value, int size);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
        [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);

        const uint INPUT_MOUSE = 0;
        const uint INPUT_KEYBOARD = 1;
        const uint MOUSE_MOVE = 0x0001;
        const uint MOUSE_LEFTDOWN = 0x0002;
        const uint MOUSE_LEFTUP = 0x0004;
        const uint MOUSE_RIGHTDOWN = 0x0008;
        const uint MOUSE_RIGHTUP = 0x0010;
        const uint MOUSE_MIDDLEDOWN = 0x0020;
        const uint MOUSE_MIDDLEUP = 0x0040;
        const uint MOUSE_WHEEL = 0x0800;
        const uint MOUSE_HWHEEL = 0x1000;
        const uint MOUSE_ABSOLUTE = 0x8000;
        const uint KEY_EXTENDED = 0x0001;
        const uint KEY_UP = 0x0002;
        const uint KEY_UNICODE = 0x0004;
        const int WHEEL_DELTA = 120;
        const ushort VK_SHIFT = 0x10;
        const ushort VK_CONTROL = 0x11;
        const ushort VK_MENU = 0x12;
        const ushort VK_RETURN = 0x0D;
        const ushort VK_TAB = 0x09;
        const ushort VK_UNASSIGNED = 0xE8;
        const int MAX_WINDOWS = 50;
        static readonly ushort[] HELD_KEYS = { 0x10, 0x11, 0x12, 0x5B, 0x5C, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5 };
        const string READY = "klex-desktop-ready";

        static string dpiAwareness = "unaware";

        public static void Run()
        {
            InitDpiAwareness();
            TextReader input = Console.In;
            StreamWriter output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            output.NewLine = "\n";
            output.WriteLine(READY);
            output.Flush();
            string line;
            while ((line = input.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                string reply;
                try
                {
                    reply = "ok\t" + Dispatch(line.Split('\t'));
                }
                catch (Exception error)
                {
                    reply = "err\t" + Base64(error.Message);
                }
                output.WriteLine(reply);
                output.Flush();
            }
        }

        static void InitDpiAwareness()
        {
            try
            {
                if (SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) { dpiAwareness = "per-monitor-v2"; return; }
                if (SetThreadDpiAwarenessContext(new IntPtr(-3)) != IntPtr.Zero) { dpiAwareness = "per-monitor"; return; }
            }
            catch (EntryPointNotFoundException) { }
            try
            {
                SetProcessDpiAwareness(2);
                int level;
                if (GetProcessDpiAwareness(IntPtr.Zero, out level) == 0 && level > 0)
                {
                    dpiAwareness = level == 2 ? "per-monitor" : "system";
                    return;
                }
            }
            catch (DllNotFoundException) { }
            catch (EntryPointNotFoundException) { }
            try
            {
                if (SetProcessDPIAware()) dpiAwareness = "system";
            }
            catch (EntryPointNotFoundException) { }
        }

        static string Dispatch(string[] request)
        {
            switch (request[0])
            {
                case "probe": return Probe();
                case "size": return Text(ScreenWidth()) + " " + Text(ScreenHeight());
                case "capture": return Capture(request);
                case "move": MoveTo(Int(request, 1), Int(request, 2)); return "";
                case "click": Click(request); return "";
                case "drag": Drag(request); return "";
                case "scroll": Scroll(request); return "";
                case "type": TypeText(FromBase64(Arg(request, 1))); return "";
                case "key": Keys(request); return "";
                case "windows": return Windows();
                case "focus": Focus(Arg(request, 1)); return "";
                case "release": Release(); return "";
                default: throw new ArgumentException("Unknown desktop request: " + request[0]);
            }
        }

        static string Probe()
        {
            StringBuilder result = new StringBuilder();
            uint session;
            result.Append("session=").Append(ProcessIdToSessionId(GetCurrentProcessId(), out session) ? Text((int)session) : "unknown");
            result.Append("\tinteractive=").Append(StationVisible() ? "1" : "0");
            result.Append("\tdesktop=").Append(Base64(InputDesktopName()));
            result.Append("\tdpi=").Append(dpiAwareness);
            result.Append("\twidth=").Append(Text(ScreenWidth()));
            result.Append("\theight=").Append(Text(ScreenHeight()));
            string capture = "ok";
            try
            {
                using (Bitmap pixel = Grab(0, 0, 1, 1)) { }
            }
            catch (Exception error)
            {
                capture = Base64(error.Message);
            }
            result.Append("\tcapture=").Append(capture);
            return result.ToString();
        }

        static bool StationVisible()
        {
            IntPtr station = GetProcessWindowStation();
            if (station == IntPtr.Zero) return false;
            USEROBJECTFLAGS flags = new USEROBJECTFLAGS();
            int needed;
            if (!GetUserObjectInformationW(station, 1, ref flags, Marshal.SizeOf(typeof(USEROBJECTFLAGS)), out needed)) return false;
            return (flags.dwFlags & 1) != 0;
        }

        static string InputDesktopName()
        {
            IntPtr desktop = OpenInputDesktop(0, false, 0x0001);
            if (desktop == IntPtr.Zero) return "";
            try
            {
                byte[] buffer = new byte[512];
                int needed;
                if (!GetUserObjectName(desktop, 2, buffer, buffer.Length, out needed)) return "";
                return Encoding.Unicode.GetString(buffer, 0, Math.Min(Math.Max(needed, 0), buffer.Length)).TrimEnd('\0');
            }
            finally
            {
                CloseDesktop(desktop);
            }
        }

        static int ScreenWidth() { return GetSystemMetrics(0); }
        static int ScreenHeight() { return GetSystemMetrics(1); }

        static Bitmap Grab(int x, int y, int width, int height)
        {
            Bitmap bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb);
            try
            {
                using (Graphics graphics = Graphics.FromImage(bitmap))
                {
                    graphics.CopyFromScreen(x, y, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
                }
                return bitmap;
            }
            catch
            {
                bitmap.Dispose();
                throw;
            }
        }

        static string Capture(string[] request)
        {
            int x = 0, y = 0, width = ScreenWidth(), height = ScreenHeight();
            if (Arg(request, 1) != "-")
            {
                x = Int(request, 1); y = Int(request, 2); width = Int(request, 3); height = Int(request, 4);
            }
            if (width <= 0 || height <= 0) throw new ArgumentException("The capture region is empty");
            using (Bitmap shot = Grab(x, y, width, height))
            {
                Bitmap image = shot;
                if (Arg(request, 5) != "-")
                {
                    int outWidth = Int(request, 5), outHeight = Int(request, 6);
                    if (outWidth <= 0 || outHeight <= 0) throw new ArgumentException("The output size is empty");
                    if (outWidth != width || outHeight != height) image = Resize(shot, outWidth, outHeight);
                }
                try
                {
                    return Encode(image, Arg(request, 7));
                }
                finally
                {
                    if (image != shot) image.Dispose();
                }
            }
        }

        static Bitmap Resize(Bitmap source, int width, int height)
        {
            Bitmap result = new Bitmap(width, height, PixelFormat.Format24bppRgb);
            using (Graphics graphics = Graphics.FromImage(result))
            using (ImageAttributes attributes = new ImageAttributes())
            {
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
                graphics.CompositingQuality = CompositingQuality.HighQuality;
                attributes.SetWrapMode(WrapMode.TileFlipXY);
                graphics.DrawImage(source, new Rectangle(0, 0, width, height), 0, 0, source.Width, source.Height, GraphicsUnit.Pixel, attributes);
            }
            return result;
        }

        static string Encode(Bitmap image, string format)
        {
            using (MemoryStream stream = new MemoryStream())
            {
                if (format == "jpeg")
                {
                    EncoderParameters parameters = new EncoderParameters(1);
                    parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 75L);
                    image.Save(stream, Codec("image/jpeg"), parameters);
                }
                else if (format == "png")
                {
                    image.Save(stream, ImageFormat.Png);
                }
                else
                {
                    throw new ArgumentException("Unsupported image format: " + format);
                }
                return Convert.ToBase64String(stream.ToArray());
            }
        }

        static ImageCodecInfo Codec(string mimeType)
        {
            foreach (ImageCodecInfo codec in ImageCodecInfo.GetImageEncoders())
            {
                if (codec.MimeType == mimeType) return codec;
            }
            throw new InvalidOperationException("No encoder for " + mimeType);
        }

        static void Send(params INPUT[] inputs)
        {
            uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
            if (sent != inputs.Length)
            {
                throw new InvalidOperationException("Windows blocked the input (error " + Text(Marshal.GetLastWin32Error()) + "). Input cannot reach windows of elevated apps, the lock screen or a UAC prompt.");
            }
        }

        static void TrySend(params INPUT[] inputs)
        {
            try { Send(inputs); } catch (InvalidOperationException) { }
        }

        static INPUT Mouse(uint flags, int dx, int dy, uint data)
        {
            INPUT input = new INPUT();
            input.type = INPUT_MOUSE;
            input.u.mi.dx = dx;
            input.u.mi.dy = dy;
            input.u.mi.mouseData = data;
            input.u.mi.dwFlags = flags;
            return input;
        }

        static INPUT Key(ushort vk, bool up)
        {
            INPUT input = new INPUT();
            input.type = INPUT_KEYBOARD;
            input.u.ki.wVk = vk;
            input.u.ki.wScan = (ushort)MapVirtualKeyW(vk, 0);
            input.u.ki.dwFlags = (up ? KEY_UP : 0) | (Extended(vk) ? KEY_EXTENDED : 0);
            return input;
        }

        static INPUT Unicode(char ch, bool up)
        {
            INPUT input = new INPUT();
            input.type = INPUT_KEYBOARD;
            input.u.ki.wScan = ch;
            input.u.ki.dwFlags = KEY_UNICODE | (up ? KEY_UP : 0);
            return input;
        }

        static bool Extended(ushort vk)
        {
            return (vk >= 0x21 && vk <= 0x28) || vk == 0x2C || vk == 0x2D || vk == 0x2E
                || vk == 0x5B || vk == 0x5C || vk == 0x5D || vk == 0x6F || vk == 0x90;
        }

        static void MoveTo(int x, int y)
        {
            int width = Math.Max(ScreenWidth(), 2), height = Math.Max(ScreenHeight(), 2);
            int nx = (int)Math.Round(x * 65535.0 / (width - 1));
            int ny = (int)Math.Round(y * 65535.0 / (height - 1));
            Send(Mouse(MOUSE_MOVE | MOUSE_ABSOLUTE, nx, ny, 0));
            // Absolute input is normalized to 0..65535; this lands on the exact pixel.
            SetCursorPos(x, y);
        }

        static uint[] Button(string name)
        {
            if (name == "middle") return new uint[] { MOUSE_MIDDLEDOWN, MOUSE_MIDDLEUP };
            if (name != "left" && name != "right") throw new ArgumentException("Unknown mouse button: " + name);
            // SendInput buttons are physical, so honor swapped buttons.
            bool left = (name == "left") != (GetSystemMetrics(23) != 0);
            return left ? new uint[] { MOUSE_LEFTDOWN, MOUSE_LEFTUP } : new uint[] { MOUSE_RIGHTDOWN, MOUSE_RIGHTUP };
        }

        static void Click(string[] request)
        {
            int x = Int(request, 1), y = Int(request, 2);
            uint[] button = Button(Arg(request, 3));
            int count = Int(request, 4);
            ushort[] modifiers = VirtualKeys(Arg(request, 5));
            MoveTo(x, y);
            int held = 0;
            try
            {
                for (; held < modifiers.Length; held++) Send(Key(modifiers[held], false));
                for (int i = 0; i < count; i++)
                {
                    if (i > 0) Thread.Sleep(40);
                    Send(Mouse(button[0], 0, 0, 0), Mouse(button[1], 0, 0, 0));
                }
            }
            finally
            {
                for (int i = held - 1; i >= 0; i--) TrySend(Key(modifiers[i], true));
            }
        }

        static void Drag(string[] request)
        {
            int fromX = Int(request, 1), fromY = Int(request, 2), toX = Int(request, 3), toY = Int(request, 4);
            uint[] button = Button(Arg(request, 5));
            MoveTo(fromX, fromY);
            Send(Mouse(button[0], 0, 0, 0));
            bool down = true;
            try
            {
                Thread.Sleep(50);
                for (int step = 1; step <= 10; step++)
                {
                    MoveTo(fromX + (toX - fromX) * step / 10, fromY + (toY - fromY) * step / 10);
                    Thread.Sleep(15);
                }
                Thread.Sleep(50);
                Send(Mouse(button[1], 0, 0, 0));
                down = false;
            }
            finally
            {
                if (down) TrySend(Mouse(button[1], 0, 0, 0));
            }
        }

        static void Scroll(string[] request)
        {
            int x = Int(request, 1), y = Int(request, 2);
            string direction = Arg(request, 3);
            int amount = Int(request, 4);
            uint flag;
            int delta;
            switch (direction)
            {
                case "up": flag = MOUSE_WHEEL; delta = WHEEL_DELTA; break;
                case "down": flag = MOUSE_WHEEL; delta = -WHEEL_DELTA; break;
                case "left": flag = MOUSE_HWHEEL; delta = -WHEEL_DELTA; break;
                case "right": flag = MOUSE_HWHEEL; delta = WHEEL_DELTA; break;
                default: throw new ArgumentException("Unknown scroll direction: " + direction);
            }
            MoveTo(x, y);
            for (int i = 0; i < amount; i++)
            {
                if (i > 0) Thread.Sleep(30);
                Send(Mouse(flag, 0, 0, unchecked((uint)delta)));
            }
        }

        static void Tap(ushort vk)
        {
            Send(Key(vk, false), Key(vk, true));
        }

        static void TypeText(string text)
        {
            for (int i = 0; i < text.Length; i++)
            {
                char ch = text[i];
                if (ch == '\r')
                {
                    if (i + 1 < text.Length && text[i + 1] == '\n') continue;
                    Tap(VK_RETURN);
                }
                else if (ch == '\n') Tap(VK_RETURN);
                else if (ch == '\t') Tap(VK_TAB);
                else if (char.IsHighSurrogate(ch) && i + 1 < text.Length)
                {
                    char low = text[++i];
                    Send(Unicode(ch, false), Unicode(ch, true), Unicode(low, false), Unicode(low, true));
                }
                else Send(Unicode(ch, false), Unicode(ch, true));
                Thread.Sleep(8);
            }
        }

        static ushort[] VirtualKeys(string list)
        {
            if (list == "-" || list.Length == 0) return new ushort[0];
            string[] parts = list.Split(',');
            ushort[] keys = new ushort[parts.Length];
            for (int i = 0; i < parts.Length; i++) keys[i] = ushort.Parse(parts[i], CultureInfo.InvariantCulture);
            return keys;
        }

        static void AddOnce(List<ushort> keys, ushort vk)
        {
            if (!keys.Contains(vk)) keys.Add(vk);
        }

        static void Keys(string[] request)
        {
            for (int i = 1; i < request.Length; i++)
            {
                if (i > 1) Thread.Sleep(40);
                PressCombo(request[i]);
            }
        }

        static void PressCombo(string combo)
        {
            List<ushort> keys = new List<ushort>();
            foreach (string token in combo.Split('+'))
            {
                if (token.Length < 2) throw new ArgumentException("Invalid key token: " + token);
                int code = int.Parse(token.Substring(1), CultureInfo.InvariantCulture);
                if (token[0] == 'v')
                {
                    AddOnce(keys, (ushort)code);
                }
                else if (token[0] == 'c')
                {
                    char ch = (char)code;
                    short scan = VkKeyScanW(ch);
                    if (scan == -1) throw new ArgumentException("The keyboard layout has no key for '" + ch + "'");
                    int shiftState = (scan >> 8) & 0xFF;
                    if ((shiftState & 1) != 0) AddOnce(keys, VK_SHIFT);
                    if ((shiftState & 2) != 0) AddOnce(keys, VK_CONTROL);
                    if ((shiftState & 4) != 0) AddOnce(keys, VK_MENU);
                    AddOnce(keys, (ushort)(scan & 0xFF));
                }
                else
                {
                    throw new ArgumentException("Invalid key token: " + token);
                }
            }
            int pressed = 0;
            try
            {
                for (; pressed < keys.Count; pressed++) Send(Key(keys[pressed], false));
            }
            finally
            {
                for (int i = pressed - 1; i >= 0; i--) TrySend(Key(keys[i], true));
            }
        }

        static bool Cloaked(IntPtr hWnd)
        {
            try
            {
                int cloaked;
                return DwmGetWindowAttributeInt(hWnd, 14, out cloaked, 4) == 0 && cloaked != 0;
            }
            catch (DllNotFoundException) { return false; }
        }

        static bool Bounds(IntPtr hWnd, out RECT rect)
        {
            try
            {
                // Extended frame bounds leave out the invisible resize border.
                if (DwmGetWindowAttribute(hWnd, 9, out rect, Marshal.SizeOf(typeof(RECT))) == 0) return true;
            }
            catch (DllNotFoundException) { }
            return GetWindowRect(hWnd, out rect);
        }

        static string Windows()
        {
            List<string> records = new List<string>();
            IntPtr foreground = GetForegroundWindow();
            int screenWidth = ScreenWidth(), screenHeight = ScreenHeight();
            EnumWindowsProc visit = delegate(IntPtr hWnd, IntPtr unused)
            {
                if (records.Count >= MAX_WINDOWS) return false;
                if (!IsWindowVisible(hWnd) || IsIconic(hWnd) || Cloaked(hWnd)) return true;
                if ((GetWindowLong(hWnd, -20) & 0x80) != 0) return true;
                int length = GetWindowTextLengthW(hWnd);
                if (length <= 0) return true;
                StringBuilder title = new StringBuilder(length + 1);
                GetWindowTextW(hWnd, title, title.Capacity);
                RECT rect;
                if (!Bounds(hWnd, out rect)) return true;
                // Capture and input cover the primary monitor only, so clip to it.
                int left = Math.Max(rect.Left, 0), top = Math.Max(rect.Top, 0);
                int width = Math.Min(rect.Right, screenWidth) - left, height = Math.Min(rect.Bottom, screenHeight) - top;
                if (width <= 1 || height <= 1) return true;
                records.Add(hWnd.ToInt64().ToString(CultureInfo.InvariantCulture) + "," + Text(left) + "," + Text(top) + ","
                    + Text(width) + "," + Text(height) + "," + (hWnd == foreground ? "1" : "0") + "," + Base64(title.ToString()));
                return true;
            };
            EnumWindows(visit, IntPtr.Zero);
            GC.KeepAlive(visit);
            return string.Join(";", records.ToArray());
        }

        static bool IsForeground(IntPtr hWnd)
        {
            for (int i = 0; i < 10; i++)
            {
                if (GetForegroundWindow() == hWnd) return true;
                Thread.Sleep(20);
            }
            return false;
        }

        static void Focus(string id)
        {
            long value;
            if (!long.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out value)) throw new ArgumentException("Invalid window id: " + id);
            IntPtr hWnd = new IntPtr(value);
            if (!IsWindow(hWnd)) throw new ArgumentException("No window has id " + id);
            if (IsIconic(hWnd)) ShowWindow(hWnd, 9);
            if (SetForegroundWindow(hWnd) && IsForeground(hWnd)) return;

            // Foreground lock: borrow the foreground thread's input state.
            uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
            uint thread = GetCurrentThreadId();
            bool attached = foregroundThread != 0 && foregroundThread != thread && AttachThreadInput(thread, foregroundThread, true);
            try
            {
                BringWindowToTop(hWnd);
                SetForegroundWindow(hWnd);
            }
            finally
            {
                if (attached) AttachThreadInput(thread, foregroundThread, false);
            }
            if (IsForeground(hWnd)) return;

            // Holding Alt lifts the lock; an unassigned key keeps the release from opening a menu.
            Send(Key(VK_MENU, false));
            try
            {
                SetForegroundWindow(hWnd);
                TrySend(Key(VK_UNASSIGNED, false), Key(VK_UNASSIGNED, true));
            }
            finally
            {
                TrySend(Key(VK_MENU, true));
            }
            if (!IsForeground(hWnd)) throw new InvalidOperationException("Windows kept window " + id + " in the background");
        }

        // A killed helper skips its finally blocks; a new one lets go of what it may have held.
        static void Release()
        {
            foreach (ushort vk in HELD_KEYS)
            {
                if ((GetAsyncKeyState(vk) & 0x8000) != 0) TrySend(Key(vk, true));
            }
            // GetAsyncKeyState reads physical buttons, which is what SendInput sends.
            if ((GetAsyncKeyState(0x01) & 0x8000) != 0) TrySend(Mouse(MOUSE_LEFTUP, 0, 0, 0));
            if ((GetAsyncKeyState(0x02) & 0x8000) != 0) TrySend(Mouse(MOUSE_RIGHTUP, 0, 0, 0));
            if ((GetAsyncKeyState(0x04) & 0x8000) != 0) TrySend(Mouse(MOUSE_MIDDLEUP, 0, 0, 0));
        }

        static string Arg(string[] request, int index)
        {
            if (index >= request.Length) throw new ArgumentException("Missing argument " + Text(index) + " for " + request[0]);
            return request[index];
        }

        static int Int(string[] request, int index)
        {
            return int.Parse(Arg(request, index), NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
        }

        static string Text(int value) { return value.ToString(CultureInfo.InvariantCulture); }
        static string Base64(string value) { return Convert.ToBase64String(Encoding.UTF8.GetBytes(value)); }
        static string FromBase64(string value) { return Encoding.UTF8.GetString(Convert.FromBase64String(value)); }
    }
}
`;

/** Printed once the helper reads requests; a prompt may precede it on its line. */
export const WINDOWS_HELPER_READY = 'klex-desktop-ready';

/**
 * The single `-Command -` line that compiles the helper and hands stdin to
 * it. Reading the script from stdin keeps it off the command line, where
 * encoded commands look like malware to endpoint protection.
 */
export function windowsHelperBootstrap(): string {
  const source = Buffer.from(WINDOWS_HELPER_SOURCE, 'utf8').toString('base64');
  return [
    "$ErrorActionPreference = 'Stop'",
    `try { Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'))) -ReferencedAssemblies System.Drawing } catch { [Console]::Error.WriteLine('klex-desktop: ' + $_.Exception.Message); exit 3 }`,
    '[KlexMachine.DesktopHost]::Run()',
    'exit 0',
  ].join('; ');
}
