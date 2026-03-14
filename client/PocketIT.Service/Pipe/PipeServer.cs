using Microsoft.Extensions.Logging;
using PocketIT.Pipe;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace PocketIT.Service.Pipe;

public class PipeServer
{
    public const string PipeName = "PocketIT-Agent";

    private readonly ILogger _logger;
    private NamedPipeServerStream? _pipe;
    private CancellationTokenSource? _cts;
    private StreamWriter? _writer;
    private readonly SemaphoreSlim _writeLock = new(1, 1);

    public event Action<PipeMessage>? OnTrayMessage;

    public PipeServer(ILogger logger) => _logger = logger;

    public void Start()
    {
        _cts = new CancellationTokenSource();
        _ = ListenLoopAsync(_cts.Token);
    }

    public void Stop() => _cts?.Cancel();

    public void Send(PipeMessage msg)
    {
        _ = SendAsync(msg);
    }

    private async Task SendAsync(PipeMessage msg)
    {
        if (_writer == null) return;
        await _writeLock.WaitAsync();
        try
        {
            var json = JsonSerializer.Serialize(msg);
            await _writer.WriteLineAsync(json);
            await _writer.FlushAsync();
        }
        catch (Exception ex)
        {
            _logger.LogWarning("Pipe send failed: {Error}", ex.Message);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    private async Task ListenLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                _pipe = new NamedPipeServerStream(
                    PipeName,
                    PipeDirection.InOut,
                    1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous);

                _logger.LogInformation("Pipe server waiting for tray connection");
                await _pipe.WaitForConnectionAsync(ct);
                _logger.LogInformation("Tray app connected to pipe");

                _writer = new StreamWriter(_pipe, Encoding.UTF8) { AutoFlush = false };
                var reader = new StreamReader(_pipe, Encoding.UTF8);

                while (_pipe.IsConnected && !ct.IsCancellationRequested)
                {
                    var line = await reader.ReadLineAsync(ct);
                    if (line == null) break;
                    try
                    {
                        var msg = JsonSerializer.Deserialize<PipeMessage>(line);
                        if (msg != null) OnTrayMessage?.Invoke(msg);
                    }
                    catch (JsonException ex)
                    {
                        _logger.LogWarning("Invalid pipe message: {Error}", ex.Message);
                    }
                }

                _writer = null;
                _pipe.Dispose();
                _logger.LogInformation("Tray app disconnected from pipe");
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Pipe server error, restarting listener");
                await Task.Delay(2000, ct);
            }
        }
    }
}
