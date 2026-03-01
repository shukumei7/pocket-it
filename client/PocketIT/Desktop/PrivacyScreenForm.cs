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
