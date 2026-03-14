using System;
using System.IO;
using System.Security.Cryptography;

namespace PocketIT.Core;

public static class IntegrityCheck
{
    private static string? _cachedHash;

    public static string GetExeHash()
    {
        if (_cachedHash != null) return _cachedHash;

        try
        {
            var exePath = System.Diagnostics.Process.GetCurrentProcess().MainModule?.FileName;
            if (string.IsNullOrEmpty(exePath) || !File.Exists(exePath)) return "unknown";

            using var sha256 = SHA256.Create();
            using var stream = File.OpenRead(exePath);
            var hash = sha256.ComputeHash(stream);
            _cachedHash = BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
            return _cachedHash;
        }
        catch
        {
            return "unknown";
        }
    }
}
