import Cocoa
import WebKit
import Foundation

// MARK: - Stdout Helper

func writeToStdout(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict),
          let line = String(data: data, encoding: .utf8) else { return }
    let output = line + "\n"
    FileHandle.standardOutput.write(output.data(using: .utf8)!)
    fflush(stdout)
}

func log(_ message: String) {
    fputs("[glimpse] \(message)\n", stderr)
}

// MARK: - System Info

func getSystemInfo() -> [String: Any] {
    let mouse = NSEvent.mouseLocation

    // Main screen
    var screenInfo: [String: Any] = [:]
    if let screen = NSScreen.main {
        let f = screen.frame
        let v = screen.visibleFrame
        screenInfo = [
            "width": Int(f.width),
            "height": Int(f.height),
            "scaleFactor": Int(screen.backingScaleFactor),
            "visibleX": Int(v.origin.x),
            "visibleY": Int(v.origin.y),
            "visibleWidth": Int(v.width),
            "visibleHeight": Int(v.height),
        ]
    }

    // All screens
    let screens: [[String: Any]] = NSScreen.screens.map { screen in
        let f = screen.frame
        let v = screen.visibleFrame
        return [
            "x": Int(f.origin.x),
            "y": Int(f.origin.y),
            "width": Int(f.width),
            "height": Int(f.height),
            "scaleFactor": Int(screen.backingScaleFactor),
            "visibleX": Int(v.origin.x),
            "visibleY": Int(v.origin.y),
            "visibleWidth": Int(v.width),
            "visibleHeight": Int(v.height),
        ]
    }

    // Appearance
    let isDark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    let accent = NSColor.controlAccentColor.usingColorSpace(.sRGB)
    let accentHex: String
    if let c = accent {
        accentHex = String(format: "#%02X%02X%02X", Int(c.redComponent * 255), Int(c.greenComponent * 255), Int(c.blueComponent * 255))
    } else {
        accentHex = "#007AFF"
    }
    let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    let increaseContrast = NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast

    return [
        "screen": screenInfo,
        "screens": screens,
        "appearance": [
            "darkMode": isDark,
            "accentColor": accentHex,
            "reduceMotion": reduceMotion,
            "increaseContrast": increaseContrast,
        ],
        "cursor": [
            "x": Int(mouse.x),
            "y": Int(mouse.y),
        ],
    ]
}

// MARK: - Cursor Anchor

let safeZoneLeft: CGFloat = 20
let safeZoneRight: CGFloat = 27
let safeZoneUp: CGFloat = 15
let safeZoneDown: CGFloat = 39

func anchorPosition(mouse: NSPoint, windowSize: NSSize, anchor: String) -> NSPoint? {
    let cx = mouse.x
    let cy = mouse.y
    let W = windowSize.width
    let H = windowSize.height
    let sL = safeZoneLeft
    let sR = safeZoneRight
    let sU = safeZoneUp
    let sD = safeZoneDown
    switch anchor {
    case "top-left":
        return NSPoint(x: cx - sL - W, y: cy + sU)
    case "top-right":
        return NSPoint(x: cx + sR, y: cy + sU)
    case "right":
        return NSPoint(x: cx + sR, y: cy - H / 2)
    case "bottom-right":
        return NSPoint(x: cx + sR, y: cy - sD - H)
    case "bottom-left":
        return NSPoint(x: cx - sL - W, y: cy - sD - H)
    case "left":
        return NSPoint(x: cx - sL - W, y: cy - H / 2)
    default:
        return nil
    }
}

// MARK: - CLI Config

struct Config {
    var width: Int = 800
    var height: Int = 600
    var title: String = "Glimpse"
    var frameless: Bool = false
    var floating: Bool = false
    var transparent: Bool = false
    var x: Int? = nil
    var y: Int? = nil
    var followCursor: Bool = false
    var cursorOffsetX: Int = 20
    var cursorOffsetY: Int = -20
    var clickThrough: Bool = false
    var autoClose: Bool = false
    var cursorAnchor: String? = nil
}

func parseArgs() -> Config {
    var config = Config()
    let args = CommandLine.arguments
    var i = 1
    while i < args.count {
        switch args[i] {
        case "--width":
            i += 1
            if i < args.count, let v = Int(args[i]) { config.width = v }
        case "--height":
            i += 1
            if i < args.count, let v = Int(args[i]) { config.height = v }
        case "--title":
            i += 1
            if i < args.count { config.title = args[i] }
        case "--frameless":
            config.frameless = true
        case "--floating":
            config.floating = true
        case "--transparent":
            config.transparent = true
        case "--x":
            i += 1
            if i < args.count, let v = Int(args[i]) { config.x = v }
        case "--y":
            i += 1
            if i < args.count, let v = Int(args[i]) { config.y = v }
        case "--follow-cursor":
            config.followCursor = true
        case "--cursor-offset-x":
            i += 1
            if i < args.count, let v = Int(args[i]) { config.cursorOffsetX = v }
        case "--cursor-offset-y":
            i += 1
            if i < args.count, let v = Int(args[i]) { config.cursorOffsetY = v }
        case "--click-through":
            config.clickThrough = true
        case "--auto-close":
            config.autoClose = true
        case "--cursor-anchor":
            i += 1
            if i < args.count { config.cursorAnchor = args[i] }
        default:
            break
        }
        i += 1
    }
    // When anchor is set, offsets default to 0 (fine-tuning only).
    // The non-zero defaults (20, -20) are for offset-only mode.
    if config.cursorAnchor != nil {
        var explicitOffsetX = false
        var explicitOffsetY = false
        var j = 1
        while j < args.count {
            if args[j] == "--cursor-offset-x" { explicitOffsetX = true }
            if args[j] == "--cursor-offset-y" { explicitOffsetY = true }
            j += 1
        }
        if !explicitOffsetX { config.cursorOffsetX = 0 }
        if !explicitOffsetY { config.cursorOffsetY = 0 }
    }
    return config
}

// MARK: - Window Subclass (keyboard support for frameless windows)

class GlimpsePanel: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

// MARK: - AppDelegate

@MainActor
class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler, NSWindowDelegate {

    var window: NSWindow!
    var webView: WKWebView!
    let config: Config

    // Cursor anchor — mutable so the follow-cursor protocol command can update it at runtime
    var cursorAnchor: String? = nil

    // Mouse monitor references for follow-cursor mode
    var globalMouseMonitor: Any?
    var localMouseMonitor: Any?

    nonisolated init(config: Config) {
        self.config = config
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        cursorAnchor = config.cursorAnchor
        setupWindow()
        setupWebView()
        if config.followCursor {
            startFollowingCursor()
        }
        startStdinReader()
    }

    // MARK: - Setup

    private func setupWindow() {
        let rect = NSRect(x: 0, y: 0, width: config.width, height: config.height)
        let styleMask: NSWindow.StyleMask = config.frameless
            ? [.borderless]
            : [.titled, .closable, .miniaturizable, .resizable]
        window = GlimpsePanel(
            contentRect: rect,
            styleMask: styleMask,
            backing: .buffered,
            defer: false
        )
        window.title = config.title
        if config.frameless {
            window.isMovableByWindowBackground = true
        }
        if config.floating || config.followCursor {
            window.level = .floating
        }
        if config.clickThrough {
            window.ignoresMouseEvents = true
        }
        if config.transparent {
            window.isOpaque = false
            window.backgroundColor = .clear
        }
        if config.followCursor {
            let mouse = NSEvent.mouseLocation
            if let anchor = cursorAnchor,
               let base = anchorPosition(mouse: mouse, windowSize: NSSize(width: config.width, height: config.height), anchor: anchor) {
                let x = base.x + CGFloat(config.cursorOffsetX)
                let y = base.y + CGFloat(config.cursorOffsetY)
                window.setFrameOrigin(NSPoint(x: x, y: y))
            } else {
                let x = mouse.x + CGFloat(config.cursorOffsetX)
                let y = mouse.y + CGFloat(config.cursorOffsetY)
                window.setFrameOrigin(NSPoint(x: x, y: y))
            }
        } else if let x = config.x, let y = config.y {
            window.setFrameOrigin(NSPoint(x: x, y: y))
        } else {
            window.center()
        }
        window.delegate = self
        if config.clickThrough {
            window.orderFrontRegardless()
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    private func setupWebView() {
        let ucc = WKUserContentController()

        let bridgeJS = """
        window.glimpse = {
            cursorTip: null,
            send: function(data) {
                window.webkit.messageHandlers.glimpse.postMessage(JSON.stringify(data));
            },
            close: function() {
                window.webkit.messageHandlers.glimpse.postMessage(JSON.stringify({__glimpse_close: true}));
            }
        };
        """
        let script = WKUserScript(source: bridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        ucc.addUserScript(script)
        ucc.add(self, name: "glimpse")

        let wkConfig = WKWebViewConfiguration()
        wkConfig.userContentController = ucc

        webView = WKWebView(frame: window.contentView!.bounds, configuration: wkConfig)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        if config.transparent {
            webView.underPageBackgroundColor = .clear
            webView.setValue(false, forKey: "drawsBackground")
        }
        window.contentView?.addSubview(webView)

        // Load blank page so didFinish fires and we emit "ready"
        webView.loadHTMLString("<html><body></body></html>", baseURL: nil)
    }

    // MARK: - Follow Cursor

    func startFollowingCursor() {
        guard globalMouseMonitor == nil else { return }
        window.level = .floating
        let moveHandler: (NSEvent) -> Void = { [weak self] _ in
            guard let self else { return }
            let mouse = NSEvent.mouseLocation
            if let anchor = self.cursorAnchor,
               let base = anchorPosition(mouse: mouse, windowSize: self.window.frame.size, anchor: anchor) {
                let x = base.x + CGFloat(self.config.cursorOffsetX)
                let y = base.y + CGFloat(self.config.cursorOffsetY)
                self.window.setFrameOrigin(NSPoint(x: x, y: y))
            } else {
                let x = mouse.x + CGFloat(self.config.cursorOffsetX)
                let y = mouse.y + CGFloat(self.config.cursorOffsetY)
                self.window.setFrameOrigin(NSPoint(x: x, y: y))
            }
        }
        globalMouseMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.mouseMoved, .leftMouseDragged, .rightMouseDragged],
            handler: moveHandler
        )
        localMouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged, .rightMouseDragged]) { [weak self] event in
            guard let self else { return event }
            let mouse = NSEvent.mouseLocation
            if let anchor = self.cursorAnchor,
               let base = anchorPosition(mouse: mouse, windowSize: self.window.frame.size, anchor: anchor) {
                let x = base.x + CGFloat(self.config.cursorOffsetX)
                let y = base.y + CGFloat(self.config.cursorOffsetY)
                self.window.setFrameOrigin(NSPoint(x: x, y: y))
            } else {
                let x = mouse.x + CGFloat(self.config.cursorOffsetX)
                let y = mouse.y + CGFloat(self.config.cursorOffsetY)
                self.window.setFrameOrigin(NSPoint(x: x, y: y))
            }
            return event
        }
    }

    func computeCursorTip() -> [String: Int]? {
        let H = window.frame.size.height
        if let anchor = cursorAnchor,
           let base = anchorPosition(mouse: NSPoint(x: 0, y: 0), windowSize: window.frame.size, anchor: anchor) {
            // In anchor mode, the offset from mouse to window origin is constant.
            // base is computed with mouse at (0,0), so base.x/y IS the offset from mouse to window origin.
            let cssX = 0 - base.x - CGFloat(config.cursorOffsetX)
            let cssY = H - (0 - base.y - CGFloat(config.cursorOffsetY))
            return ["x": Int(cssX), "y": Int(cssY)]
        } else if config.followCursor || globalMouseMonitor != nil {
            // Offset-only mode: windowOrigin.x = mouse.x + offsetX, windowOrigin.y = mouse.y + offsetY
            // cssX = mouse.x - windowOrigin.x = -offsetX
            // cssY = H - (mouse.y - windowOrigin.y) = H - (-offsetY) = H + offsetY
            let cssX = -config.cursorOffsetX
            let cssY = Int(H) + config.cursorOffsetY
            return ["x": cssX, "y": cssY]
        }
        return nil
    }

    func stopFollowingCursor() {
        if let monitor = globalMouseMonitor {
            NSEvent.removeMonitor(monitor)
            globalMouseMonitor = nil
        }
        if let monitor = localMouseMonitor {
            NSEvent.removeMonitor(monitor)
            localMouseMonitor = nil
        }
    }

    // MARK: - Stdin Reader

    private func startStdinReader() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            while let line = readLine() {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                guard !trimmed.isEmpty else { continue }
                guard let data = trimmed.data(using: .utf8),
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let type = json["type"] as? String
                else {
                    log("Skipping invalid JSON: \(trimmed)")
                    continue
                }
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        self?.handleCommand(type: type, json: json)
                    }
                }
            }
            // stdin EOF — close window
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self?.closeAndExit()
                }
            }
        }
    }

    // MARK: - Command Dispatch

    func handleCommand(type: String, json: [String: Any]) {
        switch type {
        case "html":
            guard let base64 = json["html"] as? String,
                  let htmlData = Data(base64Encoded: base64),
                  let html = String(data: htmlData, encoding: .utf8)
            else {
                log("html command: missing or invalid base64 payload")
                return
            }
            webView.loadHTMLString(html, baseURL: nil)
        case "eval":
            guard let js = json["js"] as? String else {
                log("eval command: missing js field")
                return
            }
            webView.evaluateJavaScript(js, completionHandler: nil)
        case "follow-cursor":
            let enabled = json["enabled"] as? Bool ?? true
            if let anchor = json["anchor"] as? String, !anchor.isEmpty {
                cursorAnchor = anchor
            } else if json.keys.contains("anchor") {
                cursorAnchor = nil
            }
            if enabled {
                startFollowingCursor()
            } else {
                stopFollowingCursor()
            }
            if let tip = computeCursorTip() {
                webView.evaluateJavaScript("window.glimpse.cursorTip = {x: \(tip["x"]!), y: \(tip["y"]!)}", completionHandler: nil)
            } else {
                webView.evaluateJavaScript("window.glimpse.cursorTip = null", completionHandler: nil)
            }
        case "file":
            guard let path = json["path"] as? String else {
                log("file command: missing path field")
                return
            }
            let fileURL = URL(fileURLWithPath: path)
            guard FileManager.default.fileExists(atPath: path) else {
                log("file command: file not found: \(path)")
                return
            }
            webView.loadFileURL(fileURL, allowingReadAccessTo: fileURL.deletingLastPathComponent())
        case "get-info":
            var info = getSystemInfo()
            info["type"] = "info"
            if let tip = computeCursorTip() {
                info["cursorTip"] = tip
            }
            writeToStdout(info)
        case "close":
            closeAndExit()
        default:
            log("Unknown command type: \(type)")
        }
    }

    func closeAndExit() {
        writeToStdout(["type": "closed"])
        exit(0)
    }

    // MARK: - WKNavigationDelegate

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        MainActor.assumeIsolated {
            window.makeFirstResponder(webView)
            var info = getSystemInfo()
            info["type"] = "ready"
            if let tip = computeCursorTip() {
                info["cursorTip"] = tip
                webView.evaluateJavaScript("window.glimpse.cursorTip = {x: \(tip["x"]!), y: \(tip["y"]!)}", completionHandler: nil)
            }
            writeToStdout(info)
        }
    }

    // MARK: - WKScriptMessageHandler

    nonisolated func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated {
            guard let body = message.body as? String,
                  let data = body.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                log("Received invalid message from webview")
                return
            }

            if json["__glimpse_close"] as? Bool == true {
                closeAndExit()
                return
            }

            writeToStdout(["type": "message", "data": json])
            if config.autoClose {
                closeAndExit()
            }
        }
    }

    // MARK: - NSWindowDelegate

    func windowDidResize(_ notification: Notification) {
        if let tip = computeCursorTip() {
            webView.evaluateJavaScript("window.glimpse.cursorTip = {x: \(tip["x"]!), y: \(tip["y"]!)}", completionHandler: nil)
        }
    }

    func windowWillClose(_ notification: Notification) {
        writeToStdout(["type": "closed"])
        exit(0)
    }
}

// MARK: - Entry Point

let config = parseArgs()
let app = NSApplication.shared
let delegate = AppDelegate(config: config)
app.delegate = delegate
app.setActivationPolicy(config.clickThrough ? .accessory : .regular)
app.run()
