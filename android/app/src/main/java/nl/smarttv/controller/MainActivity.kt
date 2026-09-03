package nl.smarttv.controller

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager
import kotlin.math.ceil
import kotlin.math.max

class MainActivity : Activity() {
    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        setContentView(webView)
        webView.setBackgroundColor(android.graphics.Color.rgb(5, 8, 17))
        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.allowFileAccess = true
        webView.settings.allowContentAccess = true
        webView.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        webView.settings.mediaPlaybackRequiresUserGesture = false
        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = WebViewClient()
        webView.addJavascriptInterface(NativeApi(this, webView), "AndroidNative")
        webView.loadUrl("file:///android_asset/index.html")
    }

    override fun onBackPressed() {
        webView.evaluateJavascript("typeof go==='function' ? go('home') : null", null)
    }
}

private data class NetResponse(val status: Int, val text: String, val headers: Map<String, List<String>>) {
    fun json(): JSONObject = try { if (text.isBlank()) JSONObject() else JSONObject(text) } catch (_: Exception) { JSONObject().put("raw", text) }
}

private class NativeApi(private val activity: Activity, private val webView: WebView) {
    private val prefs = activity.getSharedPreferences("smart_tv_controller", Activity.MODE_PRIVATE)
    private val executor = Executors.newCachedThreadPool()
    private val countdownPages = ConcurrentHashMap<String, String>()
    private val countdownServer = CountdownServer(countdownPages)
    @Volatile private var countdownEndAt = 0L
    @Volatile private var countdownPausedRemaining = 0L
    @Volatile private var countdownPaused = false
    @Volatile private var countdownToken: String? = null
    @Volatile private var countdownConfig: JSONObject? = null

    private val trustAll = arrayOf<TrustManager>(object : X509TrustManager {
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        override fun checkClientTrusted(chain: Array<X509Certificate>?, authType: String?) {}
        override fun checkServerTrusted(chain: Array<X509Certificate>?, authType: String?) {}
    })
    private val sslContext = SSLContext.getInstance("TLS").apply { init(null, trustAll, SecureRandom()) }

    init { countdownServer.start() }

    @JavascriptInterface
    fun request(id: String, method: String, path: String, body: String?) {
        executor.execute {
            try {
                val result = handle(method.uppercase(), path, body)
                reply(id, 200, result)
            } catch (e: ApiError) {
                reply(id, e.status, JSONObject().put("error", e.message ?: "Android API error").put("code", e.code))
            } catch (e: Exception) {
                reply(id, 500, JSONObject().put("error", e.message ?: "Android API error"))
            }
        }
    }

    private fun reply(id: String, status: Int, data: JSONObject) {
        val js = "window.__nativeResolve(${JSONObject.quote(id)},$status,${JSONObject.quote(data.toString())})"
        webView.post { webView.evaluateJavascript(js, null) }
    }

    private fun body(s: String?): JSONObject = try { if (s.isNullOrBlank()) JSONObject() else JSONObject(s) } catch (_: Exception) { JSONObject() }
    private fun tvIp(): String = prefs.getString("tvIp", null) ?: throw ApiError(404, "no_tv", "Verbind eerst je TV in Devices.")
    private fun deviceId(): String = "philips:${tvIp()}"
    private fun hasSecure(): Boolean = !prefs.getString("username", null).isNullOrBlank() && !prefs.getString("password", null).isNullOrBlank()

    private fun handle(method: String, pathRaw: String, bodyRaw: String?): JSONObject {
        val path = pathRaw.substringBefore('?')
        val query = pathRaw.substringAfter('?', "")
        val b = body(bodyRaw)
        return when (path) {
            "/api/health" -> JSONObject().put("ok", true).put("name", "Smart TV Controller Android").put("version", "android-native-1.0").put("localIPv4s", JSONArray(localIPv4s())).put("nativeAndroid", true)
            "/api/connect" -> connect(b)
            "/api/discover" -> discover()
            "/api/status" -> status()
            "/api/key" -> { sendKey(b.optString("key")); JSONObject().put("ok", true) }
            "/api/volume" -> setVolume(b.optInt("volume", 20))
            "/api/mute" -> setMute(b.optBoolean("muted", true))
            "/api/apps" -> apps()
            "/api/apps/launch", "/api/apps/open" -> openApp(b.optJSONObject("app") ?: JSONObject())
            "/api/apps/action" -> appAction(b)
            "/api/ambilight/info" -> ambilightInfo()
            "/api/ambilight/styles" -> { val x = ambilightInfo(); JSONObject().put("styles", x.optJSONArray("styles") ?: JSONArray()).put("current", x.optJSONObject("current")) }
            "/api/ambilight/topology" -> ambilightInfo().optJSONObject("topology") ?: JSONObject()
            "/api/ambilight" -> applyAmbilight(b)
            "/api/ambilight/zones" -> applyAmbilightZones(b)
            "/api/android/info" -> androidInfo()
            "/api/info" -> tvInfo()
            "/api/remote/status" -> JSONObject().put("ok", true).put("paired", hasSecure()).put("secureRemote", hasSecure()).put("remembered", hasSecure()).put("deviceId", deviceId()).put("ip", tvIp())
            "/api/remote/pair/request" -> pairRequest()
            "/api/remote/pair/grant" -> pairGrant(b.optString("pin"))
            "/api/remote/key" -> { sendSecureKey(b.optString("key")); JSONObject().put("ok", true) }
            "/api/remote/volume" -> setSecureVolume(b.optInt("volume", 20))
            "/api/remote/mute" -> setSecureMute(b)
            "/api/remote/hdmi1" -> launchAssistant("HDMI 1")
            "/api/announcements/test" -> announcement(JSONObject().put("title", "Smart TV Controller").put("message", "Android verbinding werkt").put("duration", 4).put("position", 4))
            "/api/announcements/send" -> announcement(b)
            "/api/countdown/start" -> countdownStart(b)
            "/api/countdown/status" -> countdownStatus()
            "/api/countdown/pause" -> countdownPause()
            "/api/countdown/resume" -> countdownResume()
            "/api/countdown/stop" -> countdownStop()
            "/api/diagnose" -> diagnose(query)
            else -> throw ApiError(404, "not_implemented", "Deze functie is nog niet native beschikbaar op Android: $path")
        }
    }

    private fun connect(b: JSONObject): JSONObject {
        val ip = b.optString("ip").trim().ifBlank { prefs.getString("tvIp", "") ?: "" }
        if (ip.isBlank()) throw ApiError(400, "missing_ip", "Vul het IP-adres van je TV in.")
        val sys = tryGet("http", ip, 1925, "/6/system") ?: tryGet("http", ip, 1925, "/1/system") ?: throw ApiError(503, "tv_unreachable", "TV JointSpace is niet bereikbaar op $ip:1925")
        val j = sys.json()
        val name = j.optString("name", b.optString("name", "Philips TV"))
        prefs.edit().putString("tvIp", ip).putString("tvName", name).apply()
        return JSONObject().put("ok", true).put("apiMode", "android-native").put("apiVersion", 6).put("secureCredentials", hasSecure()).put("device", JSONObject().put("id", "philips:$ip").put("ip", ip).put("name", name).put("model", j.optString("model", "Philips Android TV")).put("brand", "philips").put("apiMode", "android-native").put("apiVersion", 6))
    }

    private fun discover(): JSONObject {
        val arr = JSONArray()
        prefs.getString("tvIp", null)?.let { ip -> arr.put(JSONObject().put("id", "philips:$ip").put("ip", ip).put("name", prefs.getString("tvName", "Philips TV")).put("brand", "philips")) }
        return JSONObject().put("devices", arr)
    }

    private fun status(): JSONObject {
        val ip = tvIp()
        val vol = tryJson("audio/volume")
        val act = tryJson("activities/current")
        val power = tryJson("powerstate")
        val ambi = tryJson("ambilight/currentconfiguration")
        val sys = tryJson("system")
        val out = JSONObject().put("connected", true).put("apiMode", "android-native").put("apiVersion", 6).put("secureCredentials", hasSecure())
        vol?.let { out.put("volume", it.optInt("current")).put("muted", it.optBoolean("muted")).put("maxVolume", it.optInt("max", 60)) }
        act?.let {
            val pkg = packageFromActivity(it)
            val source = it.optJSONObject("channel")?.optString("name") ?: it.optJSONObject("component")?.optString("label")
            if (!source.isNullOrBlank()) out.put("source", source)
            if (!pkg.isNullOrBlank()) out.put("app", pkg)
        }
        power?.let { out.put("power", it.optString("powerstate", it.optString("power", ""))) }
        ambi?.let { out.put("ambilight", it.optString("styleName", it.optString("style", "On"))).put("ambilightConfiguration", it) }
        val jf = sys?.optJSONObject("featuring")?.optJSONObject("jsonfeatures")
        out.put("capabilities", JSONObject().put("volume", vol != null).put("activities", act != null).put("power", power != null).put("ambilight", ambi != null).put("inputkey", jf?.has("inputkey") == true).put("applications", jf?.has("applications") == true).put("recordings", jf?.has("recordings") == true).put("textentry", jf?.has("textentry") == true))
        return out
    }

    private fun apps(): JSONObject {
        val data = try { secureJson("applications", "GET", null) } catch (_: Exception) { tvJson("applications") }
        val rawList = data.optJSONArray("applications") ?: data.optJSONArray("apps") ?: JSONArray()
        val act = tryJson("activities/current")
        val activePkg = act?.let { packageFromActivity(it) }
        val apps = JSONArray()
        var hidden = 0
        for (i in 0 until rawList.length()) {
            val a = rawList.optJSONObject(i) ?: continue
            val pkg = packageFromApp(a)
            val name = a.optString("label", a.optString("name", pkg ?: "App"))
            if (isSystemApp(name, pkg)) { hidden++; continue }
            apps.put(JSONObject().put("id", a.optString("id", pkg ?: i.toString())).put("name", name).put("packageName", pkg).put("active", !activePkg.isNullOrBlank() && activePkg == pkg).put("raw", a))
        }
        val active = if (activePkg.isNullOrBlank() || isSystemApp("", activePkg)) JSONObject.NULL else JSONObject().put("packageName", activePkg).put("label", act?.optJSONObject("component")?.optString("label"))
        return JSONObject().put("apps", apps).put("count", apps.length()).put("filteredSystemApps", hidden).put("unavailable", false).put("active", active)
    }

    private fun openApp(app: JSONObject): JSONObject {
        val raw = app.optJSONObject("raw") ?: app
        val payloads = mutableListOf<JSONObject>()
        if (raw.has("intent")) payloads.add(raw)
        val pkg = app.optString("packageName", packageFromApp(raw) ?: app.optString("id"))
        if (pkg.isNotBlank()) {
            payloads.add(JSONObject().put("intent", JSONObject().put("component", JSONObject().put("packageName", pkg))))
            payloads.add(JSONObject().put("intent", JSONObject().put("action", "android.intent.action.MAIN").put("category", "android.intent.category.LEANBACK_LAUNCHER").put("component", JSONObject().put("packageName", pkg))))
        }
        var last: Exception? = null
        for (p in payloads) try { secureJson("activities/launch", "POST", p); return JSONObject().put("ok", true).put("packageName", pkg) } catch (e: Exception) { last = e }
        throw ApiError(400, "launch_failed", last?.message ?: "App kon niet worden geopend")
    }

    private fun appAction(b: JSONObject): JSONObject {
        return when (b.optString("action").lowercase()) {
            "home", "stop" -> { sendSecureKey("Home"); JSONObject().put("ok", true).put("action", "home") }
            "back" -> { sendSecureKey("Back"); JSONObject().put("ok", true).put("action", "back") }
            "reopen" -> openApp(b.optJSONObject("app") ?: JSONObject())
            "refresh" -> JSONObject().put("ok", true).put("active", tryJson("activities/current"))
            else -> throw ApiError(400, "bad_action", "Onbekende app-actie")
        }
    }

    private fun ambilightInfo(): JSONObject {
        val styles = tryJson("ambilight/supportedstyles")
        val topology = tryJson("ambilight/topology")
        val current = tryJson("ambilight/currentconfiguration")
        val power = tryJson("ambilight/power")
        val mode = tryJson("ambilight/mode")
        return JSONObject().put("styles", styles?.optJSONArray("supportedStyles") ?: styles?.optJSONArray("styles") ?: JSONArray()).put("topology", topology ?: JSONObject()).put("current", current ?: JSONObject()).put("power", power ?: JSONObject()).put("mode", mode ?: JSONObject())
    }

    private fun applyAmbilight(b: JSONObject): JSONObject {
        val mode = b.optString("mode", "FOLLOW_VIDEO").uppercase()
        if (mode == "OFF") {
            tvPost("ambilight/power", JSONObject().put("power", "Off"))
            return JSONObject().put("ok", true).put("mode", "OFF")
        }
        try { tvPost("ambilight/power", JSONObject().put("power", "On")) } catch (_: Exception) {}
        val preset = b.optString("preset", "STANDARD").uppercase()
        val payload = JSONObject().put("styleName", mode).put("isExpert", false).put("menuSetting", preset).put("stringValue", preset.replace('_', ' '))
        tvPost("ambilight/currentconfiguration", payload)
        return JSONObject().put("ok", true).put("mode", mode).put("preset", preset)
    }

    private fun applyAmbilightZones(b: JSONObject): JSONObject {
        val topo = ambilightInfo().optJSONObject("topology") ?: throw ApiError(400, "no_topology", "Geen Ambilight-topologie")
        val rgb = hexRgb(b.optString("color", "#7c5cff"))
        val zones = b.optJSONObject("zones") ?: JSONObject()
        val layer = JSONObject()
        for (side in arrayOf("left", "top", "right")) {
            val count = topo.optInt(side, 0)
            if (count <= 0) continue
            val pixels = JSONObject()
            for (i in 0 until count) pixels.put(i.toString(), if (zones.optBoolean(side, true)) rgb else JSONObject().put("r",0).put("g",0).put("b",0))
            layer.put(side, pixels)
        }
        tvPost("ambilight/mode", JSONObject().put("current", "manual"))
        tvPost("ambilight/cached", JSONObject().put("layer1", layer))
        return JSONObject().put("ok", true).put("mode", "manual")
    }

    private fun androidInfo(): JSONObject {
        val sys = tryJson("system")
        val act = tryJson("activities/current")
        val storage = tryJson("storage")
        val timestamp = tryJson("timestamp")
        return JSONObject().put("system", sys ?: JSONObject()).put("activity", act ?: JSONObject()).put("storage", storage ?: JSONObject()).put("timestamp", timestamp ?: JSONObject()).put("availability", JSONObject().put("system", sys!=null).put("activity",act!=null).put("storage",storage!=null).put("timestamp",timestamp!=null).put("channels",false).put("recordings",false))
    }

    private fun tvInfo(): JSONObject = JSONObject().put("device", JSONObject().put("id", deviceId()).put("ip", tvIp()).put("name", prefs.getString("tvName", "Philips TV")).put("apiMode", "android-native").put("apiVersion", 6)).put("system", tryJson("system") ?: JSONObject()).put("power", tryJson("powerstate") ?: JSONObject()).put("status", status())

    private fun pairRequest(): JSONObject {
        if (hasSecure()) return JSONObject().put("ok", true).put("alreadyPaired", true).put("paired", true).put("pinRequired", false)
        val deviceId = randomId(16)
        val payload = JSONObject().put("scope", JSONArray().put("read").put("write").put("control")).put("device", pairDevice(deviceId))
        val r = raw("https", tvIp(), 1926, "/6/pair/request", "POST", payload.toString(), null)
        if (r.status !in 200..299) throw ApiError(r.status, "pair_request_failed", r.json().optString("error_text", "Pair request HTTP ${r.status}"))
        val j = r.json(); val authKey = j.optString("auth_key"); val timestamp = j.optLong("timestamp", 0)
        if (authKey.isBlank() || timestamp == 0L) throw ApiError(400, "pair_invalid", "TV gaf geen pairing credentials terug")
        prefs.edit().putString("pendingDeviceId", deviceId).putString("pendingAuthKey", authKey).putLong("pendingTimestamp", timestamp).apply()
        return JSONObject().put("ok", true).put("pinRequired", true).put("timeout", j.optInt("timeout", 60)).put("message", "PIN staat op de TV")
    }

    private fun pairGrant(pin: String): JSONObject {
        if (hasSecure()) return JSONObject().put("ok", true).put("paired", true).put("alreadyPaired", true)
        val did = prefs.getString("pendingDeviceId", null) ?: throw ApiError(400, "no_pair_session", "Klik opnieuw op Remote activeren")
        val authKey = prefs.getString("pendingAuthKey", null) ?: throw ApiError(400, "no_pair_session", "Klik opnieuw op Remote activeren")
        val ts = prefs.getLong("pendingTimestamp", 0)
        if (!pin.matches(Regex("\\d{4,8}"))) throw ApiError(400, "bad_pin", "Vul de PIN van de TV in")
        val payload = JSONObject().put("auth", JSONObject().put("auth_AppId", "1").put("pin", pin).put("auth_timestamp", ts).put("auth_signature", pairingSignature(ts, pin))).put("device", pairDevice(did))
        val r = secureRaw("/6/pair/grant", "POST", payload.toString(), did, authKey)
        val j = r.json()
        if (r.status !in 200..299 || (j.has("error_id") && j.optString("error_id") != "SUCCESS")) throw ApiError(r.status, "pair_grant_failed", j.optString("error_text", "Pairing mislukt"))
        prefs.edit().putString("username", did).putString("password", authKey).remove("pendingDeviceId").remove("pendingAuthKey").remove("pendingTimestamp").apply()
        return JSONObject().put("ok", true).put("paired", true).put("message", "Remote koppeling veilig op Android opgeslagen")
    }

    private fun sendKey(key: String) {
        if (key.isBlank()) return
        try { tvPost("input/key", JSONObject().put("key", keyAlias(key))) } catch (e: Exception) { if (hasSecure()) sendSecureKey(key) else throw e }
    }
    private fun sendSecureKey(key: String) { secureJson("input/key", "POST", JSONObject().put("key", keyAlias(key))) }
    private fun setVolume(v: Int): JSONObject { val cur = tryJson("audio/volume"); val maxV = cur?.optInt("max", 60) ?: 60; val value = v.coerceIn(0,maxV); try { tvPost("audio/volume", JSONObject().put("muted", false).put("current", value)) } catch (e:Exception) { if(hasSecure()) secureJson("audio/volume","POST",JSONObject().put("muted",false).put("current",value)) else throw e }; return JSONObject().put("ok",true).put("current",value).put("max",maxV) }
    private fun setMute(muted:Boolean):JSONObject { val cur=tryJson("audio/volume"); val value=cur?.optInt("current",20)?:20; try { tvPost("audio/volume",JSONObject().put("muted",muted).put("current",value)) } catch(e:Exception){ if(hasSecure()) secureJson("audio/volume","POST",JSONObject().put("muted",muted).put("current",value)) else throw e }; return JSONObject().put("ok",true).put("muted",muted) }
    private fun setSecureVolume(v:Int):JSONObject { val cur=secureJson("audio/volume","GET",null); val maxV=cur.optInt("max",60); val value=v.coerceIn(0,maxV); secureJson("audio/volume","POST",JSONObject().put("muted",false).put("current",value)); return JSONObject().put("ok",true).put("current",value).put("max",maxV) }
    private fun setSecureMute(b:JSONObject):JSONObject { val cur=secureJson("audio/volume","GET",null); val muted=if(b.has("muted")) b.optBoolean("muted") else !cur.optBoolean("muted"); secureJson("audio/volume","POST",JSONObject().put("muted",muted).put("current",cur.optInt("current",20))); return JSONObject().put("ok",true).put("muted",muted) }

    private fun launchAssistant(query:String):JSONObject { val p=JSONObject().put("intent",JSONObject().put("extras",JSONObject().put("query",query)).put("action","Intent {  act=android.intent.action.ASSIST cmp=com.google.android.katniss/com.google.android.apps.tvsearch.app.launch.trampoline.SearchActivityTrampoline flg=0x10200000 }").put("component",JSONObject().put("packageName","com.google.android.katniss").put("className","com.google.android.apps.tvsearch.app.launch.trampoline.SearchActivityTrampoline"))); secureJson("activities/launch","POST",p); return JSONObject().put("ok",true).put("source",query) }

    private fun announcement(b:JSONObject):JSONObject {
        val payload=JSONObject().put("duration",b.optInt("duration",5).coerceIn(1,3600)).put("position",b.optInt("position",4).coerceIn(0,4)).put("title",b.optString("title","Smart TV Controller")).put("titleColor",b.optString("titleColor","#FFFFFF")).put("titleSize",b.optInt("titleSize",18)).put("message",b.optString("message",b.optString("text",""))).put("messageColor",b.optString("messageColor","#FFFFFF")).put("messageSize",b.optInt("messageSize",24)).put("backgroundColor",b.optString("backgroundColor","#E6111820"))
        val r=raw("http",tvIp(),7979,"/notify","POST",payload.toString(),null); if(r.status !in 200..299) throw ApiError(r.status,"pipup_failed","PiPup HTTP ${r.status}"); return JSONObject().put("ok",true)
    }

    private fun countdownStart(b:JSONObject):JSONObject {
        val ms=((b.optLong("days",0)*86400)+(b.optLong("hours",0)*3600)+(b.optLong("minutes",0)*60)+b.optLong("seconds",0))*1000
        if(ms<1000) throw ApiError(400,"countdown_short","Countdown moet minimaal 1 seconde zijn")
        countdownStop()
        countdownConfig=JSONObject(b.toString()); countdownPaused=false; countdownPausedRemaining=0; countdownEndAt=System.currentTimeMillis()+ms
        showCountdown(ms)
        return countdownStatus()
    }
    private fun countdownStatus():JSONObject { if(!countdownPaused && countdownEndAt>0 && System.currentTimeMillis()>=countdownEndAt){ countdownToken?.let{countdownPages.remove(it)}; countdownToken=null; countdownEndAt=0 }; val active=countdownPaused||countdownEndAt>0; val rem=if(countdownPaused)countdownPausedRemaining else max(0,countdownEndAt-System.currentTimeMillis()); return JSONObject().put("ok",true).put("active",active).put("paused",countdownPaused).put("remainingMs",rem).put("endAt",if(countdownPaused)JSONObject.NULL else countdownEndAt).put("mode","android-single-overlay") }
    private fun countdownPause():JSONObject { if(countdownEndAt<=0)return countdownStatus(); countdownPausedRemaining=max(0,countdownEndAt-System.currentTimeMillis()); countdownPaused=true; countdownEndAt=0; countdownToken?.let{countdownPages.remove(it)}; countdownToken=null; cancelPipup(); return countdownStatus() }
    private fun countdownResume():JSONObject { if(!countdownPaused)return countdownStatus(); val rem=countdownPausedRemaining; countdownPaused=false; countdownEndAt=System.currentTimeMillis()+rem; showCountdown(rem); return countdownStatus() }
    private fun countdownStop():JSONObject { countdownToken?.let{countdownPages.remove(it)}; countdownToken=null; countdownEndAt=0; countdownPaused=false; countdownPausedRemaining=0; try{cancelPipup()}catch(_:Exception){}; return JSONObject().put("ok",true).put("active",false) }
    private fun showCountdown(ms:Long){ val c=countdownConfig?:JSONObject(); val token=UUID.randomUUID().toString().replace("-",""); countdownToken=token; countdownPages[token]=countdownHtml(ms,c); val ip=localIPv4s().firstOrNull()?:throw ApiError(500,"no_phone_ip","Geen wifi-IP op de telefoon gevonden"); val media=JSONObject().put("web",JSONObject().put("uri","http://$ip:8766/countdown/$token").put("width",700).put("height",180)); val payload=JSONObject().put("duration",ceil(ms/1000.0).toInt()+2).put("position",c.optInt("position",4).coerceIn(0,4)).put("backgroundColor","#00000000").put("media",media); val r=raw("http",tvIp(),7979,"/notify","POST",payload.toString(),null); if(r.status !in 200..299)throw ApiError(r.status,"pipup_failed","PiPup HTTP ${r.status}") }
    private fun cancelPipup(){ raw("http",tvIp(),7979,"/cancel","POST","{}",null) }
    private fun countdownHtml(ms:Long,c:JSONObject):String { val title=js(c.optString("title","COUNTDOWN")); val label=js(c.optString("label","")); val bg=cssColor(c.optString("backgroundColor","#E6111820")); val tc=c.optString("titleColor","#FFFFFF"); val mc=c.optString("messageColor","#FFFFFF"); val ts=c.optInt("titleSize",18); val ss=c.optInt("messageSize",34); return """<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:$bg;font-family:Roboto,Arial,sans-serif}.card{width:100%;height:100%;padding:18px 22px;background:$bg;color:$mc}.title{font-size:${ts}px;font-weight:800;color:$tc}.label{margin-top:5px;opacity:.8;font-size:${max(12,ss/2)}px}.time{margin-top:7px;font-size:${ss}px;font-weight:900;font-variant-numeric:tabular-nums;letter-spacing:.06em}.bar{height:4px;margin-top:12px;background:rgba(255,255,255,.15);overflow:hidden}.bar i{display:block;width:100%;height:100%;background:$mc;transform-origin:left;animation:x ${ms/1000.0}s linear forwards}@keyframes x{to{transform:scaleX(0)}}</style></head><body><div class='card'><div class='title'>$title</div><div class='label'>$label</div><div id='v' class='time'></div><div class='bar'><i></i></div></div><script>const total=$ms,start=performance.now(),p=n=>String(n).padStart(2,'0');function f(x){let q=Math.max(0,Math.ceil(x/1000)),d=Math.floor(q/86400),h=Math.floor(q%86400/3600),m=Math.floor(q%3600/60),s=q%60;return p(d)+':'+p(h)+':'+p(m)+':'+p(s)}function t(){let l=total-(performance.now()-start);document.getElementById('v').textContent=f(l);if(l>0)requestAnimationFrame(t)}t()</script></body></html>""" }

    private fun diagnose(query:String):JSONObject { val ip=Regex("(?:^|&)ip=([^&]+)").find(query)?.groupValues?.getOrNull(1) ?: tvIp(); return JSONObject().put("ip",ip).put("httpV6",tryGet("http",ip,1925,"/6/system")?.let{JSONObject().put("ok",it.status in 200..299).put("http",it.status)} ?: JSONObject().put("ok",false)).put("secureSaved",hasSecure()).put("pipupPort",try{raw("http",ip,7979,"/","GET",null,null).status}catch(_:Exception){0}) }

    private fun tvJson(endpoint:String):JSONObject { val ip=tvIp(); for(route in arrayOf("/6/$endpoint","/1/$endpoint","/$endpoint")){ val r=try{raw("http",ip,1925,route,"GET",null,null)}catch(_:Exception){null}; if(r!=null&&r.status in 200..299)return r.json() }; if(hasSecure())return secureJson(endpoint,"GET",null); throw ApiError(404,"endpoint_unavailable","$endpoint is niet beschikbaar") }
    private fun tryJson(endpoint:String):JSONObject?=try{tvJson(endpoint)}catch(_:Exception){null}
    private fun tvPost(endpoint:String,payload:JSONObject):JSONObject { val ip=tvIp(); for(route in arrayOf("/6/$endpoint","/1/$endpoint","/$endpoint")){ val r=try{raw("http",ip,1925,route,"POST",payload.toString(),null)}catch(_:Exception){null}; if(r!=null&&r.status in 200..299)return r.json(); if(r!=null&&r.status !in arrayOf(401,403,404))break }; if(hasSecure())return secureJson(endpoint,"POST",payload); throw ApiError(409,"secure_required","Deze TV-functie vereist de beveiligde koppeling") }
    private fun secureJson(endpoint:String,method:String,payload:JSONObject?):JSONObject { val user=prefs.getString("username",null)?:throw ApiError(409,"not_paired","Remote is nog niet gekoppeld"); val pass=prefs.getString("password",null)?:throw ApiError(409,"not_paired","Remote is nog niet gekoppeld"); val r=secureRaw("/6/${endpoint.trimStart('/')}",method,payload?.toString(),user,pass); if(r.status !in 200..299)throw ApiError(r.status,"secure_http_error",r.json().optString("error_text",r.json().optString("error","Secure TV HTTP ${r.status}"))); return r.json() }
    private fun secureRaw(route:String,method:String,payload:String?,user:String,pass:String):NetResponse { val first=raw("https",tvIp(),1926,route,method,payload,null); if(first.status in 200..299)return first; var challenge=header(first,"WWW-Authenticate"); if(first.status!=401||challenge.isNullOrBlank()){ val p=raw("https",tvIp(),1926,"/6/system","GET",null,null); challenge=header(p,"WWW-Authenticate") }; if(challenge.isNullOrBlank())return first; val auth=digestAuth(route,method,user,pass,challenge); var second=raw("https",tvIp(),1926,route,method,payload,auth); if(second.status==401){ val c2=header(second,"WWW-Authenticate"); if(!c2.isNullOrBlank())second=raw("https",tvIp(),1926,route,method,payload,digestAuth(route,method,user,pass,c2)) }; return second }

    private fun raw(protocol:String,ip:String,port:Int,route:String,method:String,payload:String?,authorization:String?):NetResponse { val url=URL("$protocol://$ip:$port$route"); val c=(url.openConnection() as HttpURLConnection); if(c is HttpsURLConnection){c.sslSocketFactory=sslContext.socketFactory;c.hostnameVerifier=HostnameVerifier{_,_->true}}; c.connectTimeout=6500;c.readTimeout=8500;c.requestMethod=method;c.setRequestProperty("Accept","application/json");authorization?.let{c.setRequestProperty("Authorization",it)}; if(payload!=null){c.doOutput=true;c.setRequestProperty("Content-Type","application/json");c.outputStream.use{it.write(payload.toByteArray(StandardCharsets.UTF_8))}}; val status=try{c.responseCode}catch(e:Exception){throw e}; val stream=if(status>=400)c.errorStream else c.inputStream; val text=try{stream?.bufferedReader()?.use{it.readText()}.orEmpty()}catch(_:Exception){""}; return NetResponse(status,text,c.headerFields.filterKeys{it!=null}) }
    private fun tryGet(protocol:String,ip:String,port:Int,route:String):NetResponse?=try{raw(protocol,ip,port,route,"GET",null,null)}catch(_:Exception){null}
    private fun header(r:NetResponse,name:String):String?=r.headers.entries.firstOrNull{it.key.equals(name,true)}?.value?.firstOrNull()

    private fun digestAuth(route:String,method:String,user:String,pass:String,challenge:String):String { val c=parseDigest(challenge); val realm=c["realm"]?:""; val nonce=c["nonce"]?:""; val qop=c["qop"]?.split(',')?.map{it.trim()}?.firstOrNull{it=="auth"}; val nc="00000001"; val cnonce=randomId(16); val ha1=md5("$user:$realm:$pass"); val ha2=md5("$method:$route"); val response=if(qop!=null)md5("$ha1:$nonce:$nc:$cnonce:$qop:$ha2")else md5("$ha1:$nonce:$ha2"); val parts=mutableListOf("username=\"$user\"","realm=\"$realm\"","nonce=\"$nonce\"","uri=\"$route\"","response=\"$response\""); c["algorithm"]?.let{parts.add("algorithm=$it")};c["opaque"]?.let{parts.add("opaque=\"$it\"")};if(qop!=null){parts.add("qop=$qop");parts.add("nc=$nc");parts.add("cnonce=\"$cnonce\"")};return "Digest ${parts.joinToString(", ")}" }
    private fun parseDigest(s:String):Map<String,String>{ val out=mutableMapOf<String,String>(); Regex("(\\w+)=(?:\\\"([^\\\"]*)\\\"|([^,\\s]+))").findAll(s.removePrefix("Digest ")).forEach{m->out[m.groupValues[1].lowercase()]=if(m.groupValues[2].isNotEmpty())m.groupValues[2]else m.groupValues[3]};return out }
    private fun md5(s:String)=MessageDigest.getInstance("MD5").digest(s.toByteArray()).joinToString(""){"%02x".format(it)}
    private fun pairingSignature(ts:Long,pin:String):String { val key=Base64.getDecoder().decode("ZmVay1EQVFOaZhwQ4Kv81ypLAZNczV9sG4KkseXWn1NEk6cXmPKO/MCa9sryslvLCFMnNe4Z4CPXzToowvhHvA=="); val mac=Mac.getInstance("HmacSHA1");mac.init(SecretKeySpec(key,"HmacSHA1"));val hex=mac.doFinal("$ts$pin".toByteArray()).joinToString(""){"%02x".format(it)};return Base64.getEncoder().encodeToString(hex.toByteArray()) }
    private fun pairDevice(id:String)=JSONObject().put("device_name","Smart TV Controller Android").put("device_os","Android").put("app_name","Smart TV Controller").put("type","native").put("app_id","app.id").put("id",id)
    private fun randomId(n:Int):String { val chars="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; val sr=SecureRandom(); return buildString{repeat(n){append(chars[sr.nextInt(chars.length)])}} }
    private fun keyAlias(k:String)=when(k){"Settings"->"Adjust";"Menu"->"Options";"Power"->"Standby";else->k}
    private fun packageFromActivity(a:JSONObject):String?=a.optJSONObject("intent")?.optJSONObject("component")?.optString("packageName")?.takeIf{it.isNotBlank()} ?: a.optJSONObject("component")?.optString("packageName")?.takeIf{it.isNotBlank()}
    private fun packageFromApp(a:JSONObject):String?=a.optJSONObject("intent")?.optJSONObject("component")?.optString("packageName")?.takeIf{it.isNotBlank()} ?: a.optJSONObject("component")?.optString("packageName")?.takeIf{it.isNotBlank()} ?: a.optString("packageName").takeIf{it.isNotBlank()}
    private fun isSystemApp(name:String,pkg:String?):Boolean { val s=(name+" "+(pkg?:"")).lowercase(); return listOf("launcher","systemui","settings","leanbacklauncher","recommendations","setupwizard","inputmethod","org.droidtv.home","org.droidtv.launcher").any{s.contains(it)} }
    private fun hexRgb(hex:String):JSONObject { val s=hex.removePrefix("#").padEnd(6,'0'); return JSONObject().put("r",s.substring(0,2).toIntOrNull(16)?:0).put("g",s.substring(2,4).toIntOrNull(16)?:0).put("b",s.substring(4,6).toIntOrNull(16)?:0) }
    private fun localIPv4s():List<String>{ val out=mutableListOf<String>(); try{NetworkInterface.getNetworkInterfaces().toList().forEach{n->n.inetAddresses.toList().forEach{a->if(a is Inet4Address&&!a.isLoopbackAddress&&a.isSiteLocalAddress)out.add(a.hostAddress?:return@forEach)}}}catch(_:Exception){};return out.distinct() }
    private fun cssColor(v:String):String { val s=v.removePrefix("#"); if(s.length==8){val a=s.substring(0,2).toInt(16)/255.0;return "rgba(${s.substring(2,4).toInt(16)},${s.substring(4,6).toInt(16)},${s.substring(6,8).toInt(16)},$a)"};return v }
    private fun js(s:String)=s.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;").replace("\"","&quot;").replace("'","&#39;")
}

private class CountdownServer(private val pages: ConcurrentHashMap<String,String>) {
    @Volatile private var running=false
    fun start(){ if(running)return; running=true; Thread{ try{ ServerSocket(8766).use{server->while(running){val socket=server.accept();Thread{handle(socket)}.start()}} }catch(_:Exception){} }.apply{isDaemon=true;name="CountdownServer"}.start() }
    private fun handle(socket:java.net.Socket){ try{ socket.use{s-> val reader=BufferedReader(InputStreamReader(s.getInputStream())); val first=reader.readLine()?:return; val path=first.split(' ').getOrNull(1)?:"/"; while(true){val line=reader.readLine()?:break;if(line.isEmpty())break}; val token=path.substringAfter("/countdown/",""); val html=pages[token]; val body=(html?:"Countdown verlopen").toByteArray(); val status=if(html!=null)"200 OK" else "404 Not Found"; val h="HTTP/1.1 $status\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n"; s.getOutputStream().write(h.toByteArray());s.getOutputStream().write(body);s.getOutputStream().flush() } }catch(_:Exception){} }
}

private class ApiError(val status:Int,val code:String,message:String):RuntimeException(message)
