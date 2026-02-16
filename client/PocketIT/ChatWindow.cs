using System;
using System.Collections.Generic;
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
    private readonly string _initialPage;
    private readonly Queue<string> _pendingMessages = new();
    private bool _webViewReady;

    public ChatWindow(string initialPage = "chat.html")
    {
        _initialPage = initialPage;
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
        var uiPath = Path.Combine(AppContext.BaseDirectory, "WebUI", _initialPage);
        if (File.Exists(uiPath))
        {
            _webView.CoreWebView2.Navigate($"file:///{uiPath.Replace('\\', '/')}");
        }
        else
        {
            _webView.CoreWebView2.NavigateToString("<html><body><h2>Pocket IT</h2><p>Chat UI loading...</p></body></html>");
        }

        // Flush queued messages once navigation completes
        _webView.CoreWebView2.NavigationCompleted += (_, _) =>
        {
            _webViewReady = true;
            while (_pendingMessages.Count > 0)
            {
                var msg = _pendingMessages.Dequeue();
                _webView.CoreWebView2.PostWebMessageAsString(msg);
            }
        };
    }

    public event Action<string, string>? OnBridgeMessage; // type, json data

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        var json = e.TryGetWebMessageAsString();
        if (string.IsNullOrEmpty(json)) return;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var type = doc.RootElement.GetProperty("type").GetString() ?? "";
            OnBridgeMessage?.Invoke(type, json);
        }
        catch (Exception ex)
        {
            Core.Logger.Warn($"Bridge message parse error: {ex.Message}");
        }
    }

    // Send message from C# to JS
    public void SendToWebView(string jsonMessage)
    {
        if (_webViewReady && _webView.CoreWebView2 != null)
        {
            BeginInvoke(() => _webView.CoreWebView2.PostWebMessageAsString(jsonMessage));
        }
        else
        {
            _pendingMessages.Enqueue(jsonMessage);
        }
    }

    public void NavigateTo(string page)
    {
        _webViewReady = false;
        var uiPath = Path.Combine(AppContext.BaseDirectory, "WebUI", page);
        if (_webView.CoreWebView2 != null && File.Exists(uiPath))
        {
            _webView.CoreWebView2.Navigate($"file:///{uiPath.Replace('\\', '/')}");
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
