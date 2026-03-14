using System.Timers;
using PocketIT.Core;

namespace PocketIT.Diagnostics;

public class ScheduledCheckService : IDisposable
{
    private readonly DiagnosticsEngine _engine;
    private readonly ServerConnection _connection;
    private readonly System.Timers.Timer _timer;
    private bool _isRunning;

    public ScheduledCheckService(DiagnosticsEngine engine, ServerConnection connection, int intervalMinutes = 15)
    {
        _engine = engine;
        _connection = connection;
        _timer = new System.Timers.Timer(intervalMinutes * 60 * 1000);
        _timer.Elapsed += async (_, _) => await RunScheduledChecksAsync();
        _timer.AutoReset = true;
    }

    public void Start()
    {
        if (_isRunning) return;
        _isRunning = true;
        _timer.Start();
        Logger.Info($"Scheduled diagnostics started (interval: {_timer.Interval / 60000}min)");
    }

    public void Stop()
    {
        _isRunning = false;
        _timer.Stop();
        Logger.Info("Scheduled diagnostics stopped");
    }

    public async Task RunNowAsync()
    {
        await RunScheduledChecksAsync();
    }

    private async Task RunScheduledChecksAsync()
    {
        if (!_connection.IsConnected)
        {
            Logger.Info("Scheduled diagnostics skipped: not connected");
            return;
        }

        try
        {
            Logger.Info("Scheduled diagnostics: starting run");
            var results = await _engine.RunAllAsync();
            foreach (var result in results)
            {
                await _connection.SendDiagnosticResult(result, silent: true);
            }
            Logger.Info($"Scheduled diagnostics: {results.Count} checks completed");
        }
        catch (Exception ex)
        {
            Logger.Error("Scheduled diagnostics failed", ex);
        }
    }

    public void Dispose()
    {
        Stop();
        _timer.Dispose();
    }
}
