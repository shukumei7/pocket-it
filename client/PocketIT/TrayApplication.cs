using System;
using System.Drawing;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using System.Linq;
using System.Windows.Forms;
using Microsoft.Extensions.Configuration;
using PocketIT.Core;
using PocketIT.Enrollment;
using PocketIT.Diagnostics;
using PocketIT.Remediation;

namespace PocketIT;

public class TrayApplication : ApplicationContext
{
    private readonly NotifyIcon _trayIcon;
    private ChatWindow? _chatWindow;
    private readonly ServerConnection _serverConnection;
    private readonly EnrollmentFlow _enrollmentFlow;
    private readonly DiagnosticsEngine _diagnosticsEngine;
    private readonly RemediationEngine _remediationEngine;
    private readonly IConfiguration _config;
    private readonly SynchronizationContext _uiContext;
    private readonly LocalDatabase _localDb;
    private bool _isEnrolled;
    private bool _wasConnected;

    public TrayApplication()
    {
        _uiContext = SynchronizationContext.Current ?? new SynchronizationContext();

        Logger.Initialize();

        // Load config
        try
        {
            _config = new ConfigurationBuilder()
                .SetBasePath(AppContext.BaseDirectory)
                .AddJsonFile("appsettings.json", optional: false)
                .Build();
        }
        catch (Exception ex)
        {
            Logger.Error("Failed to load appsettings.json", ex);
            _config = new ConfigurationBuilder().Build();
        }

        var serverUrl = _config["Server:Url"] ?? "http://localhost:9100";
        var enrollmentToken = _config["Enrollment:Token"] ?? "";
        var deviceId = DeviceIdentity.GetMachineId();

        var dbPath = Path.Combine(AppContext.BaseDirectory, _config["Database:Path"] ?? "pocket-it.db");
        _localDb = new LocalDatabase(dbPath);

        // Create components
        _enrollmentFlow = new EnrollmentFlow(serverUrl);
        var deviceSecret = _localDb.GetSetting("device_secret") ?? "";
        _serverConnection = new ServerConnection(serverUrl, deviceId, deviceSecret);
        _diagnosticsEngine = new DiagnosticsEngine();
        _remediationEngine = new RemediationEngine();

        // Wire server connection events
        _serverConnection.OnChatResponse += OnServerChatResponse;
        _serverConnection.OnChatHistory += OnServerChatHistory;
        _serverConnection.OnConnectionChanged += OnServerConnectionChanged;
        _serverConnection.OnDiagnosticRequest += OnServerDiagnosticRequest;
        _serverConnection.OnRemediationRequest += OnServerRemediationRequest;
        _serverConnection.OnConnectedReady += OnServerConnectedReady;

        var contextMenu = new ContextMenuStrip();
        contextMenu.Items.Add("Open Chat", null, OnOpenChat);
        contextMenu.Items.Add(new ToolStripSeparator());
        contextMenu.Items.Add("Run Diagnostics", null, OnRunDiagnostics);
        contextMenu.Items.Add(new ToolStripSeparator());
        contextMenu.Items.Add("About", null, OnAbout);
        contextMenu.Items.Add("Exit", null, OnExit);

        _trayIcon = new NotifyIcon
        {
            Icon = LoadTrayIcon(),
            Text = "Pocket IT",
            Visible = true,
            ContextMenuStrip = contextMenu
        };
        _trayIcon.Click += OnOpenChat;

        if (!ValidateConfig()) return;

        // Start async initialization (enrollment + connection)
        Task.Run(InitializeAsync);
    }

    private Icon LoadTrayIcon()
    {
        var iconPath = Path.Combine(AppContext.BaseDirectory, "Resources", "tray-icon.ico");
        return File.Exists(iconPath) ? new Icon(iconPath) : SystemIcons.Application;
    }

    private bool ValidateConfig()
    {
        var serverUrl = _config["Server:Url"];
        if (string.IsNullOrWhiteSpace(serverUrl))
        {
            Logger.Error("Missing Server:Url in appsettings.json");
            _trayIcon.ShowBalloonTip(5000, "Pocket IT",
                "Configuration error: Server URL not set. Check appsettings.json.", ToolTipIcon.Error);
            return false;
        }

        if (!Uri.TryCreate(serverUrl, UriKind.Absolute, out var uri) ||
            (uri.Scheme != "http" && uri.Scheme != "https"))
        {
            Logger.Error($"Invalid Server:Url: {serverUrl}");
            _trayIcon.ShowBalloonTip(5000, "Pocket IT",
                $"Configuration error: Invalid server URL.", ToolTipIcon.Error);
            return false;
        }

        return true;
    }

    private async Task InitializeAsync()
    {
        try
        {
            // Check enrollment
            var deviceSecret = _localDb.GetSetting("device_secret") ?? "";
            var isEnrolled = await _enrollmentFlow.CheckEnrolledAsync(deviceSecret);
            var enrollmentToken = _config["Enrollment:Token"] ?? "";

            if (!isEnrolled && !string.IsNullOrEmpty(enrollmentToken))
            {
                var result = await _enrollmentFlow.EnrollAsync(enrollmentToken);
                if (result.Success && !string.IsNullOrEmpty(result.DeviceSecret))
                {
                    _localDb.SetSetting("device_secret", result.DeviceSecret);
                    _serverConnection.UpdateDeviceSecret(result.DeviceSecret);
                    _isEnrolled = true;
                }
                else if (!result.Success)
                {
                    _uiContext.Post(_ => _trayIcon.ShowBalloonTip(5000, "Pocket IT",
                        $"Enrollment failed: {result.Message}", ToolTipIcon.Warning), null);
                }
            }

            if (!isEnrolled && string.IsNullOrEmpty(enrollmentToken))
            {
                // No token in config, not enrolled — show enrollment UI
                _uiContext.Post(_ => ShowEnrollmentWindow(), null);
                return;
            }

            _isEnrolled = true;

            // Connect to server
            await _serverConnection.ConnectAsync();

            // Purge old offline messages
            try
            {
                var purged = _localDb.PurgeSyncedMessages();
                if (purged > 0) Logger.Info($"Purged {purged} old offline messages");
            }
            catch (Exception ex)
            {
                Logger.Warn($"Failed to purge old messages: {ex.Message}");
            }
        }
        catch (Exception ex)
        {
            _uiContext.Post(_ => _trayIcon.ShowBalloonTip(5000, "Pocket IT",
                $"Connection error: {ex.Message}", ToolTipIcon.Error), null);
        }
    }

    private void ShowChatWindow()
    {
        if (!_isEnrolled)
        {
            ShowEnrollmentWindow();
            return;
        }

        if (_chatWindow == null || _chatWindow.IsDisposed)
        {
            _chatWindow = new ChatWindow();

            // Wire chat window bridge events
            _chatWindow.OnBridgeMessage += OnChatBridgeMessage;

            // Send offline contacts config
            var phone = _config["OfflineContacts:Phone"] ?? "";
            var email = _config["OfflineContacts:Email"] ?? "";
            var portal = _config["OfflineContacts:Portal"] ?? "";
            var offlineConfig = JsonSerializer.Serialize(new { type = "offline_config", phone, email, portal });
            _chatWindow.SendToWebView(offlineConfig);

            // Send agent info
            var agentInfo = JsonSerializer.Serialize(new { type = "agent_info", agentName = "Pocket IT" });
            _chatWindow.SendToWebView(agentInfo);
        }

        if (!_chatWindow.Visible)
        {
            // Position bottom-right of current screen
            var screen = Screen.FromPoint(Cursor.Position).WorkingArea;
            var dpiScale = _chatWindow.DeviceDpi / 96.0f;
            var margin = (int)(12 * dpiScale);
            _chatWindow.StartPosition = FormStartPosition.Manual;
            _chatWindow.Location = new Point(
                screen.Right - _chatWindow.Width - margin,
                screen.Bottom - _chatWindow.Height - margin
            );
        }

        _chatWindow.Show();
        _chatWindow.BringToFront();
    }

    private void ShowEnrollmentWindow()
    {
        if (_chatWindow == null || _chatWindow.IsDisposed)
        {
            _chatWindow = new ChatWindow("enrollment.html");
            _chatWindow.OnBridgeMessage += OnChatBridgeMessage;
        }

        if (!_chatWindow.Visible)
        {
            var screen = Screen.FromPoint(Cursor.Position).WorkingArea;
            var dpiScale = _chatWindow.DeviceDpi / 96.0f;
            var margin = (int)(12 * dpiScale);
            _chatWindow.StartPosition = FormStartPosition.Manual;
            _chatWindow.Location = new Point(
                screen.Right - _chatWindow.Width - margin,
                screen.Bottom - _chatWindow.Height - margin
            );
        }

        _chatWindow.Show();
        _chatWindow.BringToFront();
    }

    private void OnServerChatResponse(string json)
    {
        // Inject "type" field for WebView bridge dispatch
        var wrapped = json.TrimStart().StartsWith("{")
            ? "{\"type\":\"chat_response\"," + json.TrimStart().Substring(1)
            : json;
        _uiContext.Post(_ => _chatWindow?.SendToWebView(wrapped), null);
    }

    private void OnServerChatHistory(string json)
    {
        var wrapped = json.TrimStart().StartsWith("{")
            ? "{\"type\":\"chat_history\"," + json.TrimStart().Substring(1)
            : json;
        _uiContext.Post(_ => _chatWindow?.SendToWebView(wrapped), null);
    }

    private void OnServerConnectionChanged(bool connected)
    {
        var statusMsg = JsonSerializer.Serialize(new { type = "connection_status", connected });
        _uiContext.Post(_ =>
        {
            _chatWindow?.SendToWebView(statusMsg);
            _trayIcon.Text = connected ? "Pocket IT - Connected" : "Pocket IT - Disconnected";
            if (_wasConnected && !connected)
            {
                _trayIcon.ShowBalloonTip(3000, "Pocket IT", "Lost connection to server. Reconnecting...", ToolTipIcon.Warning);
            }
            _wasConnected = connected;
        }, null);
    }

    private async void OnServerDiagnosticRequest(string checkType)
    {
        try
        {
            var result = await _diagnosticsEngine.RunCheckAsync(checkType);
            await _serverConnection.SendDiagnosticResult(result);
        }
        catch (Exception ex)
        {
            Logger.Error("Diagnostic request failed", ex);
        }
    }

    private void OnServerRemediationRequest(string actionId, string requestId)
    {
        // Forward to chat window for user approval
        var info = _remediationEngine.GetActionInfo(actionId);
        var msg = JsonSerializer.Serialize(new
        {
            type = "remediation_request",
            actionId,
            requestId,
            description = info?.Description ?? actionId,
            requiresApproval = true
        });
        _uiContext.Post(_ => _chatWindow?.SendToWebView(msg), null);
    }

    private async void OnServerConnectedReady()
    {
        try
        {
            // Send system profile
            var profile = await DeviceIdentity.GetSystemProfileAsync();
            await _serverConnection.SendSystemProfile(profile);

            // Auto-run all diagnostics
            var results = await _diagnosticsEngine.RunAllAsync();
            foreach (var result in results)
            {
                await _serverConnection.SendDiagnosticResult(result);
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Auto-diagnostics on connect failed", ex);
        }
    }

    private async void OnChatBridgeMessage(string type, string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            switch (type)
            {
                case "chat_message":
                    var content = root.GetProperty("content").GetString() ?? "";
                    if (content.Length > 5000) content = content[..5000];
                    await _serverConnection.SendChatMessage(content);
                    break;

                case "approve_remediation":
                    var actionId = root.GetProperty("actionId").GetString() ?? "";
                    var requestId = root.GetProperty("requestId").GetString() ?? "";
                    var result = await _remediationEngine.ExecuteAsync(actionId);
                    await _serverConnection.SendRemediationResult(requestId, result.Success, result.Message);
                    break;

                case "deny_remediation":
                    requestId = root.GetProperty("requestId").GetString() ?? "";
                    await _serverConnection.SendRemediationResult(requestId, false, "User denied remediation");
                    break;

                case "enroll":
                    var token = root.GetProperty("token").GetString() ?? "";
                    var enrollResult = await _enrollmentFlow.EnrollAsync(token);
                    var enrollResponse = JsonSerializer.Serialize(new
                    {
                        type = "enrollment_result",
                        success = enrollResult.Success,
                        message = enrollResult.Message
                    });
                    _uiContext.Post(_ => _chatWindow?.SendToWebView(enrollResponse), null);
                    if (enrollResult.Success && !string.IsNullOrEmpty(enrollResult.DeviceSecret))
                    {
                        _localDb.SetSetting("device_secret", enrollResult.DeviceSecret);
                        _serverConnection.UpdateDeviceSecret(enrollResult.DeviceSecret);
                        _isEnrolled = true;
                        await Task.Delay(1500);
                        _uiContext.Post(_ =>
                        {
                            _chatWindow?.NavigateTo("chat.html");
                            // Send config to chat UI
                            var phone = _config["OfflineContacts:Phone"] ?? "";
                            var email = _config["OfflineContacts:Email"] ?? "";
                            var portal = _config["OfflineContacts:Portal"] ?? "";
                            _chatWindow?.SendToWebView(JsonSerializer.Serialize(new { type = "offline_config", phone, email, portal }));
                            _chatWindow?.SendToWebView(JsonSerializer.Serialize(new { type = "agent_info", agentName = "Pocket IT" }));
                        }, null);
                        // Connect to server now that we have a secret
                        await _serverConnection.ConnectAsync();
                    }
                    break;
            }
        }
        catch (Exception ex)
        {
            Logger.Error("Bridge message handling failed", ex);
        }
    }

    private void OnOpenChat(object? sender, EventArgs e) => ShowChatWindow();

    private async void OnRunDiagnostics(object? sender, EventArgs e)
    {
        ShowChatWindow();
        try
        {
            var progressMsg = JsonSerializer.Serialize(new { type = "diagnostic_progress", checkType = "all" });
            _uiContext.Post(_ => _chatWindow?.SendToWebView(progressMsg), null);

            var results = await _diagnosticsEngine.RunAllAsync();
            foreach (var result in results)
            {
                await _serverConnection.SendDiagnosticResult(result);
            }

            var resultsMsg = JsonSerializer.Serialize(new
            {
                type = "chat_response",
                text = "Manual diagnostics complete. Results have been sent to the server.",
                sender = "ai",
                diagnosticResults = results.Select(r => new { r.CheckType, r.Status, label = r.Label, value = r.Value })
            });
            _uiContext.Post(_ => _chatWindow?.SendToWebView(resultsMsg), null);
        }
        catch (Exception ex)
        {
            Logger.Error("Manual diagnostics failed", ex);
        }
    }

    private void OnAbout(object? sender, EventArgs e)
    {
        MessageBox.Show("Pocket IT v0.2.1\nAI-Powered IT Helpdesk", "About Pocket IT",
            MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private void OnExit(object? sender, EventArgs e)
    {
        _trayIcon.Visible = false;
        _chatWindow?.Close();
        Application.Exit();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _trayIcon.Dispose();
            _chatWindow?.Dispose();
            _serverConnection?.Dispose();
            _localDb?.Dispose();
        }
        base.Dispose(disposing);
    }
}
