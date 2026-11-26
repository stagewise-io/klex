/**
 * C# for the Windows desktop stream host, the Windows side of
 * native/stream-protocol.md. Like the desktop helper it is compiled by
 * Windows PowerShell 5.1, so it must stay C# 5: no string interpolation, `?.`,
 * `nameof` or expression-bodied members.
 *
 * The primary monitor is captured with GDI about ten times a second, in
 * physical pixels. While the lock screen or a UAC prompt holds the input
 * desktop, which no user process can capture, the frame is a placeholder.
 * Input goes through SendInput as scan codes, the clipboard through Windows
 * Forms on its own STA thread.
 */
export const WINDOWS_STREAM_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace KlexMachine
{
    public static class StreamHost
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
        struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT ptScreenPos; }

        [StructLayout(LayoutKind.Sequential)]
        struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }

        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] static extern short VkKeyScanW(char ch);
        [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint mapType);
        [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO info);
        [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out ICONINFO info);
        [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr icon, int width, int height, int step, IntPtr brush, int flags);
        [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", SetLastError = true, EntryPoint = "GetUserObjectInformationW")] static extern bool GetUserObjectName(IntPtr handle, int index, byte[] info, int length, out int needed);
        [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int value);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr handle);

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
        const uint KEY_SCANCODE = 0x0008;
        const int WHEEL_DELTA = 120;
        const int TILE = 128;
        const int MAX_DIMENSION = 16384;
        const int FRAME_MS = 100;
        const int PHOTO_COLORS = 64;
        const long LOSSLESS_DELAY_MS = 1500;
        const int MAX_CLIPBOARD_BYTES = 1 << 20;
        const byte SIZE = 1, RAW = 2, JPEG = 3, FRAME = 4, CLIPBOARD = 5, LOG = 6;
        const string READY = "klex-stream-ready 1\n";
        const string PLACEHOLDER = "Windows is locked or showing a UAC prompt";

        static readonly object writeLock = new object();
        static Stream output;
        static volatile bool running = true;
        static volatile int quality;
        static volatile bool refreshRequested;
        static string pendingClipboard;
        static readonly AutoResetEvent clipboardWake = new AutoResetEvent(false);
        static readonly List<string> heldKeys = new List<string>();
        // Characters pressed as virtual keys for a shortcut go up the same way.
        static readonly Dictionary<string, int> heldCharacterKeys = new Dictionary<string, int>();
        static readonly List<string> heldButtons = new List<string>();
        static int pointerX = -1, pointerY = -1;

        public static void Run()
        {
            InitDpiAwareness();
            output = Console.OpenStandardOutput();
            byte[] ready = Encoding.ASCII.GetBytes(READY);
            lock (writeLock) { WriteOrExit(ready, 0, ready.Length); }
            Thread capture = new Thread(CaptureLoop);
            capture.IsBackground = true;
            capture.Start();
            Thread clipboard = new Thread(ClipboardLoop);
            clipboard.IsBackground = true;
            clipboard.SetApartmentState(ApartmentState.STA);
            clipboard.Start();
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                try { Handle(line.Split(' ')); }
                catch (Exception error) { Log("Input failed: " + error.Message); }
            }
            ReleaseAll();
            running = false;
        }

        static void InitDpiAwareness()
        {
            try
            {
                if (SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero) return;
                if (SetThreadDpiAwarenessContext(new IntPtr(-3)) != IntPtr.Zero) return;
            }
            catch (EntryPointNotFoundException) { }
            try { if (SetProcessDpiAwareness(2) == 0) return; }
            catch (DllNotFoundException) { }
            catch (EntryPointNotFoundException) { }
            try { SetProcessDPIAware(); }
            catch (EntryPointNotFoundException) { }
        }

        // MARK: Output

        static void WriteOrExit(byte[] data, int offset, int count)
        {
            try
            {
                output.Write(data, offset, count);
                output.Flush();
            }
            catch (IOException)
            {
                // The daemon is gone.
                Environment.Exit(0);
            }
        }

        static void Send(byte type, byte[] payload, int length)
        {
            byte[] header = new byte[5];
            header[0] = type;
            header[1] = (byte)(length >> 24);
            header[2] = (byte)(length >> 16);
            header[3] = (byte)(length >> 8);
            header[4] = (byte)length;
            lock (writeLock)
            {
                WriteOrExit(header, 0, 5);
                if (length > 0) WriteOrExit(payload, 0, length);
            }
        }

        static void Log(string message)
        {
            byte[] text = Encoding.UTF8.GetBytes(message);
            Send(LOG, text, text.Length);
        }

        static void PutU16(byte[] data, int offset, int value)
        {
            data[offset] = (byte)(value >> 8);
            data[offset + 1] = (byte)value;
        }

        // MARK: Capture

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

        static void CaptureLoop()
        {
            InitDpiAwareness();
            Stopwatch clock = Stopwatch.StartNew();
            int width = 0, height = 0;
            Bitmap bitmap = null;
            int[] current = null, previous = null;
            bool[] lossy = null;
            long[] changedAt = null;
            bool wasSecure = false;
            while (running)
            {
                long started = clock.ElapsedMilliseconds;
                try
                {
                    int w = GetSystemMetrics(0), h = GetSystemMetrics(1);
                    if (w <= 0 || h <= 0 || w > MAX_DIMENSION || h > MAX_DIMENSION)
                    {
                        Thread.Sleep(500);
                        continue;
                    }
                    bool full = refreshRequested;
                    refreshRequested = false;
                    if (bitmap == null || w != width || h != height)
                    {
                        if (bitmap != null) bitmap.Dispose();
                        width = w;
                        height = h;
                        bitmap = new Bitmap(w, h, PixelFormat.Format32bppRgb);
                        current = new int[w * h];
                        previous = new int[w * h];
                        int tiles = ((w + TILE - 1) / TILE) * ((h + TILE - 1) / TILE);
                        lossy = new bool[tiles];
                        changedAt = new long[tiles];
                        byte[] size = new byte[4];
                        PutU16(size, 0, w);
                        PutU16(size, 2, h);
                        Send(SIZE, size, 4);
                        full = true;
                    }
                    bool secure = !string.Equals(InputDesktopName(), "Default", StringComparison.OrdinalIgnoreCase);
                    if (!secure && !Grab(bitmap)) secure = true;
                    if (secure) DrawPlaceholder(bitmap);
                    if (secure != wasSecure) full = true;
                    wasSecure = secure;
                    Read(bitmap, width, height, current);
                    bool sent = false;
                    long now = clock.ElapsedMilliseconds;
                    int index = 0;
                    for (int ty = 0; ty < height; ty += TILE)
                    {
                        for (int tx = 0; tx < width; tx += TILE, index++)
                        {
                            int tw = Math.Min(TILE, width - tx), th = Math.Min(TILE, height - ty);
                            bool changed = full || TileChanged(current, previous, width, tx, ty, tw, th);
                            if (changed)
                            {
                                CopyTile(current, previous, width, tx, ty, tw, th);
                                changedAt[index] = now;
                                lossy[index] = SendTile(previous, width, tx, ty, tw, th, !full && !secure);
                                sent = true;
                            }
                            else if (lossy[index] && now - changedAt[index] >= LOSSLESS_DELAY_MS)
                            {
                                lossy[index] = SendTile(previous, width, tx, ty, tw, th, false);
                                sent = true;
                            }
                        }
                    }
                    if (sent) Send(FRAME, null, 0);
                }
                catch (Exception error)
                {
                    Log("Capture failed: " + error.Message);
                    Thread.Sleep(500);
                }
                int elapsed = (int)(clock.ElapsedMilliseconds - started);
                Thread.Sleep(Math.Max(10, FRAME_MS - elapsed));
            }
        }

        static bool Grab(Bitmap bitmap)
        {
            try
            {
                using (Graphics graphics = Graphics.FromImage(bitmap))
                {
                    graphics.CopyFromScreen(0, 0, 0, 0, bitmap.Size, CopyPixelOperation.SourceCopy);
                    DrawCursor(graphics);
                }
                return true;
            }
            catch (System.ComponentModel.Win32Exception)
            {
                return false;
            }
        }

        static void DrawCursor(Graphics graphics)
        {
            CURSORINFO info = new CURSORINFO();
            info.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
            if (!GetCursorInfo(ref info) || (info.flags & 1) == 0 || info.hCursor == IntPtr.Zero) return;
            ICONINFO icon;
            if (!GetIconInfo(info.hCursor, out icon)) return;
            try
            {
                IntPtr hdc = graphics.GetHdc();
                try
                {
                    DrawIconEx(hdc, info.ptScreenPos.X - icon.xHotspot, info.ptScreenPos.Y - icon.yHotspot, info.hCursor, 0, 0, 0, IntPtr.Zero, 3);
                }
                finally
                {
                    graphics.ReleaseHdc(hdc);
                }
            }
            finally
            {
                if (icon.hbmMask != IntPtr.Zero) DeleteObject(icon.hbmMask);
                if (icon.hbmColor != IntPtr.Zero) DeleteObject(icon.hbmColor);
            }
        }

        static void DrawPlaceholder(Bitmap bitmap)
        {
            using (Graphics graphics = Graphics.FromImage(bitmap))
            using (Font font = new Font("Segoe UI", Math.Max(12, bitmap.Height / 40), FontStyle.Regular, GraphicsUnit.Pixel))
            using (StringFormat format = new StringFormat())
            {
                graphics.Clear(Color.FromArgb(32, 32, 32));
                graphics.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                format.Alignment = StringAlignment.Center;
                format.LineAlignment = StringAlignment.Center;
                graphics.DrawString(PLACEHOLDER, font, Brushes.White, new RectangleF(0, 0, bitmap.Width, bitmap.Height), format);
            }
        }

        static void Read(Bitmap bitmap, int width, int height, int[] pixels)
        {
            BitmapData data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
            try
            {
                for (int y = 0; y < height; y++)
                {
                    Marshal.Copy(new IntPtr(data.Scan0.ToInt64() + (long)y * data.Stride), pixels, y * width, width);
                }
            }
            finally
            {
                bitmap.UnlockBits(data);
            }
        }

        static bool TileChanged(int[] current, int[] previous, int width, int x, int y, int w, int h)
        {
            for (int row = 0; row < h; row++)
            {
                int at = (y + row) * width + x, end = at + w;
                for (; at < end; at++)
                {
                    if (((current[at] ^ previous[at]) & 0xFFFFFF) != 0) return true;
                }
            }
            return false;
        }

        static void CopyTile(int[] from, int[] to, int width, int x, int y, int w, int h)
        {
            for (int row = 0; row < h; row++)
            {
                int at = (y + row) * width + x;
                Array.Copy(from, at, to, at, w);
            }
        }

        // Returns whether the tile went out as JPEG.
        static bool SendTile(int[] pixels, int width, int x, int y, int w, int h, bool allowJpeg)
        {
            int q = quality;
            if (allowJpeg && q > 0 && Photographic(pixels, width, x, y, w, h))
            {
                byte[] jpeg = EncodeJpeg(pixels, width, x, y, w, h, q);
                byte[] message = new byte[8 + jpeg.Length];
                TileHeader(message, x, y, w, h);
                Buffer.BlockCopy(jpeg, 0, message, 8, jpeg.Length);
                Send(JPEG, message, message.Length);
                return true;
            }
            byte[] raw = new byte[8 + w * h * 4];
            TileHeader(raw, x, y, w, h);
            for (int row = 0; row < h; row++)
            {
                Buffer.BlockCopy(pixels, ((y + row) * width + x) * 4, raw, 8 + row * w * 4, w * 4);
            }
            Send(RAW, raw, raw.Length);
            return false;
        }

        static void TileHeader(byte[] data, int x, int y, int w, int h)
        {
            PutU16(data, 0, x);
            PutU16(data, 2, y);
            PutU16(data, 4, w);
            PutU16(data, 6, h);
        }

        // Samples every third pixel; text and UI rarely use many colours per tile.
        static bool Photographic(int[] pixels, int width, int x, int y, int w, int h)
        {
            HashSet<int> colors = new HashSet<int>();
            for (int i = 0; i < w * h; i += 3)
            {
                colors.Add(pixels[(y + i / w) * width + x + i % w] & 0xFFFFFF);
                if (colors.Count > PHOTO_COLORS) return true;
            }
            return false;
        }

        static ImageCodecInfo jpegCodec;

        static byte[] EncodeJpeg(int[] pixels, int width, int x, int y, int w, int h, int q)
        {
            if (jpegCodec == null)
            {
                foreach (ImageCodecInfo codec in ImageCodecInfo.GetImageEncoders())
                {
                    if (codec.MimeType == "image/jpeg") jpegCodec = codec;
                }
            }
            using (Bitmap tile = new Bitmap(w, h, PixelFormat.Format32bppRgb))
            using (MemoryStream stream = new MemoryStream())
            {
                BitmapData data = tile.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
                try
                {
                    for (int row = 0; row < h; row++)
                    {
                        Marshal.Copy(pixels, (y + row) * width + x, new IntPtr(data.Scan0.ToInt64() + (long)row * data.Stride), w);
                    }
                }
                finally
                {
                    tile.UnlockBits(data);
                }
                EncoderParameters parameters = new EncoderParameters(1);
                parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)q);
                tile.Save(stream, jpegCodec, parameters);
                return stream.ToArray();
            }
        }

        // MARK: Clipboard

        static void ClipboardLoop()
        {
            uint seen = 0;
            bool first = true;
            while (running)
            {
                try
                {
                    string pending = Interlocked.Exchange(ref pendingClipboard, null);
                    if (pending != null)
                    {
                        if (pending.Length == 0) Clipboard.Clear();
                        else Clipboard.SetText(pending, TextDataFormat.UnicodeText);
                        seen = GetClipboardSequenceNumber();
                        first = false;
                    }
                    uint sequence = GetClipboardSequenceNumber();
                    if (first || sequence != seen)
                    {
                        string text = Clipboard.ContainsText() ? Clipboard.GetText(TextDataFormat.UnicodeText) : "";
                        seen = sequence;
                        first = false;
                        if (text.Length > 0 && Encoding.UTF8.GetByteCount(text) <= MAX_CLIPBOARD_BYTES)
                        {
                            byte[] data = Encoding.UTF8.GetBytes(text);
                            Send(CLIPBOARD, data, data.Length);
                        }
                    }
                }
                catch (ExternalException)
                {
                    // Another process holds the clipboard; try again on the next round.
                }
                catch (Exception error)
                {
                    Log("Clipboard failed: " + error.Message);
                }
                clipboardWake.WaitOne(250);
            }
        }

        // MARK: Input

        static void Handle(string[] command)
        {
            switch (command[0])
            {
                case "quality":
                    if (command.Length == 2)
                    {
                        int q = Int(command[1]);
                        if (q >= 0 && q <= 100) quality = q;
                    }
                    break;
                case "refresh":
                    refreshRequested = true;
                    break;
                case "move":
                    if (command.Length == 3) MoveTo(Int(command[1]), Int(command[2]));
                    break;
                case "button":
                    if (command.Length == 5) Button(command[1], command[2] == "1", Int(command[3]), Int(command[4]));
                    break;
                case "wheel":
                    if (command.Length == 4) Wheel(command[1], Int(command[2]), Int(command[3]));
                    break;
                case "key":
                    if (command.Length == 3) Key(command[1] == "1", command[2]);
                    break;
                case "clipboard":
                    if (command.Length == 2)
                    {
                        Interlocked.Exchange(ref pendingClipboard, Encoding.UTF8.GetString(Convert.FromBase64String(command[1])));
                        clipboardWake.Set();
                    }
                    break;
            }
        }

        static int Int(string text)
        {
            return int.Parse(text, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture);
        }

        // Input is refused while a secure desktop is up; there is nothing to do about it.
        static void TrySend(params INPUT[] inputs)
        {
            SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
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

        static INPUT Keyboard(ushort vk, ushort scan, uint flags)
        {
            INPUT input = new INPUT();
            input.type = INPUT_KEYBOARD;
            input.u.ki.wVk = vk;
            input.u.ki.wScan = scan;
            input.u.ki.dwFlags = flags;
            return input;
        }

        static void MoveTo(int x, int y)
        {
            if (x == pointerX && y == pointerY) return;
            pointerX = x;
            pointerY = y;
            int width = Math.Max(GetSystemMetrics(0), 2), height = Math.Max(GetSystemMetrics(1), 2);
            int nx = (int)Math.Round(x * 65535.0 / (width - 1));
            int ny = (int)Math.Round(y * 65535.0 / (height - 1));
            TrySend(Mouse(MOUSE_MOVE | MOUSE_ABSOLUTE, nx, ny, 0));
            SetCursorPos(x, y);
        }

        static uint ButtonFlag(string name, bool down)
        {
            if (name == "middle") return down ? MOUSE_MIDDLEDOWN : MOUSE_MIDDLEUP;
            // SendInput buttons are physical, so honor swapped buttons.
            bool left = (name == "left") != (GetSystemMetrics(23) != 0);
            if (left) return down ? MOUSE_LEFTDOWN : MOUSE_LEFTUP;
            return down ? MOUSE_RIGHTDOWN : MOUSE_RIGHTUP;
        }

        static void Button(string name, bool down, int x, int y)
        {
            if (name != "left" && name != "middle" && name != "right") return;
            if (!down && !heldButtons.Contains(name)) return;
            MoveTo(x, y);
            if (down) { if (!heldButtons.Contains(name)) heldButtons.Add(name); }
            else heldButtons.Remove(name);
            TrySend(Mouse(ButtonFlag(name, down), 0, 0, 0));
        }

        static void Wheel(string direction, int x, int y)
        {
            uint flag;
            int delta;
            switch (direction)
            {
                case "up": flag = MOUSE_WHEEL; delta = WHEEL_DELTA; break;
                case "down": flag = MOUSE_WHEEL; delta = -WHEEL_DELTA; break;
                case "left": flag = MOUSE_HWHEEL; delta = -WHEEL_DELTA; break;
                case "right": flag = MOUSE_HWHEEL; delta = WHEEL_DELTA; break;
                default: return;
            }
            MoveTo(x, y);
            TrySend(Mouse(flag, 0, 0, unchecked((uint)delta)));
        }

        static bool Extended(int vk)
        {
            return (vk >= 0x21 && vk <= 0x28) || vk == 0x2C || vk == 0x2D || vk == 0x2E
                || vk == 0x5B || vk == 0x5C || vk == 0x5D || vk == 0x6F || vk == 0x90
                || vk == 0xA3 || vk == 0xA5;
        }

        // Ctrl, Alt or Windows held: characters must be keys to make shortcuts.
        static bool ShortcutHeld()
        {
            foreach (string token in heldKeys)
            {
                if (token == "s1d" || token == "e1d" || token == "s38" || token == "e38" || token == "e5b" || token == "e5c") return true;
                if (token == "va2" || token == "va3" || token == "va4" || token == "va5" || token == "v5b" || token == "v5c") return true;
            }
            return false;
        }

        static void Key(bool down, string token)
        {
            if (token.Length < 2) return;
            int code = int.Parse(token.Substring(1), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
            uint up = down ? 0 : KEY_UP;
            switch (token[0])
            {
                case 's':
                    TrySend(Keyboard(0, (ushort)code, KEY_SCANCODE | up));
                    break;
                case 'e':
                    TrySend(Keyboard(0, (ushort)code, KEY_SCANCODE | KEY_EXTENDED | up));
                    break;
                case 'v':
                    TrySend(Keyboard((ushort)code, (ushort)MapVirtualKeyW((uint)code, 0), (Extended(code) ? KEY_EXTENDED : 0) | up));
                    break;
                case 'u':
                    string text = char.ConvertFromUtf32(code);
                    int vk;
                    if (down)
                    {
                        short scan = text.Length == 1 ? VkKeyScanW(text[0]) : (short)-1;
                        vk = scan != -1 && ShortcutHeld() ? scan & 0xFF : -1;
                        if (vk != -1) heldCharacterKeys[token] = vk;
                    }
                    else if (heldCharacterKeys.TryGetValue(token, out vk))
                    {
                        heldCharacterKeys.Remove(token);
                    }
                    else
                    {
                        vk = -1;
                    }
                    if (vk != -1)
                    {
                        TrySend(Keyboard((ushort)vk, (ushort)MapVirtualKeyW((uint)vk, 0), up));
                    }
                    else
                    {
                        foreach (char unit in text) TrySend(Keyboard(0, unit, KEY_UNICODE | up));
                    }
                    break;
                default:
                    return;
            }
            if (down) { if (!heldKeys.Contains(token)) heldKeys.Add(token); }
            else heldKeys.Remove(token);
        }

        static void ReleaseAll()
        {
            for (int i = heldKeys.Count - 1; i >= 0; i--) Key(false, heldKeys[i]);
            foreach (string name in heldButtons.ToArray()) Button(name, false, pointerX, pointerY);
        }
    }
}
`;

/**
 * The single `-Command -` line that compiles the stream host and hands stdin
 * to it, read from stdin like the desktop helper's.
 */
export function windowsStreamBootstrap(): string {
  const source = Buffer.from(WINDOWS_STREAM_SOURCE, 'utf8').toString('base64');
  return [
    "$ErrorActionPreference = 'Stop'",
    `try { Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${source}'))) -ReferencedAssemblies System.Drawing, System.Windows.Forms } catch { [Console]::Error.WriteLine('klex-stream: ' + $_.Exception.Message); exit 3 }`,
    '[KlexMachine.StreamHost]::Run()',
    'exit 0',
  ].join('; ');
}
