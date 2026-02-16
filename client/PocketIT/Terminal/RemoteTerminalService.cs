using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

namespace PocketIT.Terminal;

public class RemoteTerminalService : IDisposable
{
    private const int FlushIntervalMs = 100;
    private const int DefaultIdleTimeoutMs = 15 * 60 * 1000; // 15 minutes
    private const int MaxOutputBufferBytes = 1 * 1024 * 1024; // 1 MB

    private Process? _process;
    private Timer? _flushTimer;
    private Timer? _idleTimer;
    private readonly StringBuilder _pendingOutput = new();
    private readonly StringBuilder _rollingBuffer = new();
    private readonly object _lock = new();
    private bool _isActive;
    private bool _disposed;
    private bool _stopping;

    public bool IsSessionActive => _isActive;

    public event Action<string>? OnOutput;
    public event Action<int>? OnSessionEnded;

    public void StartSession()
    {
        lock (_lock)
        {
            if (_isActive)
                throw new InvalidOperationException("A terminal session is already active.");

            var psPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.System),
                "WindowsPowerShell", "v1.0", "powershell.exe");

            var psi = new ProcessStartInfo
            {
                FileName = psPath,
                Arguments = "-NoLogo -NoProfile -NonInteractive",
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            _process = new Process { StartInfo = psi, EnableRaisingEvents = true };
            _process.OutputDataReceived += OnDataReceived;
            _process.ErrorDataReceived += OnDataReceived;
            _process.Exited += OnProcessExited;

            _process.Start();
            _process.BeginOutputReadLine();
            _process.BeginErrorReadLine();

            _stopping = false;
            _isActive = true;
            _pendingOutput.Clear();
            _rollingBuffer.Clear();

            _flushTimer = new Timer(FlushOutput, null, FlushIntervalMs, FlushIntervalMs);
            _idleTimer = new Timer(OnIdleTimeout, null, DefaultIdleTimeoutMs, Timeout.Infinite);
        }
    }

    public void SendInput(string input)
    {
        lock (_lock)
        {
            if (!_isActive || _process == null || _process.HasExited)
                return;

            // Ctrl+C break signal — no newline, just write the control char
            if (input == "\x03")
            {
                _process.StandardInput.Write(input);
                _process.StandardInput.Flush();
            }
            else
            {
                // Complete line from dashboard — ensure newline terminator
                if (!input.EndsWith('\n'))
                    input += "\n";

                _process.StandardInput.Write(input);
                _process.StandardInput.Flush();
            }

            _idleTimer?.Change(DefaultIdleTimeoutMs, Timeout.Infinite);
        }
    }

    public void StopSession()
    {
        lock (_lock)
        {
            if (!_isActive || _stopping)
                return;

            _stopping = true;
        }

        int exitCode = -1;

        // Dispose timers outside of process kill to keep things clean
        _flushTimer?.Dispose();
        _flushTimer = null;
        _idleTimer?.Dispose();
        _idleTimer = null;

        // Flush any remaining output
        FlushOutput(null);

        if (_process != null && !_process.HasExited)
        {
            try
            {
                _process.Kill(entireProcessTree: true);
            }
            catch
            {
                // Process may have already exited
            }
        }

        if (_process != null)
        {
            try { exitCode = _process.ExitCode; } catch { }
            _process.OutputDataReceived -= OnDataReceived;
            _process.ErrorDataReceived -= OnDataReceived;
            _process.Exited -= OnProcessExited;
            _process.Dispose();
            _process = null;
        }

        lock (_lock)
        {
            _isActive = false;
            _stopping = false;
        }

        OnSessionEnded?.Invoke(exitCode);
    }

    public void Dispose()
    {
        if (_disposed)
            return;

        _disposed = true;
        StopSession();
    }

    private void OnDataReceived(object sender, DataReceivedEventArgs e)
    {
        if (e.Data == null)
            return;

        lock (_lock)
        {
            _pendingOutput.AppendLine(e.Data);

            // Rolling buffer guard: track total size, discard oldest if over limit
            _rollingBuffer.AppendLine(e.Data);
            while (_rollingBuffer.Length * 2 > MaxOutputBufferBytes) // *2 for char->byte estimate
            {
                // Remove roughly the first quarter
                int removeCount = _rollingBuffer.Length / 4;
                _rollingBuffer.Remove(0, removeCount);
            }
        }
    }

    private void FlushOutput(object? state)
    {
        string? text = null;

        lock (_lock)
        {
            if (_pendingOutput.Length > 0)
            {
                text = _pendingOutput.ToString();
                _pendingOutput.Clear();
            }
        }

        if (text != null)
        {
            OnOutput?.Invoke(text);
        }
    }

    private void OnIdleTimeout(object? state)
    {
        StopSession();
    }

    private void OnProcessExited(object? sender, EventArgs e)
    {
        // Process exited naturally — clean up via StopSession which guards against double-call
        StopSession();
    }
}
