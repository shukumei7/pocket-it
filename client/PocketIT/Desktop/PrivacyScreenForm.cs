using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace PocketIT.Desktop;

public class PrivacyScreenForm : Form
{
    [DllImport("user32.dll")]
    private static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint dwAffinity);
    private const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011; // Windows 10 2004+

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags);
    private static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    private const uint SWP_NOMOVE = 0x0002;
    private const uint SWP_NOSIZE = 0x0001;
    private const uint SWP_NOACTIVATE = 0x0010;

    private System.Windows.Forms.Timer? _topmostTimer;

    public PrivacyScreenForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        BackColor = Color.Black;
        TopMost = true;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;

        // Cover all monitors using virtual screen bounds
        var vBounds = SystemInformation.VirtualScreen;
        SetBounds(vBounds.X, vBounds.Y, vBounds.Width, vBounds.Height);

        // Centered label
        var label = new Label
        {
            Text = "Remote support in progress",
            ForeColor = Color.FromArgb(120, 120, 120),
            Font = new Font("Segoe UI", 24, FontStyle.Regular),
            AutoSize = true
        };
        Controls.Add(label);
        label.Location = new Point(
            (vBounds.Width - label.PreferredWidth) / 2,
            (vBounds.Height - label.PreferredHeight) / 2
        );

        // Prevent closing via Alt+F4
        KeyPreview = true;
        KeyDown += (s, e) =>
        {
            if (e.Alt && e.KeyCode == Keys.F4)
                e.Handled = true;
        };
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // Exclude this window from screen captures (GDI BitBlt, CopyFromScreen).
        // Local display shows the black overlay normally (local user can't see the screen),
        // but screen capture APIs see through it to the real desktop (IT operator can work).
        SetWindowDisplayAffinity(Handle, WDA_EXCLUDEFROMCAPTURE);

        // Re-assert HWND_TOPMOST every 500ms — fullscreen apps and remote desktop viewers
        // can briefly pop over a WinForms TopMost window; periodic re-assertion prevents it.
        _topmostTimer = new System.Windows.Forms.Timer { Interval = 500 };
        _topmostTimer.Tick += (s, ev) =>
        {
            if (IsHandleCreated && !IsDisposed)
                SetWindowPos(Handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        };
        _topmostTimer.Start();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        _topmostTimer?.Stop();
        _topmostTimer?.Dispose();
        _topmostTimer = null;
        base.OnFormClosing(e);
    }

    // Override to prevent closing via window messages
    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE — don't steal focus from IT session
            return cp;
        }
    }
}
