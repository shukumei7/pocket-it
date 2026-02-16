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
    private readonly string _serverUrl;
    private readonly string _deviceId;
    private string _deviceSecret;
    private readonly System.Timers.Timer _heartbeatTimer;
    private readonly ConcurrentQueue<object> _offlineQueue = new();
    private bool _isConnected;
    public bool IsConnected => _isConnected;

    public event Action<string>? OnChatResponse;
    public event Action<string, string>? OnDiagnosticRequest; // checkType, requestId
    public event Action<string, string, string?, bool>? OnRemediationRequest; // actionId, requestId, parameter, autoApprove
    public event Action<bool>? OnConnectionChanged;
    public event Action<string>? OnChatHistory;
    public event Action? OnConnectedReady;
    public event Action<string, string>? OnFileBrowseRequest; // requestId, path
    public event Action<string, string>? OnFileReadRequest; // requestId, path
    public event Action<string, string, string, bool, int>? OnScriptRequest; // requestId, scriptName, scriptContent, requiresElevation, timeoutSeconds
    public event Action<string>? OnTerminalStartRequest;  // requestId
    public event Action<string>? OnTerminalInput;          // input text
    public event Action<string>? OnTerminalStopRequest;    // requestId

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
                new("deviceSecret", _deviceSecret)
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
            OnDiagnosticRequest?.Invoke(checkType, requestId);
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
            Logger.Info($"File browse request: {path} (requestId: {requestId})");
            OnFileBrowseRequest?.Invoke(requestId, path);
        });

        _socket.On("file_read_request", response =>
        {
            var json = response.GetValue<JsonElement>();
            var requestId = json.GetProperty("requestId").GetString() ?? "";
            var path = json.GetProperty("path").GetString() ?? "";
            Logger.Info($"File read request: {path} (requestId: {requestId})");
            OnFileReadRequest?.Invoke(requestId, path);
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
            Logger.Info($"Script request: {scriptName} (requestId: {requestId}, elevation: {requiresElevation})");
            OnScriptRequest?.Invoke(requestId, scriptName, scriptContent, requiresElevation, timeoutSeconds);
        });

        _socket.On("terminal_start_request", response =>
        {
            var json = response.GetValue<JsonElement>();
            var requestId = json.GetProperty("requestId").GetString() ?? "";
            Logger.Info($"Terminal start request (requestId: {requestId})");
            OnTerminalStartRequest?.Invoke(requestId);
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

    public async Task SendDiagnosticResult(DiagnosticResult result)
    {
        var payload = new
        {
            checkType = result.CheckType,
            status = result.Status,
            results = result.Details,
            label = result.Label,
            value = result.Value
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
}
