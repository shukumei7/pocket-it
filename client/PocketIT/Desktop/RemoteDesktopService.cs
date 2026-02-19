using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;

namespace PocketIT.Desktop;

public class RemoteDesktopService : IDisposable
{
    private readonly ScreenCaptureService _capture = new();
    private Thread? _captureThread;
    private volatile bool _running;
    private volatile int _fps = 10;
    private volatile bool _disposed;
    private System.Threading.Timer? _idleTimer;
    private System.Threading.Timer? _perfTimer;
    private const int IdleTimeoutMs = 15 * 60 * 1000;

    // Sidebar state
    private PrivacyScreenForm? _privacyScreen;
    private volatile bool _userInputBlocked;
    private volatile bool _itInputEnabled = true;

    public bool IsActive => _running;
    public bool ItInputEnabled => _itInputEnabled;

    public event Action<string, int, int>? OnFrame; // base64, width, height
    public event Action? OnSessionEnded;
    public event Action<float, float, float>? OnPerfData; // cpu, memory%, disk%

    public void StartSession()
    {
        if (_running) return;
        _running = true;

        _idleTimer = new System.Threading.Timer(_ => StopSession(), null, IdleTimeoutMs, Timeout.Infinite);

        // Start perf data collection every 2 seconds
        _perfTimer = new System.Threading.Timer(_ => CollectPerfData(), null, 0, 2000);

        _captureThread = new Thread(CaptureLoop) { IsBackground = true, Name = "DesktopCapture" };
        _captureThread.Start();
    }

    public void StopSession()
    {
        if (!_running) return;
        _running = false;
        _idleTimer?.Dispose();
        _idleTimer = null;
        _perfTimer?.Dispose();
        _perfTimer = null;
        _captureThread?.Join(2000);
        _captureThread = null;

        // Safety: unblock user input and close privacy screen
        if (_userInputBlocked)
        {
            InputInjectionService.BlockUserInput(false);
            _userInputBlocked = false;
        }
        ClosePrivacyScreen();
        _itInputEnabled = true;

        OnSessionEnded?.Invoke();
    }

    public void UpdateQuality(int quality, int fps, float scale)
    {
        _capture.Quality = quality;
        _capture.Scale = scale;
        _fps = Math.Clamp(fps, 1, 30);
        _idleTimer?.Change(IdleTimeoutMs, Timeout.Infinite);
    }

    public void ResetIdleTimer()
    {
        _idleTimer?.Change(IdleTimeoutMs, Timeout.Infinite);
    }

    // --- Multi-monitor ---

    public object[] GetMonitors() => _capture.GetMonitors()
        .Select(m => (object)new { index = m.Index, name = m.Name, width = m.Width, height = m.Height, primary = m.Primary })
        .ToArray();

    public void SwitchMonitor(int index)
    {
        _capture.SetMonitor(index);
    }

    // --- Input handling ---

    public void HandleMouseInput(double x, double y, string button, string action)
    {
        if (!_itInputEnabled) return;
        ResetIdleTimer();
        // Use monitor-aware mouse positioning
        var bounds = _capture.GetCurrentMonitorBounds();
        if (action == "move")
            InputInjectionService.MoveMouse(x, y, bounds);
        else if (action == "scroll")
            InputInjectionService.MouseScroll(x, y, button == "up" ? 1 : -1);
        else
            InputInjectionService.MouseClick(x, y, button, action);
    }

    public void HandleKeyboardInput(ushort vkCode, string action)
    {
        if (!_itInputEnabled) return;
        ResetIdleTimer();
        InputInjectionService.KeyPress(vkCode, action);
    }

    // --- Sidebar actions ---

    public void PasteText(string text)
    {
        ResetIdleTimer();
        InputInjectionService.TypeText(text);
    }

    public void SendCtrlAltDel()
    {
        ResetIdleTimer();
        InputInjectionService.SendCtrlAltDel();
    }

    public (bool success, string error) LaunchTool(string tool)
    {
        ResetIdleTimer();
        return DesktopToolLauncher.Launch(tool);
    }

    public (bool success, string path, string error) ReceiveFileUpload(string fileName, string base64Data, string? targetPath)
    {
        try
        {
            string dir = targetPath ?? Path.Combine(Path.GetTempPath(), "PocketIT-Uploads");
            Directory.CreateDirectory(dir);
            string fullPath = Path.Combine(dir, fileName);
            byte[] data = Convert.FromBase64String(base64Data);
            File.WriteAllBytes(fullPath, data);
            return (true, fullPath, "");
        }
        catch (Exception ex)
        {
            return (false, "", ex.Message);
        }
    }

    public void HandleToggle(string toggle, bool enabled)
    {
        switch (toggle)
        {
            case "it_input":
                _itInputEnabled = enabled;
                break;
            case "user_input":
                InputInjectionService.BlockUserInput(enabled);
                _userInputBlocked = enabled;
                break;
            case "privacy_screen":
                if (enabled) ShowPrivacyScreen();
                else ClosePrivacyScreen();
                break;
        }
    }

    // --- Privacy screen ---

    private void ShowPrivacyScreen()
    {
        if (_privacyScreen != null) return;
        // Must run on UI thread for WinForms
        var thread = new Thread(() =>
        {
            _privacyScreen = new PrivacyScreenForm();
            System.Windows.Forms.Application.Run(_privacyScreen);
            _privacyScreen = null;
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.IsBackground = true;
        thread.Name = "PrivacyScreen";
        thread.Start();
    }

    private void ClosePrivacyScreen()
    {
        if (_privacyScreen == null) return;
        try
        {
            _privacyScreen.Invoke(new Action(() => _privacyScreen?.Close()));
        }
        catch { }
        _privacyScreen = null;
    }

    // --- Performance data ---

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);

    private PerformanceCounter? _cpuCounter;
    private void CollectPerfData()
    {
        try
        {
            _cpuCounter ??= new PerformanceCounter("Processor", "% Processor Time", "_Total");
            float cpu = _cpuCounter.NextValue();

            var memStatus = new MEMORYSTATUSEX { dwLength = (uint)System.Runtime.InteropServices.Marshal.SizeOf<MEMORYSTATUSEX>() };
            GlobalMemoryStatusEx(ref memStatus);
            float memPercent = memStatus.dwMemoryLoad;

            // Disk: primary drive
            var drive = new DriveInfo(Path.GetPathRoot(Environment.SystemDirectory)!);
            float diskPercent = ((float)(drive.TotalSize - drive.AvailableFreeSpace) / drive.TotalSize) * 100f;

            OnPerfData?.Invoke(cpu, memPercent, diskPercent);
        }
        catch (Exception ex)
        {
            Core.Logger.Error("Perf data collection error", ex);
        }
    }

    // --- Capture loop ---

    private void CaptureLoop()
    {
        while (_running)
        {
            try
            {
                var (base64, width, height) = _capture.CaptureScreen();
                OnFrame?.Invoke(base64, width, height);
            }
            catch (Exception ex)
            {
                PocketIT.Core.Logger.Error("Screen capture error", ex);
            }

            int delayMs = 1000 / Math.Max(1, _fps);
            Thread.Sleep(delayMs);
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        StopSession();
        _cpuCounter?.Dispose();
    }
}
