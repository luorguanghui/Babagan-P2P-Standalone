package cloud.babagan.meeting;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.*;
import java.io.ByteArrayInputStream;
import java.util.Collections;

public class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private WebView web;
    private PermissionRequest pending;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        web = new WebView(this);
        setContentView(web);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !request.getUrl().toString().startsWith(ORIGIN + "/");
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (!"appassets.androidplatform.net".equals(request.getUrl().getHost())) return null;
                String file = request.getUrl().getPath();
                if ("/".equals(file)) file = "/index.html";
                if (file == null || !file.matches("/[a-zA-Z0-9._-]+")) return missing();
                String mime = file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : "application/javascript";
                try { return new WebResourceResponse(mime, "UTF-8", 200, "OK", Collections.singletonMap("Cache-Control", "no-cache"), getAssets().open(file.substring(1))); }
                catch (Exception error) { return missing(); }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    if (!ORIGIN.equals(request.getOrigin().toString().replaceAll("/$", ""))) { request.deny(); return; }
                    boolean audio = false;
                    for (String resource : request.getResources()) if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) audio = true;
                    if (!audio) { request.deny(); return; }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    else { if (pending != null) pending.deny(); pending = request; requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 100); }
                });
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) { if (pending == request) pending = null; }
            @Override public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) { callback.onCustomViewHidden(); return; }
                customView = view;
                customViewCallback = callback;
                web.setVisibility(View.GONE);
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
                addContentView(view, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            }
            @Override public void onHideCustomView() {
                if (customView == null) return;
                web.setVisibility(View.VISIBLE);
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
                ViewGroup parent = (ViewGroup) customView.getParent();
                if (parent != null) parent.removeView(customView);
                customView = null;
                if (customViewCallback != null) {
                    customViewCallback.onCustomViewHidden();
                    customViewCallback = null;
                }
            }
        });
        web.loadUrl(ORIGIN + "/index.html");
    }
    private WebResourceResponse missing() { return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", Collections.emptyMap(), new ByteArrayInputStream(new byte[0])); }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == 100 && pending != null) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) pending.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE}); else pending.deny();
            pending = null;
        }
    }
    @Override protected void onPause() { if (web != null) web.evaluateJavascript("window.dispatchEvent(new Event('native-background'))", null); super.onPause(); }
    @Override protected void onResume() { super.onResume(); if (web != null) web.evaluateJavascript("window.dispatchEvent(new Event('native-foreground'))", null); }
    @Override public void onBackPressed() {
        if (customView != null) {
            if (web != null) {
                web.evaluateJavascript("if (document.exitFullscreen) document.exitFullscreen(); else if (document.webkitExitFullscreen) document.webkitExitFullscreen();", null);
            }
            return;
        }
        new AlertDialog.Builder(this).setTitle("退出 Babagan？").setMessage("退出将断开当前会议。").setNegativeButton("继续会议", null).setPositiveButton("退出", (d, w) -> finish()).show();
    }
    @Override protected void onDestroy() { if (pending != null) pending.deny(); if (web != null) { web.loadUrl("about:blank"); web.destroy(); } super.onDestroy(); }
}
