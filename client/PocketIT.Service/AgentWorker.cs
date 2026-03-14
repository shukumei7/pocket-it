using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Configuration;
using PocketIT.Core;
using PocketIT.Pipe;
using PocketIT.Service.Desktop;
using PocketIT.Service.Pipe;
using System.Text.Json;

namespace PocketIT.Service;

public class AgentWorker : BackgroundService
{
    private readonly ILogger<AgentWorker> _logger;
    private readonly IConfiguration _config;
    private ServerConnection? _serverConnection;
    private PipeServer? _pipeServer;
    private DesktopSessionManager? _desktopSessionManager;
    private LocalDatabase? _localDb;
    private string? _deviceId;

    public AgentWorker(ILogger<AgentWorker> logger, IConfiguration config)
    {
        _logger = logger;
        _config = config;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("PocketIT Agent Service starting");

        try
        {
            await InitializeAsync(stoppingToken);
            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
        catch (OperationCanceledException)
        {
            _logger.LogInformation("PocketIT Agent Service stopping");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Fatal error in AgentWorker");
            throw;
        }
        finally
        {
            _desktopSessionManager?.Dispose();
            _serverConnection?.Dispose();
            _pipeServer?.Stop();
        }
    }

    private async Task InitializeAsync(CancellationToken ct)
    {
        // Use LocalMachine-scoped DB path (accessible to SYSTEM service)
        var dbPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "PocketIT", "agent.db");
        Directory.CreateDirectory(Path.GetDirectoryName(dbPath)!);
        _localDb = new LocalDatabase(dbPath, useLocalMachineProtection: true);

        _deviceId = DeviceIdentity.GetMachineId();
        var deviceSecret = _localDb.GetSetting("device_secret") ?? string.Empty;
        var serverUrl = _config["Server:Url"] ?? "http://localhost:9100";

        _serverConnection = new ServerConnection(serverUrl, _deviceId, deviceSecret);

        // Desktop session manager handles service-level remote desktop via session helper
        _desktopSessionManager = new DesktopSessionManager(_logger, _serverConnection);

        WireServerEvents();

        // Start pipe server so tray app can connect
        _pipeServer = new PipeServer(_logger);
        _pipeServer.OnTrayMessage += OnTrayMessage;
        _pipeServer.Start();

        await _serverConnection.ConnectAsync();
        _logger.LogInformation("AgentWorker initialized, device: {DeviceId}", _deviceId);
    }

    private void WireServerEvents()
    {
        if (_serverConnection == null) return;

        // Forward UI-required events to tray via pipe
        _serverConnection.OnChatResponse += msg =>
            _pipeServer?.Send(new PipeMessage { Type = PipeMessageType.ChatMessage, Payload = msg });

        _serverConnection.OnChatHistory += json =>
            _pipeServer?.Send(new PipeMessage { Type = PipeMessageType.ChatHistory, Payload = json });

        // Desktop events: handled directly by DesktopSessionManager (service-level remote desktop).
        // IT authority: service-level access bypasses user privacy mode on enrolled managed devices.
        _serverConnection.OnDesktopStartRequest += (requestId, itInitiated) =>
            _desktopSessionManager?.StartSession(requestId);

        _serverConnection.OnDesktopMouseInput += (x, y, button, action) =>
            _desktopSessionManager?.SendMouseInput(x, y, button, action);

        _serverConnection.OnDesktopKeyboardInput += (vkCode, action) =>
            _desktopSessionManager?.SendKeyboardInput(vkCode, action);

        _serverConnection.OnDesktopStopRequest += requestId =>
            _desktopSessionManager?.StopSession(requestId);

        _serverConnection.OnDesktopQualityUpdate += (quality, fps, scale) =>
            _desktopSessionManager?.SendQualityUpdate(quality, fps, scale);

        _serverConnection.OnDesktopSwitchMonitor += idx =>
            _desktopSessionManager?.SendSwitchMonitor(idx);

        _serverConnection.OnDesktopPasteText += text =>
            _desktopSessionManager?.SendPasteText(text);

        _serverConnection.OnDesktopCtrlAltDel += () =>
            _desktopSessionManager?.SendCtrlAltDel();

        _serverConnection.OnDesktopToggle += (name, enabled) =>
            _desktopSessionManager?.SendToggle(name, enabled);

        _serverConnection.OnAIStatusChanged += (enabled, reason) =>
            _pipeServer?.Send(new PipeMessage
            {
                Type = PipeMessageType.AiStatusChanged,
                Payload = JsonSerializer.Serialize(new { enabled, reason })
            });

        _serverConnection.OnUpdateAvailable += json =>
            _pipeServer?.Send(new PipeMessage { Type = PipeMessageType.UpdateAvailable, Payload = json });

        _serverConnection.OnServerUrlChanged += newUrl =>
            _pipeServer?.Send(new PipeMessage { Type = PipeMessageType.ServerUrlChanged, Payload = newUrl });

        _serverConnection.OnScreenshotRequest += (requestId, reason) =>
            _pipeServer?.Send(new PipeMessage
            {
                Type = PipeMessageType.ConsentRequired,
                RequestId = requestId,
                Payload = JsonSerializer.Serialize(new { action = "screenshot", reason })
            });

        // Handle non-UI events directly in service
        _serverConnection.OnDiagnosticRequest += async (checkType, requestId, itInitiated) =>
        {
            // TODO Phase 2: run DiagnosticsEngine here
            _logger.LogInformation("Diagnostic request: {CheckType}", checkType);
        };

        _serverConnection.OnRemediationRequest += async (actionId, requestId, parameter, autoApprove) =>
        {
            // TODO Phase 2: run RemediationEngine here
            _logger.LogInformation("Remediation request: {ActionId}", actionId);
        };

        _serverConnection.OnSettingsRequest += requestId =>
        {
            // Send service-level settings
            var settings = _localDb?.GetAllSettings() ?? new Dictionary<string, string>();
            settings.Remove("device_secret");
            _ = _serverConnection?.SendSettings(settings.ToDictionary(k => k.Key, k => (object)k.Value));
        };
    }

    private void OnTrayMessage(PipeMessage msg)
    {
        if (_serverConnection == null) return;

        switch (msg.Type)
        {
            case PipeMessageType.ChatSend:
                _ = _serverConnection.SendChatMessage(msg.Payload ?? string.Empty);
                break;
            case PipeMessageType.DesktopStarted:
                _ = _serverConnection.SendDesktopStarted(msg.RequestId ?? string.Empty);
                break;
            case PipeMessageType.DesktopDenied:
                _ = _serverConnection.SendDesktopDenied(msg.RequestId ?? string.Empty);
                break;
            case PipeMessageType.DesktopStopped:
                _ = _serverConnection.SendDesktopStopped(msg.RequestId ?? string.Empty, "stopped");
                break;
            case PipeMessageType.DesktopFrame:
                if (msg.Payload != null)
                {
                    var f = JsonSerializer.Deserialize<DesktopFramePayload>(msg.Payload);
                    if (f != null) _ = _serverConnection.SendDesktopFrame(f.Data, f.Width, f.Height);
                }
                break;
            case PipeMessageType.ScreenshotResult:
                if (msg.Payload != null)
                {
                    var s = JsonSerializer.Deserialize<ScreenshotPayload>(msg.Payload);
                    if (s != null) _ = _serverConnection.SendScreenshotResult(msg.RequestId ?? string.Empty, true, s.Base64, s.Width, s.Height);
                }
                break;
            case PipeMessageType.SettingsUpdate:
                if (msg.Payload != null && _localDb != null)
                {
                    var kv = JsonSerializer.Deserialize<Dictionary<string, string>>(msg.Payload);
                    if (kv != null)
                        foreach (var (key, value) in kv)
                            _localDb.SetSetting(key, value);
                }
                break;
        }
    }

    private record DesktopFramePayload(string Data, int Width, int Height);
    private record ScreenshotPayload(string Base64, int Width, int Height);
}
