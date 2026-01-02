package com.zhoud.stockboard;

import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * 处理返回键事件
     * 优先尝试关闭页面内的弹窗，如果没有弹窗则直接退出应用
     */
    @Override
    public void onBackPressed() {
        WebView webView = getBridge().getWebView();

        if (webView != null) {
            // 调用JavaScript检查并关闭弹窗
            // 如果成功关闭弹窗返回true，否则返回false
            webView.evaluateJavascript(
                    "(function() {" +
                            "  var modal = document.querySelector('.modal.active');" +
                            "  if (modal) {" +
                            "    modal.classList.remove('active');" +
                            "    return true;" +
                            "  }" +
                            "  return false;" +
                            "})()",
                    result -> {
                        // 如果没有弹窗被关闭（result为"false"），则直接结束Activity
                        if ("false".equals(result)) {
                            finish(); // 直接返回主界面，不触发浏览器后退
                        }
                        // 如果有弹窗被关闭，不做其他操作
                    });
        } else {
            // WebView为空时直接退出
            finish();
        }
    }
}
