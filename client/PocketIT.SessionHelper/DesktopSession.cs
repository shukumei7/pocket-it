using System.Text.Json;
using PocketIT.Desktop;
using PocketIT.SessionHelper.Pipe;

namespace PocketIT.SessionHelper;

public class DesktopSession : IDisposable
{
    private readonly DesktopPipeClient _pipe;
    private readonly ScreenCaptureService _capture = new();
    private Thread? _captureThread;
    private volatile bool _running;
    private volatile int _fps = 10;
    private volatile bool _disposed;
    private volatile bool _itInputEnabled = true;

    public DesktopSession(DesktopPipeClient pipe)
    {
        _pipe = pipe;
        _pipe.OnMessage += HandleMessage;
    }

    public void Start()
    {
        if (_running) return;
        _running = true;
        _captureThread = new Thread(CaptureLoop) { IsBackground = true, Name = "DesktopCapture" };
        _captureThread.Start();
    }

    public void Stop()
    {
        if (!_running) return;
        _running = false;
        _captureThread?.Join(2000);
        _captureThread = null;
    }

    private void HandleMessage(string type, JsonElement doc)
    {
        switch (type)
        {
            case "stop":
                Stop();
                break;

            case "quality":
                if (doc.TryGetProperty("payload", out var qp))
                {
                    int quality = qp.TryGetProperty("quality", out var qqp) ? qqp.GetInt32() : 50;
                    int fps = qp.TryGetProperty("fps", out var fp) ? fp.GetInt32() : 10;
                    float scale = qp.TryGetProperty("scale", out var sp) ? (float)sp.GetDouble() : 0.5f;
                    _capture.Quality = quality;
                    _capture.Scale = scale;
                    _fps = Math.Clamp(fps, 1, 30);
                }
                break;

            case "monitor":
                if (doc.TryGetProperty("payload", out var mp) &&
                    mp.TryGetProperty("index", out var ip))
                {
                    try { _capture.SetMonitor(ip.GetInt32()); }
                    catch { }
                }
                break;

            case "mouse":
                if (!_itInputEnabled) break;
                if (doc.TryGetProperty("payload", out var mousep))
                {
                    double x = mousep.GetProperty("x").GetDouble();
                    double y = mousep.GetProperty("y").GetDouble();
                    string button = mousep.TryGetProperty("button", out var bp) ? bp.GetString() ?? "left" : "left";
                    string action = mousep.GetProperty("action").GetString() ?? "click";
                    var bounds = _capture.GetCurrentMonitorBounds();
                    if (action == "move")
                        InputInjectionService.MoveMouse(x, y, bounds);
                    else if (action == "scroll")
                        InputInjectionService.MouseScroll(x, y, button == "up" ? 1 : -1);
                    else
                        InputInjectionService.MouseClick(x, y, button, action);
                }
                break;

            case "keyboard":
                if (!_itInputEnabled) break;
                if (doc.TryGetProperty("payload", out var kp))
                {
                    ushort vkCode = (ushort)kp.GetProperty("vkCode").GetInt32();
                    string action = kp.GetProperty("action").GetString() ?? "press";
                    InputInjectionService.KeyPress(vkCode, action);
                }
                break;

            case "paste":
                if (doc.TryGetProperty("payload", out var pp) &&
                    pp.TryGetProperty("text", out var tp))
                {
                    InputInjectionService.TypeText(tp.GetString() ?? "");
                }
                break;

            case "ctrl_alt_del":
                InputInjectionService.SendCtrlAltDel();
                break;

            case "toggle":
                if (doc.TryGetProperty("payload", out var tgp))
                {
                    string toggle = tgp.TryGetProperty("name", out var tn) ? tn.GetString() ?? "" : "";
                    bool enabled = tgp.TryGetProperty("enabled", out var en) && en.GetBoolean();
                    if (toggle == "it_input")
                        _itInputEnabled = enabled;
                    else if (toggle == "user_input")
                        InputInjectionService.BlockUserInput(enabled);
                }
                break;
        }
    }

    private void CaptureLoop()
    {
        while (_running)
        {
            try
            {
                var (base64, width, height) = _capture.CaptureScreen();
                _pipe.SendFrameAsync(base64, width, height, CancellationToken.None).GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                PocketIT.Core.Logger.Error("SessionHelper capture error", ex);
                if (!_pipe.IsConnected) break;
            }

            int delayMs = 1000 / Math.Max(1, _fps);
            Thread.Sleep(delayMs);
        }

        // Ensure user input is unblocked when capture ends
        InputInjectionService.BlockUserInput(false);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        Stop();
        InputInjectionService.BlockUserInput(false);
    }
}
