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
        default:
            break
        }
        i += 1
    }
    return config
}

// MARK: - AppDelegate

@MainActor
class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler, NSWindowDelegate {

    var window: NSWindow!
    var webView: WKWebView!
    let config: Config

    nonisolated init(config: Config) {
        self.config = config
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupWindow()
        setupWebView()
        startStdinReader()
    }

    // MARK: - Setup

    private func setupWindow() {
        let rect = NSRect(x: 0, y: 0, width: config.width, height: config.height)
        let styleMask: NSWindow.StyleMask = config.frameless
            ? [.borderless]
            : [.titled, .closable, .miniaturizable, .resizable]
        window = NSWindow(
            contentRect: rect,
            styleMask: styleMask,
            backing: .buffered,
            defer: false
        )
        window.title = config.title
        if config.frameless {
            window.isMovableByWindowBackground = true
        }
        if config.floating {
            window.level = .floating
        }
        if config.transparent {
            window.isOpaque = false
            window.backgroundColor = .clear
        }
        if let x = config.x, let y = config.y {
            window.setFrameOrigin(NSPoint(x: x, y: y))
        } else {
            window.center()
        }
        window.delegate = self
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func setupWebView() {
        let ucc = WKUserContentController()

        let bridgeJS = """
        window.glimpse = {
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
        }
        window.contentView?.addSubview(webView)

        // Load blank page so didFinish fires and we emit "ready"
        webView.loadHTMLString("<html><body></body></html>", baseURL: nil)
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
            writeToStdout(["type": "ready"])
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
        }
    }

    // MARK: - NSWindowDelegate

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
app.setActivationPolicy(.regular)
app.run()
