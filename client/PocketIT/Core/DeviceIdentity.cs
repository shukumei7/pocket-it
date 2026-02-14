using System;
using Microsoft.Win32;

namespace PocketIT.Core;

public static class DeviceIdentity
{
    public static string GetMachineId()
    {
        using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography");
        return key?.GetValue("MachineGuid")?.ToString() ?? Guid.NewGuid().ToString();
    }

    public static string GetHostname() => Environment.MachineName;
    public static string GetOsVersion() => Environment.OSVersion.ToString();
}
