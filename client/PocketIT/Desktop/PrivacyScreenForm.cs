using System;
using System.Drawing;
using System.Windows.Forms;

namespace PocketIT.Desktop;

public class PrivacyScreenForm : Form
{
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
