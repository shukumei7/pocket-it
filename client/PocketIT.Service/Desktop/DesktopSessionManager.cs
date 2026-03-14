using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using PocketIT.Core;

namespace PocketIT.Service.Desktop;

// IT authority: service-level access bypasses user privacy mode.
// DesktopSessionManager spawns PocketIT.SessionHelper.exe into the active user session
// using WTSQueryUserToken + CreateProcessAsUser so the service (SYSTEM) can drive
// the desktop without the tray app being running.

public class DesktopSessionManager : IDisposable
{
    // ── Win32 P/Invoke ─────────────────────────────────────────────────────────

    [DllImport("kernel32.dll")]
    private static extern uint WTSGetActiveConsoleSessionId();

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSQueryUserToken(uint sessionId, out IntPtr phToken);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessAsUser(
        IntPtr hToken,
        string? lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string? lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);

    [DllImport("userenv.dll", SetLastError = true)]
    private static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize;
        public uint dwXCountChars, dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;

    // ── State ──────────────────────────────────────────────────────────────────

    private readonly ILogger _logger;
    private readonly ServerConnection _serverConnection;
    private readonly LocalDatabase _localDb;

    private string? _activeRequestId;
    private IntPtr _helperProcess = IntPtr.Zero;
    private NamedPipeServerStream? _desktopPipe;
    private StreamWriter? _pipeWriter;
    private StreamReader? _pipeReader;
    private CancellationTokenSource? _pipeCts;
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private bool _disposed;

    public bool IsActive => _activeRequestId != null;

    public DesktopSessionManager(ILogger logger, ServerConnection serverConnection, LocalDatabase localDb)
    {
        _logger = logger;
        _serverConnection = serverConnection;
        _localDb = localDb;
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    public void StartSession(string requestId, bool forceOverride = false)
    {
        // Check privacy mode — only bypass if IT explicitly forced the session
        // IT authority: forceOverride=true bypasses privacy mode by design (admin role required on server)
        if (!forceOverride)
        {
            var privacyMode = _localDb.GetSetting("privacy_mode");
            if (privacyMode == "true")
            {
                _logger.LogInformation("Desktop denied: privacy mode is enabled and session was not force-initiated");
                _ = _serverConnection.SendDesktopDenied(requestId);
                return;
            }
        }

        if (IsActive)
        {
            _logger.LogWarning("Desktop session already active, ignoring start request {RequestId}", requestId);
            return;
        }

        _activeRequestId = requestId;

        try
        {
            uint sessionId = WTSGetActiveConsoleSessionId();
            if (sessionId == 0xFFFFFFFF)
                throw new InvalidOperationException("No active console session (WTSGetActiveConsoleSessionId returned 0xFFFFFFFF)");

            string pipeName = $"PocketIT-Desktop-{sessionId}";

            // Start the named pipe server before spawning the helper so the helper can connect
            StartPipeServer(pipeName);

            // Spawn helper into user session
            SpawnHelper(sessionId, pipeName);

            _logger.LogInformation("Desktop session started: requestId={RequestId}, session={SessionId}, pipe={PipeName}",
                requestId, sessionId, pipeName);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to start desktop session");
            _ = _serverConnection.SendDesktopStopped(requestId, "error: " + ex.Message);
            CleanupSession();
        }
    }

    public void StopSession(string requestId)
    {
        if (!IsActive)
        {
            _logger.LogWarning("No active desktop session to stop");
            return;
        }

        SendToHelper("stop");
        CleanupSession();
        _ = _serverConnection.SendDesktopStopped(requestId, "stopped");
    }

    public void SendMouseInput(double x, double y, string button, string action)
    {
        if (!IsActive) return;
        SendToHelper("mouse", new { x, y, button, action });
    }

    public void SendKeyboardInput(ushort vkCode, string action)
    {
        if (!IsActive) return;
        SendToHelper("keyboard", new { vkCode, action });
    }

    public void SendQualityUpdate(int quality, int fps, float scale)
    {
        if (!IsActive) return;
        SendToHelper("quality", new { quality, fps, scale });
    }

    public void SendSwitchMonitor(int monitorIndex)
    {
        if (!IsActive) return;
        SendToHelper("monitor", new { index = monitorIndex });
    }

    public void SendPasteText(string text)
    {
        if (!IsActive) return;
        SendToHelper("paste", new { text });
    }

    public void SendCtrlAltDel()
    {
        if (!IsActive) return;
        SendToHelper("ctrl_alt_del");
    }

    public void SendToggle(string name, bool enabled)
    {
        if (!IsActive) return;
        SendToHelper("toggle", new { name, enabled });
    }

    // ── Pipe server ────────────────────────────────────────────────────────────

    private void StartPipeServer(string pipeName)
    {
        _pipeCts = new CancellationTokenSource();

        // Use PipeSecurity to allow the user session process to connect
        _desktopPipe = new NamedPipeServerStream(
            pipeName,
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous);

        _ = PipeAcceptLoopAsync(pipeName, _pipeCts.Token);
    }

    private async Task PipeAcceptLoopAsync(string pipeName, CancellationToken ct)
    {
        try
        {
            if (_desktopPipe == null) return;

            _logger.LogInformation("Desktop pipe server waiting for helper on '{PipeName}'", pipeName);
            await _desktopPipe.WaitForConnectionAsync(ct);
            _logger.LogInformation("Session helper connected on '{PipeName}'", pipeName);

            _pipeWriter = new StreamWriter(_desktopPipe, Encoding.UTF8) { AutoFlush = false };
            _pipeReader = new StreamReader(_desktopPipe, Encoding.UTF8);

            // Send desktop_started once the helper signals "ready"
            await ReadHelperMessagesAsync(ct);
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Desktop pipe server error");
        }
        finally
        {
            // Helper disconnected or was stopped — end the session
            var rid = _activeRequestId;
            if (rid != null)
            {
                CleanupSession();
                _ = _serverConnection.SendDesktopStopped(rid, "helper_disconnected");
            }
        }
    }

    private async Task ReadHelperMessagesAsync(CancellationToken ct)
    {
        if (_pipeReader == null || _desktopPipe == null) return;

        while (!ct.IsCancellationRequested && _desktopPipe.IsConnected)
        {
            string? line;
            try
            {
                line = await _pipeReader.ReadLineAsync(ct);
            }
            catch (OperationCanceledException) { break; }
            catch { break; }

            if (line == null) break;

            try
            {
                var doc = JsonSerializer.Deserialize<JsonElement>(line);
                string type = doc.GetProperty("type").GetString() ?? "";

                switch (type)
                {
                    case "ready":
                        if (_activeRequestId != null)
                            _ = _serverConnection.SendDesktopStarted(_activeRequestId);
                        break;

                    case "frame":
                        if (doc.TryGetProperty("payload", out var fp))
                        {
                            string data = fp.GetProperty("data").GetString() ?? "";
                            int w = fp.GetProperty("width").GetInt32();
                            int h = fp.GetProperty("height").GetInt32();
                            _ = _serverConnection.SendDesktopFrame(data, w, h);
                        }
                        break;
                }
            }
            catch (JsonException ex)
            {
                _logger.LogWarning("Desktop pipe: invalid JSON from helper: {Error}", ex.Message);
            }
        }
    }

    // ── Sending to helper ──────────────────────────────────────────────────────

    private void SendToHelper(string type, object? payload = null)
    {
        _ = SendToHelperAsync(type, payload);
    }

    private async Task SendToHelperAsync(string type, object? payload)
    {
        if (_pipeWriter == null) return;
        await _writeLock.WaitAsync();
        try
        {
            string json = payload != null
                ? JsonSerializer.Serialize(new { type, payload })
                : JsonSerializer.Serialize(new { type });
            await _pipeWriter.WriteLineAsync(json);
            await _pipeWriter.FlushAsync();
        }
        catch (Exception ex)
        {
            _logger.LogWarning("Desktop pipe send failed: {Error}", ex.Message);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    // ── Process spawning ───────────────────────────────────────────────────────

    private void SpawnHelper(uint sessionId, string pipeName)
    {
        // Resolve helper path relative to service executable directory
        string serviceDir = AppContext.BaseDirectory;
        string helperExe = Path.Combine(serviceDir, "PocketIT.SessionHelper.exe");

        if (!File.Exists(helperExe))
            throw new FileNotFoundException($"Session helper not found at: {helperExe}");

        if (!WTSQueryUserToken(sessionId, out IntPtr userToken))
        {
            int err = Marshal.GetLastWin32Error();
            throw new InvalidOperationException($"WTSQueryUserToken failed (win32 error {err}). Service must run as SYSTEM.");
        }

        IntPtr envBlock = IntPtr.Zero;
        try
        {
            if (!CreateEnvironmentBlock(out envBlock, userToken, false))
                envBlock = IntPtr.Zero;

            var si = new STARTUPINFO
            {
                cb = Marshal.SizeOf<STARTUPINFO>(),
                lpDesktop = "winsta0\\default"
            };

            string cmdLine = $"\"{helperExe}\" {pipeName}";

            uint flags = CREATE_NO_WINDOW | (envBlock != IntPtr.Zero ? CREATE_UNICODE_ENVIRONMENT : 0);

            if (!CreateProcessAsUser(
                    userToken,
                    null,
                    cmdLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    false,
                    flags,
                    envBlock,
                    null,
                    ref si,
                    out var pi))
            {
                int err = Marshal.GetLastWin32Error();
                throw new InvalidOperationException($"CreateProcessAsUser failed (win32 error {err})");
            }

            _helperProcess = pi.hProcess;
            CloseHandle(pi.hThread);

            _logger.LogInformation("Session helper spawned: PID={Pid}", pi.dwProcessId);
        }
        finally
        {
            CloseHandle(userToken);
            if (envBlock != IntPtr.Zero)
                DestroyEnvironmentBlock(envBlock);
        }
    }

    // ── Cleanup ────────────────────────────────────────────────────────────────

    private void CleanupSession()
    {
        _activeRequestId = null;
        _pipeCts?.Cancel();
        _pipeCts = null;

        // Kill helper process if still running
        if (_helperProcess != IntPtr.Zero)
        {
            try { TerminateProcess(_helperProcess, 0); } catch { }
            CloseHandle(_helperProcess);
            _helperProcess = IntPtr.Zero;
        }

        _pipeWriter?.Dispose();
        _pipeWriter = null;
        _pipeReader?.Dispose();
        _pipeReader = null;
        _desktopPipe?.Dispose();
        _desktopPipe = null;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;

        var rid = _activeRequestId;
        if (rid != null)
        {
            SendToHelper("stop");
            CleanupSession();
        }
    }
}
