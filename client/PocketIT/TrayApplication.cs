using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace PocketIT;

public class TrayApplication : ApplicationContext
{
    private readonly NotifyIcon _trayIcon;
    private ChatWindow? _chatWindow;

    public TrayApplication()
    {
        var contextMenu = new ContextMenuStrip();
        contextMenu.Items.Add("Open Chat", null, OnOpenChat);
        contextMenu.Items.Add(new ToolStripSeparator());
        contextMenu.Items.Add("Run Diagnostics", null, OnRunDiagnostics);
        contextMenu.Items.Add(new ToolStripSeparator());
        contextMenu.Items.Add("About", null, OnAbout);
        contextMenu.Items.Add("Exit", null, OnExit);

        _trayIcon = new NotifyIcon
        {
            Icon = LoadTrayIcon(),
            Text = "Pocket IT",
            Visible = true,
            ContextMenuStrip = contextMenu
        };
        _trayIcon.DoubleClick += OnOpenChat;
    }

    private Icon LoadTrayIcon()
    {
        var iconPath = Path.Combine(AppContext.BaseDirectory, "Resources", "tray-icon.ico");
        return File.Exists(iconPath) ? new Icon(iconPath) : SystemIcons.Application;
    }

    private void ShowChatWindow()
    {
        if (_chatWindow == null || _chatWindow.IsDisposed)
        {
            _chatWindow = new ChatWindow();
        }

        if (!_chatWindow.Visible)
        {
            // Position bottom-right of primary screen
            var screen = Screen.PrimaryScreen!.WorkingArea;
            _chatWindow.StartPosition = FormStartPosition.Manual;
            _chatWindow.Location = new Point(
                screen.Right - _chatWindow.Width - 20,
                screen.Bottom - _chatWindow.Height - 20
            );
        }

        _chatWindow.Show();
        _chatWindow.BringToFront();
    }

    private void OnOpenChat(object? sender, EventArgs e) => ShowChatWindow();

    private void OnRunDiagnostics(object? sender, EventArgs e)
    {
        ShowChatWindow();
        // TODO: Trigger diagnostics via chat
    }

    private void OnAbout(object? sender, EventArgs e)
    {
        MessageBox.Show("Pocket IT v0.1.0\nAI-Powered IT Helpdesk", "About Pocket IT",
            MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private void OnExit(object? sender, EventArgs e)
    {
        _trayIcon.Visible = false;
        _chatWindow?.Close();
        Application.Exit();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _trayIcon.Dispose();
            _chatWindow?.Dispose();
        }
        base.Dispose(disposing);
    }
}
