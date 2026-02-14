using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Web.WebView2.Core;

namespace PocketIT;

public class ChatWindow : Form
{
    private readonly WebView2 _webView;

    public ChatWindow()
    {
        Text = "Pocket IT";
        Width = 420;
        Height = 600;
        MaximizeBox = false;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        ShowInTaskbar = false;

        _webView = new WebView2
        {
            Dock = DockStyle.Fill
        };
        Controls.Add(_webView);

        Load += async (_, _) => await InitializeWebView();
    }

    private async Task InitializeWebView()
    {
        var env = await CoreWebView2Environment.CreateAsync(
            userDataFolder: Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "PocketIT", "WebView2"
            )
        );
        await _webView.EnsureCoreWebView2Async(env);

        // Set up JS → C# bridge
        _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;

        // Navigate to embedded UI
        var uiPath = Path.Combine(AppContext.BaseDirectory, "WebUI", "index.html");
        if (File.Exists(uiPath))
        {
            _webView.CoreWebView2.Navigate($"file:///{uiPath.Replace('\\', '/')}");
        }
        else
        {
            _webView.CoreWebView2.NavigateToString("<html><body><h2>Pocket IT</h2><p>Chat UI loading...</p></body></html>");
        }
    }

    public event Action<string, string>? OnBridgeMessage; // type, json data

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        var json = e.WebMessageAsJson;
        try
        {
            using var doc = JsonDocument.Parse(json.Trim('"').Replace("\\\"", "\"").Replace("\\\\", "\\"));
            var type = doc.RootElement.GetProperty("type").GetString() ?? "";
            OnBridgeMessage?.Invoke(type, json);
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"Bridge message parse error: {ex.Message}");
        }
    }

    // Send message from C# to JS
    public void SendToWebView(string jsonMessage)
    {
        if (_webView.CoreWebView2 != null)
        {
            BeginInvoke(() => _webView.CoreWebView2.PostWebMessageAsString(jsonMessage));
        }
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            Hide();
            return;
        }
        base.OnFormClosing(e);
    }
}
