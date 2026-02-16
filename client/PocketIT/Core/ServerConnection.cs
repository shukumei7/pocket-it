using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
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
    public event Action<string>? OnDiagnosticRequest;
    public event Action<string, string>? OnRemediationRequest;
    public event Action<bool>? OnConnectionChanged;
    public event Action<string>? OnChatHistory;
    public event Action? OnConnectedReady;

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
            OnDiagnosticRequest?.Invoke(checkType);
        });

        _socket.On("remediation_request", response =>
        {
            var data = response.GetValue<JsonElement>();
            var actionId = data.GetProperty("actionId").GetString() ?? "";
            var requestId = data.GetProperty("requestId").GetString() ?? "";
            OnRemediationRequest?.Invoke(actionId, requestId);
        });

        _socket.On("chat_history", response =>
        {
            var data = response.GetValue<JsonElement>();
            OnChatHistory?.Invoke(data.GetRawText());
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

    public async Task SendDiagnosticResult(object result)
    {
        if (_isConnected && _socket != null)
        {
            await _socket.EmitAsync("diagnostic_result", result);
        }
        else
        {
            _offlineQueue.Enqueue(new { type = "diagnostic_result", data = result });
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
