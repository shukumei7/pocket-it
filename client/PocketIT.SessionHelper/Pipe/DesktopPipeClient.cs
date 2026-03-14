using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace PocketIT.SessionHelper.Pipe;

public class DesktopPipeClient : IDisposable
{
    private readonly string _pipeName;
    private NamedPipeClientStream? _pipe;
    private StreamWriter? _writer;
    private StreamReader? _reader;
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private bool _disposed;

    public event Action<string, JsonElement>? OnMessage; // type, payload

    public DesktopPipeClient(string pipeName)
    {
        _pipeName = pipeName;
    }

    public async Task ConnectAsync(CancellationToken ct)
    {
        _pipe = new NamedPipeClientStream(".", _pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await _pipe.ConnectAsync(10000, ct); // 10s timeout
        _writer = new StreamWriter(_pipe, Encoding.UTF8) { AutoFlush = false };
        _reader = new StreamReader(_pipe, Encoding.UTF8);
    }

    public async Task SendFrameAsync(string base64, int width, int height, CancellationToken ct)
    {
        var msg = new { type = "frame", payload = new { data = base64, width, height } };
        await SendRawAsync(JsonSerializer.Serialize(msg), ct);
    }

    public async Task SendEventAsync(string type, CancellationToken ct)
    {
        var msg = new { type };
        await SendRawAsync(JsonSerializer.Serialize(msg), ct);
    }

    private async Task SendRawAsync(string json, CancellationToken ct)
    {
        if (_writer == null) return;
        await _writeLock.WaitAsync(ct);
        try
        {
            await _writer.WriteLineAsync(json.AsMemory(), ct);
            await _writer.FlushAsync(ct);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    public async Task ReadLoopAsync(CancellationToken ct)
    {
        if (_reader == null) return;
        while (!ct.IsCancellationRequested && (_pipe?.IsConnected ?? false))
        {
            var line = await _reader.ReadLineAsync(ct);
            if (line == null) break;
            try
            {
                var doc = JsonSerializer.Deserialize<JsonElement>(line);
                var type = doc.GetProperty("type").GetString() ?? "";
                OnMessage?.Invoke(type, doc);
            }
            catch (JsonException)
            {
                // malformed message — skip
            }
        }
    }

    public bool IsConnected => _pipe?.IsConnected ?? false;

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _writer?.Dispose();
        _reader?.Dispose();
        _pipe?.Dispose();
    }
}
