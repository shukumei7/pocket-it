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
using PocketIT.Terminal;
using PocketIT.Desktop;

namespace PocketIT;

public class TrayApplication : ApplicationContext
{
    private readonly NotifyIcon _trayIcon;
    private ChatWindow? _chatWindow;
    private readonly ServerConnection _serverConnection;
    private readonly EnrollmentFlow _enrollmentFlow;
    private readonly DiagnosticsEngine _diagnosticsEngine;
    private readonly RemediationEngine _remediationEngine;
    private readonly ScheduledCheckService _scheduledChecks;
    private readonly IConfiguration _config;
    private readonly SynchronizationContext _uiContext;
    private readonly LocalDatabase _localDb;
    private readonly FileAccess.FileAccessService _fileAccess = new();
    private readonly Scripts.ScriptExecutionService _scriptExecution = new();
    private RemoteTerminalService? _remoteTerminal;
    private RemoteDesktopService? _remoteDesktop;
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

        // Read monitoring interval from config (default 15 minutes)
        int monitoringInterval = 15;
        if (int.TryParse(_config["Monitoring:IntervalMinutes"], out int configInterval) && configInterval > 0)
        {
            monitoringInterval = configInterval;
        }
        _scheduledChecks = new ScheduledCheckService(_diagnosticsEngine, _serverConnection, monitoringInterval);

        // Wire server connection events
        _serverConnection.OnChatResponse += OnServerChatResponse;
        _serverConnection.OnChatHistory += OnServerChatHistory;
        _serverConnection.OnConnectionChanged += OnServerConnectionChanged;
        _serverConnection.OnDiagnosticRequest += OnServerDiagnosticRequest;
        _serverConnection.OnRemediationRequest += OnServerRemediationRequest;
        _serverConnection.OnConnectedReady += OnServerConnectedReady;
        _serverConnection.OnFileBrowseRequest += OnServerFileBrowseRequest;
        _serverConnection.OnFileReadRequest += OnServerFileReadRequest;
        _serverConnection.OnScriptRequest += OnServerScriptRequest;
        _serverConnection.OnTerminalStartRequest += OnServerTerminalStartRequest;
        _serverConnection.OnTerminalInput += OnServerTerminalInput;
        _serverConnection.OnTerminalStopRequest += OnServerTerminalStopRequest;
        _serverConnection.OnDesktopStartRequest += OnServerDesktopStartRequest;
        _serverConnection.OnDesktopMouseInput += OnServerDesktopMouseInput;
        _serverConnection.OnDesktopKeyboardInput += OnServerDesktopKeyboardInput;
        _serverConnection.OnDesktopStopRequest += OnServerDesktopStopRequest;
        _serverConnection.OnDesktopQualityUpdate += OnServerDesktopQualityUpdate;

        var contextMenu = new ContextMenuStrip();
        contextMenu.Items.Add("Open Chat", null, OnOpenChat);
        contextMenu.Items.Add(new ToolStripSeparator());
        contextMenu.Items.Add("Run Diagnostics", null, OnRunDiagnostics);
        contextMenu.Items.Add(new ToolStripSeparator());
        contextMenu.Items.Add("About", null, OnAbout);
        var startupItem = new ToolStripMenuItem("Start with Windows")
        {
            Checked = StartupManager.IsRegistered(),
            CheckOnClick = true
        };
        startupItem.Click += (s, e) =>
        {
            StartupManager.Toggle();
            startupItem.Checked = StartupManager.IsRegistered();
        };
        contextMenu.Items.Add(startupItem);
        contextMenu.Items.Add("Exit", null, OnExit);

        _trayIcon = new NotifyIcon
        {
            Icon = LoadTrayIcon(),
            Text = "Pocket IT",
            Visible = true,
            ContextMenuStrip = contextMenu
        };
        _trayIcon.MouseClick += OnTrayMouseClick;

        // Auto-register for Windows startup on first run
        if (!StartupManager.IsRegistered())
        {
            StartupManager.Register();
        }

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
            Logger.Info($"Enrollment check: secret={(!string.IsNullOrEmpty(deviceSecret) ? "present" : "empty")}");
            var isEnrolled = await _enrollmentFlow.CheckEnrolledAsync(deviceSecret);
            Logger.Info($"Enrollment status: {isEnrolled}");
            var enrollmentToken = _config["Enrollment:Token"] ?? "";

            if (!isEnrolled && !string.IsNullOrEmpty(enrollmentToken))
            {
                Logger.Info("Attempting enrollment with config token");
                var result = await _enrollmentFlow.EnrollAsync(enrollmentToken);
                Logger.Info($"Enrollment result: success={result.Success}, message={result.Message}");
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
                    // If device exists but local secret is lost, show enrollment UI
                    _uiContext.Post(_ => ShowEnrollmentWindow(), null);
                    return;
                }
            }

            if (!isEnrolled && string.IsNullOrEmpty(enrollmentToken))
            {
                // No token in config, not enrolled — show enrollment UI
                _uiContext.Post(_ => ShowEnrollmentWindow(), null);
                return;
            }

            _isEnrolled = true;
            Logger.Info("Device enrolled, connecting to server");

            // Connect to server
            await _serverConnection.ConnectAsync();

            // Start scheduled diagnostic monitoring
            _scheduledChecks.Start();

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

            // Send current connection status
            var connected = _serverConnection.IsConnected;
            var statusMsg = JsonSerializer.Serialize(new { type = "connection_status", connected });
            _chatWindow.SendToWebView(statusMsg);
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
        _chatWindow.Activate();
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
        _chatWindow.Activate();
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
                // Stop any active terminal session on disconnect
                if (_remoteTerminal != null)
                {
                    _remoteTerminal.StopSession();
                    _remoteTerminal.Dispose();
                    _remoteTerminal = null;
                }
                if (_remoteDesktop != null)
                {
                    _remoteDesktop.StopSession();
                    _remoteDesktop.Dispose();
                    _remoteDesktop = null;
                }
            }
            _wasConnected = connected;
        }, null);
    }

    private void OnServerDiagnosticRequest(string checkType, string requestId, bool itInitiated)
    {
        if (itInitiated)
        {
            Logger.Info($"IT-initiated diagnostic: {checkType} (requestId: {requestId})");
            _ = Task.Run(async () =>
            {
                try
                {
                    if (checkType == "all")
                    {
                        var allResults = await _diagnosticsEngine.RunAllAsync();
                        foreach (var diagResult in allResults)
                        {
                            await _serverConnection.SendDiagnosticResult(diagResult);
                        }
                    }
                    else
                    {
                        var diagResult = await _diagnosticsEngine.RunCheckAsync(checkType);
                        await _serverConnection.SendDiagnosticResult(diagResult);
                    }
                }
                catch (Exception ex)
                {
                    Logger.Error($"IT-initiated diagnostic failed: {checkType}", ex);
                }
            });
            return;
        }

        // Forward to chat window for user consent (like remediation)
        var msg = JsonSerializer.Serialize(new
        {
            type = "diagnostic_request",
            checkType,
            requestId,
            description = checkType == "all" ? "Full System Diagnostic" : $"{char.ToUpper(checkType[0])}{checkType[1..]} Check"
        });
        _uiContext.Post(_ => _chatWindow?.SendToWebView(msg), null);
    }

    private void OnServerRemediationRequest(string actionId, string requestId, string? parameter, bool autoApprove)
    {
        // v0.5.0: Auto-approve for low-risk actions when policy allows
        if (autoApprove)
        {
            var info = _remediationEngine.GetActionInfo(actionId);
            if (info != null && info.CanAutoApprove)
            {
                Logger.Info($"Auto-remediation executing: {actionId} (parameter: {parameter})");
                _ = Task.Run(async () =>
                {
                    try
                    {
                        var result = await _remediationEngine.ExecuteAsync(actionId, parameter);
                        await _serverConnection.SendRemediationResult(requestId, result.Success, result.Message);
                        Logger.Info($"Auto-remediation completed: {actionId} - {(result.Success ? "success" : "failed")}");
                    }
                    catch (Exception ex)
                    {
                        Logger.Error($"Auto-remediation failed: {actionId}", ex);
                    }
                });
                return;
            }
            Logger.Warn($"Auto-approve denied for {actionId}: not a low-risk action");
        }

        // Forward to chat window for user approval
        var info2 = _remediationEngine.GetActionInfo(actionId);
        var msg = JsonSerializer.Serialize(new
        {
            type = "remediation_request",
            actionId,
            requestId,
            parameter,
            description = info2?.Description ?? actionId,
            requiresApproval = true
        });
        _uiContext.Post(_ => _chatWindow?.SendToWebView(msg), null);
    }

    private void OnServerFileBrowseRequest(string requestId, string path, bool itInitiated)
    {
        Logger.Info($"File browse request: {path}");

        if (itInitiated)
        {
            Logger.Info($"IT-initiated file browse: {path} (requestId: {requestId})");
            _ = Task.Run(async () =>
            {
                try
                {
                    var entries = _fileAccess.Browse(path);
                    await _serverConnection.SendFileBrowseResult(requestId, path, true, entries);
                }
                catch (Exception ex)
                {
                    Logger.Error($"IT-initiated file browse failed: {path}", ex);
                    await _serverConnection.SendFileBrowseResult(requestId, path, true, error: ex.Message);
                }
            });
            return;
        }

        var bridgeData = new
        {
            type = "file_access_request",
            operation = "browse",
            path,
            requestId
        };
        _uiContext.Post(_ => _chatWindow?.SendToWebView(JsonSerializer.Serialize(bridgeData)), null);
    }

    private void OnServerFileReadRequest(string requestId, string path, bool itInitiated)
    {
        Logger.Info($"File read request: {path}");

        if (itInitiated)
        {
            Logger.Info($"IT-initiated file read: {path} (requestId: {requestId})");
            _ = Task.Run(async () =>
            {
                try
                {
                    var result = _fileAccess.ReadFile(path);
                    if (result.Success)
                        await _serverConnection.SendFileReadResult(requestId, path, true, result.Content, result.SizeBytes);
                    else
                        await _serverConnection.SendFileReadResult(requestId, path, true, error: result.Error);
                }
                catch (Exception ex)
                {
                    Logger.Error($"IT-initiated file read failed: {path}", ex);
                    await _serverConnection.SendFileReadResult(requestId, path, true, error: ex.Message);
                }
            });
            return;
        }

        var bridgeData = new
        {
            type = "file_access_request",
            operation = "read",
            path,
            requestId
        };
        _uiContext.Post(_ => _chatWindow?.SendToWebView(JsonSerializer.Serialize(bridgeData)), null);
    }

    private void OnServerScriptRequest(string requestId, string scriptName, string scriptContent, bool requiresElevation, int timeoutSeconds, bool itInitiated)
    {
        Logger.Info($"Script request: {scriptName} (elevation: {requiresElevation})");

        if (itInitiated)
        {
            Logger.Info($"IT-initiated script execution: {scriptName} (requestId: {requestId})");
            _ = Task.Run(async () =>
            {
                try
                {
                    var result = await _scriptExecution.ExecuteAsync(scriptContent, timeoutSeconds, requiresElevation);
                    await _serverConnection.SendScriptResult(requestId, scriptName, result.Success,
                        result.Output, result.ErrorOutput, result.ExitCode, result.DurationMs,
                        result.Truncated, result.TimedOut, result.ValidationError);
                }
                catch (Exception ex)
                {
                    Logger.Error($"IT-initiated script execution failed: {scriptName}", ex);
                    await _serverConnection.SendScriptResult(requestId, scriptName, false, errorOutput: ex.Message);
                }
            });
            return;
        }

        var bridgeData = new
        {
            type = "script_request",
            requestId,
            scriptName,
            scriptContent,
            requiresElevation,
            timeoutSeconds
        };
        _uiContext.Post(_ => _chatWindow?.SendToWebView(JsonSerializer.Serialize(bridgeData)), null);
    }

    private void OnServerTerminalStartRequest(string requestId, bool itInitiated)
    {
        Logger.Info($"Terminal start request: {requestId}");

        if (itInitiated)
        {
            Logger.Info($"IT-initiated terminal start (requestId: {requestId})");
            _remoteTerminal?.Dispose();
            _remoteTerminal = new RemoteTerminalService();

            _remoteTerminal.OnOutput += output =>
            {
                _ = _serverConnection.SendTerminalOutput(output);
            };

            _remoteTerminal.OnSessionEnded += exitCode =>
            {
                _ = _serverConnection.SendTerminalStopped(requestId, exitCode, exitCode == -1 ? "idle_timeout" : "process_exited");
                _remoteTerminal?.Dispose();
                _remoteTerminal = null;
                var endMsg = JsonSerializer.Serialize(new { type = "terminal_session_ended", exitCode });
                _uiContext.Post(_ => _chatWindow?.SendToWebView(endMsg), null);
            };

            _remoteTerminal.StartSession();
            _ = _serverConnection.SendTerminalStarted(requestId);

            var activeMsg = JsonSerializer.Serialize(new { type = "terminal_session_active" });
            _uiContext.Post(_ => _chatWindow?.SendToWebView(activeMsg), null);
            return;
        }

        var bridgeData = new
        {
            type = "terminal_start_request",
            requestId
        };
        _uiContext.Post(_ => _chatWindow?.SendToWebView(JsonSerializer.Serialize(bridgeData)), null);
    }

    private void OnServerTerminalInput(string input)
    {
        if (_remoteTerminal?.IsSessionActive == true)
        {
            _remoteTerminal.SendInput(input);
        }
    }

    private void OnServerTerminalStopRequest(string requestId)
    {
        Logger.Info($"Terminal stop request: {requestId}");
        _remoteTerminal?.StopSession();
        _remoteTerminal?.Dispose();
        _remoteTerminal = null;
    }

    private void OnServerDesktopStartRequest(string requestId, bool itInitiated)
    {
        Logger.Info($"Desktop start request: {requestId}");

        if (itInitiated)
        {
            Logger.Info($"IT-initiated desktop session (requestId: {requestId})");
            _remoteDesktop?.Dispose();
            _remoteDesktop = new RemoteDesktopService();

            _remoteDesktop.OnFrame += (base64, width, height) =>
            {
                _ = _serverConnection.SendDesktopFrame(base64, width, height);
            };

            _remoteDesktop.OnSessionEnded += () =>
            {
                _ = _serverConnection.SendDesktopStopped(requestId, "session_ended");
                _remoteDesktop?.Dispose();
                _remoteDesktop = null;
            };

            _remoteDesktop.StartSession();
            _ = _serverConnection.SendDesktopStarted(requestId);
            return;
        }

        // Non-IT-initiated: would need user approval (future)
        _ = _serverConnection.SendDesktopDenied(requestId);
    }

    private void OnServerDesktopMouseInput(double x, double y, string button, string action)
    {
        _remoteDesktop?.HandleMouseInput(x, y, button, action);
    }

    private void OnServerDesktopKeyboardInput(ushort vkCode, string action)
    {
        _remoteDesktop?.HandleKeyboardInput(vkCode, action);
    }

    private void OnServerDesktopStopRequest(string requestId)
    {
        Logger.Info($"Desktop stop request: {requestId}");
        _remoteDesktop?.StopSession();
        _remoteDesktop?.Dispose();
        _remoteDesktop = null;
    }

    private void OnServerDesktopQualityUpdate(int quality, int fps, float scale)
    {
        _remoteDesktop?.UpdateQuality(quality, fps, scale);
    }

    private async void OnServerConnectedReady()
    {
        try
        {
            // Send system profile
            var profile = await DeviceIdentity.GetSystemProfileAsync();
            await _serverConnection.SendSystemProfile(profile);

            // Run diagnostics silently on connect (no chat UI, just collect data)
            _ = Task.Run(async () =>
            {
                try
                {
                    var results = await _diagnosticsEngine.RunAllAsync();
                    foreach (var result in results)
                    {
                        await _serverConnection.SendDiagnosticResult(result, silent: true);
                    }
                    Logger.Info($"Auto-connect diagnostics: {results.Count()} checks completed silently");
                }
                catch (Exception ex2)
                {
                    Logger.Error("Auto-connect diagnostics failed", ex2);
                }
            });
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
                {
                    var actionId = root.GetProperty("actionId").GetString() ?? "";
                    var requestId = root.GetProperty("requestId").GetString() ?? "";
                    var parameter = root.TryGetProperty("parameter", out var paramProp) ? paramProp.GetString() : null;
                    var result = await _remediationEngine.ExecuteAsync(actionId, parameter);
                    await _serverConnection.SendRemediationResult(requestId, result.Success, result.Message);
                    break;
                }

                case "deny_remediation":
                {
                    var requestId = root.GetProperty("requestId").GetString() ?? "";
                    await _serverConnection.SendRemediationResult(requestId, false, "User denied remediation");
                    break;
                }

                case "approve_diagnostic":
                    var diagCheckType = root.GetProperty("checkType").GetString() ?? "all";
                    Logger.Info($"User approved diagnostic: {diagCheckType}");
                    if (diagCheckType == "all")
                    {
                        var allResults = await _diagnosticsEngine.RunAllAsync();
                        foreach (var diagResult in allResults)
                        {
                            await _serverConnection.SendDiagnosticResult(diagResult);
                        }
                    }
                    else
                    {
                        var diagResult = await _diagnosticsEngine.RunCheckAsync(diagCheckType);
                        await _serverConnection.SendDiagnosticResult(diagResult);
                    }
                    break;

                case "deny_diagnostic":
                    Logger.Info($"User denied diagnostic: {root.GetProperty("checkType").GetString()}");
                    break;

                case "clear_chat":
                    await _serverConnection.SendClearContext();
                    break;

                case "approve_file_access":
                {
                    var requestId = root.GetProperty("requestId").GetString() ?? "";
                    var operation = root.GetProperty("operation").GetString() ?? "";
                    var path = root.GetProperty("path").GetString() ?? "";
                    Logger.Info($"File access approved: {operation} {path}");

                    _ = Task.Run(async () =>
                    {
                        try
                        {
                            if (operation == "browse")
                            {
                                var entries = _fileAccess.Browse(path);
                                await _serverConnection.SendFileBrowseResult(requestId, path, true, entries);
                            }
                            else if (operation == "read")
                            {
                                var result = _fileAccess.ReadFile(path);
                                if (result.Success)
                                    await _serverConnection.SendFileReadResult(requestId, path, true, result.Content, result.SizeBytes);
                                else
                                    await _serverConnection.SendFileReadResult(requestId, path, true, error: result.Error);
                            }
                        }
                        catch (Exception ex)
                        {
                            Logger.Error($"File access failed: {operation} {path}", ex);
                            if (operation == "browse")
                                await _serverConnection.SendFileBrowseResult(requestId, path, true, error: ex.Message);
                            else
                                await _serverConnection.SendFileReadResult(requestId, path, true, error: ex.Message);
                        }
                    });
                    break;
                }

                case "deny_file_access":
                {
                    var requestId = root.GetProperty("requestId").GetString() ?? "";
                    var operation = root.GetProperty("operation").GetString() ?? "";
                    var path = root.GetProperty("path").GetString() ?? "";
                    Logger.Info($"File access denied: {operation} {path}");

                    _ = Task.Run(async () =>
                    {
                        if (operation == "browse")
                            await _serverConnection.SendFileBrowseResult(requestId, path, false, error: "Access denied by user");
                        else
                            await _serverConnection.SendFileReadResult(requestId, path, false, error: "Access denied by user");
                    });
                    break;
                }

                case "approve_script":
                {
                    var requestId = root.GetProperty("requestId").GetString() ?? "";
                    var scriptName = root.TryGetProperty("scriptName", out var snProp) ? snProp.GetString() : "script";
                    var scriptContent = root.GetProperty("scriptContent").GetString() ?? "";
                    bool requiresElevation = root.TryGetProperty("requiresElevation", out var eProp) && eProp.ValueKind == JsonValueKind.True;
                    int timeoutSeconds = root.TryGetProperty("timeoutSeconds", out var tProp) ? tProp.GetInt32() : 60;
                    Logger.Info($"Script approved: {scriptName}");

                    _ = Task.Run(async () =>
                    {
                        try
                        {
                            var result = await _scriptExecution.ExecuteAsync(scriptContent, timeoutSeconds, requiresElevation);
                            await _serverConnection.SendScriptResult(requestId, scriptName, result.Success,
                                result.Output, result.ErrorOutput, result.ExitCode, result.DurationMs,
                                result.Truncated, result.TimedOut, result.ValidationError);
                        }
                        catch (Exception ex)
                        {
                            Logger.Error($"Script execution failed: {scriptName}", ex);
                            await _serverConnection.SendScriptResult(requestId, scriptName, false, errorOutput: ex.Message);
                        }
                    });
                    break;
                }

                case "deny_script":
                {
                    var requestId = root.GetProperty("requestId").GetString() ?? "";
                    var scriptName = root.TryGetProperty("scriptName", out var snProp) ? snProp.GetString() : "script";
                    Logger.Info($"Script denied: {scriptName}");

                    _ = Task.Run(async () =>
                    {
                        await _serverConnection.SendScriptResult(requestId, scriptName, false, errorOutput: "Script execution denied by user");
                    });
                    break;
                }

                case "approve_terminal":
                {
                    var requestId = root.GetProperty("requestId").GetString() ?? "";
                    Logger.Info($"Terminal approved: {requestId}");

                    _remoteTerminal?.Dispose();
                    _remoteTerminal = new RemoteTerminalService();

                    _remoteTerminal.OnOutput += output =>
                    {
                        _ = _serverConnection.SendTerminalOutput(output);
                    };

                    _remoteTerminal.OnSessionEnded += exitCode =>
                    {
                        _ = _serverConnection.SendTerminalStopped(requestId, exitCode, exitCode == -1 ? "idle_timeout" : "process_exited");
                        _remoteTerminal?.Dispose();
                        _remoteTerminal = null;
                        var endMsg = JsonSerializer.Serialize(new { type = "terminal_session_ended", exitCode });
                        _uiContext.Post(_ => _chatWindow?.SendToWebView(endMsg), null);
                    };

                    _remoteTerminal.StartSession();
                    _ = _serverConnection.SendTerminalStarted(requestId);

                    var activeMsg = JsonSerializer.Serialize(new { type = "terminal_session_active" });
                    _uiContext.Post(_ => _chatWindow?.SendToWebView(activeMsg), null);
                    break;
                }

                case "deny_terminal":
                {
                    var requestId = root.GetProperty("requestId").GetString() ?? "";
                    Logger.Info($"Terminal denied: {requestId}");
                    _ = _serverConnection.SendTerminalDenied(requestId);
                    break;
                }

                case "end_terminal":
                {
                    Logger.Info("User ended terminal session");
                    _remoteTerminal?.StopSession();
                    break;
                }

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

    private void OnTrayMouseClick(object? sender, MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left) ShowChatWindow();
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
        _scheduledChecks?.Stop();
        Application.Exit();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _trayIcon.Dispose();
            _chatWindow?.Dispose();
            _remoteDesktop?.Dispose();
            _remoteTerminal?.Dispose();
            _scheduledChecks?.Dispose();
            _serverConnection?.Dispose();
            _localDb?.Dispose();
        }
        base.Dispose(disposing);
    }
}
