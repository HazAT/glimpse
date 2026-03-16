/// JavaScript bridge injected before page scripts run.
/// Must match Swift bridge exactly: send() JSON.stringify's before postMessage,
/// close() sends a sentinel object. Single message handler "glimpse".
pub const BRIDGE_JS: &str = r#"
window.glimpse = {
    cursorTip: null,
    send: function(data) {
        window.webkit.messageHandlers.glimpse.postMessage(JSON.stringify(data));
    },
    close: function() {
        window.webkit.messageHandlers.glimpse.postMessage(JSON.stringify({__glimpse_close: true}));
    }
};
"#;
