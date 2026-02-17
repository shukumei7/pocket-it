using System;
using System.Runtime.InteropServices;

namespace PocketIT.Desktop;

public static class InputInjectionService
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int X, int Y);

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

    public static void MoveMouse(double normalizedX, double normalizedY)
    {
        var bounds = System.Windows.Forms.Screen.PrimaryScreen!.Bounds;
        int x = (int)(normalizedX * bounds.Width);
        int y = (int)(normalizedY * bounds.Height);
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
}
