using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using PocketIT.Diagnostics;
using SocketIOClient;

namespace PocketIT.Core;

public class ServerConnection : IDisposable
{
    private SocketIOClient.SocketIO? _socket;
    private string _serverUrl;
    private readonly string _deviceId;
    private string _deviceSecret;
    private readonly System.Timers.Timer _heartbeatTimer;
    private readonly ConcurrentQueue<object> _offlineQueue = new();
    private bool _isConnected;
    public bool IsConnected => _isConnected;
    public string LastSeenChat { get; set; } = "";

    public event Action<string>? OnChatResponse;
    public event Action<string, string, bool>? OnDiagnosticRequest; // checkType, requestId, itInitiated
    public event Action<string, string, string?, bool>? OnRemediationRequest; // actionId, requestId, parameter, autoApprove
    public event Action<bool>? OnConnectionChanged;
    public event Action<string>? OnChatHistory;
    public event Action? OnConnectedReady;
    public event Action<string, string, bool>? OnFileBrowseRequest; // requestId, path, itInitiated
    public event Action<string, string, bool>? OnFileReadRequest; // requestId, path, itInitiated
    public event Action<string, string, string, bool, int, bool>? OnScriptRequest; // requestId, scriptName, scriptContent, requiresElevation, timeoutSeconds, itInitiated
    public event Action<string, bool>? OnTerminalStartRequest;  // requestId, itInitiated
    public event Action<string>? OnTerminalInput;          // input text
    public event Action<string>? OnTerminalStopRequest;    // requestId
    public event Action<string, bool>? OnDesktopStartRequest;  // requestId, itInitiated
    public event Action<double, double, string, string>? OnDesktopMouseInput; // x, y, button, action
    public event Action<ushort, string>? OnDesktopKeyboardInput; // vkCode, action
    public event Action<string>? OnDesktopStopRequest;    // requestId
    public event Action<int, int, float>? OnDesktopQualityUpdate; // quality, fps, scale
    public event Action<string, string, string>? OnSystemToolRequest; // requestId, tool, paramsJson
    public event Action<string>? OnUpdateAvailable; // json payload
    public event Action<string, string[]>? OnFileDeleteRequest; // requestId, paths
    public event Action<string, string>? OnFilePropertiesRequest; // requestId, path
    public event Action<string, string[], string, bool>? OnFilePasteRequest; // requestId, paths, destination, move
    public event Action<string, string>? OnFileDownloadRequest; // requestId, path
    public event Action<string, string, string, string>? OnFileUploadRequest; // requestId, destinationPath, filename, base64data
    public event Action<string, string, string, string?, int>? OnInstallerRequest; // requestId, filename, fileData(base64), silentArgs, timeoutSeconds
    public event Action<string, string>? OnScreenshotRequest; // requestId, reason
    public event Action<string>? OnServerUrlChanged; // newUrl

    public ServerConnection(string serverUrl, string deviceId, string deviceSecret = "")
    {
        _serverUrl = serverUrl;
        _deviceId = deviceId;
        _deviceSecret = deviceSecret;
        _heartbeatTimer = new System.Timers.Timer(30000);
        _heartbeatTimer.Elapsed += async (_, _) => await SendHeartbeat();
    }

    /// <summary>
    /// Updates the device secret before connecting. Must be called before ConnectAsync.
    /// </summary>
    public void UpdateDeviceSecret(string secret)
    {
        _deviceSecret = secret;
    }

    public async Task ConnectAsync()
    {
        // Dispose existing socket if any (reconnect scenario)
        if (_socket != null)
        {
            try { await _socket.DisconnectAsync(); } catch { }
            _socket.Dispose();
            _socket = null;
        }

        _socket = new SocketIOClient.SocketIO($"{_serverUrl}/agent", new SocketIOOptions
        {
            Query = new List<KeyValuePair<string, string>>
            {
                new("deviceId", _deviceId),
                new("hostname", DeviceIdentity.GetHostname()),
                new("deviceSecret", _deviceSecret),
                new("clientVersion", AppVersion.Current),
                new("exeHash", IntegrityCheck.GetExeHash()),
                new("lastSeenChat", LastSeenChat)
            },
            Reconnection = true,
            ReconnectionAttempts = 50,
            ReconnectionDelay = 5000,
            ConnectionTimeout = TimeSpan.FromSeconds(10)
        });

        _socket.OnConnected += async (_, _) =>
        {
            _isConnected = true;
            _heartbeatTimer.Start();
            OnConnectionChanged?.Invoke(true);
            await FlushOfflineQueue();
            OnConnectedReady?.Invoke();
        };

        _socket.OnDisconnected += (_, _) =>
        {
            _isConnected = false;
            _heartbeatTimer.Stop();
            OnConnectionChanged?.Invoke(false);
        };

        _socket.On("chat_response", response =>
        {
            var data = response.GetValue<JsonElement>();
            OnChatResponse?.Invoke(data.GetRawText());
        });

        _socket.On("diagnostic_request", response =>
        {
            var data = response.GetValue<JsonElement>();
            var checkType = data.GetProperty("checkType").GetString() ?? "all";
            var requestId = data.TryGetProperty("requestId", out var rid) ? rid.GetString() ?? "" : "";
            bool itInitiated = data.TryGetProperty("itInitiated", out var itProp) && itProp.ValueKind == JsonValueKind.True;
            OnDiagnosticRequest?.Invoke(checkType, requestId, itInitiated);
        });

        _socket.On("remediation_request", response =>
        {
            var data = response.GetValue<JsonElement>();
            var actionId = data.GetProperty("actionId").GetString() ?? "";
            var requestId = data.GetProperty("requestId").GetString() ?? "";
            var parameter = data.TryGetProperty("parameter", out var paramProp) ? paramProp.GetString() : null;
            bool autoApprove = false;
            if (data.TryGetProperty("autoApprove", out var autoApproveProp) && autoApproveProp.ValueKind == JsonValueKind.True)
                autoApprove = true;
            OnRemediationRequest?.Invoke(actionId, requestId, parameter, autoApprove);
        });

        _socket.On("chat_history", response =>
        {
            var data = response.GetValue<JsonElement>();
            OnChatHistory?.Invoke(data.GetRawText());
        });

        _socket.On("file_browse_request", response =>
        {
            var json = response.GetValue<JsonElement>();
            var requestId = json.GetProperty("requestId").GetString() ?? "";
            var path = json.GetProperty("path").GetString() ?? "";
            bool itInitiated = json.TryGetProperty("itInitiated", out var itProp) && itProp.ValueKind == JsonValueKind.True;
            Logger.Info($"File browse request: {path} (requestId: {requestId})");
            OnFileBrowseRequest?.Invoke(requestId, path, itInitiated);
        });

        _socket.On("file_read_request", response =>
        {
            var json = response.GetValue<JsonElement>();
            var requestId = json.GetProperty("requestId").GetString() ?? "";
            var path = json.GetProperty("path").GetString() ?? "";
            bool itInitiated = json.TryGetProperty("itInitiated", out var itProp2) && itProp2.ValueKind == JsonValueKind.True;
            Logger.Info($"File read request: {path} (requestId: {requestId})");
            OnFileReadRequest?.Invoke(requestId, path, itInitiated);
        });

        _socket.On("script_request", response =>
        {
            var json = response.GetValue<JsonElement>();
            var requestId = json.GetProperty("requestId").GetString() ?? "";
            var scriptName = json.GetProperty("scriptName").GetString() ?? "";
            var scriptContent = json.GetProperty("scriptContent").GetString() ?? "";
            bool requiresElevation = false;
            if (json.TryGetProperty("requiresElevation", out var elevProp) && elevProp.ValueKind == JsonValueKind.True)
                requiresElevation = true;
            int timeoutSeconds = 60;
            if (json.TryGetProperty("timeoutSeconds", out var toProp))
                timeoutSeconds = toProp.GetInt32();
            bool itInitiated = json.TryGetProperty("itInitiated", out var itProp) && itProp.ValueKind == JsonValueKind.True;
            Logger.Info($"Script request: {scriptName} (requestId: {requestId}, elevation: {requiresElevation})");
            OnScriptRequest?.Invoke(requestId, scriptName, scriptContent, requiresElevation, timeoutSeconds, itInitiated);
        });

        _socket.On("terminal_start_request", response =>
        {
            var json = response.GetValue<JsonElement>();
            var requestId = json.GetProperty("requestId").GetString() ?? "";
            bool itInitiated = json.TryGetProperty("itInitiated", out var itProp) && itProp.ValueKind == JsonValueKind.True;
            Logger.Info($"Terminal start request (requestId: {requestId})");
            OnTerminalStartRequest?.Invoke(requestId, itInitiated);
        });

        _socket.On("terminal_input", response =>
        {
            var json = response.GetValue<JsonElement>();
            var input = json.GetProperty("input").GetString() ?? "";
            OnTerminalInput?.Invoke(input);
        });

        _socket.On("terminal_stop_request", response =>
        {
            var json = response.GetValue<JsonElement>();
            var requestId = json.GetProperty("requestId").GetString() ?? "";
            Logger.Info($"Terminal stop request (requestId: {requestId})");
            OnTerminalStopRequest?.Invoke(requestId);
        });

        _socket.On("desktop_start_request", response =>
        {
            var json = response.GetValue<JsonElement>();
            var requestId = json.GetProperty("requestId").GetString() ?? "";
            bool itInitiated = json.TryGetProperty("itInitiated", out var itProp) && itProp.ValueKind == JsonValueKind.True;
            Logger.Info($"Desktop start request (requestId: {requestId})");
            OnDesktopStartRequest?.Invoke(requestId, itInitiated);
        });

        _socket.On("desktop_mouse_input", response =>
        {
            var json = response.GetValue<JsonElement>();
            double x = json.GetProperty("x").GetDouble();
            double y = json.GetProperty("y").GetDouble();
            string button = json.TryGetProperty("button", out var bp) ? bp.GetString() ?? "left" : "left";
            string action = json.GetProperty("action").GetString() ?? "click";
            OnDesktopMouseInput?.Invoke(x, y, button, action);
        });

        _socket.On("desktop_keyboard_input", response =>
        {
            var json = response.GetValue<JsonElement>();
            ushort vkCode = (ushort)json.GetProperty("vkCode").GetInt32();
            string action = json.GetProperty("action").GetString() ?? "press";
            OnDesktopKeyboardInput?.Invoke(vkCode, action);
        });

        _socket.On("desktop_stop_request", response =>
        {
            var json = response.GetValue<JsonElement>();
            var requestId = json.GetProperty("requestId").GetString() ?? "";
            Logger.Info($"Desktop stop request (requestId: {requestId})");
            OnDesktopStopRequest?.Invoke(requestId);
        });

        _socket.On("desktop_quality_update", response =>
        {
            var json = response.GetValue<JsonElement>();
            int quality = json.TryGetProperty("quality", out var qp) ? qp.GetInt32() : 50;
            int fps = json.TryGetProperty("fps", out var fp) ? fp.GetInt32() : 10;
            float scale = json.TryGetProperty("scale", out var sp) ? (float)sp.GetDouble() : 0.5f;
            OnDesktopQualityUpdate?.Invoke(quality, fps, scale);
        });

        _socket.On("system_tool_request", response =>
        {
            var json = response.GetValue<JsonElement>();
            var requestId = json.GetProperty("requestId").GetString() ?? "";
            var tool = json.GetProperty("tool").GetString() ?? "";
            var paramsValue = json.TryGetProperty("params", out var pp) ? pp.GetRawText() : null;
            Logger.Info($"System tool request: {tool} (requestId: {requestId})");
            OnSystemToolRequest?.Invoke(requestId, tool, paramsValue ?? "");
        });

        _socket.On("update_available", response =>
        {
            var data = response.GetValue<JsonElement>();
            OnUpdateAvailable?.Invoke(data.GetRawText());
        });

        _socket.On("request_file_delete", response =>
        {
            var json = response.GetValue<JsonElement>();
            var requestId = json.TryGetProperty("requestId", out var ridProp) ? ridProp.GetString() ?? "" : "";
            var pathsEl = json.GetProperty("paths");
            var paths = pathsEl.EnumerateArray().Select(p => p.GetString() ?? "").Where(p => p.Length > 0).ToArray();
            Logger.Info($"File delete request: {paths.Length} paths (requestId: {requestId})");
            OnFileDeleteRequest?.Invoke(requestId, paths);
        });

        _socket.On("request_file_properties", response =>
        {
            var json = response.GetValue<JsonElement>();
            var requestId = json.TryGetProperty("requestId", out var ridProp) ? ridProp.GetString() ?? "" : "";
            var path = json.GetProperty("path").GetString() ?? "";
            Logger.Info($"File properties request: {path}");
            OnFilePropertiesRequest?.Invoke(requestId, path);
        });

        _socket.On("request_file_paste", response =>
        {
            var json = response.GetValue<JsonElement>();
            var requestId = json.TryGetProperty("requestId", out var ridProp) ? ridProp.GetString() ?? "" : "";
            var operation = json.GetProperty("operation").GetString() ?? "copy";
            var pathsEl = json.GetProperty("paths");
            var paths = pathsEl.EnumerateArray().Select(p => p.GetString() ?? "").Where(p => p.Length > 0).ToArray();
            var destination = json.GetProperty("destination").GetString() ?? "";
            bool move = operation == "move";
            Logger.Info($"File paste request: {operation} {paths.Length} items to {destination}");
            OnFilePasteRequest?.Invoke(requestId, paths, destination, move);
        });

        _socket.On("request_file_download", response =>
        {
            var json = response.GetValue<JsonElement>();
            var requestId = json.TryGetProperty("requestId", out var ridProp) ? ridProp.GetString() ?? "" : "";
            var path = json.GetProperty("path").GetString() ?? "";
            Logger.Info($"File download request: {path}");
            OnFileDownloadRequest?.Invoke(requestId, path);
        });

        _socket.On("request_file_upload", response =>
        {
            var json = response.GetValue<JsonElement>();
            var requestId = json.TryGetProperty("requestId", out var ridProp) ? ridProp.GetString() ?? "" : "";
            var destinationPath = json.GetProperty("destinationPath").GetString() ?? "";
            var filename = json.GetProperty("filename").GetString() ?? "";
            var data = json.GetProperty("data").GetString() ?? "";
            Logger.Info($"File upload request: {filename} to {destinationPath}");
            OnFileUploadRequest?.Invoke(requestId, destinationPath, filename, data);
        });

        _socket.On("installer_request", response =>
        {
            var json = response.GetValue<JsonElement>();
            var requestId = json.GetProperty("requestId").GetString() ?? "";
            var filename = json.GetProperty("filename").GetString() ?? "";
            var fileData = json.GetProperty("fileData").GetString() ?? "";
            var silentArgs = json.TryGetProperty("silentArgs", out var saProp) ? saProp.GetString() : null;
            int timeoutSeconds = json.TryGetProperty("timeoutSeconds", out var toProp) ? toProp.GetInt32() : 300;
            Logger.Info($"Installer request: {filename} (requestId: {requestId})");
            OnInstallerRequest?.Invoke(requestId, filename, fileData, silentArgs, timeoutSeconds);
        });

        _socket.On("screenshot_request", response =>
        {
            var data = response.GetValue<JsonElement>();
            var requestId = data.TryGetProperty("requestId", out var rid) ? rid.GetString() ?? "" : "";
            var reason = data.TryGetProperty("reason", out var rProp) ? rProp.GetString() ?? "" : "";
            OnScreenshotRequest?.Invoke(requestId, reason);
        });

        _socket.On("server_url_changed", response =>
        {
            var data = response.GetValue<JsonElement>();
            var url = data.TryGetProperty("url", out var urlProp) ? urlProp.GetString() ?? "" : "";
            if (!string.IsNullOrEmpty(url))
            {
                Logger.Info($"Server URL changed to: {url}");
                OnServerUrlChanged?.Invoke(url);
            }
        });

        try
        {
            await _socket.ConnectAsync();
        }
        catch (Exception ex)
        {
            Logger.Error("Socket connection failed", ex);
            _socket.Dispose();
            _socket = null;
            _isConnected = false;
            throw;
        }
    }

    public async Task SendChatMessage(string message)
    {
        var payload = new { content = message, deviceId = _deviceId };
        if (_isConnected && _socket != null)
        {
            await _socket.EmitAsync("chat_message", payload);
        }
        else
        {
            _offlineQueue.Enqueue(new { type = "chat_message", data = payload });
        }
    }

    public async Task SendDiagnosticResult(DiagnosticResult result, bool silent = false)
    {
        var payload = new
        {
            checkType = result.CheckType,
            status = result.Status,
            results = result.Details,
            label = result.Label,
            value = result.Value,
            silent = silent
        };
        if (_isConnected && _socket != null)
        {
            await _socket.EmitAsync("diagnostic_result", payload);
        }
        else
        {
            _offlineQueue.Enqueue(new { type = "diagnostic_result", data = payload });
        }
    }

    public async Task SendRemediationResult(string requestId, bool success, string message)
    {
        var payload = new { requestId, success, message, deviceId = _deviceId };
        if (_isConnected && _socket != null)
        {
            await _socket.EmitAsync("remediation_result", payload);
        }
        else
        {
            _offlineQueue.Enqueue(new { type = "remediation_result", data = payload });
        }
    }

    public async Task SendSystemProfile(Dictionary<string, object> profile)
    {
        if (_isConnected && _socket != null)
        {
            await _socket.EmitAsync("system_profile", profile);
        }
        else
        {
            _offlineQueue.Enqueue(new { type = "system_profile", data = profile });
        }
    }

    public async Task SendClearContext()
    {
        if (_isConnected && _socket != null)
        {
            await _socket.EmitAsync("clear_context", new { deviceId = _deviceId });
        }
    }

    public async Task SendFileBrowseResult(string requestId, string path, bool approved, object? entries = null, string? error = null)
    {
        await EmitAsync("file_browse_result", new { requestId, path, approved, entries, error });
    }

    public async Task SendFileReadResult(string requestId, string path, bool approved, string? content = null, long sizeBytes = 0, string? error = null)
    {
        await EmitAsync("file_read_result", new { requestId, path, approved, content, sizeBytes, error });
    }

    public async Task SendScriptResult(string requestId, string? scriptName, bool success, string output = "", string errorOutput = "", int exitCode = -1, long durationMs = 0, bool truncated = false, bool timedOut = false, string? validationError = null)
    {
        await EmitAsync("script_result", new { requestId, scriptName, success, output, errorOutput, exitCode, durationMs, truncated, timedOut, validationError });
    }

    public async Task SendTerminalStarted(string requestId)
    {
        await EmitAsync("terminal_started", new { requestId });
    }

    public async Task SendTerminalOutput(string output)
    {
        await EmitAsync("terminal_output", new { output });
    }

    public async Task SendTerminalStopped(string requestId, int exitCode, string reason)
    {
        await EmitAsync("terminal_stopped", new { requestId, exitCode, reason });
    }

    public async Task SendTerminalDenied(string requestId)
    {
        await EmitAsync("terminal_denied", new { requestId });
    }

    public async Task SendDesktopFrame(string base64, int width, int height)
    {
        await EmitAsync("desktop_frame", new { frame = base64, width, height, timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
    }

    public async Task SendDesktopStarted(string requestId)
    {
        await EmitAsync("desktop_started", new { requestId });
    }

    public async Task SendDesktopStopped(string requestId, string reason)
    {
        await EmitAsync("desktop_stopped", new { requestId, reason });
    }

    public async Task SendDesktopDenied(string requestId)
    {
        await EmitAsync("desktop_denied", new { requestId });
    }

    public async Task SendSystemToolResult(string requestId, string tool, bool success, object? data, string? error)
    {
        await EmitAsync("system_tool_result", new { requestId, tool, success, data, error });
    }

    public async Task SendFileDeleteResult(string requestId, bool success, object results)
    {
        await EmitAsync("file_delete_result", new { requestId, success, results });
    }

    public async Task SendFilePropertiesResult(string requestId, bool success, object? properties, string? error)
    {
        await EmitAsync("file_properties_result", new { requestId, success, properties, error });
    }

    public async Task SendFilePasteResult(string requestId, bool success, object results, string? error)
    {
        await EmitAsync("file_paste_result", new { requestId, success, results, error });
    }

    public async Task SendFileDownloadResult(string requestId, bool success, string? path, string? filename, string? data, string? mimeType, long size, string? error)
    {
        await EmitAsync("file_download_result", new { requestId, success, path, filename, data, mimeType, size, error });
    }

    public async Task SendFileUploadResult(string requestId, bool success, string? path, string? error)
    {
        await EmitAsync("file_upload_result", new { requestId, success, path, error });
    }

    public async Task SendInstallerResult(string requestId, bool success, string output = "", string errorOutput = "", int exitCode = -1, long durationMs = 0, bool timedOut = false, string? validationError = null)
    {
        await EmitAsync("installer_result", new { requestId, success, output, errorOutput, exitCode, durationMs, timedOut, validationError });
    }

    public async Task SendScreenshotResult(string requestId, bool approved, string? imageData = null, int width = 0, int height = 0)
    {
        if (_socket == null) return;
        await _socket.EmitAsync("screenshot_result", new
        {
            requestId,
            approved,
            imageData,
            width,
            height
        });
    }

    private async Task EmitAsync(string eventName, object data)
    {
        if (_isConnected && _socket != null)
        {
            await _socket.EmitAsync(eventName, data);
        }
        else
        {
            _offlineQueue.Enqueue(new { type = eventName, data });
        }
    }

    private async Task SendHeartbeat()
    {
        if (_isConnected && _socket != null)
        {
            await _socket.EmitAsync("heartbeat", new { deviceId = _deviceId, timestamp = DateTime.UtcNow });
        }
    }

    private async Task FlushOfflineQueue()
    {
        if (_socket == null) return;
        while (_offlineQueue.TryDequeue(out var item))
        {
            var json = JsonSerializer.Serialize(item);
            var element = JsonSerializer.Deserialize<JsonElement>(json);
            var type = element.GetProperty("type").GetString();
            var data = element.GetProperty("data");
            if (type != null)
            {
                await _socket.EmitAsync(type, JsonSerializer.Deserialize<object>(data.GetRawText())!);
            }
        }
    }

    public void Dispose()
    {
        _heartbeatTimer.Dispose();
        _socket?.DisconnectAsync().Wait();
        _socket?.Dispose();
    }

    public async Task ReconnectWithNewUrl(string newUrl)
    {
        Logger.Info($"Reconnecting with new server URL: {newUrl}");
        _serverUrl = newUrl;

        // Disconnect existing socket
        if (_socket != null)
        {
            try { await _socket.DisconnectAsync(); } catch { }
            _socket.Dispose();
            _socket = null;
        }
        _isConnected = false;
        _heartbeatTimer.Stop();

        // Reconnect with new URL
        await ConnectAsync();
    }
}
