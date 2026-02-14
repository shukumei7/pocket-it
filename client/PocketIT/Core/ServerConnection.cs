using System;
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
    private readonly System.Timers.Timer _heartbeatTimer;
    private readonly List<object> _offlineQueue = new();
    private bool _isConnected;

    public event Action<string>? OnChatResponse;
    public event Action<string>? OnDiagnosticRequest;
    public event Action<string, string>? OnRemediationRequest;
    public event Action<bool>? OnConnectionChanged;

    public ServerConnection(string serverUrl, string deviceId)
    {
        _serverUrl = serverUrl;
        _deviceId = deviceId;
        _heartbeatTimer = new System.Timers.Timer(30000);
        _heartbeatTimer.Elapsed += async (_, _) => await SendHeartbeat();
    }

    public async Task ConnectAsync()
    {
        _socket = new SocketIOClient.SocketIO($"{_serverUrl}/agent", new SocketIOOptions
        {
            Query = new List<KeyValuePair<string, string>>
            {
                new("deviceId", _deviceId),
                new("hostname", DeviceIdentity.GetHostname())
            },
            Reconnection = true,
            ReconnectionAttempts = int.MaxValue,
            ReconnectionDelay = 5000
        });

        _socket.OnConnected += async (_, _) =>
        {
            _isConnected = true;
            _heartbeatTimer.Start();
            OnConnectionChanged?.Invoke(true);
            await FlushOfflineQueue();
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

        await _socket.ConnectAsync();
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
            _offlineQueue.Add(new { type = "chat_message", data = payload });
        }
    }

    public async Task SendDiagnosticResult(object result)
    {
        if (_isConnected && _socket != null)
        {
            await _socket.EmitAsync("diagnostic_result", result);
        }
    }

    public async Task SendRemediationResult(string requestId, bool success, string message)
    {
        var payload = new { requestId, success, message, deviceId = _deviceId };
        if (_isConnected && _socket != null)
        {
            await _socket.EmitAsync("remediation_result", payload);
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
        var queue = _offlineQueue.ToList();
        _offlineQueue.Clear();
        foreach (var item in queue)
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
