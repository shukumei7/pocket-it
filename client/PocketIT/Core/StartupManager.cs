using Microsoft.Win32;
using System;

namespace PocketIT.Core
{
    public static class StartupManager
    {
        private const string RegistryKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string AppName = "PocketIT";

        public static bool IsRegistered()
        {
            using var key = Registry.CurrentUser.OpenSubKey(RegistryKeyPath, false);
            return key?.GetValue(AppName) != null;
        }

        public static void Register()
        {
            try
            {
                var exePath = Environment.ProcessPath ?? System.Reflection.Assembly.GetExecutingAssembly().Location;
                using var key = Registry.CurrentUser.OpenSubKey(RegistryKeyPath, true);
                key?.SetValue(AppName, $"\"{exePath}\"");
                Logger.Info($"Registered for Windows startup: {exePath}");
            }
            catch (Exception ex)
            {
                Logger.Error("Failed to register for Windows startup", ex);
            }
        }

        public static void Unregister()
        {
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(RegistryKeyPath, true);
                if (key?.GetValue(AppName) != null)
                {
                    key.DeleteValue(AppName);
                    Logger.Info("Unregistered from Windows startup");
                }
            }
            catch (Exception ex)
            {
                Logger.Error("Failed to unregister from Windows startup", ex);
            }
        }

        public static void Toggle()
        {
            if (IsRegistered())
                Unregister();
            else
                Register();
        }
    }
}
