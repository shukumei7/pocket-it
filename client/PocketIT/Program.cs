using System;
using System.Threading;
using System.Windows.Forms;

namespace PocketIT;

static class Program
{
    [STAThread]
    static void Main()
    {
        using var mutex = new Mutex(true, "PocketIT_SingleInstance", out bool createdNew);
        if (!createdNew)
        {
            MessageBox.Show("Pocket IT is already running.", "Pocket IT", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        string? enrollToken = null;
        var args = Environment.GetCommandLineArgs();
        for (int i = 1; i < args.Length - 1; i++)
        {
            if (args[i] == "--enroll-token")
            {
                enrollToken = args[i + 1];
                break;
            }
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new TrayApplication(enrollToken));
    }
}
