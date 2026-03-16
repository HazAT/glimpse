using System.Drawing;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var config = Config.Parse(args);
        using var host = new GlimpseHost(config);
        Application.Run(host.Form);
    }
}

sealed class GlimpseHost : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = false };

    private const int GwlExStyle = -20;
    private const int WsExTopmost = 0x8;
    private const int WsExTransparent = 0x20;
    private const int WsExLayered = 0x80000;
    private const int SwShow = 5;
    private const int SwShowNoActivate = 4;
    private const int SwpNoMove = 0x2;
    private const int SwpNoSize = 0x1;
    private const int HwndTopmost = -1;
    private const int HwndNotopmost = -2;

    private readonly Config _config;
    private readonly WebView2 _webView;
    private readonly System.Windows.Forms.Timer _cursorTimer;
    private bool _closed;
    private bool _hidden;
    private bool _initialized;
    private bool _followCursorEnabled;
    private string? _cursorAnchor;
    private int _cursorOffsetX;
    private int _cursorOffsetY;
    private string _followMode;
    private double _springPosX;
    private double _springPosY;
    private double _springVelX;
    private double _springVelY;

    public Form Form { get; }

    public GlimpseHost(Config config)
    {
        _config = config;
        _hidden = config.Hidden;
        _followCursorEnabled = config.FollowCursor;
        _cursorAnchor = config.CursorAnchor;
        _cursorOffsetX = config.CursorOffsetX;
        _cursorOffsetY = config.CursorOffsetY;
        _followMode = config.FollowMode;

        Form = new Form
        {
            Text = config.Title,
            StartPosition = FormStartPosition.Manual,
            ClientSize = new Size(config.Width, config.Height),
            TopMost = config.Floating || config.FollowCursor,
            ShowInTaskbar = false
        };

        if (config.Frameless || config.Transparent)
        {
            Form.FormBorderStyle = FormBorderStyle.None;
        }

        if (config.Transparent)
        {
            Form.AllowTransparency = true;
            Form.BackColor = Color.Magenta;
            Form.TransparencyKey = Color.Magenta;
        }

        if (config.X is not null && config.Y is not null)
        {
            Form.Location = new Point(config.X.Value, config.Y.Value);
        }
        else
        {
            Form.StartPosition = FormStartPosition.CenterScreen;
        }

        _webView = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = config.Transparent ? Color.Transparent : Color.White
        };

        Form.Controls.Add(_webView);
        Form.Load += async (_, _) => await InitializeAsync();
        Form.Shown += (_, _) =>
        {
            if (_hidden)
            {
                Form.Hide();
                return;
            }

            if (!_config.ClickThrough)
            {
                ActivateVisibleWindow();
            }
        };
        Form.FormClosing += (_, _) => CloseOnce();
        Form.HandleCreated += (_, _) => ApplyExtendedStyles();

        _cursorTimer = new System.Windows.Forms.Timer { Interval = 16 };
        _cursorTimer.Tick += (_, _) => UpdateFollowCursor();

        _ = Task.Run(ReadCommandsAsync);
    }

    private async Task InitializeAsync()
    {
        await _webView.EnsureCoreWebView2Async();
        _webView.CoreWebView2.WebMessageReceived += (_, args) => HandleWebMessage(args.TryGetWebMessageAsString());
        await _webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(@"window.glimpse = {
    cursorTip: null,
    send: function(data) {
        window.chrome.webview.postMessage(JSON.stringify(data));
    },
    close: function() {
        window.chrome.webview.postMessage(JSON.stringify({ __glimpse_close: true }));
    }
};");
        _webView.NavigationCompleted += (_, _) =>
        {
            if (!_hidden)
            {
                if (_config.ClickThrough)
                {
                    ShowPassiveWindow();
                }
                else
                {
                    ActivateVisibleWindow();
                    _webView.Focus();
                }
            }

            PushCursorTip();
            WriteJson(new
            {
                type = "ready",
                screen = GetCurrentScreen(),
                screens = GetScreens(),
                appearance = GetAppearance(),
                cursor = GetCursor(),
                cursorTip = GetCursorTip()
            });
        };

        ApplyExtendedStyles();
        _initialized = true;
        _webView.CoreWebView2.NavigateToString("<html><body></body></html>");

        if (_followCursorEnabled)
        {
            InitializeSpringState();
            _cursorTimer.Start();
            UpdateFollowCursor();
        }
    }

    private async Task ReadCommandsAsync()
    {
        while (await Console.In.ReadLineAsync() is { } line)
        {
            var payload = line.Trim();
            if (payload.Length == 0) continue;
            if (!Form.IsDisposed)
            {
                Form.BeginInvoke(() => HandleCommand(payload));
            }
        }

        if (!Form.IsDisposed)
        {
            Form.BeginInvoke(() => CloseOnce());
        }
    }

    private void HandleCommand(string payload)
    {
        if (!_initialized)
        {
            _ = Task.Delay(10).ContinueWith(_ =>
            {
                if (!Form.IsDisposed)
                {
                    Form.BeginInvoke(() => HandleCommand(payload));
                }
            }, TaskScheduler.Default);
            return;
        }

        JsonDocument json;
        try
        {
            json = JsonDocument.Parse(payload);
        }
        catch
        {
            return;
        }

        using (json)
        {
            HandleCommand(json.RootElement);
        }
    }

    private void HandleCommand(JsonElement json)
    {
        if (!json.TryGetProperty("type", out var typeNode)) return;
        var type = typeNode.GetString();
        switch (type)
        {
            case "html":
                if (!json.TryGetProperty("html", out var htmlNode)) return;
                var html = Encoding.UTF8.GetString(Convert.FromBase64String(htmlNode.GetString() ?? string.Empty));
                _webView.CoreWebView2.NavigateToString(html);
                break;
            case "eval":
                if (!json.TryGetProperty("js", out var jsNode)) return;
                _ = _webView.CoreWebView2.ExecuteScriptAsync(jsNode.GetString() ?? string.Empty);
                break;
            case "file":
                if (!json.TryGetProperty("path", out var pathNode)) return;
                var path = Path.GetFullPath(pathNode.GetString() ?? string.Empty);
                if (File.Exists(path))
                {
                    _webView.CoreWebView2.Navigate(new Uri(path).AbsoluteUri);
                }
                break;
            case "get-info":
                WriteJson(new
                {
                    type = "info",
                    screen = GetCurrentScreen(),
                    screens = GetScreens(),
                    appearance = GetAppearance(),
                    cursor = GetCursor(),
                    cursorTip = GetCursorTip()
                });
                break;
            case "show":
                if (json.TryGetProperty("title", out var titleNode))
                {
                    Form.Text = titleNode.GetString() ?? Form.Text;
                }
                _hidden = false;
                Form.Show();
                if (!_config.ClickThrough)
                {
                    ActivateVisibleWindow();
                    _webView.Focus();
                }
                break;
            case "close":
                CloseOnce();
                break;
            case "follow-cursor":
                _followCursorEnabled = !json.TryGetProperty("enabled", out var enabledNode) || enabledNode.GetBoolean();
                if (json.TryGetProperty("anchor", out var anchorNode))
                {
                    _cursorAnchor = anchorNode.ValueKind == JsonValueKind.Null ? null : anchorNode.GetString();
                }
                if (json.TryGetProperty("mode", out var modeNode) && modeNode.ValueKind == JsonValueKind.String)
                {
                    _followMode = modeNode.GetString() ?? "snap";
                    InitializeSpringState();
                }
                Form.TopMost = _followCursorEnabled || _config.Floating;
                EnsureTopMost();
                if (_followCursorEnabled)
                {
                    InitializeSpringState();
                    _cursorTimer.Start();
                    UpdateFollowCursor();
                }
                else
                {
                    _cursorTimer.Stop();
                    PushCursorTip();
                }
                break;
        }
    }

    private void HandleWebMessage(string? message)
    {
        if (string.IsNullOrWhiteSpace(message)) return;
        try
        {
            using var json = JsonDocument.Parse(message);
            if (json.RootElement.TryGetProperty("__glimpse_close", out var closeNode) && closeNode.GetBoolean())
            {
                CloseOnce();
                return;
            }

            WriteJson(new
            {
                type = "message",
                data = JsonSerializer.Deserialize<object>(message)
            });

            if (_config.AutoClose)
            {
                CloseOnce();
            }
        }
        catch
        {
        }
    }

    private void UpdateFollowCursor()
    {
        if (!_followCursorEnabled) return;

        var target = ComputeTargetLocation(Cursor.Position);
        if (_followMode == "spring")
        {
            var dx = target.X - _springPosX;
            var dy = target.Y - _springPosY;
            var fx = 400.0 * dx - 28.0 * _springVelX;
            var fy = 400.0 * dy - 28.0 * _springVelY;
            _springVelX += fx * (1.0 / 120.0);
            _springVelY += fy * (1.0 / 120.0);
            _springPosX += _springVelX * (1.0 / 120.0);
            _springPosY += _springVelY * (1.0 / 120.0);
            Form.Location = new Point((int)Math.Round(_springPosX), (int)Math.Round(_springPosY));
        }
        else
        {
            Form.Location = target;
            _springPosX = target.X;
            _springPosY = target.Y;
            _springVelX = 0;
            _springVelY = 0;
        }

        PushCursorTip();
    }

    private void InitializeSpringState()
    {
        _springPosX = Form.Left;
        _springPosY = Form.Top;
        _springVelX = 0;
        _springVelY = 0;
    }

    private Point ComputeTargetLocation(Point cursor)
    {
        const int safeZoneLeft = 20;
        const int safeZoneRight = 27;
        const int safeZoneUp = 15;
        const int safeZoneDown = 39;

        var width = Form.Width;
        var height = Form.Height;
        var x = cursor.X + _cursorOffsetX;
        var y = cursor.Y + _cursorOffsetY;

        switch (_cursorAnchor)
        {
            case "top-left":
                x = cursor.X - safeZoneLeft - width + _cursorOffsetX;
                y = cursor.Y - safeZoneUp - height + _cursorOffsetY;
                break;
            case "top-right":
                x = cursor.X + safeZoneRight + _cursorOffsetX;
                y = cursor.Y - safeZoneUp - height + _cursorOffsetY;
                break;
            case "right":
                x = cursor.X + safeZoneRight + _cursorOffsetX;
                y = cursor.Y - (height / 2) + _cursorOffsetY;
                break;
            case "bottom-right":
                x = cursor.X + safeZoneRight + _cursorOffsetX;
                y = cursor.Y + safeZoneDown + _cursorOffsetY;
                break;
            case "bottom-left":
                x = cursor.X - safeZoneLeft - width + _cursorOffsetX;
                y = cursor.Y + safeZoneDown + _cursorOffsetY;
                break;
            case "left":
                x = cursor.X - safeZoneLeft - width + _cursorOffsetX;
                y = cursor.Y - (height / 2) + _cursorOffsetY;
                break;
        }

        return new Point(x, y);
    }

    private object? GetCursorTip()
    {
        if (!_followCursorEnabled) return null;
        var cursor = Cursor.Position;
        return new
        {
            x = cursor.X - Form.Left,
            y = cursor.Y - Form.Top
        };
    }

    private void PushCursorTip()
    {
        if (_webView.CoreWebView2 is null) return;
        var tip = GetCursorTip();
        var script = tip is null
            ? "window.glimpse.cursorTip = null"
            : $"window.glimpse.cursorTip = {JsonSerializer.Serialize(tip, JsonOptions)}";
        _ = _webView.CoreWebView2.ExecuteScriptAsync(script);
    }

    private void ActivateVisibleWindow()
    {
        Form.Show();
        Form.WindowState = FormWindowState.Normal;
        Form.BringToFront();
        Form.Activate();
        ShowWindow(Form.Handle, SwShow);
        SetForegroundWindow(Form.Handle);
    }

    private void ShowPassiveWindow()
    {
        Form.Show();
        Form.WindowState = FormWindowState.Normal;
        Form.BringToFront();
        ShowWindow(Form.Handle, SwShow);
        EnsureTopMost();
    }

    private void EnsureTopMost()
    {
        if (!Form.IsHandleCreated) return;
        var shouldBeTopMost = _followCursorEnabled || _config.Floating;
        var hWndInsertAfter = shouldBeTopMost ? new IntPtr(HwndTopmost) : new IntPtr(HwndNotopmost);
        SetWindowPos(Form.Handle, hWndInsertAfter, 0, 0, 0, 0, SwpNoMove | SwpNoSize);
    }

    private void ApplyExtendedStyles()
    {
        if (!Form.IsHandleCreated) return;

        var style = GetWindowLong(Form.Handle, GwlExStyle);
        // WS_EX_LAYERED not needed with TransparencyKey
        if (_config.ClickThrough)
        {
            style |= WsExTransparent;
        }
        else
        {
            style &= ~WsExTransparent;
        }
        // Preserve WS_EX_TOPMOST if the window should be on top
        if (_config.Floating || _config.FollowCursor)
        {
            style |= WsExTopmost;
        }
        SetWindowLong(Form.Handle, GwlExStyle, style);
    }

    private static object GetCursor()
    {
        var point = Cursor.Position;
        return new { x = point.X, y = point.Y };
    }

    private static object GetCurrentScreen()
    {
        var current = Screen.FromPoint(Cursor.Position);
        return new
        {
            width = current.Bounds.Width,
            height = current.Bounds.Height,
            scaleFactor = GetScaleFactor(current),
            visibleX = current.WorkingArea.X,
            visibleY = current.WorkingArea.Y,
            visibleWidth = current.WorkingArea.Width,
            visibleHeight = current.WorkingArea.Height
        };
    }

    private static object[] GetScreens()
    {
        return Screen.AllScreens.Select(screen => new
        {
            x = screen.Bounds.X,
            y = screen.Bounds.Y,
            width = screen.Bounds.Width,
            height = screen.Bounds.Height,
            scaleFactor = GetScaleFactor(screen),
            visibleX = screen.WorkingArea.X,
            visibleY = screen.WorkingArea.Y,
            visibleWidth = screen.WorkingArea.Width,
            visibleHeight = screen.WorkingArea.Height
        }).Cast<object>().ToArray();
    }

    private static object GetAppearance()
    {
        return new
        {
            darkMode = IsDarkMode(),
            accentColor = ToHex(SystemColors.Highlight),
            reduceMotion = false,
            increaseContrast = false
        };
    }

    private static int GetScaleFactor(Screen screen)
    {
        try
        {
            return (int)Math.Round(GetDpiForScreen(screen) / 96.0);
        }
        catch
        {
            return 1;
        }
    }

    [SupportedOSPlatform("windows")]
    private static uint GetDpiForScreen(Screen screen)
    {
        var point = new Point(screen.Bounds.Left + 1, screen.Bounds.Top + 1);
        var monitor = MonitorFromPoint(point, 2);
        if (monitor == IntPtr.Zero)
        {
            return 96;
        }

        var result = GetDpiForMonitor(monitor, 0, out var dpiX, out _);
        return result == 0 ? dpiX : 96;
    }

    private static bool IsDarkMode()
    {
        using var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
        var value = key?.GetValue("AppsUseLightTheme");
        return value is int mode && mode == 0;
    }

    private static string ToHex(Color color)
    {
        return $"#{color.R:X2}{color.G:X2}{color.B:X2}";
    }

    private static void WriteJson(object payload)
    {
        Console.Out.WriteLine(JsonSerializer.Serialize(payload, JsonOptions));
        Console.Out.Flush();
    }

    private void CloseOnce()
    {
        if (_closed) return;
        _closed = true;
        WriteJson(new { type = "closed" });
        _cursorTimer.Stop();
        if (!Form.IsDisposed)
        {
            Form.Close();
        }
        Environment.Exit(0);
    }

    public void Dispose()
    {
        _cursorTimer.Dispose();
        _webView.Dispose();
        Form.Dispose();
    }

    [DllImport("user32.dll", EntryPoint = "GetWindowLong")]
    private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLong")]
    private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int newStyle);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint uFlags);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromPoint(Point pt, uint dwFlags);

    [DllImport("Shcore.dll")]
    private static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);
}

sealed class Config
{
    public int Width { get; init; } = 800;
    public int Height { get; init; } = 600;
    public string Title { get; init; } = "Glimpse";
    public bool Frameless { get; init; }
    public bool Floating { get; init; }
    public bool Transparent { get; init; }
    public bool ClickThrough { get; init; }
    public bool FollowCursor { get; init; }
    public bool Hidden { get; init; }
    public bool AutoClose { get; init; }
    public int? X { get; init; }
    public int? Y { get; init; }
    public int CursorOffsetX { get; init; } = 20;
    public int CursorOffsetY { get; init; } = -20;
    public string? CursorAnchor { get; init; }
    public string FollowMode { get; init; } = "snap";

    public static Config Parse(string[] args)
    {
        var data = new Dictionary<string, string?>();
        var flags = new HashSet<string>();

        for (var index = 0; index < args.Length; index++)
        {
            var arg = args[index];
            switch (arg)
            {
                case "--frameless":
                case "--floating":
                case "--transparent":
                case "--click-through":
                case "--follow-cursor":
                case "--hidden":
                case "--auto-close":
                    flags.Add(arg);
                    break;
                case "--width":
                case "--height":
                case "--title":
                case "--x":
                case "--y":
                case "--cursor-offset-x":
                case "--cursor-offset-y":
                case "--cursor-anchor":
                case "--follow-mode":
                    if (index + 1 < args.Length)
                    {
                        data[arg] = args[++index];
                    }
                    break;
            }
        }

        return new Config
        {
            Width = ParseInt(data, "--width", 800),
            Height = ParseInt(data, "--height", 600),
            Title = data.GetValueOrDefault("--title") ?? "Glimpse",
            Frameless = flags.Contains("--frameless"),
            Floating = flags.Contains("--floating"),
            Transparent = flags.Contains("--transparent"),
            ClickThrough = flags.Contains("--click-through"),
            FollowCursor = flags.Contains("--follow-cursor"),
            Hidden = flags.Contains("--hidden"),
            AutoClose = flags.Contains("--auto-close"),
            X = ParseNullableInt(data, "--x"),
            Y = ParseNullableInt(data, "--y"),
            CursorOffsetX = ParseInt(data, "--cursor-offset-x", data.ContainsKey("--cursor-anchor") ? 0 : 20),
            CursorOffsetY = ParseInt(data, "--cursor-offset-y", data.ContainsKey("--cursor-anchor") ? 0 : -20),
            CursorAnchor = data.GetValueOrDefault("--cursor-anchor"),
            FollowMode = data.GetValueOrDefault("--follow-mode") ?? "snap"
        };
    }

    private static int ParseInt(Dictionary<string, string?> data, string key, int fallback)
    {
        return data.TryGetValue(key, out var value) && int.TryParse(value, out var parsed) ? parsed : fallback;
    }

    private static int? ParseNullableInt(Dictionary<string, string?> data, string key)
    {
        return data.TryGetValue(key, out var value) && int.TryParse(value, out var parsed) ? parsed : null;
    }
}
