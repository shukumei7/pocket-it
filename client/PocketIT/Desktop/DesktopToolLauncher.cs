using System;
using System.Diagnostics;

namespace PocketIT.Desktop;

public static class DesktopToolLauncher
{
    public static (bool success, string error) Launch(string tool)
    {
        try
        {
            var (fileName, arguments, elevated) = tool.ToLowerInvariant() switch
            {
                "cmd" => ("cmd.exe", "", true),
                "powershell" => ("powershell.exe", "", true),
                "control" => ("control.exe", "", false),
                "eventvwr" => ("mmc.exe", "eventvwr.msc", false),
                "compmgmt" => ("mmc.exe", "compmgmt.msc", false),
                "regedit" => ("regedit.exe", "", true),
                "services" => ("mmc.exe", "services.msc", false),
                "taskmgr" => ("taskmgr.exe", "", false),
                _ => throw new ArgumentException($"Unknown tool: {tool}")
            };

            var psi = new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = arguments,
                UseShellExecute = true
            };

            // Only set runas if we need elevation AND we're not already elevated
            if (elevated && !IsElevated())
            {
                psi.Verb = "runas";
            }

            Process.Start(psi);
            return (true, "");
        }
        catch (ArgumentException ex)
        {
            return (false, ex.Message);
        }
        catch (System.ComponentModel.Win32Exception ex) when (ex.NativeErrorCode == 1223)
        {
            // User cancelled UAC prompt
            return (false, "Elevation cancelled by user");
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
    }

    private static bool IsElevated()
    {
        using var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
        var principal = new System.Security.Principal.WindowsPrincipal(identity);
        return principal.IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
    }
}
