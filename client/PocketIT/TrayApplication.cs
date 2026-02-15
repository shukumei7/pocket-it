using System;
using System.Drawing;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
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

    public TrayApplication()
    {
        _uiContext = SynchronizationContext.Current ?? new SynchronizationContext();

        // Load config
        _config = new ConfigurationBuilder()
            .SetBasePath(AppContext.BaseDirectory)
            .AddJsonFile("appsettings.json", optional: false)
            .Build();

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
        _serverConnection.OnConnectionChanged += OnServerConnectionChanged;
        _serverConnection.OnDiagnosticRequest += OnServerDiagnosticRequest;
        _serverConnection.OnRemediationRequest += OnServerRemediationRequest;

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
        _trayIcon.DoubleClick += OnOpenChat;

        // Start async initialization (enrollment + connection)
        Task.Run(InitializeAsync);
    }

    private Icon LoadTrayIcon()
    {
        var iconPath = Path.Combine(AppContext.BaseDirectory, "Resources", "tray-icon.ico");
        return File.Exists(iconPath) ? new Icon(iconPath) : SystemIcons.Application;
    }

    private async Task InitializeAsync()
    {
        try
        {
            // Check enrollment
            var isEnrolled = await _enrollmentFlow.CheckEnrolledAsync();
            var enrollmentToken = _config["Enrollment:Token"] ?? "";

            if (!isEnrolled && !string.IsNullOrEmpty(enrollmentToken))
            {
                var result = await _enrollmentFlow.EnrollAsync(enrollmentToken);
                if (result.Success && !string.IsNullOrEmpty(result.DeviceSecret))
                {
                    _localDb.SetSetting("device_secret", result.DeviceSecret);
                }
                else if (!result.Success)
                {
                    _uiContext.Post(_ => _trayIcon.ShowBalloonTip(5000, "Pocket IT",
                        $"Enrollment failed: {result.Message}", ToolTipIcon.Warning), null);
                }
            }

            // Connect to server
            await _serverConnection.ConnectAsync();
        }
        catch (Exception ex)
        {
            _uiContext.Post(_ => _trayIcon.ShowBalloonTip(5000, "Pocket IT",
                $"Connection error: {ex.Message}", ToolTipIcon.Error), null);
        }
    }

    private void ShowChatWindow()
    {
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
            // Position bottom-right of primary screen
            var screen = Screen.PrimaryScreen!.WorkingArea;
            _chatWindow.StartPosition = FormStartPosition.Manual;
            _chatWindow.Location = new Point(
                screen.Right - _chatWindow.Width - 20,
                screen.Bottom - _chatWindow.Height - 20
            );
        }

        _chatWindow.Show();
        _chatWindow.BringToFront();
    }

    private void OnServerChatResponse(string json)
    {
        // Forward chat response to UI (already in JSON format from server)
        _uiContext.Post(_ => _chatWindow?.SendToWebView(json), null);
    }

    private void OnServerConnectionChanged(bool connected)
    {
        var statusMsg = JsonSerializer.Serialize(new { type = "connection_status", connected });
        _uiContext.Post(_ => _chatWindow?.SendToWebView(statusMsg), null);
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
            System.Diagnostics.Debug.WriteLine($"Diagnostic error: {ex.Message}");
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
            }
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"Bridge message error: {ex.Message}");
        }
    }

    private void OnOpenChat(object? sender, EventArgs e) => ShowChatWindow();

    private void OnRunDiagnostics(object? sender, EventArgs e)
    {
        ShowChatWindow();
        // TODO: Trigger diagnostics via chat
    }

    private void OnAbout(object? sender, EventArgs e)
    {
        MessageBox.Show("Pocket IT v0.1.0\nAI-Powered IT Helpdesk", "About Pocket IT",
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
