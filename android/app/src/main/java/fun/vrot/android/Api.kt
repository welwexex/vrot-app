package `fun`.vrot.android


import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SessionStore(context: Context) {
    private val prefs = context.getSharedPreferences("vrot_session", Context.MODE_PRIVATE)
    private val alias = "vrot.android.session.v1"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        }.generateKey()
    }
    fun save(cookie: String) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val value = cipher.iv + cipher.doFinal(cookie.toByteArray(Charsets.UTF_8))
        prefs.edit().putString("cookie", Base64.encodeToString(value, Base64.NO_WRAP)).apply()
    }
    fun cookie(): String? = try {
        val raw = Base64.decode(prefs.getString("cookie", null) ?: return null, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw.copyOfRange(0, 12))) }
        String(cipher.doFinal(raw.copyOfRange(12, raw.size)), Charsets.UTF_8)
    } catch (_: Exception) { clear(); null }
    fun clear() { prefs.edit().remove("cookie").apply() }
}

class Api(private val session: SessionStore) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .apply {
            try {
                val trustAllCerts = arrayOf<javax.net.ssl.TrustManager>(object : javax.net.ssl.X509TrustManager {
                    override fun checkClientTrusted(chain: Array<out java.security.cert.X509Certificate>?, authType: String?) {}
                    override fun checkServerTrusted(chain: Array<out java.security.cert.X509Certificate>?, authType: String?) {}
                    override fun getAcceptedIssuers(): Array<java.security.cert.X509Certificate> = arrayOf()
                })
                val sslContext = javax.net.ssl.SSLContext.getInstance("SSL")
                sslContext.init(null, trustAllCerts, java.security.SecureRandom())
                sslSocketFactory(sslContext.socketFactory, trustAllCerts[0] as javax.net.ssl.X509TrustManager)
                hostnameVerifier { _, _ -> true }
            } catch (_: Exception) {}
        }
        .build()

    suspend fun request(path: String, method: String = "GET", json: JSONObject? = null): Any = withContext(Dispatchers.IO) {
        val body = if (method == "GET") null else (json?.toString() ?: "{}").toRequestBody("application/json; charset=utf-8".toMediaType())
        val request = Request.Builder().url(BuildConfig.API_BASE + path).apply {
            header("Origin", "https://vrot.fun")
            header("User-Agent", "VrotApp-Android/1.0")
            session.cookie()?.let { header("Cookie", it) }
            method(method, body)
        }.build()
        client.newCall(request).execute().use { response ->
            response.header("Set-Cookie")?.substringBefore(';')?.takeIf { it.startsWith("vrot_session=") }?.let(session::save)
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val error = runCatching { JSONObject(text).optString("error") }.getOrNull().orEmpty()
                throw ApiException(response.code, error.ifBlank { "Ошибка ${response.code}" })
            }
            when {
                text.isBlank() -> JSONObject()
                text.trimStart().startsWith("[") -> JSONArray(text)
                else -> JSONObject(text)
            }
        }
    }
    suspend fun obj(path: String, method: String = "GET", json: JSONObject? = null) = request(path, method, json) as JSONObject
    suspend fun array(path: String) = request(path) as JSONArray
    fun cookie() = session.cookie()
    fun clear() = session.clear()
}
class ApiException(val status: Int, message: String): Exception(message)

fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }
fun JSONObject.text(key: String): String = optString(key).takeUnless { it == "null" } ?: ""
