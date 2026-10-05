import SwiftUI
import WebKit

struct WebContainerView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []

        let userContentController = WKUserContentController()
        userContentController.add(context.coordinator, name: "callHandler")
        configuration.userContentController = userContentController

        // Script to bridge CallKit with web notifications / WebRTC
        let jsBridge = """
        window.VrotNative = {
            reportIncomingCall: function(caller, isVideo) {
                if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.callHandler) {
                    window.webkit.messageHandlers.callHandler.postMessage({
                        action: 'incomingCall',
                        caller: caller,
                        isVideo: !!isVideo
                    });
                }
            },
            endCall: function() {
                if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.callHandler) {
                    window.webkit.messageHandlers.callHandler.postMessage({
                        action: 'endCall'
                    });
                }
            }
        };
        """
        let userScript = WKUserScript(source: jsBridge, injectionTime: .atDocumentStart, forMainFrameOnly: false)
        userContentController.addUserScript(userScript)

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 30/255, green: 31/255, blue: 34/255, alpha: 1.0)
        webView.scrollView.backgroundColor = UIColor(red: 30/255, green: 31/255, blue: 34/255, alpha: 1.0)
        webView.scrollView.bounces = false

        let request = URLRequest(url: url)
        webView.load(request)

        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let dict = message.body as? [String: Any],
                  let action = dict["action"] as? String else { return }

            if action == "incomingCall" {
                let caller = dict["caller"] as? String ?? "Vrot.fun"
                let isVideo = dict["isVideo"] as? Bool ?? false
                CallKitManager.shared.reportIncomingCall(callerName: caller, hasVideo: isVideo)
            } else if action == "endCall" {
                CallKitManager.shared.endCall()
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(.allow)
        }

        @available(iOS 15.0, *)
        func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
            decisionHandler(.grant)
        }
    }
}
