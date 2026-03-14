using System;
using System.IO;

namespace PocketIT.Core;

public static class Logger
{
    private static readonly object _lock = new();
    private static string _logDir = "";
    private static readonly long _maxFileSize = 5 * 1024 * 1024; // 5 MB
    private static readonly int _maxFiles = 3;

    public static void Initialize(string? logDir = null)
    {
        _logDir = logDir ?? Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "PocketIT", "logs");
        Directory.CreateDirectory(_logDir);
    }

    public static void Info(string message) => Write("INFO", message);
    public static void Warn(string message) => Write("WARN", message);

    public static void Error(string message, Exception? ex = null) =>
        Write("ERROR", ex != null ? $"{message}: {ex.Message}" : message);

    private static void Write(string level, string message)
    {
        if (string.IsNullOrEmpty(_logDir)) return;
        lock (_lock)
        {
            try
            {
                var logFile = Path.Combine(_logDir, "pocket-it.log");
                RotateIfNeeded(logFile);
                var line = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] [{level}] {message}\n";
                File.AppendAllText(logFile, line);
            }
            catch
            {
                // Last resort: don't crash the app for logging
            }
        }
    }

    private static void RotateIfNeeded(string logFile)
    {
        if (!File.Exists(logFile)) return;
        if (new FileInfo(logFile).Length < _maxFileSize) return;

        for (int i = _maxFiles - 1; i >= 1; i--)
        {
            var src = Path.Combine(_logDir, $"pocket-it.{i}.log");
            var dst = Path.Combine(_logDir, $"pocket-it.{i + 1}.log");
            if (File.Exists(dst)) File.Delete(dst);
            if (File.Exists(src)) File.Move(src, dst);
        }
        File.Move(logFile, Path.Combine(_logDir, "pocket-it.1.log"));
    }
}
