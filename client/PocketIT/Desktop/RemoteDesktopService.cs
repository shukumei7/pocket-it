using System;
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
    private const int IdleTimeoutMs = 15 * 60 * 1000;

    public bool IsActive => _running;

    public event Action<string, int, int>? OnFrame; // base64, width, height
    public event Action? OnSessionEnded;

    public void StartSession()
    {
        if (_running) return;
        _running = true;

        _idleTimer = new System.Threading.Timer(_ => StopSession(), null, IdleTimeoutMs, Timeout.Infinite);

        _captureThread = new Thread(CaptureLoop) { IsBackground = true, Name = "DesktopCapture" };
        _captureThread.Start();
    }

    public void StopSession()
    {
        if (!_running) return;
        _running = false;
        _idleTimer?.Dispose();
        _idleTimer = null;
        _captureThread?.Join(2000);
        _captureThread = null;
        OnSessionEnded?.Invoke();
    }

    public void UpdateQuality(int quality, int fps, float scale)
    {
        _capture.Quality = quality;
        _capture.Scale = scale;
        _fps = Math.Clamp(fps, 1, 30);
        // Reset idle timer on interaction
        _idleTimer?.Change(IdleTimeoutMs, Timeout.Infinite);
    }

    public void ResetIdleTimer()
    {
        _idleTimer?.Change(IdleTimeoutMs, Timeout.Infinite);
    }

    public void HandleMouseInput(double x, double y, string button, string action)
    {
        ResetIdleTimer();
        if (action == "move")
            InputInjectionService.MoveMouse(x, y);
        else if (action == "scroll")
            InputInjectionService.MouseScroll(x, y, button == "up" ? 1 : -1);
        else
            InputInjectionService.MouseClick(x, y, button, action);
    }

    public void HandleKeyboardInput(ushort vkCode, string action)
    {
        ResetIdleTimer();
        InputInjectionService.KeyPress(vkCode, action);
    }

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
    }
}
