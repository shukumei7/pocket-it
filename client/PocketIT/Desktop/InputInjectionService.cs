using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace PocketIT.Desktop;

public static class InputInjectionService
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    private static extern short VkKeyScanW(char ch);

    [DllImport("user32.dll")]
    private static extern bool BlockInput(bool fBlockInput);

    [DllImport("sas.dll", SetLastError = true)]
    private static extern void SendSAS(bool AsUser);

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public INPUTUNION u;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx, dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const ushort VK_SHIFT = 0x10;
    private const ushort VK_CONTROL = 0x11;
    private const ushort VK_MENU = 0x12; // Alt
    private const ushort VK_RETURN = 0x0D;
    private const ushort VK_TAB = 0x09;
    private const uint KEYEVENTF_UNICODE = 0x0004;

    public static void MoveMouse(double normalizedX, double normalizedY)
    {
        var bounds = System.Windows.Forms.Screen.PrimaryScreen!.Bounds;
        int x = (int)(normalizedX * bounds.Width);
        int y = (int)(normalizedY * bounds.Height);
        SetCursorPos(x, y);
    }

    public static void MoveMouse(double normalizedX, double normalizedY, System.Drawing.Rectangle monitorBounds)
    {
        int x = monitorBounds.X + (int)(normalizedX * monitorBounds.Width);
        int y = monitorBounds.Y + (int)(normalizedY * monitorBounds.Height);
        SetCursorPos(x, y);
    }

    public static void MouseClick(double normalizedX, double normalizedY, string button, string action)
    {
        MoveMouse(normalizedX, normalizedY);

        uint downFlag, upFlag;
        switch (button)
        {
            case "right": downFlag = MOUSEEVENTF_RIGHTDOWN; upFlag = MOUSEEVENTF_RIGHTUP; break;
            case "middle": downFlag = MOUSEEVENTF_MIDDLEDOWN; upFlag = MOUSEEVENTF_MIDDLEUP; break;
            default: downFlag = MOUSEEVENTF_LEFTDOWN; upFlag = MOUSEEVENTF_LEFTUP; break;
        }

        var inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;

        if (action == "down")
            inputs[0].u.mi.dwFlags = downFlag;
        else if (action == "up")
            inputs[0].u.mi.dwFlags = upFlag;
        else // "click"
        {
            inputs = new INPUT[2];
            inputs[0].type = INPUT_MOUSE;
            inputs[0].u.mi.dwFlags = downFlag;
            inputs[1].type = INPUT_MOUSE;
            inputs[1].u.mi.dwFlags = upFlag;
        }

        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
    }

    public static void MouseScroll(double normalizedX, double normalizedY, int delta)
    {
        MoveMouse(normalizedX, normalizedY);

        var inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].u.mi.dwFlags = MOUSEEVENTF_WHEEL;
        inputs[0].u.mi.mouseData = (uint)(delta * 120); // standard wheel delta
        SendInput(1, inputs, Marshal.SizeOf<INPUT>());
    }

    public static void KeyPress(ushort vkCode, string action)
    {
        var inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].u.ki.wVk = vkCode;

        if (action == "up")
            inputs[0].u.ki.dwFlags = KEYEVENTF_KEYUP;
        else if (action == "down")
            inputs[0].u.ki.dwFlags = 0;
        else // "press" = down + up
        {
            inputs = new INPUT[2];
            inputs[0].type = INPUT_KEYBOARD;
            inputs[0].u.ki.wVk = vkCode;
            inputs[0].u.ki.dwFlags = 0;
            inputs[1].type = INPUT_KEYBOARD;
            inputs[1].u.ki.wVk = vkCode;
            inputs[1].u.ki.dwFlags = KEYEVENTF_KEYUP;
        }

        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
    }

    public static void TypeText(string text)
    {
        foreach (char c in text)
        {
            if (c == '\n' || c == '\r')
            {
                KeyPress(VK_RETURN, "press");
            }
            else if (c == '\t')
            {
                KeyPress(VK_TAB, "press");
            }
            else
            {
                short vkResult = VkKeyScanW(c);
                if (vkResult == -1)
                {
                    // Character can't be mapped to a VK — use Unicode input
                    SendUnicodeChar(c);
                }
                else
                {
                    byte vk = (byte)(vkResult & 0xFF);
                    byte shift = (byte)((vkResult >> 8) & 0xFF);
                    bool needShift = (shift & 1) != 0;
                    bool needCtrl = (shift & 2) != 0;
                    bool needAlt = (shift & 4) != 0;

                    if (needShift) KeyPress(VK_SHIFT, "down");
                    if (needCtrl) KeyPress(VK_CONTROL, "down");
                    if (needAlt) KeyPress(VK_MENU, "down");

                    KeyPress(vk, "press");

                    if (needAlt) KeyPress(VK_MENU, "up");
                    if (needCtrl) KeyPress(VK_CONTROL, "up");
                    if (needShift) KeyPress(VK_SHIFT, "up");
                }
            }
            Thread.Sleep(10); // Prevent drops
        }
    }

    private static void SendUnicodeChar(char c)
    {
        var inputs = new INPUT[2];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].u.ki.wScan = (ushort)c;
        inputs[0].u.ki.dwFlags = KEYEVENTF_UNICODE;
        inputs[1].type = INPUT_KEYBOARD;
        inputs[1].u.ki.wScan = (ushort)c;
        inputs[1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        SendInput(2, inputs, Marshal.SizeOf<INPUT>());
    }

    public static void SendCtrlAltDel()
    {
        try
        {
            SendSAS(false);
        }
        catch (DllNotFoundException)
        {
            PocketIT.Core.Logger.Warn("sas.dll not available — SendCtrlAltDel requires Windows SAS library");
        }
        catch (Exception ex)
        {
            PocketIT.Core.Logger.Error("SendCtrlAltDel failed", ex);
        }
    }

    public static void BlockUserInput(bool block)
    {
        try
        {
            BlockInput(block);
        }
        catch (Exception ex)
        {
            PocketIT.Core.Logger.Error($"BlockInput({block}) failed", ex);
        }
    }
}
